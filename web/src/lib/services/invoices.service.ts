import { apiGet, apiPost } from '$lib/services/api';

export type InvoiceLineInput = {
  description: string;
  unitLabel?: string;
  quantity?: string;
  /** Major-unit decimal currency string (UI input). Coerced server-side. */
  lineTotalMinor: string;
};

export type InvoiceComposeInput = {
  clientId: string;
  /** YYYY-MM-DD */
  issuedAt: string;
  /** YYYY-MM-DD */
  periodStart?: string;
  /** YYYY-MM-DD */
  periodEnd?: string;
  currency: string;
  eurTotalMinor?: string;
  fxRate?: string;
  btwRateBps?: number;
  sourceEventId?: string;
  lines: InvoiceLineInput[];
};

export type InvoiceLineResponse = {
  id: string;
  ordinal: number;
  description: string;
  unitLabel: string | null;
  quantity: string | null;
  lineTotalMinor: string;
};

export type InvoiceResponse = {
  id: string;
  number: string;
  clientId: string;
  issuedAt: string;
  periodStart: string | null;
  periodEnd: string | null;
  currency: string;
  totalMinor: string;
  eurTotalMinor: string | null;
  fxRate: string | null;
  btwRateBps: number | null;
  btwMinor: string | null;
  paperlessDocId: string | null;
  sourceEventId: string | null;
  createdAt: string;
  updatedAt: string;
  lines: InvoiceLineResponse[];
};

export type InvoiceComposeResponse = {
  invoice: InvoiceResponse;
};

export type InvoiceListItem = {
  id: string;
  number: string;
  issuedAt: string;
  clientId: string;
  clientName: string | null;
  currency: string;
  totalMinor: string;
  eurTotalMinor: string | null;
  btwRateBps: number | null;
  btwMinor: string | null;
  paperlessDocId: string | null;
  paid: boolean;
};

export type ListInvoicesParams = {
  year?: number;
  status?: 'open' | 'paid';
  page?: number;
  limit?: number;
};

export type ListInvoicesResponse = {
  items: InvoiceListItem[];
  total: number;
};

export const composeInvoice = (input: InvoiceComposeInput, fetchFn?: typeof fetch) =>
  apiPost<InvoiceComposeResponse>('/api/invoices/compose', input, { fetch: fetchFn });

export type WiseInvoicePrefill = {
  wiseTransferId: string;
  currency: string;
  /** Source currency total in minor units (e.g. USD cents). */
  totalMinor: string;
  /** EUR amount that actually arrived at SNS — net of Wise fees/spread. */
  eurTotalMinor: string;
  /** Our TXN-NNNN reference; surfaced as a small hint in the compose UI. */
  ourReference: string | null;
  /** Sole Non-EU client id if exactly one exists; null when operator must pick. */
  suggestedClientId: string | null;
  /** YYYY-MM-DD; null when no suggested client. */
  suggestedPeriodStart: string | null;
  suggestedPeriodEnd: string | null;
  /**
   * client.defaultDescription with any `{period.*}` placeholders substituted
   * using the suggested period. Empty string when there's no suggested client.
   */
  suggestedLineDescription: string;
};

export type InvoiceComposeFromWiseInput = {
  clientId: string;
  /** YYYY-MM-DD */
  issuedAt: string;
  /** YYYY-MM-DD */
  periodStart?: string;
  /** YYYY-MM-DD */
  periodEnd?: string;
  lines: InvoiceLineInput[];
};

export const getWiseInvoicePrefill = (wiseTransferId: string, fetchFn?: typeof fetch) =>
  apiGet<WiseInvoicePrefill>(`/api/invoices/wise-prefill/${wiseTransferId}`, { fetch: fetchFn });

export const composeInvoiceFromWise = (
  wiseTransferId: string,
  input: InvoiceComposeFromWiseInput,
  fetchFn?: typeof fetch,
) => apiPost<InvoiceComposeResponse>(`/api/invoices/compose-from-wise/${wiseTransferId}`, input, { fetch: fetchFn });

export const listInvoices = (params: ListInvoicesParams = {}, fetchFn?: typeof fetch) =>
  apiGet<ListInvoicesResponse>('/api/invoices', {
    fetch: fetchFn,
    query: {
      year: params.year,
      status: params.status,
      page: params.page,
      limit: params.limit,
    },
  });
