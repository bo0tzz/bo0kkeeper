/**
 * End-to-end auth flow against an in-process fake OIDC IDP.
 *
 * Walks the same sequence the browser would, but with a node fetch + cookie
 * jar instead of a real browser:
 *   GET  /api/auth/me                         → 401 (no cookie)
 *   GET  /api/auth/login?return_to=/          → 302 to fake-idp /authorize
 *   GET  fake-idp /authorize                  → 302 back to /api/auth/callback
 *   GET  /api/auth/callback                   → 302 to return_to (sets ID token cookie)
 *   GET  /api/auth/me                         → 200 with { sub, email, name }
 *
 * The full integration covers every gotcha from the recent dev session:
 *   - OIDC discovery + JWKS reachable from the backend
 *   - state/verifier/return_to cookies survive the redirect to the IDP
 *   - id_token cookie is set with options that allow it to be sent back
 *   - JWT verification against the IDP's JWKS succeeds
 *   - AuthGuard accepts the resulting token on subsequent requests
 */
import { INestApplication } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import type { AddressInfo } from 'node:net';
import { applyCommonAppConfig } from 'src/app.common';
import { getKyselyConfig } from 'src/utils/database';
import { CookieJar, getFreePort, startFakeIdp, type FakeIdp } from 'test/e2e/fake-idp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CLIENT_ID = 'e2e-client';

