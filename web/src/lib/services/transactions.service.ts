import { apiGet } from '$lib/services/api';

export type TransactionRow = {
  id: string;
  source: 'bank' | 'wise';
  date: string;
  amountMinor: string;
  currency: string;
  counterparty: string | null;
  type: string;
  reference: string | null;
  description: string;
  match: {
    kind: 'wise_transfer' | 'invoice' | 'expense';
    id: string;
    confidence: string | null;
  } | null;
  state: string | null;
};

export type ListTransactionsResponse = {
  items: TransactionRow[];
  total: number;
};

export type ListTransactionsParams = {
  dateFrom?: string;
  dateTo?: string;
  source?: 'bank' | 'wise';
};

export const listAllTransactions = (params: ListTransactionsParams = {}, fetchFn?: typeof fetch) =>
  apiGet<ListTransactionsResponse>('/api/transactions', {
    fetch: fetchFn,
    query: {
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      source: params.source,
    },
  });
