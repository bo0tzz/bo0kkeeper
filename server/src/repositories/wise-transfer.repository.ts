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

  /**
   * Lookup by our outgoing TXN-NNNN reference. Drives the bank-matcher's
   * high-confidence path — a bank-tx description carrying `TXN-NNNN`
   * unambiguously links to the wise_transfer that allocated it.
   */
  findByOurReference(ourReference: string): Promise<WiseTransferRow | undefined> {
    return this.db
      .selectFrom('wise_transfer')
      .selectAll()
      .where('ourReference', '=', ourReference)
      .executeTakeFirst() as Promise<WiseTransferRow | undefined>;
  }

  /**
   * Match-candidate list for the bank-tx Link modal. Substring search on
   * our TXN ref + Wise's id; unmatched-only when query is empty.
   */
  async findMatchCandidates(input: { query?: string; limit: number }): Promise<WiseTransferMatchCandidate[]> {
    const like = input.query ? `%${input.query.toLowerCase()}%` : null;
    let qb = this.db
      .selectFrom('wise_transfer')
      .select([
        'id',
        'wiseTransferId',
        'ourReference',
        'state',
        'sourceCurrency',
        'sourceAmountMinor',
        'targetCurrency',
        'targetAmountMinor',
        'createdAt',
      ])
      .orderBy('createdAt', 'desc')
      .limit(input.limit);
    qb = like
      ? qb.where((eb) =>
          eb.or([
            eb(eb.fn<string>('lower', ['ourReference']), 'like', like),
            eb(eb.fn<string>('lower', ['wiseTransferId']), 'like', like),
          ]),
        )
      : qb.where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom('bank_transaction')
                .select('id')
                .whereRef('bank_transaction.matchedTransferId', '=', 'wise_transfer.id'),
            ),
          ),
        );
    return (await qb.execute()) as WiseTransferMatchCandidate[];
  }

  async updateState(wiseTransferId: string, state: WiseTransferUpdate['state'], stateUpdatedAt: Date): Promise<void> {
    await this.db
      .updateTable('wise_transfer')
      .set({ state, stateUpdatedAt, updatedAt: new Date() })
      .where('wiseTransferId', '=', wiseTransferId)
      .execute();
  }

  /**
   * Bulk lookup of `ourReference` keyed by id. Used by the /transactions
   * unified view to label matched bank rows in one round trip.
   */
  async findOurReferencesByIds(ids: string[]): Promise<Map<string, string | null>> {
    if (ids.length === 0) {
      return new Map();
    }
    const rows = (await this.db
      .selectFrom('wise_transfer')
      .select(['id', 'ourReference'])
      .where('id', 'in', ids)
      .execute()) as Array<{ id: string; ourReference: string | null }>;
    return new Map(rows.map((row) => [row.id, row.ourReference]));
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
   * Transfers "paid in `[start, end)`" — wise_transfer rows whose matched
   * bank_tx booked inside the period. Drives Non-EU income aggregation
   * for the quarterly report (target leg in the company account).
   */
  async findPaidInPeriod(start: Date, end: Date): Promise<WiseTransferPaidRow[]> {
    return (await this.db
      .selectFrom('bank_transaction')
      .innerJoin('wise_transfer', 'wise_transfer.id', 'bank_transaction.matchedTransferId')
      .select(['wise_transfer.id', 'wise_transfer.targetAmountMinor', 'wise_transfer.targetCurrency'])
      .where('bank_transaction.txDate', '>=', start)
      .where('bank_transaction.txDate', '<', end)
      .execute()) as WiseTransferPaidRow[];
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

/** Row returned by `findPaidInPeriod` — slim projection for the quarterly aggregator. */
export type WiseTransferPaidRow = {
  id: string;
  targetAmountMinor: bigint | string;
  targetCurrency: string;
};

/** Abbreviated row used by the manual match-candidate picker. */
export type WiseTransferMatchCandidate = {
  id: string;
  wiseTransferId: string;
  ourReference: string | null;
  state: string;
  sourceCurrency: string;
  sourceAmountMinor: bigint | string;
  targetCurrency: string;
  targetAmountMinor: bigint | string;
  createdAt: Date | string;
};
