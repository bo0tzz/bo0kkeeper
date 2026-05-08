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

export const composeInvoice = (input: InvoiceComposeInput, fetchFn?: typeof fetch) =>
  apiPost<InvoiceComposeResponse>('/api/invoices/compose', input, { fetch: fetchFn });

export const getInvoice = (id: string, fetchFn?: typeof fetch) =>
  apiGet<InvoiceResponse>(`/api/invoices/${id}`, { fetch: fetchFn });

export const listInvoices = (fetchFn?: typeof fetch) =>
  apiGet<InvoiceListItem[]>('/api/invoices', { fetch: fetchFn });
