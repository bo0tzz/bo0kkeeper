import { apiGet } from '$lib/services/api';

export type SystemInfo = {
  cutoverDate: string | null;
  ingestionEnabled: boolean;
};

export const getSystemInfo = (fetchFn?: typeof fetch) =>
  apiGet<SystemInfo>('/api/system/info', { fetch: fetchFn });
