import { apiGet } from '$lib/services/api';

export type EventSource = 'wise' | 'paperless' | 'bank' | 'manual' | 'system';
export type EventStatus = 'pending' | 'processing' | 'processed' | 'failed' | 'skipped';

export type EventResponse = {
  id: string;
  source: EventSource;
  eventType: string;
  externalId: string;
  occurredAt: string;
  receivedAt: string;
  payload: Record<string, unknown>;
  status: EventStatus;
  attempts: number;
  lastError: Record<string, unknown> | null;
  processedAt: string | null;
  correlationId: string | null;
  relatedEventId: string | null;
};

export type ListEventsResponse = {
  items: EventResponse[];
  total: number;
  hasMore: boolean;
};

export type ListEventsQuery = {
  source?: EventSource;
  eventType?: string;
  status?: EventStatus;
  limit?: number;
  offset?: number;
};

export const listEvents = (query: ListEventsQuery, fetchFn?: typeof fetch) =>
  apiGet<ListEventsResponse>('/api/events', { fetch: fetchFn, query });

export const getEvent = (id: string, fetchFn?: typeof fetch) =>
  apiGet<EventResponse>(`/api/events/${id}`, { fetch: fetchFn });
