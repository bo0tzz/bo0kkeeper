import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, Selectable, sql, Updateable } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { WiseTransferState } from 'src/enum';
import { DB } from 'src/schema';
import { WiseTransferTable } from 'src/schema/tables/wise-transfer.table';

export type WiseTransferRow = Selectable<WiseTransferTable>;
export type NewWiseTransfer = Insertable<WiseTransferTable>;
export type WiseTransferUpdate = Updateable<WiseTransferTable>;

/**
 * States we treat as terminal — no more state transitions expected, no need
 * to poll Wise for updates. Anything else is fair game for the reconcile job.
 */
const TERMINAL_STATES: WiseTransferState[] = [
  WiseTransferState.OutgoingPaymentSent,
  WiseTransferState.Cancelled,
  WiseTransferState.Failed,
];

@Injectable()
export class WiseTransferRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  async create(data: NewWiseTransfer): Promise<WiseTransferRow> {
    const inserted = await this.db.insertInto('wise_transfer').values(data).returningAll().executeTakeFirstOrThrow();
    return inserted as WiseTransferRow;
  }

  findByWiseTransferId(wiseTransferId: string): Promise<WiseTransferRow | undefined> {
    return this.db
      .selectFrom('wise_transfer')
      .selectAll()
      .where('wiseTransferId', '=', wiseTransferId)
      .executeTakeFirst() as Promise<WiseTransferRow | undefined>;
  }

  async updateState(wiseTransferId: string, state: WiseTransferUpdate['state'], stateUpdatedAt: Date): Promise<void> {
    await this.db
      .updateTable('wise_transfer')
      .set({ state, stateUpdatedAt, updatedAt: new Date() })
      .where('wiseTransferId', '=', wiseTransferId)
      .execute();
  }

  /** Recent transfers, newest first. Drives the /wise/transfers list. */
  findRecent(limit = 100): Promise<WiseTransferRow[]> {
    return this.db
      .selectFrom('wise_transfer')
      .selectAll()
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .execute() as Promise<WiseTransferRow[]>;
  }

  /**
   * Transfers in a non-terminal state, oldest first. The reconcile job pulls
   * each from Wise and reapplies the state — catches missed webhooks.
   */
  findReconcilable(): Promise<WiseTransferRow[]> {
    return this.db
      .selectFrom('wise_transfer')
      .selectAll()
      .where('state', 'not in', TERMINAL_STATES)
      .orderBy('stateUpdatedAt', 'asc')
      .execute() as Promise<WiseTransferRow[]>;
  }

  /**
   * Allocate the next `TXN-NNNN` reference for an outbound transfer. Backed by
   * a Postgres SEQUENCE — atomic and gap-tolerant under concurrency.
   */
  async allocateTxnReference(): Promise<string> {
    const result = await sql<{ nextval: number | string }>`SELECT nextval('wise_txn_sequence')`.execute(this.db);
    const next = result.rows[0]?.nextval;
    if (next === undefined) {
      throw new Error('Failed to allocate TXN reference: nextval returned no row');
    }
    return `TXN-${String(next).padStart(4, '0')}`;
  }
}