describe('Auth E2E (real Nest app + fake OIDC IDP)', () => {
  let idp: FakeIdp;
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const idpPort = await getFreePort();
    const appPort = await getFreePort();

    idp = await startFakeIdp({ port: idpPort, clientId: CLIENT_ID });

    process.env.NODE_ENV = 'test';
    process.env.HOST = '127.0.0.1';
    process.env.PORT = String(appPort);
    process.env.OIDC_ISSUER = idp.issuer;
    process.env.OIDC_CLIENT_ID = CLIENT_ID;
    delete process.env.OIDC_CLIENT_SECRET;
    process.env.OIDC_REDIRECT_URI = `http://localhost:${appPort}/api/auth/callback`;
    process.env.OIDC_SCOPES = 'openid email profile offline_access';
    process.env.OIDC_POST_LOGIN_PATH = '/';
    process.env.COOKIE_SECURE = 'false';
    process.env.WISE_WEBHOOK_VERIFY = 'false';

    // Point the backend at a fresh per-suite database (cloned from the medium
    // test template). pg-boss creates its own schema on first start; the
    // template has no pgboss schema yet so this works.
    const tplHost = process.env.BO0KKEEPER_TEST_POSTGRES_HOST!;
    const tplPort = process.env.BO0KKEEPER_TEST_POSTGRES_PORT!;
    const tplUser = process.env.BO0KKEEPER_TEST_POSTGRES_USER!;
    const tplPass = process.env.BO0KKEEPER_TEST_POSTGRES_PASSWORD!;
    const tplName = process.env.BO0KKEEPER_TEST_POSTGRES_TEMPLATE!;
    const dbName = `bo0kkeeper_e2e_${Math.random().toString(36).slice(2, 10)}`;
    const admin = new Kysely(
      getKyselyConfig({
        connectionType: 'parts',
        host: tplHost,
        port: Number(tplPort),
        username: tplUser,
        password: tplPass,
        database: tplName,
      }),
    );
    try {
      await sql`CREATE DATABASE ${sql.id(dbName)} WITH TEMPLATE ${sql.id(tplName)} OWNER ${sql.id(tplUser)}`.execute(
        admin,
      );
    } finally {
      await admin.destroy();
    }
    process.env.DB_HOST = tplHost;
    process.env.DB_PORT = tplPort;
    process.env.DB_USERNAME = tplUser;
    process.env.DB_PASSWORD = tplPass;
    process.env.DB_DATABASE_NAME = dbName;
    delete process.env.DB_URL;

    // Reset module cache so app.module re-reads env in this process.
    const vitest = await import('vitest');
    vitest.vi.resetModules();

    const { NestFactory } = await import('@nestjs/core');
    // app.module is dynamically imported AFTER env is set so loadConfig() runs
    // against our overridden values rather than whatever was loaded statically.
    const { AppModule } = (await import('../../src/app.module.js')) as typeof import('src/app.module');

    app = await NestFactory.create(AppModule, { logger: false });
    applyCommonAppConfig(app as Parameters<typeof applyCommonAppConfig>[0]);
    await app.listen(appPort, '127.0.0.1');
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://localhost:${address.port}`;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await idp?.close();
  });

  it('walks login → callback → /api/auth/me end-to-end', async () => {
    const jar = new CookieJar();

    // 1. /api/auth/me without a session → 401.
    const meBefore = await fetch(`${baseUrl}/api/auth/me`, { redirect: 'manual' });
    expect(meBefore.status).toBe(401);

    // 2. /api/auth/login → 302 to IDP authorize URL, plus state/verifier/return_to cookies.
    const loginRes = await fetch(`${baseUrl}/api/auth/login?return_to=/`, { redirect: 'manual' });
    expect(loginRes.status).toBe(302);
    jar.ingest(loginRes.headers);
    expect(jar.get('bo0kkeeper.oauth_state')).toBeTruthy();
    expect(jar.get('bo0kkeeper.oauth_code_verifier')).toBeTruthy();
    // Cookie value is URL-encoded on the wire (Express res.cookie behaviour);
    // the server decodes it on the way in. The test mirrors the server view.
    expect(decodeURIComponent(jar.get('bo0kkeeper.oauth_return_to') ?? '')).toBe('/');
    const authorizeUrl = loginRes.headers.get('location');
    expect(authorizeUrl).toMatch(new RegExp(String.raw`^${idp.issuer}/authorize\?`));

    // 3. /authorize → 302 back to backend's callback URL with a code+state.
    const authorizeRes = await fetch(authorizeUrl!, { redirect: 'manual' });
    expect(authorizeRes.status).toBe(302);
    const callbackUrl = authorizeRes.headers.get('location');
    expect(callbackUrl).toMatch(/\/api\/auth\/callback\?/);

    // 4. Backend's callback → 302 to return_to, sets id_token cookie.
    const callbackRes = await fetch(callbackUrl!, {
      redirect: 'manual',
      headers: { cookie: jar.asHeader() },
    });
    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.get('location')).toBe('/');
    jar.ingest(callbackRes.headers);
    expect(jar.get('bo0kkeeper.id_token')).toBeTruthy();
    // State/verifier/return_to cookies are cleared after a successful callback.
    expect(jar.get('bo0kkeeper.oauth_state')).toBeFalsy();
    expect(jar.get('bo0kkeeper.oauth_code_verifier')).toBeFalsy();

    // 5. /api/auth/me with the new cookie → 200 with the synthetic test user.
    const meAfter = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { cookie: jar.asHeader() },
    });
    expect(meAfter.status).toBe(200);
    const me = (await meAfter.json()) as { sub: string; email?: string; name?: string };
    expect(me.sub).toBe('test-user-sub');
    expect(me.email).toBe('test@example.test');
    expect(me.name).toBe('Test User');
  });

  it('rejects callback when state cookie is missing', async () => {
    const jar = new CookieJar();
    const loginRes = await fetch(`${baseUrl}/api/auth/login?return_to=/`, { redirect: 'manual' });
    jar.ingest(loginRes.headers);
    const authorizeUrl = loginRes.headers.get('location')!;
    const authorizeRes = await fetch(authorizeUrl, { redirect: 'manual' });
    const callbackUrl = authorizeRes.headers.get('location')!;

    // Strip the state cookie so the backend rejects the callback.
    const headerWithoutState = jar
      .asHeader()
      .split('; ')
      .filter((part) => !part.startsWith('bo0kkeeper.oauth_state='))
      .join('; ');
    const callbackRes = await fetch(callbackUrl, {
      redirect: 'manual',
      headers: { cookie: headerWithoutState },
    });
    expect(callbackRes.status).toBe(400);
  });

  it('callback also stores a refresh token cookie scoped to /api/auth/refresh', async () => {
    const jar = new CookieJar();
    const loginRes = await fetch(`${baseUrl}/api/auth/login?return_to=/`, { redirect: 'manual' });
    jar.ingest(loginRes.headers);
    const authRes = await fetch(loginRes.headers.get('location')!, { redirect: 'manual' });
    const callbackRes = await fetch(authRes.headers.get('location')!, {
      redirect: 'manual',
      headers: { cookie: jar.asHeader() },
    });
    expect(callbackRes.status).toBe(302);

    // The Set-Cookie for the refresh token has Path=/api/auth/refresh — assert
    // on the raw header rather than going through the cookie jar (which
    // ignores path attributes for our single-host test).
    const setCookies = callbackRes.headers.getSetCookie();
    const refreshSetCookie = setCookies.find((c) => c.startsWith('bo0kkeeper.refresh_token='));
    expect(refreshSetCookie).toBeTruthy();
    expect(refreshSetCookie).toMatch(/Path=\/api\/auth\/refresh/);
  });

  it('refresh swaps in a fresh id_token cookie using the refresh-token cookie', async () => {
    const jar = new CookieJar();
    const loginRes = await fetch(`${baseUrl}/api/auth/login?return_to=/`, { redirect: 'manual' });
    jar.ingest(loginRes.headers);
    const authRes = await fetch(loginRes.headers.get('location')!, { redirect: 'manual' });
    const callbackRes = await fetch(authRes.headers.get('location')!, {
      redirect: 'manual',
      headers: { cookie: jar.asHeader() },
    });
    jar.ingest(callbackRes.headers);
    const originalIdToken = jar.get('bo0kkeeper.id_token');
    const originalRefreshToken = jar.get('bo0kkeeper.refresh_token');
    expect(originalIdToken).toBeTruthy();
    expect(originalRefreshToken).toBeTruthy();

    // The IDP issues fresh id_tokens stamped with the current second; pause a
    // beat so the rotated id_token has a strictly later iat than the original.
    await new Promise((r) => setTimeout(r, 1100));

    const refreshRes = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: jar.asHeader() },
    });
    expect(refreshRes.status).toBe(204);

    jar.ingest(refreshRes.headers);
    const newIdToken = jar.get('bo0kkeeper.id_token');
    const newRefreshToken = jar.get('bo0kkeeper.refresh_token');
    expect(newIdToken).toBeTruthy();
    expect(newIdToken).not.toBe(originalIdToken);
    // IDP rotates refresh tokens by default in our fake (matches Authentik),
    // so the new one must differ from the original.
    expect(newRefreshToken).toBeTruthy();
    expect(newRefreshToken).not.toBe(originalRefreshToken);

    // The new id_token still authenticates /api/auth/me successfully.
    const meAfter = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: jar.asHeader() } });
    expect(meAfter.status).toBe(200);
  });

  it('refresh returns 401 when the refresh-token cookie is missing', async () => {
    const refreshRes = await fetch(`${baseUrl}/api/auth/refresh`, { method: 'POST', redirect: 'manual' });
    expect(refreshRes.status).toBe(401);
  });

  it('refresh clears cookies when the IDP rejects the refresh token', async () => {
    const jar = new CookieJar();
    const loginRes = await fetch(`${baseUrl}/api/auth/login?return_to=/`, { redirect: 'manual' });
    jar.ingest(loginRes.headers);
    const authRes = await fetch(loginRes.headers.get('location')!, { redirect: 'manual' });
    const callbackRes = await fetch(authRes.headers.get('location')!, {
      redirect: 'manual',
      headers: { cookie: jar.asHeader() },
    });
    jar.ingest(callbackRes.headers);
    expect(jar.get('bo0kkeeper.refresh_token')).toBeTruthy();

    // Revoke the token at the IDP — next refresh attempt gets invalid_grant.
    idp.revokeAllRefreshTokens();

    const refreshRes = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: jar.asHeader() },
    });
    expect(refreshRes.status).toBe(401);

    // Both cookies were cleared so the next API call will redirect to login
    // rather than loop on 401 → refresh → 401.
    jar.ingest(refreshRes.headers);
    expect(jar.get('bo0kkeeper.id_token')).toBeFalsy();
    expect(jar.get('bo0kkeeper.refresh_token')).toBeFalsy();
  });

  it('logout clears the id token cookie and returns the end-session URL', async () => {
    // Re-auth a session for this test.
    const jar = new CookieJar();
    const loginRes = await fetch(`${baseUrl}/api/auth/login?return_to=/`, { redirect: 'manual' });
    jar.ingest(loginRes.headers);
    const authRes = await fetch(loginRes.headers.get('location')!, { redirect: 'manual' });
    const callbackRes = await fetch(authRes.headers.get('location')!, {
      redirect: 'manual',
      headers: { cookie: jar.asHeader() },
    });
    jar.ingest(callbackRes.headers);
    expect(jar.get('bo0kkeeper.id_token')).toBeTruthy();

    const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie: jar.asHeader(), 'content-type': 'application/json' },
      body: '{}',
    });
    expect(logoutRes.status).toBe(200);
    const body = (await logoutRes.json()) as { endSessionUrl: string | null };
    expect(body.endSessionUrl).toMatch(new RegExp(`^${idp.issuer}/end-session`));

    jar.ingest(logoutRes.headers);
    expect(jar.get('bo0kkeeper.id_token')).toBeFalsy();
    expect(jar.get('bo0kkeeper.refresh_token')).toBeFalsy();
  });
});
