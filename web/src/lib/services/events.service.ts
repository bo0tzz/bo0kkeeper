import { apiGet, apiPost } from '$lib/services/api';

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
  /** Inclusive lower bound on receivedAt; ISO date or datetime. */
  since?: string;
  limit?: number;
  offset?: number;
};

export const listEvents = (query: ListEventsQuery, fetchFn?: typeof fetch) =>
  apiGet<ListEventsResponse>('/api/events', { fetch: fetchFn, query });

/**
 * Drop an event out of the pending inbox without acting on it. Use this
 * for Wise credits that sit below the transfer minimum (they'll get swept
 * into the next larger transfer once the balance accrues).
 */
export const dismissEvent = (eventId: string, fetchFn?: typeof fetch) =>
  apiPost<EventResponse>(`/api/events/${eventId}/dismiss`, {}, { fetch: fetchFn });
