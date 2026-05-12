import { apiGet, apiPatch, apiPost } from '$lib/services/api';

export type SettingsResponse = {
  issuer: {
    kvk: string;
    vatId: string;
    addressLine1: string;
    postalCode: string;
    city: string;
    country: string;
    iban: string;
  };
  paperless: {
    expenseTags: string[];
    outgoingInvoiceTags: string[];
  };
  updatedAt: string;
};

export type UpdateSettingsBody = {
  issuer?: Partial<SettingsResponse['issuer']>;
  paperless?: Partial<SettingsResponse['paperless']>;
};

export const getSettings = (fetchFn?: typeof fetch) => apiGet<SettingsResponse>('/api/settings', { fetch: fetchFn });

export const updateSettings = (body: UpdateSettingsBody, fetchFn?: typeof fetch) =>
  apiPatch<SettingsResponse>('/api/settings', body, { fetch: fetchFn });

export type PaperlessTagCheckResult = {
  name: string;
  exists: boolean;
  id: number | null;
};

export type PaperlessTagCheckResponse = {
  results: PaperlessTagCheckResult[];
};

export const checkPaperlessTags = (tags: string[], fetchFn?: typeof fetch) =>
  apiPost<PaperlessTagCheckResponse>('/api/settings/paperless/tag-check', { tags }, { fetch: fetchFn });
