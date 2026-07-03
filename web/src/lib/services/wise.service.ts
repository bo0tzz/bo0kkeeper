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

export type WiseTransferState =
  'incoming_payment_waiting' | 'processing' | 'funds_converted' | 'outgoing_payment_sent' | 'cancelled' | 'failed';

export type ListWiseTransfersParams = {
  state?: WiseTransferState;
  page?: number;
  limit?: number;
};

/** List-row variant: response shape + the linked-invoice fields joined from the invoice table. */
export type WiseTransferListItem = WiseTransferResponse & {
  linkedInvoiceId: string | null;
  linkedInvoiceNumber: string | null;
};

export type ListWiseTransfersResponse = {
  items: WiseTransferListItem[];
  total: number;
};

export const draftFromEvent = (eventId: string, ourReference?: string, fetchFn?: typeof fetch) =>
  apiPost<WiseTransferResponse>(`/api/wise/draft-from-event/${eventId}`, { ourReference }, { fetch: fetchFn });

export const reconcileWise = (fetchFn?: typeof fetch) =>
  apiPost<{ enqueued: true }>('/api/wise/reconcile', {}, { fetch: fetchFn });

export const listWiseTransfers = (params: ListWiseTransfersParams = {}, fetchFn?: typeof fetch) =>
  apiGet<ListWiseTransfersResponse>('/api/wise/transfers', {
    fetch: fetchFn,
    query: {
      state: params.state,
      page: params.page,
      limit: params.limit,
    },
  });
