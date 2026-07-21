import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, Selectable, sql, Updateable } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { ExpenseLocationClass, ExpenseStatus, MatchConfidence } from 'src/enum';
import { DB } from 'src/schema';
import { ExpenseTable } from 'src/schema/tables/expense.table';

export type Expense = Selectable<ExpenseTable>;
export type NewExpense = Insertable<ExpenseTable>;
export type ExpenseUpdate = Updateable<ExpenseTable>;

export type IngestResult = { ingested: true; row: Expense } | { ingested: false; existingId: string };

@Injectable()
export class ExpenseRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /**
   * Idempotent insert keyed on `paperlessDocId`. Re-firing the post-consume
   * webhook is safe; the existing row's status is preserved.
   */
  async ingest(input: NewExpense): Promise<IngestResult> {
    const inserted = (await this.db
      .insertInto('expense')
      .values(input)
      .onConflict((oc) => oc.column('paperlessDocId').doNothing())
      .returningAll()
      .executeTakeFirst()) as Expense | undefined;

    if (inserted) {
      return { ingested: true, row: inserted };
    }

    const existing = await this.db
      .selectFrom('expense')
      .select('id')
      .where('paperlessDocId', '=', input.paperlessDocId as string)
      .executeTakeFirstOrThrow();

    return { ingested: false, existingId: existing.id };
  }

  findById(id: string): Promise<Expense | undefined> {
    return this.db.selectFrom('expense').selectAll().where('id', '=', id).executeTakeFirst() as Promise<
      Expense | undefined
    >;
  }

  /**
   * Bulk lookup of vendor labels keyed by id. Used by the /transactions
   * unified view to label matched bank rows in one round trip.
   */
  async findVendorsByIds(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) {
      return new Map();
    }
    const rows = (await this.db
      .selectFrom('expense')
      .select(['id', 'vendor'])
      .where('id', 'in', ids)
      .execute()) as Array<{ id: string; vendor: string }>;
    return new Map(rows.map((row) => [row.id, row.vendor]));
  }

  /**
   * Look up an auto-created bank-fee expense by its source bank-tx.
   * Used by the matcher's create-Expense branch to stay idempotent on
   * reprocess / repeat ingest.
   */
  findBySourceBankTxId(bankTxId: string): Promise<Expense | undefined> {
    return this.db
      .selectFrom('expense')
      .selectAll()
      .where('sourceBankTxId', '=', bankTxId)
      .executeTakeFirst() as Promise<Expense | undefined>;
  }

  /**
   * Idempotent insert for an auto-created bank-fee expense, keyed on
   * `sourceBankTxId`. Status is `approved` and `reviewedAt` is set on
   * creation — these are deterministically derived from a recognised
   * recurring-fee pattern, no human review needed. `paperlessDocId` is null:
   * the bank statement line itself is the *vereenvoudigde factuur*.
   */
  async ingestFromBankFee(input: NewExpense & { sourceBankTxId: string }): Promise<IngestResult> {
    const inserted = (await this.db
      .insertInto('expense')
      .values(input)
      .onConflict((oc) => oc.column('sourceBankTxId').doNothing())
      .returningAll()
      .executeTakeFirst()) as Expense | undefined;

    if (inserted) {
      return { ingested: true, row: inserted };
    }

    const existing = await this.db
      .selectFrom('expense')
      .select('id')
      .where('sourceBankTxId', '=', input.sourceBankTxId)
      .executeTakeFirstOrThrow();

    return { ingested: false, existingId: existing.id };
  }

  /** Pending review queue, oldest first (oldest receipts probably need attention sooner). */
  findPendingReview(limit = 100): Promise<Expense[]> {
    return this.db
      .selectFrom('expense')
      .selectAll()
      .where('status', '=', ExpenseStatus.PendingReview)
      .orderBy('expenseDate', 'asc')
      .limit(limit)
      .execute() as Promise<Expense[]>;
  }

  /**
   * Paginated list with optional filters; backs the admin expense browser.
   * Sort order: pending review first (so the queue lands at the top), then by
   * expense date descending — newer receipts surface first within each status.
   */
  async findMany(filter: ExpenseListFilter): Promise<ExpenseListPage> {
    const baseQuery = this.db
      .selectFrom('expense')
      .$if(!!filter.status, (qb) => qb.where('status', '=', filter.status!))
      .$if(!!filter.locationClass, (qb) => qb.where('locationClass', '=', filter.locationClass!))
      .$if(!!filter.from, (qb) => qb.where('expenseDate', '>=', filter.from!))
      .$if(!!filter.to, (qb) => qb.where('expenseDate', '<=', filter.to!))
      .$if(filter.matched === false, (qb) =>
        qb.where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom('bank_transaction')
                .select('id')
                .whereRef('bank_transaction.matchedExpenseId', '=', 'expense.id'),
            ),
          ),
        ),
      )
      .$if(filter.matched === true, (qb) =>
        qb.where(({ exists, selectFrom }) =>
          exists(
            selectFrom('bank_transaction')
              .select('id')
              .whereRef('bank_transaction.matchedExpenseId', '=', 'expense.id'),
          ),
        ),
      );

    const [items, totalRow] = await Promise.all([
      baseQuery
        .selectAll()
        .orderBy(({ ref }) => sql`CASE ${ref('status')} WHEN ${ExpenseStatus.PendingReview} THEN 0 ELSE 1 END`)
        .orderBy('expenseDate', 'desc')
        .limit(filter.limit)
        .offset(filter.offset)
        .execute(),
      baseQuery.select((eb) => eb.fn.countAll().as('total')).executeTakeFirstOrThrow(),
    ]);

    const total = Number(totalRow.total);
    return {
      items: items as Expense[],
      total,
      hasMore: filter.offset + items.length < total,
    };
  }

  /** Apply review edits + flip status. Idempotent for the same `status`. */
  async update(id: string, patch: ExpenseUpdate): Promise<Expense | undefined> {
    const updated = (await this.db
      .updateTable('expense')
      .set({ ...patch, updatedAt: new Date() })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst()) as Expense | undefined;
    return updated;
  }

  async approve(id: string, patch: Omit<ExpenseUpdate, 'status' | 'reviewedAt'> = {}): Promise<Expense | undefined> {
    return this.update(id, { ...patch, status: ExpenseStatus.Approved, reviewedAt: new Date() });
  }

  async reject(id: string, notes?: string): Promise<Expense | undefined> {
    return this.update(id, {
      status: ExpenseStatus.Rejected,
      reviewedAt: new Date(),
      ...(notes && { notes }),
    });
  }

  /**
   * Count approved expenses with a manual-match linked bank_tx whose sheet
   * row never landed AND where the bank-tx-match has been sitting for longer
   * than `staleAfterMs`. Parallel to
   * BankTransactionRepository.countStaleSheetWrites for the expense side.
   */
  /**
   * Approved expense + its manual-confidence bank-tx link, surfaced with
   * the bank-tx id + date, for rows that don't yet have a sheet write.
   * Used by the sheet-write helper that runs after either approval or
   * link to fire the row when both conditions are satisfied.
   *
   * Pass `expenseId` to scope to a single row (post-approval / post-link
   * triggers); omit to walk all eligible rows (retry job).
   */
  async findMatchedReadyForSheet(
    expenseId?: string,
  ): Promise<Array<Expense & { bankTxId: string; bankTxDate: Date | string }>> {
    let query = this.db
      .selectFrom('expense')
      .innerJoin('bank_transaction', 'bank_transaction.matchedExpenseId', 'expense.id')
      .where('expense.status', '=', ExpenseStatus.Approved)
      .where('expense.sheetRowAt', 'is', null)
      .where('bank_transaction.matchConfidence', '=', MatchConfidence.Manual);
    if (expenseId !== undefined) {
      query = query.where('expense.id', '=', expenseId);
    }
    return (await query
      .selectAll('expense')
      .select(['bank_transaction.id as bankTxId', 'bank_transaction.txDate as bankTxDate'])
      .execute()) as Array<Expense & { bankTxId: string; bankTxDate: Date | string }>;
  }

  /**
   * Unmatched expenses with matching amount + currency in a date window.
   * Drives the bank-matcher's auto-low heuristic — the service still
   * applies the fuzzy-vendor narrowing on top.
   */
  async findUnmatchedAmountAndDateWindow(input: {
    amountMinor: bigint;
    currency: string;
    dateLow: Date;
    dateHigh: Date;
  }): Promise<Expense[]> {
    return (await this.db
      .selectFrom('expense')
      .selectAll()
      .where('amountMinor', '=', input.amountMinor)
      .where('currency', '=', input.currency)
      .where('expenseDate', '>=', input.dateLow)
      .where('expenseDate', '<=', input.dateHigh)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('bank_transaction')
              .select('id')
              .whereRef('bank_transaction.matchedExpenseId', '=', 'expense.id'),
          ),
        ),
      )
      .execute()) as Expense[];
  }

  /**
   * Match-candidate list for the bank-tx Link modal. Returns the abbreviated
   * shape the UI cares about. With `query`, runs a case-insensitive vendor
   * substring filter and includes already-matched rows (the operator may be
   * fixing a wrong link). Without, restricts to unmatched.
   */
  async findMatchCandidates(input: { query?: string; limit: number }): Promise<ExpenseMatchCandidate[]> {
    const like = input.query ? `%${input.query.toLowerCase()}%` : null;
    let qb = this.db
      .selectFrom('expense')
      .select(['id', 'vendor', 'amountMinor', 'currency', 'expenseDate', 'status'])
      .orderBy('expenseDate', 'desc')
      .limit(input.limit);
    qb = like
      ? qb.where((eb) => eb(eb.fn<string>('lower', ['vendor']), 'like', like))
      : qb.where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom('bank_transaction')
                .select('id')
                .whereRef('bank_transaction.matchedExpenseId', '=', 'expense.id'),
            ),
          ),
        );
    return (await qb.execute()) as ExpenseMatchCandidate[];
  }

  /** Mark an expense as having its sheet row successfully written. */
  async markSheetRowWritten(id: string): Promise<void> {
    await this.db
      .updateTable('expense')
      .set({ sheetRowAt: new Date(), updatedAt: new Date() })
      .where('id', '=', id)
      .execute();
  }

  /**
   * Pending-review expense count + a small vendor sample for the
   * quarterly-aggregator warning panel. One round trip.
   */
  async findPendingInPeriod(input: {
    start: Date;
    end: Date;
    sampleLimit: number;
  }): Promise<{ count: number; sampleVendors: string[] }> {
    const [countRow, sample] = await Promise.all([
      this.db
        .selectFrom('expense')
        .select((eb) => eb.fn.countAll<string>().as('total'))
        .where('status', '=', ExpenseStatus.PendingReview)
        .where('expenseDate', '>=', input.start)
        .where('expenseDate', '<', input.end)
        .executeTakeFirstOrThrow(),
      this.db
        .selectFrom('expense')
        .select(['vendor'])
        .where('status', '=', ExpenseStatus.PendingReview)
        .where('expenseDate', '>=', input.start)
        .where('expenseDate', '<', input.end)
        .limit(input.sampleLimit)
        .execute(),
    ]);
    return { count: Number(countRow.total), sampleVendors: sample.map((row) => row.vendor) };
  }

  /**
   * Approved expenses whose *payment date* falls in `[start, end)`.
   *
   * Kasstelsel (cash basis) counts an expense in the quarter it was paid,
   * not the quarter its receipt is dated — so we look at the matched
   * bank_transaction's `txDate` first, and only fall back to
   * `expense.expenseDate` when nothing is matched yet (rare: cash purchases
   * or manual entries). If multiple bank_transactions point at the same
   * expense (partial payments), the latest one wins.
   *
   * This aligns the aggregator with the sheet-sync path, which already
   * places expense rows on the tab of `bankTx.txDate`.
   */
  async findApprovedInPeriod(start: Date, end: Date): Promise<Expense[]> {
    // COALESCE(latest bt.txDate matched to this expense, expense.expenseDate)
    // as the effective period date. Kysely's typed `fn.coalesce` doesn't
    // accept a subquery scalar in this position, so build it via `sql`.
    const effectiveDate = sql<Date>`COALESCE(
      (SELECT MAX(bt."txDate") FROM bank_transaction bt WHERE bt."matchedExpenseId" = expense.id),
      expense."expenseDate"
    )`;
    return (await this.db
      .selectFrom('expense')
      .selectAll('expense')
      .where('status', '=', ExpenseStatus.Approved)
      .where(effectiveDate, '>=', start)
      .where(effectiveDate, '<', end)
      .orderBy('expense.expenseDate', 'asc')
      .execute()) as Expense[];
  }

  async countStaleSheetWrites(staleAfterMs: number): Promise<number> {
    const threshold = new Date(Date.now() - staleAfterMs);
    const result = (await this.db
      .selectFrom('expense')
      .innerJoin('bank_transaction', 'bank_transaction.matchedExpenseId', 'expense.id')
      .select((eb) => eb.fn.countAll().as('total'))
      .where('expense.status', '=', ExpenseStatus.Approved)
      .where('expense.sheetRowAt', 'is', null)
      .where('bank_transaction.matchConfidence', '=', MatchConfidence.Manual)
      .where('bank_transaction.matchedAt', '<', threshold)
      .executeTakeFirstOrThrow()) as { total: string | number };
    return Number(result.total);
  }
}

export type ExpenseListFilter = {
  status?: ExpenseStatus;
  locationClass?: ExpenseLocationClass;
  /** Inclusive lower bound on expenseDate. */
  from?: Date;
  /** Inclusive upper bound on expenseDate. */
  to?: Date;
  /**
   * Filter by whether a bank_transaction is matched to this expense.
   *   false → only unmatched (no row in bank_transaction has matchedExpenseId = this.id)
   *   true  → only matched
   *   undefined → no filter
   * Drives the dashboard's "Approved, unmatched" tile — the new failure
   * mode where an expense has been approved but no bank tx has landed yet.
   */
  matched?: boolean;
  limit: number;
  offset: number;
};

export type ExpenseListPage = {
  items: Expense[];
  total: number;
  hasMore: boolean;
};

/** Abbreviated row returned by the match-candidate list. */
export type ExpenseMatchCandidate = {
  id: string;
  vendor: string;
  amountMinor: bigint | string;
  currency: string;
  expenseDate: Date | string;
  status: string;
};
