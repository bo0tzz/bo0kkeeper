import { apiGet, apiPost } from '$lib/services/api';

export type BankingAccount = {
  uid: string;
  iban: string | null;
  currency: string;
  name: string | null;
  product: string | null;
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
};

export const listBankTransactions = (fetchFn?: typeof fetch) =>
  apiGet<BankTransaction[]>('/api/banking/transactions', { fetch: fetchFn });
