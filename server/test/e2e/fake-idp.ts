/**
 * In-process OIDC IDP for end-to-end auth tests.
 *
 * Boots a node:http server that implements just enough of OIDC for the
 * backend's discovery + auth-code + JWKS flow to succeed:
 *   - GET /.well-known/openid-configuration
 *   - GET /jwks
 *   - GET /authorize    → 302 back to redirect_uri with code + state
 *   - POST /token       → returns id_token signed with our test private key
 *   - GET /end-session  → 302 to post_logout_redirect_uri
 *
 * No user interaction; /authorize auto-grants for whatever subject the test
 * requested. ID tokens are signed RS256 (matches Authentik defaults), and the
 * public JWK is exposed at /jwks so the backend's `jwtVerify` succeeds.
 */
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

export type FakeIdp = {
  issuer: string;
  jwksUri: string;
  authorizeUri: string;
  tokenUri: string;
  endSessionUri: string;
  /** Tear down the underlying http server. */
  close(): Promise<void>;
  /** Override the user the next /authorize call will grant (default: a synthetic test user). */
  setNextUser(user: { sub: string; email?: string; name?: string }): void;
  /** Mark every currently-outstanding refresh token as revoked so the next refresh fails. */
  revokeAllRefreshTokens(): void;
};

type IssuedCode = {
  code: string;
  redirectUri: string;
  user: { sub: string; email?: string; name?: string };
  audience: string;
  // The PKCE code_challenge supplied at /authorize. We don't verify the
  // verifier here — that's the backend's job to send correctly. Tracked only
  // so future tests could assert on it.
  codeChallenge?: string;
};

type IssuedRefreshToken = {
  token: string;
  user: { sub: string; email?: string; name?: string };
  audience: string;
};

