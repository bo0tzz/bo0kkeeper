import { apiGet, apiPatch, apiPost } from '$lib/services/api';

export type ClientClass = 'non_eu' | 'eu' | 'eu_reverse_charge' | 'domestic';
export type TradeName = 'it_services' | '3d';

export type ClientResponse = {
  id: string;
  name: string;
  class: ClientClass;
  tradeName: TradeName;
  address: Record<string, unknown>;
  vatId: string | null;
  wiseSenderPattern: string | null;
  defaultDescription: string;
  createdAt: string;
  updatedAt: string;
};

export type ClientCreateInput = {
  name: string;
  class: ClientClass;
  tradeName: TradeName;
  address?: Record<string, unknown>;
  vatId?: string;
  wiseSenderPattern?: string;
  defaultDescription?: string;
};

export type ClientPatch = Partial<ClientCreateInput>;

export const listClients = (fetchFn?: typeof fetch) => apiGet<ClientResponse[]>('/api/clients', { fetch: fetchFn });

export const getClient = (id: string, fetchFn?: typeof fetch) =>
  apiGet<ClientResponse>(`/api/clients/${id}`, { fetch: fetchFn });

export const createClient = (input: ClientCreateInput, fetchFn?: typeof fetch) =>
  apiPost<ClientResponse>('/api/clients', input, { fetch: fetchFn });

export const updateClient = (id: string, patch: ClientPatch, fetchFn?: typeof fetch) =>
  apiPatch<ClientResponse>(`/api/clients/${id}`, patch, { fetch: fetchFn });
