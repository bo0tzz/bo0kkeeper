import { apiGet, apiPost } from '$lib/services/api';

export type WiseTransferResponse = {
  id: string;
  wiseTransferId: string;
  direction: string;
  state: string;
  sourceAmountMinor: string;
  sourceCurrency: string;
  targetAmountMinor: string;
  targetCurrency: string;
  fxRate: string | null;
  feeMinor: string;
  feeCurrency: string;
  ourReference: string | null;
  correlationId: string | null;
};

export const draftFromEvent = (eventId: string, ourReference?: string, fetchFn?: typeof fetch) =>
  apiPost<WiseTransferResponse>(`/api/wise/draft-from-event/${eventId}`, { ourReference }, { fetch: fetchFn });

export const reconcileWise = (fetchFn?: typeof fetch) =>
  apiPost<{ enqueued: true }>('/api/wise/reconcile', {}, { fetch: fetchFn });

export const listWiseTransfers = (fetchFn?: typeof fetch) =>
  apiGet<WiseTransferResponse[]>('/api/wise/transfers', { fetch: fetchFn });