export async function startFakeIdp(opts: { port: number; clientId: string }): Promise<FakeIdp> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  const kid = 'fake-idp-key-1';
  jwk.kid = kid;
  jwk.use = 'sig';
  jwk.alg = 'RS256';

  let nextUser: { sub: string; email?: string; name?: string } = {
    sub: 'test-user-sub',
    email: 'test@example.test',
    name: 'Test User',
  };
  const issuedCodes = new Map<string, IssuedCode>();
  const issuedRefreshTokens = new Map<string, IssuedRefreshToken>();
  // Refresh tokens that have been administratively revoked — used to test the
  // refresh-failure path (e.g. user logged out from the IDP, token expired).
  const revokedRefreshTokens = new Set<string>();

  const handler = async (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ): Promise<void> => {
    try {
      const url = new URL(req.url ?? '/', `http://localhost:${opts.port}`);
      const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };

      if (url.pathname === '/.well-known/openid-configuration' && req.method === 'GET') {
        const issuer = `http://localhost:${opts.port}`;
        send(200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          end_session_endpoint: `${issuer}/end-session`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          scopes_supported: ['openid', 'email', 'profile'],
          token_endpoint_auth_methods_supported: ['client_secret_basic', 'none'],
          code_challenge_methods_supported: ['S256'],
        });
        return;
      }

      if (url.pathname === '/jwks' && req.method === 'GET') {
        send(200, { keys: [jwk] });
        return;
      }

      if (url.pathname === '/authorize' && req.method === 'GET') {
        const redirectUri = url.searchParams.get('redirect_uri');
        const state = url.searchParams.get('state');
        if (!redirectUri || !state) {
          send(400, { error: 'invalid_request', missing: { redirectUri: !redirectUri, state: !state } });
          return;
        }
        const codeChallenge = url.searchParams.get('code_challenge') ?? undefined;
        const audience = url.searchParams.get('client_id') ?? opts.clientId;
        const code = randomUUID();
        issuedCodes.set(code, { code, redirectUri, user: nextUser, audience, codeChallenge });
        const redirect = new URL(redirectUri);
        redirect.searchParams.set('code', code);
        redirect.searchParams.set('state', state);
        res.writeHead(302, { location: redirect.href });
        res.end();
        return;
      }

      if (url.pathname === '/token' && req.method === 'POST') {
        const body = await readBody(req);
        const params = new URLSearchParams(body);
        const grantType = params.get('grant_type');

        const issueIdToken = async (user: IssuedCode['user'], audience: string) => {
          const now = Math.floor(Date.now() / 1000);
          return new SignJWT({ email: user.email, name: user.name })
            .setProtectedHeader({ alg: 'RS256', kid })
            .setIssuer(`http://localhost:${opts.port}`)
            .setSubject(user.sub)
            .setAudience(audience)
            .setIssuedAt(now)
            .setExpirationTime(now + 3600)
            .sign(privateKey);
        };

        if (grantType === 'refresh_token') {
          const refreshToken = params.get('refresh_token');
          if (!refreshToken) {
            send(400, { error: 'invalid_request', detail: 'missing refresh_token' });
            return;
          }
          if (revokedRefreshTokens.has(refreshToken)) {
            send(400, { error: 'invalid_grant', detail: 'refresh token revoked' });
            return;
          }
          const existing = issuedRefreshTokens.get(refreshToken);
          if (!existing) {
            send(400, { error: 'invalid_grant', detail: 'unknown refresh_token' });
            return;
          }
          // Rotate the refresh token — the old one is consumed, a new one is
          // issued. Mirrors how Authentik / most modern IDPs behave.
          issuedRefreshTokens.delete(refreshToken);
          const newRefreshToken = randomUUID();
          issuedRefreshTokens.set(newRefreshToken, existing);
          const idToken = await issueIdToken(existing.user, existing.audience);
          send(200, {
            access_token: 'fake-access-token',
            token_type: 'Bearer',
            expires_in: 3600,
            id_token: idToken,
            refresh_token: newRefreshToken,
            scope: 'openid email profile offline_access',
          });
          return;
        }

        const code = params.get('code');
        if (!code) {
          send(400, { error: 'invalid_request', detail: 'missing code' });
          return;
        }
        const issued = issuedCodes.get(code);
        if (!issued) {
          send(400, { error: 'invalid_grant', detail: 'unknown code' });
          return;
        }
        issuedCodes.delete(code);

        const idToken = await issueIdToken(issued.user, issued.audience);
        const refreshToken = randomUUID();
        issuedRefreshTokens.set(refreshToken, {
          token: refreshToken,
          user: issued.user,
          audience: issued.audience,
        });

        send(200, {
          access_token: 'fake-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
          id_token: idToken,
          refresh_token: refreshToken,
          scope: 'openid email profile offline_access',
        });
        return;
      }

      if (url.pathname === '/end-session' && req.method === 'GET') {
        const postLogout = url.searchParams.get('post_logout_redirect_uri');
        if (postLogout) {
          res.writeHead(302, { location: postLogout });
          res.end();
          return;
        }
        send(200, { ok: true });
        return;
      }

      send(404, { error: 'not_found', path: url.pathname });
    } catch (error) {
      send500(res, error);
    }
  };
  const server = createServer((req, res) => {
    void handler(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => resolve());
  });

  const issuer = `http://localhost:${opts.port}`;
  return {
    issuer,
    jwksUri: `${issuer}/jwks`,
    authorizeUri: `${issuer}/authorize`,
    tokenUri: `${issuer}/token`,
    endSessionUri: `${issuer}/end-session`,
    setNextUser(user) {
      nextUser = user;
    },
    revokeAllRefreshTokens() {
      for (const token of issuedRefreshTokens.keys()) {
        revokedRefreshTokens.add(token);
      }
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send500(res: import('node:http').ServerResponse, error: unknown): void {
  res.writeHead(500, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'internal', detail: (error as Error).message }));
}

/** Allocate a free TCP port by binding-and-closing. */
export async function getFreePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/** Minimal cookie jar for redirect-following tests. Domain ignored — tests are single-host. */
export class CookieJar {
  private store = new Map<string, string>();

  store_set(setCookie: string | string[]): void {
    const headers = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const header of headers) {
      const [first] = header.split(';', 1);
      const eq = first.indexOf('=');
      if (eq <= 0) {
        continue;
      }
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      if (value === '' || value === 'undefined') {
        this.store.delete(name);
      } else {
        this.store.set(name, value);
      }
    }
  }

  ingest(headers: Headers): void {
    // Headers.getSetCookie() returns each Set-Cookie individually.
    const all = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    if (all.length > 0) {
      this.store_set(all);
    }
  }

  asHeader(): string {
    return [...this.store].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  get(name: string): string | undefined {
    return this.store.get(name);
  }

  size(): number {
    return this.store.size;
  }
}
