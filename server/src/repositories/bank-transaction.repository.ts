import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, Selectable } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { BankSource, BankTxCategory } from 'src/enum';
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

  /** Lookup by description substring — used by matchers (e.g. TXN-NNNN). */
  findByDescriptionContaining(needle: string): Promise<BankTransaction[]> {
    return this.db
      .selectFrom('bank_transaction')
      .selectAll()
      .where('description', 'like', `%${needle}%`)
      .execute() as Promise<BankTransaction[]>;
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

    const totalRow = (await query
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirst()) as { count: string } | undefined;
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
