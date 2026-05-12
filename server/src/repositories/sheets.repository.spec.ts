import { generateKeyPairSync } from 'node:crypto';
import { SheetsApiError, SheetsRepository } from 'src/repositories/sheets.repository';
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

describe('SheetsRepository', () => {
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

    const service = new SheetsRepository(fetchFn);
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

    const service = new SheetsRepository(fetchFn);
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

    const service = new SheetsRepository(fetchFn);
    const id = await service.ensureTab('existing');
    expect(id).toBe(1);
    // Only token + listTabs, no createTab.
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('ensureTab with init writes header row + applies bold/freeze + column formats', async () => {
    const fetchFn = vi
      .fn()
      // 1. token
      .mockResolvedValueOnce(tokenResponse)
      // 2. listTabs — empty, so the tab doesn't exist
      .mockResolvedValueOnce(okResponse({ sheets: [] }))
      // 3. createTab (batchUpdate addSheet)
      .mockResolvedValueOnce(
        okResponse({ replies: [{ addSheet: { properties: { sheetId: 777, title: '2099 Q1' } } }] }),
      )
      // 4. appendRow for the header
      .mockResolvedValueOnce(okResponse({}))
      // 5. batchUpdate for bold + freeze + column formats
      .mockResolvedValueOnce(okResponse({}));

    const service = new SheetsRepository(fetchFn);
    const id = await service.ensureTab('2099 Q1', {
      headers: ['Date', 'Id', 'Amount'],
      columnFormats: [
        { index: 0, type: 'DATE', pattern: 'dd/mm/yyyy' },
        { index: 2, type: 'CURRENCY', pattern: '"€"#,##0.00' },
      ],
    });
    expect(id).toBe(777);

    // Header was written.
    const [appendUrl, appendInit] = fetchFn.mock.calls[3] as [string, RequestInit];
    expect(appendUrl).toContain(':append');
    expect(JSON.parse(appendInit.body as string).values).toEqual([['Date', 'Id', 'Amount']]);

    // Final batchUpdate has bold + freeze + 2 column-format repeatCells.
    const [batchUrl, batchInit] = fetchFn.mock.calls[4] as [string, RequestInit];
    expect(batchUrl).toContain(':batchUpdate');
    const body = JSON.parse(batchInit.body as string) as { requests: unknown[] };
    expect(body.requests).toHaveLength(4);
    // Bold the header (row 0).
    expect(body.requests[0]).toMatchObject({
      repeatCell: {
        range: { sheetId: 777, startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
      },
    });
    // Freeze row 1.
    expect(body.requests[1]).toMatchObject({
      updateSheetProperties: {
        properties: { sheetId: 777, gridProperties: { frozenRowCount: 1 } },
      },
    });
    // Column 0 DATE format, skipping the header row.
    expect(body.requests[2]).toMatchObject({
      repeatCell: {
        range: { sheetId: 777, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 },
        cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'dd/mm/yyyy' } } },
      },
    });
    // Column 2 CURRENCY format.
    expect(body.requests[3]).toMatchObject({
      repeatCell: {
        range: { sheetId: 777, startRowIndex: 1, startColumnIndex: 2, endColumnIndex: 3 },
        cell: { userEnteredFormat: { numberFormat: { type: 'CURRENCY', pattern: '"€"#,##0.00' } } },
      },
    });
  });

  it('ensureTab with init does NOT re-write headers when the tab already exists', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse)
      .mockResolvedValueOnce(okResponse({ sheets: [{ properties: { sheetId: 42, title: 'existing' } }] }));

    const service = new SheetsRepository(fetchFn);
    const id = await service.ensureTab('existing', { headers: ['A', 'B'] });
    expect(id).toBe(42);
    // Only token + listTabs — no createTab, no appendRow, no batchUpdate.
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('appendRow targets values:append on the named tab', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse)
      .mockResolvedValueOnce(okResponse({ updates: { updatedRange: 'A2:F2' } }));

    const service = new SheetsRepository(fetchFn);
    await service.appendRow('2099 Q1', ['08/01/2099', '2099/001', 'Income', 'Non-EU', 'OverseasClientCo', 'Wise']);

    const [url, init] = fetchFn.mock.calls[1] as [string, RequestInit];
    expect(url).toContain('/v4/spreadsheets/fake-spreadsheet-id/values/');
    expect(url).toContain(':append');
    expect(url).toContain('valueInputOption=USER_ENTERED');
    const body = JSON.parse(init.body as string);
    expect(body.values).toEqual([['08/01/2099', '2099/001', 'Income', 'Non-EU', 'OverseasClientCo', 'Wise']]);
  });

  it('autoResizeColumns auto-fits then pads each column by the pad amount', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse)
      // 1) autoResize batchUpdate
      .mockResolvedValueOnce(okResponse({ replies: [] }))
      // 2) GET post-resize widths
      .mockResolvedValueOnce(
        okResponse({
          sheets: [
            {
              properties: { sheetId: 123 },
              data: [{ columnMetadata: [{ pixelSize: 76 }, { pixelSize: 104 }, { pixelSize: 50 }] }],
            },
          ],
        }),
      )
      // 3) pad batchUpdate
      .mockResolvedValueOnce(okResponse({ replies: [] }));

    const service = new SheetsRepository(fetchFn);
    await service.autoResizeColumns('2099 Q1', 123, 3, 16);

    // First batchUpdate is the autoResize.
    const [autoUrl, autoInit] = fetchFn.mock.calls[1] as [string, RequestInit];
    expect(autoUrl).toContain(':batchUpdate');
    expect(JSON.parse(autoInit.body as string)).toEqual({
      requests: [
        {
          autoResizeDimensions: {
            dimensions: { sheetId: 123, dimension: 'COLUMNS', startIndex: 0, endIndex: 3 },
          },
        },
      ],
    });
    // GET for post-resize widths.
    const [getUrl] = fetchFn.mock.calls[2] as [string];
    expect(getUrl).toContain('columnMetadata');
    expect(getUrl).toContain('ranges=2099%20Q1');
    // Final batchUpdate pads each column by +16.
    const [, padInit] = fetchFn.mock.calls[3] as [string, RequestInit];
    const padBody = JSON.parse(padInit.body as string);
    expect(padBody.requests).toHaveLength(3);
    expect(padBody.requests[0]).toMatchObject({
      updateDimensionProperties: {
        range: { sheetId: 123, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 },
        properties: { pixelSize: 92 },
      },
    });
    expect(padBody.requests[1]).toMatchObject({
      updateDimensionProperties: {
        range: { sheetId: 123, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 },
        properties: { pixelSize: 120 },
      },
    });
    expect(padBody.requests[2]).toMatchObject({
      updateDimensionProperties: {
        range: { sheetId: 123, dimension: 'COLUMNS', startIndex: 2, endIndex: 3 },
        properties: { pixelSize: 66 },
      },
    });
  });

  it('autoResizeColumns with padPx=0 skips the pad step', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(tokenResponse).mockResolvedValueOnce(okResponse({ replies: [] }));
    const service = new SheetsRepository(fetchFn);
    await service.autoResizeColumns('2099 Q1', 123, 3, 0);
    // Just token + autoResize batchUpdate, no GET, no pad batchUpdate.
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('token cache: second request reuses access token', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse)
      .mockResolvedValueOnce(okResponse({ sheets: [] }))
      .mockResolvedValueOnce(okResponse({ sheets: [] }));

    const service = new SheetsRepository(fetchFn);
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

    const service = new SheetsRepository(fetchFn);
    await expect(service.listTabs()).rejects.toBeInstanceOf(SheetsApiError);
  });

  it('throws if SHEETS_SPREADSHEET_ID is missing', async () => {
    delete process.env.SHEETS_SPREADSHEET_ID;
    const fetchFn = vi.fn();
    const service = new SheetsRepository(fetchFn);
    await expect(service.listTabs()).rejects.toThrow(/SHEETS_SPREADSHEET_ID/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
