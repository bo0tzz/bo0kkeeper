import { generateKeyPairSync } from 'node:crypto';
import { SheetsApiError, SheetsService } from 'src/services/sheets.service';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let testPrivateKey: string;

beforeAll(() => {
  // Single keypair for the whole suite — keygen is the slowest thing in this file.
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  testPrivateKey = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
});

const okResponse = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  }) as Response;

const errorResponse = (status: number, body: unknown): Response =>
  ({
    ok: false,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  }) as Response;

const tokenResponse = okResponse({ access_token: 'fake-access-token', expires_in: 3600, token_type: 'Bearer' });

beforeEach(() => {
  process.env.OIDC_ISSUER ??= 'http://idp.test';
  process.env.OIDC_CLIENT_ID ??= 'test';
  process.env.OIDC_REDIRECT_URI ??= 'http://localhost/callback';
  process.env.SHEETS_SERVICE_ACCOUNT_EMAIL = 'sa@project.iam.gserviceaccount.com';
  process.env.SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY = testPrivateKey;
  process.env.SHEETS_SPREADSHEET_ID = 'fake-spreadsheet-id';
});

describe('SheetsService', () => {
  it('listTabs returns parsed sheet titles + ids', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse)
      .mockResolvedValueOnce(
        okResponse({
          sheets: [
            { properties: { sheetId: 100, title: '2099 Q1' } },
            { properties: { sheetId: 200, title: '2099 Q2' } },
          ],
        }),
      );

    const service = new SheetsService(fetchFn);
    const tabs = await service.listTabs();

    expect(tabs).toEqual([
      { sheetId: 100, title: '2099 Q1' },
      { sheetId: 200, title: '2099 Q2' },
    ]);
    // First call is the token exchange.
    const [tokenUrl] = fetchFn.mock.calls[0] as [string];
    expect(tokenUrl).toBe('https://oauth2.googleapis.com/token');
    const [getUrl, getInit] = fetchFn.mock.calls[1] as [string, RequestInit];
    expect(getUrl).toBe('https://sheets.googleapis.com/v4/spreadsheets/fake-spreadsheet-id?fields=sheets.properties');
    expect((getInit.headers as Record<string, string>)['Authorization']).toBe('Bearer fake-access-token');
  });

  it('createTab issues batchUpdate addSheet and returns the new sheetId', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse)
      .mockResolvedValueOnce(
        okResponse({
          replies: [{ addSheet: { properties: { sheetId: 999, title: '2099 Q3' } } }],
        }),
      );

    const service = new SheetsService(fetchFn);
    const id = await service.createTab('2099 Q3');
    expect(id).toBe(999);

    const [url, init] = fetchFn.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://sheets.googleapis.com/v4/spreadsheets/fake-spreadsheet-id:batchUpdate');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ requests: [{ addSheet: { properties: { title: '2099 Q3' } } }] });
  });

  it('ensureTab returns existing sheetId without creating', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse)
      .mockResolvedValueOnce(
        okResponse({
          sheets: [{ properties: { sheetId: 1, title: 'existing' } }],
        }),
      );

    const service = new SheetsService(fetchFn);
    const id = await service.ensureTab('existing');
    expect(id).toBe(1);
    // Only token + listTabs, no createTab.
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('appendRow targets values:append on the named tab', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse)
      .mockResolvedValueOnce(okResponse({ updates: { updatedRange: 'A2:F2' } }));

    const service = new SheetsService(fetchFn);
    await service.appendRow('2099 Q1', ['08/01/2099', '2099/001', 'Income', 'Non-EU', 'OverseasClientCo', 'Wise']);

    const [url, init] = fetchFn.mock.calls[1] as [string, RequestInit];
    expect(url).toContain('/v4/spreadsheets/fake-spreadsheet-id/values/');
    expect(url).toContain(':append');
    expect(url).toContain('valueInputOption=USER_ENTERED');
    const body = JSON.parse(init.body as string);
    expect(body.values).toEqual([['08/01/2099', '2099/001', 'Income', 'Non-EU', 'OverseasClientCo', 'Wise']]);
  });

  it('token cache: second request reuses access token', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse)
      .mockResolvedValueOnce(okResponse({ sheets: [] }))
      .mockResolvedValueOnce(okResponse({ sheets: [] }));

    const service = new SheetsService(fetchFn);
    await service.listTabs();
    await service.listTabs();
    // Token call only once across two listTabs.
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect((fetchFn.mock.calls[0] as [string])[0]).toBe('https://oauth2.googleapis.com/token');
    expect((fetchFn.mock.calls[1] as [string])[0]).toContain('/v4/spreadsheets/');
    expect((fetchFn.mock.calls[2] as [string])[0]).toContain('/v4/spreadsheets/');
  });

  it('throws SheetsApiError on non-2xx', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse)
      .mockResolvedValueOnce(errorResponse(403, { error: { message: 'forbidden' } }));

    const service = new SheetsService(fetchFn);
    await expect(service.listTabs()).rejects.toBeInstanceOf(SheetsApiError);
  });

  it('throws if SHEETS_SPREADSHEET_ID is missing', async () => {
    delete process.env.SHEETS_SPREADSHEET_ID;
    const fetchFn = vi.fn();
    const service = new SheetsService(fetchFn);
    await expect(service.listTabs()).rejects.toThrow(/SHEETS_SPREADSHEET_ID/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
