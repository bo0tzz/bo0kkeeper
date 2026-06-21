import { Injectable, Logger, Optional } from '@nestjs/common';
import { importPKCS8, SignJWT } from 'jose';
import { Config, loadConfig } from 'src/config';

/**
 * Google Sheets client. Uses service-account JWT auth — no OAuth flow, no
 * user clicks. The user shares the target spreadsheet with the service
 * account's email, then everything works.
 *
 * Implementation talks to the v4 REST API directly (no `googleapis` SDK).
 * Tokens are minted via JWT-bearer-grant against `/oauth2/v4/token` and
 * cached until ~30s before expiry.
 */

export type SheetTab = {
  sheetId: number;
  title: string;
  /** 0-based row index of the next empty row (cached from last read). */
};

export type ColumnFormat = {
  /** 0-based column index. */
  index: number;
  type: 'DATE' | 'CURRENCY' | 'PERCENT' | 'NUMBER';
  pattern: string;
};

export type TabInitSpec = {
  /** Header row values, written to A1:…1. */
  headers: string[];
  /** Number-format requests, applied to rows 2+ on the named columns. */
  columnFormats?: ColumnFormat[];
};

export class SheetsApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
    message: string,
  ) {
    super(message);
  }
}

type FetchLike = typeof fetch;

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

@Injectable()
export class SheetsRepository {
  private readonly logger = new Logger(SheetsRepository.name);
  private readonly config: Config['sheets'];
  private readonly fetchFn: FetchLike;
  private accessToken?: { token: string; expiresAt: number };

  constructor(@Optional() fetchFn: FetchLike = fetch) {
    this.config = loadConfig().sheets;
    this.fetchFn = fetchFn;
  }

  /** List all tabs (sheets) in the configured spreadsheet. */
  async listTabs(): Promise<{ sheetId: number; title: string }[]> {
    const sheetId = this.requireSpreadsheetId();
    const response = await this.request(`/v4/spreadsheets/${sheetId}?fields=sheets.properties`, { method: 'GET' });
    const sheets = (response as { sheets: { properties: { sheetId: number; title: string } }[] }).sheets;
    return sheets.map((s) => ({ sheetId: s.properties.sheetId, title: s.properties.title }));
  }

  /** Create a new tab (sheet) in the spreadsheet. Returns its sheetId. */
  async createTab(title: string): Promise<number> {
    const sheetId = this.requireSpreadsheetId();
    const response = await this.request(`/v4/spreadsheets/${sheetId}:batchUpdate`, {
      method: 'POST',
      body: { requests: [{ addSheet: { properties: { title } } }] },
    });
    const replies = (response as { replies: { addSheet: { properties: { sheetId: number } } }[] }).replies;
    return replies[0]?.addSheet.properties.sheetId;
  }

  /**
   * Ensure a tab with the given title exists; return its sheetId.
   *
   * When `init` is supplied and the tab is newly created, the header row is
   * written and per-column number formats + a bold/frozen header row are
   * applied in one batch. Existing tabs are returned unchanged — we never
   * stomp on whatever the user has already done by hand.
   */
  async ensureTab(title: string, init?: TabInitSpec): Promise<number> {
    const tabs = await this.listTabs();
    const existing = tabs.find((t) => t.title === title);
    if (existing) {
      return existing.sheetId;
    }
    const sheetId = await this.createTab(title);
    if (init) {
      await this.initTab(title, sheetId, init);
    }
    return sheetId;
  }

