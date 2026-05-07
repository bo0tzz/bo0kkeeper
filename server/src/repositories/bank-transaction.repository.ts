import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, Selectable } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
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
      .orderBy('txDate', 'desc')
      .limit(limit)
      .execute() as Promise<BankTransaction[]>;
  }
}
