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
import { BankTransactionTable } from 'src/schema/tables/bank-transaction.table';
import { EventTable } from 'src/schema/tables/event.table';

/**
 * Receipt/expense row. Two source flavours:
 *
 * - Paperless-document expenses (the common case): created in `pending_review`
 *   state from the post-consume webhook with OCR-extracted fields, user edits +
 *   approves in the admin UI, sheet row is appended on approval+bank-tx-match.
 * - Bank-fee expenses (e.g. SNS klantonderzoek 21% BTW): auto-created in
 *   `approved` state by the bank-tx matcher when a recurring-fee rule matches
 *   AND the BTW amount can be parsed from the bank-tx description. There is
 *   no Paperless document — the bank statement line itself is the
 *   *vereenvoudigde factuur* per Art. 35a Wet OB.
 *
 * Exactly one of `paperlessDocId` / `sourceBankTxId` is set (CHECK constraint
 * enforces non-null on at least one; in practice they're mutually exclusive
 * by source).
 */
@Table('expense')
@Index({ name: 'expense_paperlessDocId_idx', columns: ['paperlessDocId'] })
@Index({ name: 'expense_sourceBankTxId_idx', columns: ['sourceBankTxId'] })
@Index({ name: 'expense_status_idx', columns: ['status'] })
@Index({ name: 'expense_expenseDate_idx', columns: ['expenseDate'] })
export class ExpenseTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  /** Paperless-ngx document id. Null for bank-fee expenses. */
  @Column({ type: 'text', unique: true, nullable: true })
  paperlessDocId!: string | null;

  /**
   * Source bank-tx id for auto-created fee expenses (SNS klantonderzoek etc.).
   * Null for Paperless-document expenses. One fee-expense per bank-tx by
   * construction — uniqueness is enforced at the DB level.
   */
  @ForeignKeyColumn(() => BankTransactionTable, { nullable: true, unique: true, onDelete: 'SET NULL' })
  sourceBankTxId!: string | null;

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
