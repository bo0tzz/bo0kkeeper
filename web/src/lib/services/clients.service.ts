import { apiGet } from '$lib/services/api';

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
  defaultInvoiceTemplate: string;
  createdAt: string;
  updatedAt: string;
};

export const listClients = (fetchFn?: typeof fetch) => apiGet<ClientResponse[]>('/api/clients', { fetch: fetchFn });