  /**
   * Write the header row + apply header bold/freeze + per-column number
   * formats. Called only when ensureTab just created the tab.
   */
  private async initTab(title: string, sheetId: number, init: TabInitSpec): Promise<void> {
    const id = this.requireSpreadsheetId();

    // Header row goes in via appendRow so values are normal strings (no
    // formula parsing surprises). USER_ENTERED is fine for plain text.
    await this.appendRow(title, init.headers);

    const requests: unknown[] = [
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
          cell: { userEnteredFormat: { textFormat: { bold: true } } },
          fields: 'userEnteredFormat.textFormat.bold',
        },
      },
      {
        updateSheetProperties: {
          properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
          fields: 'gridProperties.frozenRowCount',
        },
      },
    ];
    const columnFormats = init.columnFormats ?? [];
    for (const cf of columnFormats) {
      requests.push({
        repeatCell: {
          range: {
            sheetId,
            // Skip the header row — column number format applies to data rows only.
            startRowIndex: 1,
            startColumnIndex: cf.index,
            endColumnIndex: cf.index + 1,
          },
          cell: { userEnteredFormat: { numberFormat: { type: cf.type, pattern: cf.pattern } } },
          fields: 'userEnteredFormat.numberFormat',
        },
      });
    }
    await this.request(`/v4/spreadsheets/${id}:batchUpdate`, {
      method: 'POST',
      body: { requests },
    });
  }

  /**
   * Append a row to the named tab. `values` is the row's cell values in order
   * (matching the sheet's column layout). Google appends to the next empty row.
   */
  async appendRow(tabTitle: string, values: (string | number | null)[]): Promise<void> {
    const sheetId = this.requireSpreadsheetId();
    const range = `${tabTitle}!A1`; // append finds the next empty row regardless of the supplied range
    await this.request(
      `/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`,
      {
        method: 'POST',
        body: { values: [values] },
      },
    );
  }

  /**
   * Re-fit all columns of a tab to their widest cell, with a small pixel
   * pad applied on top. Sheets has no "auto-fit always" mode, and the
   * `autoResizeDimensions` API consistently produces widths a few pixels
   * tighter than the UI's "Fit to data" double-click — enough that text
   * sometimes clips. We work around it by:
   *   1) auto-resizing (Sheets computes per-column widths)
   *   2) reading the post-resize widths back
   *   3) updating each column to width + padPx
   */
  async autoResizeColumns(tabTitle: string, sheetId: number, columnCount: number, padPx = 16): Promise<void> {
    const id = this.requireSpreadsheetId();
    await this.request(`/v4/spreadsheets/${id}:batchUpdate`, {
      method: 'POST',
      body: {
        requests: [
          {
            autoResizeDimensions: {
              dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: columnCount },
            },
          },
        ],
      },
    });
    if (padPx <= 0) {
      return;
    }
    const meta = (await this.request(
      `/v4/spreadsheets/${id}?fields=sheets(properties(sheetId),data(columnMetadata(pixelSize)))&ranges=${encodeURIComponent(tabTitle)}`,
      { method: 'GET' },
    )) as {
      sheets: { properties: { sheetId: number }; data?: { columnMetadata?: { pixelSize?: number }[] }[] }[];
    };
    const tab = meta.sheets.find((s) => s.properties.sheetId === sheetId);
    const widths = tab?.data?.[0]?.columnMetadata ?? [];
    const padRequests = widths.slice(0, columnCount).map((cm, i) => ({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
        properties: { pixelSize: (cm.pixelSize ?? 100) + padPx },
        fields: 'pixelSize',
      },
    }));
    if (padRequests.length === 0) {
      return;
    }
    await this.request(`/v4/spreadsheets/${id}:batchUpdate`, {
      method: 'POST',
      body: { requests: padRequests },
    });
  }

  /**
   * Get an OAuth access token via the service-account JWT-bearer grant.
   * Caches until ~30s before expiry (Google tokens last 1 hour).
   */
  private async getAccessToken(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 30_000) {
      return this.accessToken.token;
    }

    const email = this.requireEmail();
    const pemKey = this.requirePrivateKey();
    const key = await importPKCS8(pemKey, 'RS256');

    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({ scope: SCOPE })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(email)
      .setSubject(email)
      .setAudience(TOKEN_URL)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(key);

    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    });
    const response = await this.fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new SheetsApiError(response.status, safeJson(text), `Sheets token exchange failed: ${response.status}`);
    }
    const payload = safeJson(text) as { access_token: string; expires_in: number };
    this.accessToken = {
      token: payload.access_token,
      expiresAt: Date.now() + payload.expires_in * 1000,
    };
    return this.accessToken.token;
  }

  private async request(path: string, opts: { method: string; body?: unknown }): Promise<unknown> {
    const token = await this.getAccessToken();
    const url = `https://sheets.googleapis.com${path}`;
    const init: RequestInit = {
      method: opts.method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    };

    this.logger.debug(`sheets → ${opts.method} ${path}`);
    const response = await this.fetchFn(url, init);
    const text = await response.text();
    if (!response.ok) {
      throw new SheetsApiError(
        response.status,
        safeJson(text),
        `Sheets ${opts.method} ${path} failed: ${response.status}`,
      );
    }
    return text ? safeJson(text) : null;
  }

  private requireEmail(): string {
    if (!this.config.serviceAccountEmail) {
      throw new Error('SHEETS_SERVICE_ACCOUNT_EMAIL is not configured');
    }
    return this.config.serviceAccountEmail;
  }

  private requirePrivateKey(): string {
    if (!this.config.serviceAccountPrivateKey) {
      throw new Error('SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY is not configured');
    }
    return this.config.serviceAccountPrivateKey;
  }

  private requireSpreadsheetId(): string {
    if (!this.config.spreadsheetId) {
      throw new Error('SHEETS_SPREADSHEET_ID is not configured');
    }
    return this.config.spreadsheetId;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
