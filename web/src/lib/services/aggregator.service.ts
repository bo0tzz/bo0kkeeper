import { apiDelete, apiGet, apiPost } from '$lib/services/api';

export type ClientClass = 'non_eu' | 'eu' | 'eu_reverse_charge' | 'domestic';

export type IncomeBucket = {
  invoiceCount: number;
  grossEurMinor: string;
  btwEurMinor: string;
};

export type AggregatorWarning =
  | { kind: 'invoice_unmatched'; count: number; sampleNumbers: string[] }
  | { kind: 'expense_pending_review'; count: number; sampleVendors: string[] }
  | { kind: 'expense_low_confidence_match'; count: number; sampleIds: string[] };

export type QuarterlyAggregateResponse = {
  year: number;
  quarter: number;
  periodStart: string;
  periodEnd: string;
  income: {
    byClass: Record<ClientClass, IncomeBucket>;
    totalGrossEurMinor: string;
    totalBtwEurMinor: string;
  };
  expenses: {
    grossEurMinor: string;
    deductibleBtwEurMinor: string;
  };
  netBtwEurMinor: string;
  warnings: AggregatorWarning[];
  closedAt: string | null;
};

export const getQuarterlyAggregate = (year: number, quarter: number, fetchFn?: typeof fetch) =>
  apiGet<QuarterlyAggregateResponse>('/api/aggregator/quarterly', {
    fetch: fetchFn,
    query: { year, quarter },
  });

export const closePeriod = (year: number, quarter: number, notes?: string, fetchFn?: typeof fetch) =>
  apiPost<{ closedAt: string }>(
    `/api/aggregator/quarterly/close?year=${year}&quarter=${quarter}`,
    { notes },
    { fetch: fetchFn },
  );

export const reopenPeriod = (year: number, quarter: number, fetchFn?: typeof fetch) =>
  apiDelete<{ reopened: true }>(`/api/aggregator/quarterly/close?year=${year}&quarter=${quarter}`, { fetch: fetchFn });
