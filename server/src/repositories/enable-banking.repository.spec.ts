import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import { EnableBankingRepository } from 'src/repositories/enable-banking.repository';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const APP_ID = '11111111-2222-4333-8444-555555555555';
let privateKey: string;
let publicKey: string;

beforeAll(() => {
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  privateKey = pair.privateKey;
  publicKey = pair.publicKey;
});

beforeEach(() => {
  process.env.OIDC_ISSUER ??= 'http://idp.test';
  process.env.OIDC_CLIENT_ID ??= 'test';
  process.env.OIDC_REDIRECT_URI ??= 'http://localhost/callback';
  process.env.ENABLE_BANKING_APP_ID = APP_ID;
  process.env.ENABLE_BANKING_PRIVATE_KEY = privateKey;
  process.env.ENABLE_BANKING_API_BASE_URL = 'https://api.enablebanking.test';
});

afterAll(() => {
  delete process.env.ENABLE_BANKING_APP_ID;
  delete process.env.ENABLE_BANKING_PRIVATE_KEY;
  delete process.env.ENABLE_BANKING_API_BASE_URL;
});

function decodeJwt(jwt: string): {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  signingInput: string;
  signatureB64Url: string;
} {
  const [headerB64, claimsB64, sigB64] = jwt.split('.', 3);
  const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
  const claims = JSON.parse(Buffer.from(claimsB64, 'base64url').toString('utf8'));
  return { header, claims, signingInput: `${headerB64}.${claimsB64}`, signatureB64Url: sigB64 };
}

describe('EnableBankingRepository — JWT', () => {
  it('signs an RS256 JWT that verifies against the matching public key', () => {
    const service = new EnableBankingRepository();
    const now = new Date('2026-05-08T12:00:00Z');
    const jwt = service.signJwt(now);
    const { header, claims, signingInput, signatureB64Url } = decodeJwt(jwt);

    expect(header).toEqual({ typ: 'JWT', alg: 'RS256', kid: APP_ID });
    expect(claims).toMatchObject({
      iss: 'enablebanking.com',
      aud: 'api.enablebanking.com',
      iat: Math.floor(now.getTime() / 1000),
      exp: Math.floor(now.getTime() / 1000) + 3600,
    });

    const verifier = createVerify('RSA-SHA256');
    verifier.update(signingInput);
    verifier.end();
    expect(verifier.verify(createPublicKey(publicKey), Buffer.from(signatureB64Url, 'base64url'))).toBe(true);
  });

  it('throws when no app id or key is configured', () => {
    delete process.env.ENABLE_BANKING_APP_ID;
    expect(() => new EnableBankingRepository().signJwt()).toThrow(/ENABLE_BANKING_APP_ID/);

    process.env.ENABLE_BANKING_APP_ID = APP_ID;
    delete process.env.ENABLE_BANKING_PRIVATE_KEY;
    expect(() => new EnableBankingRepository().signJwt()).toThrow(/ENABLE_BANKING_PRIVATE_KEY/);
  });
});

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return vi.fn().mockImplementation((url: string, init: RequestInit) => Promise.resolve(handler(url, init)));
}

describe('EnableBankingRepository — wire shapes', () => {
  it('startAuth posts the documented body and returns the redirect url', async () => {
    const fetchSpy = fakeFetch((url, init) => {
      expect(url).toBe('https://api.enablebanking.test/auth');
      expect(init.method).toBe('POST');
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toMatch(/^Bearer ey/);
      expect(headers['Content-Type']).toBe('application/json');
      const body = JSON.parse(init.body as string);
      expect(body).toMatchObject({
        access: { valid_until: '2026-08-06T12:00:00.000Z' },
        aspsp: { name: 'Mock ASPSP', country: 'NL' },
        state: 'state-uuid',
        redirect_url: 'http://localhost:3000/api/banking/callback',
        psu_type: 'personal',
      });
      return Response.json({ url: 'https://bank.test/sca?x=1', authorization_id: 'auth-1' });
    });
    const service = new EnableBankingRepository(fetchSpy);
    const result = await service.startAuth({
      aspspName: 'Mock ASPSP',
      aspspCountry: 'NL',
      redirectUrl: 'http://localhost:3000/api/banking/callback',
      state: 'state-uuid',
      psuType: 'personal',
      validUntil: new Date('2026-08-06T12:00:00.000Z'),
    });
    expect(result).toEqual({ url: 'https://bank.test/sca?x=1', authorizationId: 'auth-1' });
  });

  it('createSession exchanges code → session_id + accounts', async () => {
    const fetchSpy = fakeFetch((url) => {
      expect(url).toBe('https://api.enablebanking.test/sessions');
      return Response.json({
        session_id: 'sess-42',
        access: { valid_until: '2026-08-06T12:00:00.000Z' },
        accounts: [{ uid: 'acct-1', currency: 'EUR', name: 'Business' }],
      });
    });
    const service = new EnableBankingRepository(fetchSpy);
    const result = await service.createSession('code-xyz');
    expect(result.sessionId).toBe('sess-42');
    expect(result.accounts).toHaveLength(1);
    expect(result.validUntil).toBe('2026-08-06T12:00:00.000Z');
  });

  it('listTransactions builds the date_from + continuation_key query and threads the cursor back', async () => {
    const fetchSpy = fakeFetch((url, init) => {
      expect(url).toBe(
        'https://api.enablebanking.test/accounts/acct-1/transactions?date_from=2026-05-01&continuation_key=page-2',
      );
      const headers = init.headers as Record<string, string>;
      expect(headers['PSU-IP-Address']).toBe('203.0.113.7');
      return Response.json({
        transactions: [
          {
            entry_reference: 'tx-9',
            booking_date: '2026-05-07',
            transaction_amount: { amount: '12.34', currency: 'EUR' },
            credit_debit_indicator: 'CRDT',
          },
        ],
        continuation_key: null,
      });
    });
    const service = new EnableBankingRepository(fetchSpy);
    const result = await service.listTransactions({
      accountUid: 'acct-1',
      dateFrom: '2026-05-01',
      continuationKey: 'page-2',
      psuIpAddress: '203.0.113.7',
    });
    expect(result.transactions).toHaveLength(1);
    expect(result.continuationKey).toBeNull();
  });

  it('surfaces non-2xx responses as EnableBankingApiError with status + body', async () => {
    const fetchSpy = fakeFetch(() =>
      Response.json({ error: 'AUTHORIZATION_FAILED', description: 'expired session' }, { status: 401 }),
    );
    const service = new EnableBankingRepository(fetchSpy);
    await expect(service.createSession('bad')).rejects.toMatchObject({
      status: 401,
      body: { error: 'AUTHORIZATION_FAILED' },
    });
  });
});
