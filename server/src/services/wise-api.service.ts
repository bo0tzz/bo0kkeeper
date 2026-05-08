import { Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Config, loadConfig } from 'src/config';

/**
 * Wraps the Wise REST API for outbound calls (quotes, transfers, lookups).
 *
 * Webhook ingestion lives in `WebhookService`. This class only handles the
 * outbound side: drafting a USD→EUR transfer, polling its state, etc.
 *
 * The API token configures `Bearer` auth. EU/EEA accounts can draft transfers
 * via this token but cannot fund them — the user opens the Wise app and
 * SCA-confirms the draft before money moves.
 */

export type WiseQuoteRequest = {
  sourceCurrency: string;
  targetCurrency: string;
  /** Either source or target amount, not both. */
  sourceAmountMinor?: bigint;
  targetAmountMinor?: bigint;
};

export type WiseQuote = {
  id: string;
  rate: string;
  /** Total fee, in source currency, as decimal string. */
  feeMinor: bigint;
  feeCurrency: string;
  sourceAmountMinor: bigint;
  sourceCurrency: string;
  targetAmountMinor: bigint;
  targetCurrency: string;
};

export type WiseCreateTransferRequest = {
  quoteId: string;
  recipientId: number;
  /** Our `TXN-NNNN` reference. Surfaces in the bank statement. */
  reference: string;
};

export type WiseTransfer = {
  id: number;
  state: string;
  reference: string | null;
  rate: string | null;
  sourceCurrency: string;
  sourceValue: number | null;
  targetCurrency: string;
  targetValue: number | null;
};

export class WiseApiError extends Error {
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
export class WiseApiService {
  private readonly logger = new Logger(WiseApiService.name);
  private readonly config: Config['wise'];
  private readonly fetchFn: FetchLike;

  constructor(@Optional() fetchFn: FetchLike = fetch) {
    this.config = loadConfig().wise;
    this.fetchFn = fetchFn;
  }

  async createQuote(input: WiseQuoteRequest): Promise<WiseQuote> {
    const profileId = this.requireProfileId();
    const body = {
      sourceCurrency: input.sourceCurrency,
      targetCurrency: input.targetCurrency,
      sourceAmount: input.sourceAmountMinor === undefined ? undefined : toMajor(input.sourceAmountMinor),
      targetAmount: input.targetAmountMinor === undefined ? undefined : toMajor(input.targetAmountMinor),
      payOut: 'BANK_TRANSFER',
    };

    const response = await this.request(`/v3/profiles/${profileId}/quotes`, { method: 'POST', body });
    return mapQuote(response);
  }

  async createTransfer(input: WiseCreateTransferRequest): Promise<WiseTransfer> {
    const body = {
      targetAccount: input.recipientId,
      quoteUuid: input.quoteId,
      customerTransactionId: randomUUID(),
      details: {
        reference: input.reference,
      },
    };
    const response = await this.request('/v1/transfers', { method: 'POST', body });
    return mapTransfer(response);
  }

  async getTransfer(transferId: number): Promise<WiseTransfer> {
    const response = await this.request(`/v1/transfers/${transferId}`, { method: 'GET' });
    return mapTransfer(response);
  }

  private requireProfileId(): number {
    if (this.config.profileId === undefined) {
      throw new Error('WISE_PROFILE_ID is not configured');
    }
    return this.config.profileId;
  }

  private requireApiToken(): string {
    if (!this.config.apiToken) {
      throw new Error('WISE_API_TOKEN is not configured');
    }
    return this.config.apiToken;
  }

  private async request(path: string, opts: { method: string; body?: unknown }): Promise<unknown> {
    const url = `${this.config.apiBaseUrl}${path}`;
    const init: RequestInit = {
      method: opts.method,
      headers: {
        Authorization: `Bearer ${this.requireApiToken()}`,
        'Content-Type': 'application/json',
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    };

    this.logger.debug(`Wise → ${opts.method} ${path}`);
    const response = await this.fetchFn(url, init);
    const text = await response.text();
    const data: unknown = text ? safeJson(text) : null;

    if (!response.ok) {
      throw new WiseApiError(response.status, data, `Wise API ${opts.method} ${path} failed: ${response.status}`);
    }
    return data;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toMajor(minor: bigint): number {
  // Wise expects amounts as decimal numbers in major units (e.g. 4791.00 USD).
  return Number(minor) / 100;
}

function toMinor(major: unknown): bigint {
  if (typeof major === 'number') {
    return BigInt(Math.round(major * 100));
  }
  if (typeof major === 'string') {
    return BigInt(Math.round(Number.parseFloat(major) * 100));
  }
  throw new Error(`Unable to coerce ${typeof major} to minor units`);
}

type QuotePaymentOption = {
  payIn: string;
  payOut: string;
  disabled: boolean;
  sourceAmount: number;
  targetAmount: number;
  fee?: { total?: number };
  sourceCurrency: string;
  targetCurrency: string;
};

type QuoteResponse = {
  id: string;
  rate: number;
  sourceAmount: number;
  sourceCurrency: string;
  targetCurrency: string;
  paymentOptions?: QuotePaymentOption[];
};

/**
 * Quote → our shape. Wise v3 quotes don't expose a single targetAmount/fee at
 * the top level — they live per-payIn-method inside `paymentOptions[]`. We
 * pick a method preferring BALANCE (production: user funds from their Wise
 * USD balance after a paycheck arrives), falling back through DIRECT_DEBIT
 * and BANK_TRANSFER for sandboxes / accounts without a balance.
 *
 * The user still SCA-confirms the draft in the Wise app, so the picked
 * method here is just the one we record; if the user re-picks at confirm
 * time the actual amount may shift slightly. We log the chosen method for
 * traceability.
 */
const PAY_IN_PREFERENCE = ['BALANCE', 'DIRECT_DEBIT', 'BANK_TRANSFER'];

function pickPaymentOption(options: QuotePaymentOption[]): QuotePaymentOption {
  const enabled = options.filter((o) => !o.disabled);
  if (enabled.length === 0) {
    throw new Error('Wise quote has no enabled payment options');
  }
  for (const preferred of PAY_IN_PREFERENCE) {
    const match = enabled.find((o) => o.payIn === preferred);
    if (match) {
      return match;
    }
  }
  return enabled[0];
}

function mapQuote(data: unknown): WiseQuote {
  const q = data as QuoteResponse;
  if (!q.paymentOptions || q.paymentOptions.length === 0) {
    throw new Error('Wise quote response missing paymentOptions');
  }
  const option = pickPaymentOption(q.paymentOptions);
  return {
    id: q.id,
    rate: String(q.rate),
    feeMinor: toMinor(option.fee?.total ?? 0),
    feeCurrency: option.sourceCurrency,
    sourceAmountMinor: toMinor(option.sourceAmount),
    sourceCurrency: option.sourceCurrency,
    targetAmountMinor: toMinor(option.targetAmount),
    targetCurrency: option.targetCurrency,
  };
}

type TransferResponse = {
  id: number;
  status: string;
  reference?: string | null;
  rate?: number | null;
  sourceCurrency: string;
  sourceValue?: number | null;
  targetCurrency: string;
  targetValue?: number | null;
};

function mapTransfer(data: unknown): WiseTransfer {
  const t = data as TransferResponse;
  return {
    id: t.id,
    state: t.status,
    reference: t.reference ?? null,
    rate: t.rate === null || t.rate === undefined ? null : String(t.rate),
    sourceCurrency: t.sourceCurrency,
    sourceValue: t.sourceValue ?? null,
    targetCurrency: t.targetCurrency,
    targetValue: t.targetValue ?? null,
  };
}
