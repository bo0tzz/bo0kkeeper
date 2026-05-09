import { apiGet, apiPatch, apiPost } from '$lib/services/api';

export type ExpenseStatus = 'pending_review' | 'approved' | 'rejected';
export type ExpenseLocationClass = 'domestic' | 'eu' | 'eu_reverse_charge' | 'non_eu';

export type ExpenseResponse = {
  id: string;
  paperlessDocId: string;
  vendor: string;
  expenseDate: string;
  amountMinor: string;
  currency: string;
  btwRateBps: number | null;
  btwMinor: string | null;
  locationClass: ExpenseLocationClass;
  category: string;
  status: ExpenseStatus;
  reviewedAt: string | null;
  notes: string | null;
  sourceEventId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ListExpensesResponse = {
  items: ExpenseResponse[];
  total: number;
  hasMore: boolean;
};

export type ListExpensesQuery = {
  status?: ExpenseStatus;
  locationClass?: ExpenseLocationClass;
  /** YYYY-MM-DD */
  from?: string;
  /** YYYY-MM-DD */
  to?: string;
  limit?: number;
  offset?: number;
};

export type ExpensePatch = {
  vendor?: string;
  /** YYYY-MM-DD */
  expenseDate?: string;
  amountMinor?: string | number;
  currency?: string;
  btwRateBps?: number | null;
  btwMinor?: string | number | null;
  locationClass?: ExpenseLocationClass;
  category?: string;
  notes?: string | null;
};

export const listExpenses = (query: ListExpensesQuery, fetchFn?: typeof fetch) =>
  apiGet<ListExpensesResponse>('/api/expenses', { fetch: fetchFn, query });

export const updateExpense = (id: string, patch: ExpensePatch, fetchFn?: typeof fetch) =>
  apiPatch<ExpenseResponse>(`/api/expenses/${id}`, patch, { fetch: fetchFn });

export const approveExpense = (id: string, patch: ExpensePatch = {}, fetchFn?: typeof fetch) =>
  apiPost<ExpenseResponse>(`/api/expenses/${id}/approve`, patch, { fetch: fetchFn });

export const rejectExpense = (id: string, notes?: string, fetchFn?: typeof fetch) =>
  apiPost<ExpenseResponse>(`/api/expenses/${id}/reject`, { notes }, { fetch: fetchFn });

export type RescanPaperlessResponse = {
  scanned: number;
  enqueued: number;
  alreadyIngested: number;
  droppedBeforeCutover: number;
};

export const rescanPaperless = (fetchFn?: typeof fetch) =>
  apiPost<RescanPaperlessResponse>('/api/expenses/rescan-paperless', {}, { fetch: fetchFn });
