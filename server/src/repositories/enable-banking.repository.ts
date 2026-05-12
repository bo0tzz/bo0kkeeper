import { Injectable, Logger, Optional } from '@nestjs/common';
import { createSign } from 'node:crypto';
import { Config, loadConfig } from 'src/config';

/**
 * Wraps the Enable Banking PSD2 API for outbound calls (start auth, create
 * session, list transactions, fetch balances). Authentication is an RS256
 * JWT signed with the application's private key, included as a Bearer token
 * on every request.
 *
 * Mock ASPSP (sandbox) accepts the same JWTs registered apps produce — so
 * dev runs against the same code path as prod, just pointed at the mock
 * bank from the control panel.
 *
 * No PIS (payment initiation) calls live here — production AISP-only access
 * would be blocked from those anyway, and we have no PISP licence.
 */

export type StartAuthInput = {
  /** ASPSP name as listed in `/aspsps`, e.g. `"SNS Bank"`. */
  aspspName: string;
  /** Two-letter country code, e.g. `"NL"`. */
  aspspCountry: string;
  /** Where the bank should redirect the user after SCA. */
  redirectUrl: string;
  /** Caller-generated nonce returned to us on the callback. */
  state: string;
  /** `personal` or `business`. */
  psuType: 'personal' | 'business';
  /** When the bank-issued consent should expire. */
  validUntil: Date;
};

export type StartAuthResult = {
  /** URL to redirect the user to for SCA. */
  url: string;
  /** Auth-handle id; we don't use it but the API returns it. */
  authorizationId: string;
};

export type EnableBankingAccount = {
  uid: string;
  iban?: string | null;
  currency: string;
  name?: string | null;
  product?: string | null;
  accountId?: { iban?: string };
};

export type CreateSessionResult = {
  sessionId: string;
  accounts: EnableBankingAccount[];
  /** ISO-8601 timestamp the consent is valid through. */
  validUntil: string;
};

export type ListTransactionsInput = {
  accountUid: string;
  /** ISO `YYYY-MM-DD` (PSD2 transactions are date-bucketed, not timestamped). */
  dateFrom?: string;
  dateTo?: string;
  /** Cursor returned by a prior page. */
  continuationKey?: string;
  /** PSU-IP-Address header to mark the call as user-online (no rate-limit). */
  psuIpAddress?: string;
};

/**
 * Enable Banking returns snake_case keys with nested party objects, e.g.
 * `creditor: { name: "..." }` rather than a flat `creditorName`. We mirror
 * the wire shape verbatim — the mapper in banking-sync handles the
 * translation into our flat `bank_transaction` shape.
 */
export type EnableBankingTransaction = {
  /** Stable id from the bank. */
  entry_reference?: string;
  transaction_id?: string;
  booking_date: string;
  value_date?: string;
  transaction_amount: { amount: string; currency: string };
  /** CRDT = money in (account credited), DBIT = money out. */
  credit_debit_indicator: 'CRDT' | 'DBIT';
  remittance_information?: string[];
  creditor?: { name?: string } | null;
  creditor_account?: { iban?: string } | null;
  debtor?: { name?: string } | null;
  debtor_account?: { iban?: string } | null;
  status?: string;
};

export type ListTransactionsResult = {
  transactions: EnableBankingTransaction[];
  continuationKey: string | null;
};

export type EnableBankingBalance = {
  balance_amount: { amount: string; currency: string };
  balance_type: string;
  reference_date?: string;
};

export class EnableBankingApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
    message: string,
  ) {
    super(message);
  }
}

type FetchLike = typeof fetch;

@Injectable()
export class EnableBankingRepository {
  private readonly logger = new Logger(EnableBankingRepository.name);
  private readonly config: Config['enableBanking'];
  private readonly fetchFn: FetchLike;

  constructor(@Optional() fetchFn: FetchLike = fetch) {
    this.config = loadConfig().enableBanking;
    this.fetchFn = fetchFn;
  }

  async startAuth(input: StartAuthInput): Promise<StartAuthResult> {
    const body = {
      access: { valid_until: input.validUntil.toISOString() },
      aspsp: { name: input.aspspName, country: input.aspspCountry },
      state: input.state,
      redirect_url: input.redirectUrl,
      psu_type: input.psuType,
    };
    const data = (await this.request('/auth', { method: 'POST', body })) as {
      url: string;
      authorization_id: string;
    };
    return { url: data.url, authorizationId: data.authorization_id };
  }

