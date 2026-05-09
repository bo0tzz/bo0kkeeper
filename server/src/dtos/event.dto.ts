import { createZodDto } from 'nestjs-zod';
import { EventSource, EventStatus } from 'src/enum';
import { Event } from 'src/repositories/event.repository';
import z from 'zod';

const ListEventsQuerySchema = z
  .object({
    source: z.enum(EventSource).optional(),
    eventType: z.string().optional(),
    status: z.enum(EventStatus).optional(),
    /** Inclusive lower bound on receivedAt. ISO date or datetime. */
    since: z.iso.datetime().or(z.iso.date()).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .meta({ id: 'ListEventsQueryDto' });
export class ListEventsQueryDto extends createZodDto(ListEventsQuerySchema) {}

const EventResponseSchema = z
  .object({
    id: z.string(),
    source: z.enum(EventSource),
    eventType: z.string(),
    externalId: z.string(),
    occurredAt: z.iso.datetime(),
    receivedAt: z.iso.datetime(),
    payload: z.record(z.string(), z.unknown()),
    status: z.enum(EventStatus),
    attempts: z.number().int(),
    lastError: z.record(z.string(), z.unknown()).nullable(),
    processedAt: z.iso.datetime().nullable(),
    correlationId: z.string().nullable(),
    relatedEventId: z.string().nullable(),
  })
  .meta({ id: 'EventResponseDto' });
export class EventResponseDto extends createZodDto(EventResponseSchema) {}

const ListEventsResponseSchema = z
  .object({
    items: z.array(EventResponseSchema),
    total: z.number().int(),
    hasMore: z.boolean(),
  })
  .meta({ id: 'ListEventsResponseDto' });
export class ListEventsResponseDto extends createZodDto(ListEventsResponseSchema) {}

export function mapEvent(event: Event): EventResponseDto {
  return {
    id: event.id,
    source: event.source,
    eventType: event.eventType,
    externalId: event.externalId,
    occurredAt: toIso(event.occurredAt),
    receivedAt: toIso(event.receivedAt),
    payload: event.payload as Record<string, unknown>,
    status: event.status,
    attempts: event.attempts,
    lastError: (event.lastError as Record<string, unknown> | null) ?? null,
    processedAt: event.processedAt ? toIso(event.processedAt) : null,
    correlationId: event.correlationId,
    relatedEventId: event.relatedEventId,
  } as EventResponseDto;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
