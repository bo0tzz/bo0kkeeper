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
import { WiseTransferTable } from 'src/schema/tables/wise-transfer.table';

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
@Index({ name: 'expense_wiseTransferId_idx', columns: ['wiseTransferId'] })
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

  /**
   * Foreign-currency expenses paid from a Wise pool link here to the sweep
   * that converted (or will convert) that pool. Presence of this FK marks
   * the expense as Wise-flow — the EUR amount is booked at the sweep's
   * fxRate when the sweep clears, mirroring how invoice.wiseTransferId
   * booked income at sweep rate. Null for EUR-native expenses (the common
   * case) and for legacy foreign-currency rows without a Wise link.
   */
  @ForeignKeyColumn(() => WiseTransferTable, { nullable: true, onDelete: 'SET NULL' })
  wiseTransferId!: string | null;

  /**
   * EUR-booked amount for foreign-currency expenses, filled in at sweep
   * clear (from `amountMinor × wise_transfer.fxRate`). Null while the
   * sweep is still open or when currency = EUR (`amountMinor` is the
   * EUR figure directly in that case).
   */
  @Column({ type: 'bigint', nullable: true })
  eurAmountMinor!: ColumnType<bigint> | null;

  /**
   * The sweep's effective fxRate used to compute `eurAmountMinor`. Stored
   * as a string like the other fxRate columns (invoice.fxRate,
   * wise_transfer.fxRate) to preserve exact decimal representation.
   * Populated together with `eurAmountMinor` at sweep clear.
   */
  @Column({ type: 'text', nullable: true })
  fxRate!: string | null;

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
