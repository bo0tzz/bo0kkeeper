import {
  Column,
  CreateDateColumn,
  Generated,
  Index,
  PrimaryGeneratedColumn,
  Table,
  Timestamp,
  UpdateDateColumn,
} from '@immich/sql-tools';
import { ColumnType } from 'kysely';
import { WiseTransferDirection, WiseTransferState } from 'src/enum';

/**
 * State table for Wise transfers (both inbound credits and outbound USD→EUR sends).
 * Written by event handlers reacting to `wise.transfers.state-change` events.
 *
 * `wiseTransferId` is Wise's own id (e.g. `TRANSFER-2118358826`). `ourReference`
 * is the user-set reference we put on outbound transfers (`TXN-NNNN`), which the
 * bank statement preserves and lets us match payments to transfers exactly.
 */
@Table('wise_transfer')
@Index({ name: 'wise_transfer_state_idx', columns: ['state'] })
@Index({ name: 'wise_transfer_correlationId_idx', columns: ['correlationId'] })
export class WiseTransferTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @Column({ type: 'text', unique: true })
  wiseTransferId!: string;

  @Column({ type: 'character varying' })
  direction!: WiseTransferDirection;

  @Column({ type: 'bigint' })
  sourceAmountMinor!: ColumnType<bigint>;

  @Column({ type: 'text' })
  sourceCurrency!: string;

  /**
   * The original credit amount from the balance-credit event that spawned
   * this transfer, in `sourceCurrency`. Equals `sourceAmountMinor` under
   * a full-balance sweep (nothing was drawn from the pool), and is strictly
   * greater than `sourceAmountMinor` when the sweep ran with
   * `allowUnderCredit=true` because part of the balance was already spent
   * (Wise card charge, direct send, etc.).
   *
   * Invoice compose uses this — not `sourceAmountMinor` — as the invoice
   * total. Otherwise the composed invoice would under-report the amount
   * the client actually paid by the amount that leaked to Wise-flow
   * expenses. Null on historical outbound rows (pre-this-change) and on
   * inbound rows (where there's no notion of a "credit pool").
   */
  @Column({ type: 'bigint', nullable: true })
  originalCreditMinor!: ColumnType<bigint> | null;

  @Column({ type: 'bigint' })
  targetAmountMinor!: ColumnType<bigint>;

  @Column({ type: 'text' })
  targetCurrency!: string;

  /**
   * Locked-in FX rate from Wise, stored as a decimal string for exact precision.
   * Wise returns rates with up to ~6 fractional digits; we never do arithmetic on
   * this value, only display/record. Null for same-currency transfers.
   */
  @Column({ type: 'text', nullable: true })
  fxRate!: string | null;

  @Column({ type: 'bigint', default: 0 })
  feeMinor!: Generated<ColumnType<bigint>>;

  @Column({ type: 'text', default: '' })
  feeCurrency!: Generated<string>;

  @Column({ type: 'character varying' })
  state!: WiseTransferState;

  @Column({ type: 'timestamp with time zone' })
  stateUpdatedAt!: Timestamp;

  /** Our `TXN-NNNN` reference on outbound transfers; null for inbound. */
  @Column({ type: 'text', nullable: true })
  ourReference!: string | null;

  /** Counterparty name as Wise reports it (e.g. payroll provider on inbound). */
  @Column({ type: 'text', nullable: true })
  counterpartyName!: string | null;

  /** Groups events for one logical flow — same value as `event.correlationId`. */
  @Column({ type: 'uuid', nullable: true })
  correlationId!: string | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}
