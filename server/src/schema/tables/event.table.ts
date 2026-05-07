import {
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  Generated,
  Index,
  PrimaryGeneratedColumn,
  Table,
  Timestamp,
} from '@immich/sql-tools';
import { ColumnType } from 'kysely';
import { EventSource, EventStatus } from 'src/enum';

/**
 * Durable, append-only log of every external event ingested by the system.
 * Every external event is keyed on `(source, externalId)` for idempotency:
 * `INSERT ... ON CONFLICT DO NOTHING` is the deduplication mechanism.
 *
 * State tables (transfers, invoices, etc.) are written only by event handlers
 * in the same transaction that flips this row's status to `processed`.
 */
@Table('event')
@Index({ name: 'event_source_externalId_unique', unique: true, columns: ['source', 'externalId'] })
@Index({ name: 'event_status_receivedAt_idx', columns: ['status', 'receivedAt'] })
@Index({ name: 'event_eventType_occurredAt_idx', columns: ['eventType', 'occurredAt'] })
@Index({ name: 'event_correlationId_idx', columns: ['correlationId'] })
export class EventTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  /** Originating system. */
  @Column({ type: 'character varying' })
  source!: EventSource;

  /** Namespaced event type (e.g. `wise.balances.credit`). */
  @Column({ type: 'text' })
  eventType!: string;

  /** External system's idempotency key. */
  @Column({ type: 'text' })
  externalId!: string;

  /** When the event happened in the external system. */
  @Column({ type: 'timestamp with time zone' })
  occurredAt!: Timestamp;

  /** When we ingested it. */
  @CreateDateColumn()
  receivedAt!: Generated<Timestamp>;

  /** Full original event body, preserved verbatim for audit and replay. */
  @Column({ type: 'jsonb' })
  payload!: ColumnType<Record<string, unknown>>;

  @Column({ type: 'character varying', default: EventStatus.Pending })
  status!: Generated<EventStatus>;

  @Column({ type: 'integer', default: 0 })
  attempts!: Generated<number>;

  /** Last failure context (message, stack, additional fields). */
  @Column({ type: 'jsonb', nullable: true })
  lastError!: ColumnType<Record<string, unknown>> | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  processedAt!: Timestamp | null;

  /** Groups events for one logical flow (e.g. all events for a single Wise transfer). */
  @Column({ type: 'uuid', nullable: true })
  correlationId!: string | null;

  /** One-step parent: the event that directly triggered this one. */
  @ForeignKeyColumn(() => EventTable, { nullable: true })
  relatedEventId!: string | null;
}
