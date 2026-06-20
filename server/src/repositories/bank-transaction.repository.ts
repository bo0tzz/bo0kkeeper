import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, Selectable } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { BankSource, BankTxCategory, MatchConfidence } from 'src/enum';
import { DB } from 'src/schema';
import { BankTransactionTable } from 'src/schema/tables/bank-transaction.table';

export type BankTransaction = Selectable<BankTransactionTable>;
export type NewBankTransaction = Insertable<BankTransactionTable>;

export type IngestResult = { ingested: true; row: BankTransaction } | { ingested: false; existingId: string };

@Injectable()
export class BankTransactionRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /**
   * Idempotent insert keyed on `(source, externalId)`. Re-imports of the same
   * CSV are safe; same row → ingested:false on retry.
   */
  async ingest(input: NewBankTransaction): Promise<IngestResult> {
    const inserted = (await this.db
      .insertInto('bank_transaction')
      .values(input)
      .onConflict((oc) => oc.columns(['source', 'externalId']).doNothing())
      .returningAll()
      .executeTakeFirst()) as BankTransaction | undefined;

    if (inserted) {
      return { ingested: true, row: inserted };
    }

    const existing = await this.db
      .selectFrom('bank_transaction')
      .select('id')
      .where('source', '=', input.source)
      .where('externalId', '=', input.externalId as string)
      .executeTakeFirstOrThrow();

    return { ingested: false, existingId: existing.id };
  }

  findById(id: string): Promise<BankTransaction | undefined> {
    return this.db.selectFrom('bank_transaction').selectAll().where('id', '=', id).executeTakeFirst() as Promise<
      BankTransaction | undefined
    >;
  }

  findUnmatched(limit = 50): Promise<BankTransaction[]> {
    return this.db
      .selectFrom('bank_transaction')
      .selectAll()
      .where('matchedAt', 'is', null)
      .where('category', 'is', null)
      .orderBy('txDate', 'desc')
      .limit(limit)
      .execute() as Promise<BankTransaction[]>;
  }

  /**
   * Count + small id-sample of auto-low matches booked in `[start, end)`.
   * Drives the quarterly-aggregator's "expense_low_confidence_match" warning
   * so the user knows what to confirm before filing.
   */
  async findLowConfidenceInPeriod(input: {
    start: Date;
    end: Date;
    sampleLimit: number;
  }): Promise<{ count: number; sampleIds: string[] }> {
    const base = this.db
      .selectFrom('bank_transaction')
      .where('matchConfidence', '=', MatchConfidence.AutoLow)
      .where('txDate', '>=', input.start)
      .where('txDate', '<', input.end);
    const [countRow, sample] = await Promise.all([
      base.select((eb) => eb.fn.countAll<string>().as('total')).executeTakeFirstOrThrow(),
      base.select(['id']).limit(input.sampleLimit).execute(),
    ]);
    return { count: Number(countRow.total), sampleIds: sample.map((row) => row.id) };
  }

  /**
   * Set the manual category for a row (or clear it with null). Categorizing
   * implies "not a real income/expense", so any existing match is cleared —
   * match and category are mutually exclusive resolution paths. Returns the
   * refreshed row so the API can echo back the canonical state.
   */
  async setCategory(id: string, category: BankTxCategory | null): Promise<BankTransaction | undefined> {
    const patch: Record<string, unknown> = { category, updatedAt: new Date() };
    if (category !== null) {
      patch.matchedTransferId = null;
      patch.matchedInvoiceId = null;
      patch.matchedExpenseId = null;
      patch.matchedAt = null;
      patch.matchConfidence = null;
    }
    return this.db
      .updateTable('bank_transaction')
      .set(patch)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst() as Promise<BankTransaction | undefined>;
  }

  /**
   * Link a row to exactly one counterpart (wise_transfer / invoice / expense),
   * clearing the other two match FKs and any category — match and category are
   * mutually exclusive resolution paths (the mirror of setCategory). Stamps
   * matchedAt + confidence. Returns the refreshed row.
   */
  async setMatch(
    id: string,
    target: { type: 'wise_transfer' | 'invoice' | 'expense'; id: string },
    confidence: MatchConfidence,
  ): Promise<BankTransaction | undefined> {
    return this.db
      .updateTable('bank_transaction')
      .set({
        matchedTransferId: target.type === 'wise_transfer' ? target.id : null,
        matchedInvoiceId: target.type === 'invoice' ? target.id : null,
        matchedExpenseId: target.type === 'expense' ? target.id : null,
        matchedAt: new Date(),
        matchConfidence: confidence,
        category: null,
        updatedAt: new Date(),
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst() as Promise<BankTransaction | undefined>;
  }

  /** Operator unlink: clears all match fields. Sheet rows aren't rewound. */
  async clearMatch(id: string): Promise<BankTransaction | undefined> {
    return this.db
      .updateTable('bank_transaction')
      .set({
        matchedInvoiceId: null,
        matchedTransferId: null,
        matchedExpenseId: null,
        matchedAt: null,
        matchConfidence: null,
        updatedAt: new Date(),
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst() as Promise<BankTransaction | undefined>;
  }

  /**
   * Signed sum of every Enable-Banking-sourced row dated on or after `since`.
   * Used to derive expected-balance from a baseline. Returns 0n if no rows
   * match. V1 assumes a single bank account on the session; multi-account
   * setups will need to filter by account uid.
   */
  async sumIngestedSince(since: string): Promise<bigint> {
    const result = (await this.db
      .selectFrom('bank_transaction')
      .select((eb) => eb.fn.sum<string>('amountMinor').as('total'))
      .where('source', '=', BankSource.EnableBanking)
      .where('txDate', '>=', new Date(since))
      .executeTakeFirst()) as { total: string | null } | undefined;
    return result?.total ? BigInt(result.total) : 0n;
  }

  /**
   * Income-side bank_txs (matched to invoice or wise_transfer at auto_high
   * or manual confidence) whose sheet row never landed. Drives the retry
   * sweep.
   */
  async findMatchedReadyForSheet(): Promise<BankTransaction[]> {
    return (await this.db
      .selectFrom('bank_transaction')
      .selectAll()
      .where('matchedAt', 'is not', null)
      .where('matchConfidence', 'in', [MatchConfidence.AutoHigh, MatchConfidence.Manual])
      .where('sheetRowAt', 'is', null)
      .where((eb) => eb.or([eb('matchedInvoiceId', 'is not', null), eb('matchedTransferId', 'is not', null)]))
      .execute()) as BankTransaction[];
  }

  /** Mark a bank_tx as having its sheet income row successfully written. */
  async markSheetRowWritten(id: string): Promise<void> {
    await this.db
      .updateTable('bank_transaction')
      .set({ sheetRowAt: new Date(), updatedAt: new Date() })
      .where('id', '=', id)
      .execute();
  }

  /** Just the `sheetRowAt` value — used by the retry job to detect success after a side-effecting append. */
  async getSheetRowAt(id: string): Promise<Date | string | null> {
    const row = (await this.db
      .selectFrom('bank_transaction')
      .select('sheetRowAt')
      .where('id', '=', id)
      .executeTakeFirst()) as { sheetRowAt: Date | string | null } | undefined;
    return row?.sheetRowAt ?? null;
  }

  /**
   * Count matched bank_txs (auto_high or manual to an invoice / wise_transfer)
   * whose sheet income row never landed AND whose match has been sitting for
   * longer than `staleAfterMs`. Distinct from the "Sheet write failures 30d"
   * audit count which is historical noise; this is current state.
   */
  async countStaleSheetWrites(staleAfterMs: number): Promise<number> {
    const threshold = new Date(Date.now() - staleAfterMs);
    const result = (await this.db
      .selectFrom('bank_transaction')
      .select((eb) => eb.fn.countAll().as('total'))
      .where('matchedAt', 'is not', null)
      .where('matchedAt', '<', threshold)
      .where('matchConfidence', 'in', [MatchConfidence.AutoHigh, MatchConfidence.Manual])
      .where('sheetRowAt', 'is', null)
      .where((eb) => eb.or([eb('matchedInvoiceId', 'is not', null), eb('matchedTransferId', 'is not', null)]))
      .executeTakeFirstOrThrow()) as { total: string | number };
    return Number(result.total);
  }

  /** Recent rows, newest first. Used by the /transactions all-flows view. */
  findRecent(limit = 50): Promise<BankTransaction[]> {
    return this.db
      .selectFrom('bank_transaction')
      .selectAll()
      .orderBy('txDate', 'desc')
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .execute() as Promise<BankTransaction[]>;
  }

  /**
   * Paginated rows with optional date-range + status filter, newest first.
   * Status: 'matched' = any matched* FK set; 'categorized' = category set;
   * 'unmatched' = neither. Returns the page slice plus the unsliced total.
   */
  async findPaginated(input: {
    dateFrom?: string;
    dateTo?: string;
    status?: 'matched' | 'categorized' | 'unmatched';
    offset: number;
    limit: number;
  }): Promise<{ items: BankTransaction[]; total: number }> {
    let query = this.db.selectFrom('bank_transaction');
    if (input.dateFrom) {
      query = query.where('txDate', '>=', new Date(input.dateFrom));
    }
    if (input.dateTo) {
      query = query.where('txDate', '<=', new Date(input.dateTo));
    }
    switch (input.status) {
      case 'matched': {
        query = query.where('matchedAt', 'is not', null);
        break;
      }
      case 'categorized': {
        query = query.where('category', 'is not', null);
        break;
      }
      case 'unmatched': {
        query = query.where('matchedAt', 'is', null).where('category', 'is', null);
        break;
      }
      default: {
        break;
      }
    }

    const totalRow = (await query.select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirst()) as
      | { count: string }
      | undefined;
    const total = Number(totalRow?.count ?? 0);

    const items = (await query
      .selectAll()
      .orderBy('txDate', 'desc')
      .orderBy('createdAt', 'desc')
      .limit(input.limit)
      .offset(input.offset)
      .execute()) as BankTransaction[];

    return { items, total };
  }
}
