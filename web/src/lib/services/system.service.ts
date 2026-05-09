import { apiGet } from '$lib/services/api';

export type SystemInfo = {
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

export const getSystemInfo = (fetchFn?: typeof fetch) =>
  apiGet<SystemInfo>('/api/system/info', { fetch: fetchFn });

export const getIntegrations = (fetchFn?: typeof fetch) =>
  apiGet<IntegrationsResponse>('/api/system/integrations', { fetch: fetchFn });
