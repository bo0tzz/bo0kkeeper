import { apiDelete, apiGet, apiPost, apiPut } from '$lib/services/api';

export type BankingAccount = {
  uid: string;
  iban: string | null;
  currency: string;
  name: string | null;
  product: string | null;
  balance: {
    amountMinor: string;
    currency: string;
    asOf: string;
  } | null;
  expectedBalanceMinor: string | null;
  balanceDiscrepancyMinor: string | null;
};

export type BankingSession = {
  id: string;
  status: string;
  aspspName: string;
  aspspCountry: string;
  psuType: string;
  expiresAt: string | null;
  lastSyncedAt: string | null;
  accounts: BankingAccount[];
  createdAt: string;
};

export type StartAuthRequest = {
  aspspName?: string;
  aspspCountry?: string;
  psuType?: 'personal' | 'business';
};

export type StartAuthResponse = {
  sessionId: string;
  redirectUrl: string;
};

export const getLatestBankingSession = (fetchFn?: typeof fetch) =>
  apiGet<BankingSession | null>('/api/banking/session', { fetch: fetchFn });

export const startBankingAuth = (body: StartAuthRequest = {}, fetchFn?: typeof fetch) =>
  apiPost<StartAuthResponse>('/api/banking/auth/start', body, { fetch: fetchFn });

export const syncBankingNow = (fetchFn?: typeof fetch) =>
  apiPost<{ enqueued: true }>('/api/banking/sync', {}, { fetch: fetchFn });

export type BankTxCategory = 'tax' | 'drawings' | 'self_transfer' | 'fee' | 'ignored';

export type BankTransaction = {
  id: string;
  source: string;
  externalId: string;
  txDate: string;
  amountMinor: string;
  currency: string;
  counterpartyName: string | null;
  counterpartyIban: string | null;
  description: string;
  matchedTransferId: string | null;
  matchedInvoiceId: string | null;
  matchedExpenseId: string | null;
  matchedAt: string | null;
  matchConfidence: string | null;
  category: BankTxCategory | null;
};

export type BankTxStatusFilter = 'matched' | 'categorized' | 'unmatched';

export type ListBankTransactionsParams = {
  dateFrom?: string;
  dateTo?: string;
  status?: BankTxStatusFilter;
  page?: number;
  limit?: number;
};

export type ListBankTransactionsResponse = {
  items: BankTransaction[];
  total: number;
};

export const listBankTransactions = (params: ListBankTransactionsParams = {}, fetchFn?: typeof fetch) =>
  apiGet<ListBankTransactionsResponse>('/api/banking/transactions', {
    fetch: fetchFn,
    query: {
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      status: params.status,
      page: params.page,
      limit: params.limit,
    },
  });

export type TransferCandidate = {
  id: string;
  wiseTransferId: string;
  ourReference: string | null;
  state: string;
  sourceCurrency: string;
  sourceAmountMinor: string;
  targetCurrency: string;
  targetAmountMinor: string;
  createdAt: string;
};
export type InvoiceCandidate = {
  id: string;
  number: string;
  totalMinor: string;
  currency: string;
  issuedAt: string;
  clientName: string | null;
};
export type ExpenseCandidate = {
  id: string;
  vendor: string;
  amountMinor: string;
  currency: string;
  expenseDate: string;
  status: string;
};
export type MatchCandidates = {
  transfers: TransferCandidate[];
  invoices: InvoiceCandidate[];
  expenses: ExpenseCandidate[];
};

export const listMatchCandidates = (q: string, fetchFn?: typeof fetch) =>
  apiGet<MatchCandidates>('/api/banking/match-candidates', {
    fetch: fetchFn,
    query: q ? { q } : undefined,
  });

export const setBankTxMatch = (
  bankTxId: string,
  body: { type: 'wise_transfer' | 'invoice' | 'expense'; targetId: string },
  fetchFn?: typeof fetch,
) => apiPut<BankTransaction>(`/api/banking/transactions/${bankTxId}/match`, body, { fetch: fetchFn });

export const clearBankTxMatch = (bankTxId: string, fetchFn?: typeof fetch) =>
  apiDelete<BankTransaction>(`/api/banking/transactions/${bankTxId}/match`, { fetch: fetchFn });

export const setBankTxCategory = (bankTxId: string, category: BankTxCategory | null, fetchFn?: typeof fetch) =>
  apiPut<BankTransaction>(`/api/banking/transactions/${bankTxId}/category`, { category }, { fetch: fetchFn });
