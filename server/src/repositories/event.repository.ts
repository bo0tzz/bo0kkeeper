import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, Selectable, Updateable } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { EventStatus } from 'src/enum';
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
      .$if(!!filter.status, (qb) => qb.where('status', '=', filter.status!));

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
  limit: number;
  offset: number;
};

export type EventListPage = {
  items: Event[];
  total: number;
  hasMore: boolean;
};
