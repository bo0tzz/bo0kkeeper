import { Kysely } from 'kysely';
import { BankSource, BankTxCategory, MatchConfidence } from 'src/enum';
import { BankTransactionRepository, NewBankTransaction } from 'src/repositories/bank-transaction.repository';
import { DB } from 'src/schema';
import { getKyselyDB } from 'test/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('BankTransactionRepository', () => {
  let db: Kysely<DB>;
  let repo: BankTransactionRepository;

  beforeEach(async () => {
    db = await getKyselyDB();
    repo = new BankTransactionRepository(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  /** Ingest a fresh tx — terse helper for filter tests. */
  async function ingest(externalId: string, txDate: string, overrides: Partial<NewBankTransaction> = {}) {
    const result = await repo.ingest({
      source: BankSource.SnsCsv,
      externalId,
      txDate: new Date(txDate),
      amountMinor: 100n,
      currency: 'EUR',
      counterpartyName: null,
      counterpartyIban: null,
      description: '',
      rawPayload: {},
      ...overrides,
    });
    if (!result.ingested) {
      throw new Error(`bank tx ingest precondition for ${externalId}`);
    }
    return result.row;
  }

  describe('findPaginated', () => {
    it('returns newest txDate first with total reflecting the unsliced count', async () => {
      await ingest('a', '2099-01-01');
      await ingest('b', '2099-03-01');
      await ingest('c', '2099-02-01');

      const page1 = await repo.findPaginated({ offset: 0, limit: 2 });
      expect(page1.total).toBe(3);
      expect(page1.items.map((t) => t.externalId)).toEqual(['b', 'c']);

      const page2 = await repo.findPaginated({ offset: 2, limit: 2 });
      expect(page2.total).toBe(3);
      expect(page2.items.map((t) => t.externalId)).toEqual(['a']);
    });

    it('dateFrom and dateTo are inclusive on both ends', async () => {
      await ingest('before', '2099-01-31');
      await ingest('start', '2099-02-01');
      await ingest('mid', '2099-02-15');
      await ingest('end', '2099-02-28');
      await ingest('after', '2099-03-01');

      const result = await repo.findPaginated({
        dateFrom: '2099-02-01',
        dateTo: '2099-02-28',
        offset: 0,
        limit: 50,
      });
      expect(result.total).toBe(3);
      expect(result.items.map((t) => t.externalId).toSorted((a, b) => a.localeCompare(b))).toEqual([
        'end',
        'mid',
        'start',
      ]);
    });

    it('status filter partitions matched / categorized / unmatched', async () => {
      const matched = await ingest('matched', '2099-01-01');
      const categorized = await ingest('categorized', '2099-01-02');
      await ingest('unmatched', '2099-01-03');

      // Synthesize a match: matchedAt set + a confidence + an FK (we use a
      // freeform uuid for matchedExpenseId since that column isn't FK-enforced).
      await db
        .updateTable('bank_transaction')
        .set({
          matchedAt: new Date(),
          matchConfidence: MatchConfidence.Manual,
          matchedExpenseId: '00000000-0000-0000-0000-000000000001',
        })
        .where('id', '=', matched.id)
        .execute();
      await repo.setCategory(categorized.id, BankTxCategory.Fee);

      const m = await repo.findPaginated({ status: 'matched', offset: 0, limit: 50 });
      expect(m.total).toBe(1);
      expect(m.items[0].externalId).toBe('matched');

      const c = await repo.findPaginated({ status: 'categorized', offset: 0, limit: 50 });
      expect(c.total).toBe(1);
      expect(c.items[0].externalId).toBe('categorized');

      const u = await repo.findPaginated({ status: 'unmatched', offset: 0, limit: 50 });
      expect(u.total).toBe(1);
      expect(u.items[0].externalId).toBe('unmatched');
    });

    it('combines date range with status filter', async () => {
      await ingest('jan-unmatched', '2099-01-15');
      const febMatched = await ingest('feb-matched', '2099-02-15');
      await ingest('feb-unmatched', '2099-02-20');
      await db
        .updateTable('bank_transaction')
        .set({
          matchedAt: new Date(),
          matchConfidence: MatchConfidence.Manual,
          matchedExpenseId: '00000000-0000-0000-0000-000000000002',
        })
        .where('id', '=', febMatched.id)
        .execute();

      const result = await repo.findPaginated({
        dateFrom: '2099-02-01',
        dateTo: '2099-02-28',
        status: 'unmatched',
        offset: 0,
        limit: 50,
      });
      expect(result.total).toBe(1);
      expect(result.items[0].externalId).toBe('feb-unmatched');
    });
  });
});
