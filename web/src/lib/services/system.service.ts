import { apiGet, apiPost } from '$lib/services/api';

export type SystemInfo = {
  version: string;
  cutoverDate: string | null;
  ingestionEnabled: boolean;
};

export type IntegrationStatus = 'healthy' | 'degraded' | 'broken' | 'not_configured';

export type IntegrationCheck = {
  id: string;
  name: string;
  status: IntegrationStatus;
  configured: boolean;
  lastActivityAt: string | null;
  message: string;
};

export type IntegrationsResponse = {
  checks: IntegrationCheck[];
};

export const getSystemInfo = (fetchFn?: typeof fetch) => apiGet<SystemInfo>('/api/system/info', { fetch: fetchFn });

export const getIntegrations = (fetchFn?: typeof fetch) =>
  apiGet<IntegrationsResponse>('/api/system/integrations', { fetch: fetchFn });

/**
 * Trigger an immediate sheet-write retry — re-attempts any matched
 * bank_tx / approved expense whose sheet row failed to land. Same job
 * that runs hourly on cron; this is the "do it now" path.
 */
export const retrySheetWrites = (fetchFn?: typeof fetch) =>
  apiPost<{ enqueued: true }>('/api/system/retry-sheet-writes', {}, { fetch: fetchFn });

export type SheetWriteStatus = {
  staleCount: number;
};

/**
 * Current sheet-write health — how many entities should have a sheet row
 * but don't (and have been waiting past the retry healing window).
 */
export const getSheetWriteStatus = (fetchFn?: typeof fetch) =>
  apiGet<SheetWriteStatus>('/api/system/sheet-write-status', { fetch: fetchFn });
