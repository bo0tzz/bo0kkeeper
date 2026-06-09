import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, Selectable, sql, Updateable } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { WiseTransferState } from 'src/enum';
import { DB } from 'src/schema';
import { WiseTransferTable } from 'src/schema/tables/wise-transfer.table';

export type WiseTransferRow = Selectable<WiseTransferTable>;
export type NewWiseTransfer = Insertable<WiseTransferTable>;
export type WiseTransferUpdate = Updateable<WiseTransferTable>;

/** Paginated list row — wise_transfer + the linked invoice number when one exists. */
export type WiseTransferListRow = WiseTransferRow & {
  linkedInvoiceId: string | null;
  linkedInvoiceNumber: string | null;
};

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

  /** Lookup by our internal UUID (FK target). */
  findById(id: string): Promise<WiseTransferRow | undefined> {
    return this.db.selectFrom('wise_transfer').selectAll().where('id', '=', id).executeTakeFirst() as Promise<
      WiseTransferRow | undefined
    >;
  }

  async updateState(wiseTransferId: string, state: WiseTransferUpdate['state'], stateUpdatedAt: Date): Promise<void> {
    await this.db
      .updateTable('wise_transfer')
      .set({ state, stateUpdatedAt, updatedAt: new Date() })
      .where('wiseTransferId', '=', wiseTransferId)
      .execute();
  }

  /** Recent transfers, newest first. Drives the /transactions all-flows view. */
  findRecent(limit = 100): Promise<WiseTransferRow[]> {
    return this.db
      .selectFrom('wise_transfer')
      .selectAll()
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .execute() as Promise<WiseTransferRow[]>;
  }

  /**
   * Paginated transfers with optional state filter, newest first. Returns
   * the page slice plus the unsliced total so the UI can size the pager
   * without a second round trip.
   */
  async findPaginated(input: {
    state?: WiseTransferState;
    offset: number;
    limit: number;
  }): Promise<{ items: WiseTransferListRow[]; total: number }> {
    let query = this.db.selectFrom('wise_transfer');
    if (input.state) {
      query = query.where('state', '=', input.state);
    }

    const totalRow = (await query.select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirst()) as
      | { count: string }
      | undefined;
    const total = Number(totalRow?.count ?? 0);

    // Left-join the linked invoice (unique per wise_transfer) so the UI can
    // show "Compose invoice" vs "View invoice 2099/NNN" without a per-row
    // round trip.
    const items = (await query
      .leftJoin('invoice', 'invoice.wiseTransferId', 'wise_transfer.id')
      .selectAll('wise_transfer')
      .select(['invoice.id as linkedInvoiceId', 'invoice.number as linkedInvoiceNumber'])
      .orderBy('wise_transfer.createdAt', 'desc')
      .limit(input.limit)
      .offset(input.offset)
      .execute()) as WiseTransferListRow[];

    return { items, total };
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
