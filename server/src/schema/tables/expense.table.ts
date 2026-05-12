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
import { ExpenseLocationClass, ExpenseStatus } from 'src/enum';
import { EventTable } from 'src/schema/tables/event.table';

/**
 * Receipt/expense row — one per paperless document we want to record as a
 * bookkeeping expense. Created in `pending_review` state from the paperless
 * post-consume webhook with OCR-extracted fields; user edits + approves in
 * the admin UI (status → `approved`), at which point the sheet row is
 * appended.
 */
@Table('expense')
@Index({ name: 'expense_paperlessDocId_idx', columns: ['paperlessDocId'] })
@Index({ name: 'expense_status_idx', columns: ['status'] })
@Index({ name: 'expense_expenseDate_idx', columns: ['expenseDate'] })
export class ExpenseTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  /** Paperless-ngx document id. */
  @Column({ type: 'text', unique: true })
  paperlessDocId!: string;

  @Column({ type: 'text' })
  vendor!: string;

  @Column({ type: 'date' })
  expenseDate!: Timestamp;

  @Column({ type: 'bigint' })
  amountMinor!: ColumnType<bigint>;

  @Column({ type: 'text' })
  currency!: string;

  /** BTW rate in basis points (2100 = 21.00%). Null when no BTW applies. */
  @Column({ type: 'integer', nullable: true })
  btwRateBps!: number | null;

  @Column({ type: 'bigint', nullable: true })
  btwMinor!: ColumnType<bigint> | null;

  @Column({ type: 'character varying' })
  locationClass!: ExpenseLocationClass;

  /** Free-text category that maps to a BTW rubriek in the quarterly aggregator. */
  @Column({ type: 'text', default: '' })
  category!: Generated<string>;

  @Column({ type: 'character varying', default: ExpenseStatus.PendingReview })
  status!: Generated<ExpenseStatus>;

  @Column({ type: 'timestamp with time zone', nullable: true })
  reviewedAt!: Timestamp | null;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @ForeignKeyColumn(() => EventTable, { nullable: true, onDelete: 'SET NULL' })
  sourceEventId!: string | null;

  /**
   * When a sheet expense row was successfully written for this expense.
   * Null = no row yet (either no bank-tx is matched yet, or the write
   * failed and is awaiting retry). The retry job re-attempts any approved
   * + bank-tx-matched expense with this still null.
   */
  @Column({ type: 'timestamp with time zone', nullable: true })
  sheetRowAt!: Timestamp | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}