  async createSession(code: string): Promise<CreateSessionResult> {
    const data = (await this.request('/sessions', {
      method: 'POST',
      body: { code },
    })) as { session_id: string; accounts: EnableBankingAccount[]; access: { valid_until: string } };
    return {
      sessionId: data.session_id,
      accounts: data.accounts ?? [],
      validUntil: data.access.valid_until,
    };
  }

  async listTransactions(input: ListTransactionsInput): Promise<ListTransactionsResult> {
    const params = new URLSearchParams();
    if (input.dateFrom) {
      params.set('date_from', input.dateFrom);
    }
    if (input.dateTo) {
      params.set('date_to', input.dateTo);
    }
    if (input.continuationKey) {
      params.set('continuation_key', input.continuationKey);
    }
    const query = params.toString();
    const path = `/accounts/${encodeURIComponent(input.accountUid)}/transactions${query ? `?${query}` : ''}`;
    const data = (await this.request(path, {
      method: 'GET',
      psuIpAddress: input.psuIpAddress,
    })) as { transactions: EnableBankingTransaction[]; continuation_key?: string | null };
    return {
      transactions: data.transactions ?? [],
      continuationKey: data.continuation_key ?? null,
    };
  }

  /**
   * Pull balances for an account and return the most useful single number,
   * preferring "interim available" (closest to "what's spendable right now")
   * over closing-booked or expected. Returns null when the account has no
   * balances at all (Mock ASPSP without seeded balance data).
   */
  async getCurrentBalance(
    accountUid: string,
    psuIpAddress?: string,
  ): Promise<{ amountMinor: bigint; currency: string; type: string; referenceDate?: string } | null> {
    const data = (await this.request(`/accounts/${encodeURIComponent(accountUid)}/balances`, {
      method: 'GET',
      psuIpAddress,
    })) as { balances?: EnableBankingBalance[] };
    const balances = data.balances ?? [];
    if (balances.length === 0) {
      return null;
    }
    const preferred =
      balances.find((b) => b.balance_type === 'ITAV') ?? balances.find((b) => b.balance_type === 'CLBD') ?? balances[0];
    return {
      amountMinor: BigInt(Math.round(Number.parseFloat(preferred.balance_amount.amount) * 100)),
      currency: preferred.balance_amount.currency,
      type: preferred.balance_type,
      referenceDate: preferred.reference_date,
    };
  }

  /**
   * Build a fresh RS256 JWT. Each request gets its own — the API wants short-
   * lived (1h) tokens, and signing them on the way out is cheap.
   */
  signJwt(now: Date = new Date()): string {
    const appId = this.requireAppId();
    const key = this.requirePrivateKey();
    const iat = Math.floor(now.getTime() / 1000);
    const header = { typ: 'JWT', alg: 'RS256', kid: appId };
    const claims = {
      iss: 'enablebanking.com',
      aud: 'api.enablebanking.com',
      iat,
      exp: iat + 3600,
    };
    const segments = [encodeJsonSegment(header), encodeJsonSegment(claims)];
    const signingInput = segments.join('.');
    const signer = createSign('RSA-SHA256');
    signer.update(signingInput);
    signer.end();
    const signature = signer.sign(key).toString('base64url');
    return `${signingInput}.${signature}`;
  }

  private requireAppId(): string {
    if (!this.config.appId) {
      throw new Error('ENABLE_BANKING_APP_ID is not configured');
    }
    return this.config.appId;
  }

  private requirePrivateKey(): string {
    if (!this.config.privateKey) {
      throw new Error('ENABLE_BANKING_PRIVATE_KEY is not configured');
    }
    return this.config.privateKey;
  }

  private async request(
    path: string,
    opts: { method: string; body?: unknown; psuIpAddress?: string },
  ): Promise<unknown> {
    const url = `${this.config.apiBaseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.signJwt()}`,
      'Content-Type': 'application/json',
    };
    if (opts.psuIpAddress) {
      headers['PSU-IP-Address'] = opts.psuIpAddress;
    }
    this.logger.debug(`enable-banking → ${opts.method} ${path}`);
    const response = await this.fetchFn(url, {
      method: opts.method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await response.text();
    const data: unknown = text ? safeJson(text) : null;
    if (!response.ok) {
      throw new EnableBankingApiError(
        response.status,
        data,
        `Enable Banking ${opts.method} ${path} failed: ${response.status}`,
      );
    }
    return data;
  }
}

function encodeJsonSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
