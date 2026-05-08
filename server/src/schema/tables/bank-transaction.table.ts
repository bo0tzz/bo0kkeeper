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
import { BankSource, BankTxCategory, MatchConfidence } from 'src/enum';
import { InvoiceTable } from 'src/schema/tables/invoice.table';
import { WiseTransferTable } from 'src/schema/tables/wise-transfer.table';

/**
 * One row per bank transaction observed (CSV import today, Enable Banking
 * later). `description` is rich — for SNS, it carries the TXN-NNNN reference
 * embedded by the Wise outgoing transfer + invoice numbers for domestic
 * client payments — so it's the primary matching signal.
 *
 * Match results: `matchedInvoiceId`, `matchedTransferId`, `matchedExpenseId`
 * are mutually exclusive in practice but stored as separate nullable FKs to
 * keep the join shape simple. `matchConfidence` distinguishes auto-high
 * (TXN reference exact match), auto-low (heuristic — amount + date + name),
 * and manual (admin UI link).
 */
@Table('bank_transaction')
@Index({ name: 'bank_transaction_source_externalId_unique', unique: true, columns: ['source', 'externalId'] })
@Index({ name: 'bank_transaction_txDate_idx', columns: ['txDate'] })
@Index({ name: 'bank_transaction_matchedTransferId_idx', columns: ['matchedTransferId'] })
@Index({ name: 'bank_transaction_matchedInvoiceId_idx', columns: ['matchedInvoiceId'] })
export class BankTransactionTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @Column({ type: 'character varying' })
  source!: BankSource;

  /** External system's stable id for the transaction. */
  @Column({ type: 'text' })
  externalId!: string;

  @Column({ type: 'date' })
  txDate!: Timestamp;

  /** Signed; positive = credit (money in), negative = debit (money out). */
  @Column({ type: 'bigint' })
  amountMinor!: ColumnType<bigint>;

  @Column({ type: 'text' })
  currency!: string;

  @Column({ type: 'text', nullable: true })
  counterpartyName!: string | null;

  @Column({ type: 'text', nullable: true })
  counterpartyIban!: string | null;

  @Column({ type: 'text' })
  description!: string;

  /** The full source row, preserved for audit. */
  @Column({ type: 'jsonb' })
  rawPayload!: ColumnType<Record<string, unknown>>;

  @ForeignKeyColumn(() => InvoiceTable, { nullable: true, onDelete: 'SET NULL' })
  matchedInvoiceId!: string | null;

  @ForeignKeyColumn(() => WiseTransferTable, { nullable: true, onDelete: 'SET NULL' })
  matchedTransferId!: string | null;

  /** Future: FK to `expense.id` once the table exists. Plain uuid for now. */
  @Column({ type: 'uuid', nullable: true })
  matchedExpenseId!: string | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  matchedAt!: Timestamp | null;

  @Column({ type: 'character varying', nullable: true })
  matchConfidence!: MatchConfidence | null;

  /**
   * Operator-set category for rows that aren't a real income/expense (tax,
   * self-transfer, fee, etc). Mutually independent from matchedAt — a row
   * can have one, the other, neither, or both. When set, the row is
   * excluded from the "unmatched" warning surface.
   */
  @Column({ type: 'character varying', nullable: true })
  category!: BankTxCategory | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}
