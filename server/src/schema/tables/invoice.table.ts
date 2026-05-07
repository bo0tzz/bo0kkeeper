import {
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  Generated,
  Index,
  PrimaryGeneratedColumn,
  Table,
  Timestamp,
  UpdateDateColumn,
} from '@immich/sql-tools';
import { ColumnType } from 'kysely';
import { ClientTable } from 'src/schema/tables/client.table';
import { EventTable } from 'src/schema/tables/event.table';

/**
 * One row per issued invoice. Multi-line invoices have rows in `invoice_line`
 * referencing `invoice.id`.
 *
 * - `number` is `YYYY/NNN`, gap-free per Belastingdienst rules.
 * - `currency` + `totalMinor` are the invoice's primary money. For Non-EU
 *   bilingual invoices, `eurTotalMinor` + `fxRate` capture the EUR equivalent
 *   at the rate that landed.
 * - `btwRateBps` stored as basis points (2100 = 21.00%) for exact arithmetic.
 *   Null for `non_eu` clients (outside scope of EU VAT).
 */
@Table('invoice')
@Index({ name: 'invoice_clientId_idx', columns: ['clientId'] })
@Index({ name: 'invoice_issuedAt_idx', columns: ['issuedAt'] })
export class InvoiceTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @Column({ type: 'text', unique: true })
  number!: string;

  @ForeignKeyColumn(() => ClientTable, { onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  clientId!: string;

  @Column({ type: 'date' })
  issuedAt!: Timestamp;

  @Column({ type: 'date', nullable: true })
  periodStart!: Timestamp | null;

  @Column({ type: 'date', nullable: true })
  periodEnd!: Timestamp | null;

  @Column({ type: 'text' })
  currency!: string;

  @Column({ type: 'bigint' })
  totalMinor!: ColumnType<bigint>;

  /** EUR equivalent for non-EUR invoices, recorded at the FX rate that landed. */
  @Column({ type: 'bigint', nullable: true })
  eurTotalMinor!: ColumnType<bigint> | null;

  /** Decimal-string FX rate (Wise locks 6 decimals); null for EUR-native invoices. */
  @Column({ type: 'text', nullable: true })
  fxRate!: string | null;

  /** Basis points: 2100 = 21.00%. Null for `non_eu` (outside scope of EU VAT). */
  @Column({ type: 'integer', nullable: true })
  btwRateBps!: number | null;

  @Column({ type: 'bigint', nullable: true })
  btwMinor!: ColumnType<bigint> | null;

  /** Reference into paperless-ngx (the document id of the rendered PDF). */
  @Column({ type: 'text', nullable: true })
  paperlessDocId!: string | null;

  /** Wise transfer event that triggered this invoice (for Wise income flow). */
  @ForeignKeyColumn(() => EventTable, { nullable: true, onDelete: 'SET NULL' })
  sourceEventId!: string | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}
