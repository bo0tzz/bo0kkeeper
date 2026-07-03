import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, Selectable, Updateable } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { randomUUID } from 'node:crypto';
import { EventSource, EventStatus } from 'src/enum';
import { DB } from 'src/schema';
import { EventTable } from 'src/schema/tables/event.table';

export type Event = Selectable<EventTable>;
export type NewEvent = Insertable<EventTable>;
export type EventUpdate = Updateable<EventTable>;

export type IngestResult = { ingested: true; event: Event } | { ingested: false; existingId: string };

@Injectable()
export class EventRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /**
   * Insert an event row idempotently keyed on `(source, externalId)`.
   * Returns `{ ingested: true }` on first sight, `{ ingested: false }` on duplicate.
   */
  async ingest(event: NewEvent): Promise<IngestResult> {
    const inserted = await this.db
      .insertInto('event')
      .values(event)
      .onConflict((oc) => oc.columns(['source', 'externalId']).doNothing())
      .returningAll()
      .executeTakeFirst();

    if (inserted) {
      return { ingested: true, event: inserted as Event };
    }

    const existing = await this.db
      .selectFrom('event')
      .select('id')
      .where('source', '=', event.source)
      .where('externalId', '=', event.externalId as string)
      .executeTakeFirstOrThrow();

    return { ingested: false, existingId: existing.id };
  }

  findById(id: string): Promise<Event | undefined> {
    return this.db.selectFrom('event').selectAll().where('id', '=', id).executeTakeFirst();
  }

  /**
   * Record an internal action (manual user click or scheduled system run) as
   * an event row, marked processed at write time — these don't go through the
   * worker pipeline, they're audit-trail entries. `externalId` defaults to a
   * fresh UUID since there's no upstream system to dedup against.
   */
  async recordAction(input: {
    source: EventSource.Manual | EventSource.System;
    eventType: string;
    payload: Record<string, unknown>;
    correlationId?: string;
  }): Promise<Event> {
    const externalId = randomUUID();
    const now = new Date();
    return this.db
      .insertInto('event')
      .values({
        source: input.source,
        eventType: input.eventType,
        externalId,
        occurredAt: now,
        payload: input.payload,
        correlationId: input.correlationId ?? null,
        status: EventStatus.Processed,
        processedAt: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow() as Promise<Event>;
  }

  /** Pending events, oldest first. Worker pulls from this stream. */
  findPending(limit = 50): Promise<Event[]> {
    return this.db
      .selectFrom('event')
      .selectAll()
      .where('status', '=', EventStatus.Pending)
      .orderBy('receivedAt', 'asc')
      .limit(limit)
      .execute();
  }

  markProcessing(id: string): Promise<unknown> {
    return this.db
      .updateTable('event')
      .set({ status: EventStatus.Processing })
      .where('id', '=', id)
      .where('status', '=', EventStatus.Pending)
      .execute();
  }

  markProcessed(id: string): Promise<unknown> {
    return this.db
      .updateTable('event')
      .set({ status: EventStatus.Processed, processedAt: new Date() })
      .where('id', '=', id)
      .execute();
  }

  /**
   * Drop an event out of the pending inbox without processing it. Used for
   * cases where the event is a real signal (so we don't want to delete it)
   * but there's no action to take — e.g. a Wise `balances#credit` for an
   * amount below Wise's minimum transfer threshold, which naturally waits
   * to be swept into the next larger transfer.
   */
  markSkipped(id: string): Promise<unknown> {
    return this.db
      .updateTable('event')
      .set({ status: EventStatus.Skipped, processedAt: new Date() })
      .where('id', '=', id)
      .execute();
  }

  markFailed(id: string, error: Record<string, unknown>): Promise<unknown> {
    return this.db
      .updateTable('event')
      .set((eb) => ({
        status: EventStatus.Failed,
        attempts: eb('attempts', '+', 1),
        lastError: error,
      }))
      .where('id', '=', id)
      .execute();
  }

  /**
   * Paginated list with optional filters. Used by the admin event-log browser.
   * Newest events first.
   */
  async findMany(filter: EventListFilter): Promise<EventListPage> {
    const baseQuery = this.db
      .selectFrom('event')
      .$if(!!filter.source, (qb) => qb.where('source', '=', filter.source!))
      .$if(!!filter.eventType, (qb) => qb.where('eventType', '=', filter.eventType!))
      .$if(!!filter.status, (qb) => qb.where('status', '=', filter.status!))
      .$if(!!filter.since, (qb) => qb.where('receivedAt', '>=', new Date(filter.since!)));

    const [items, totalRow] = await Promise.all([
      baseQuery.selectAll().orderBy('receivedAt', 'desc').limit(filter.limit).offset(filter.offset).execute(),
      baseQuery.select((eb) => eb.fn.countAll().as('total')).executeTakeFirstOrThrow(),
    ]);

    const total = Number(totalRow.total);
    return {
      items: items as Event[],
      total,
      hasMore: filter.offset + items.length < total,
    };
  }
}

export type EventListFilter = {
  source?: import('src/enum').EventSource;
  eventType?: string;
  status?: import('src/enum').EventStatus;
  /** Inclusive lower bound on receivedAt. ISO date or datetime. */
  since?: string;
  limit: number;
  offset: number;
};

export type EventListPage = {
  items: Event[];
  total: number;
  hasMore: boolean;
};
