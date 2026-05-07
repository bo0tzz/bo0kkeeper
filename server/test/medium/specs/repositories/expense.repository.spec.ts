import { Kysely } from 'kysely';
import { ExpenseLocationClass, ExpenseStatus } from 'src/enum';
import { ExpenseRepository, NewExpense } from 'src/repositories/expense.repository';
import { DB } from 'src/schema';
import { getKyselyDB } from 'test/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const fakeExpense = (overrides: Partial<NewExpense> = {}): NewExpense => ({
  paperlessDocId: 'paperless-1',
  vendor: 'Acme Cables',
  expenseDate: new Date('2099-04-05'),
  amountMinor: 20_940n,
  currency: 'EUR',
  btwRateBps: 2100,
  btwMinor: 3634n,
  locationClass: ExpenseLocationClass.Domestic,
  category: '',
  notes: null,
  sourceEventId: null,
  ...overrides,
});

describe('ExpenseRepository', () => {
  let db: Kysely<DB>;
  let repo: ExpenseRepository;

  beforeEach(async () => {
    db = await getKyselyDB();
    repo = new ExpenseRepository(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('ingests a new expense in pending_review state', async () => {
    const result = await repo.ingest(fakeExpense());
    expect(result.ingested).toBe(true);
    if (result.ingested) {
      expect(result.row.status).toBe(ExpenseStatus.PendingReview);
      expect(result.row.vendor).toBe('Acme Cables');
    }
  });

  it('idempotent on duplicate paperlessDocId', async () => {
    const first = await repo.ingest(fakeExpense());
    expect(first.ingested).toBe(true);

    const second = await repo.ingest(fakeExpense());
    expect(second.ingested).toBe(false);
    if (!second.ingested && first.ingested) {
      expect(second.existingId).toBe(first.row.id);
    }
  });

  it('lists pending review expenses oldest-first', async () => {
    await repo.ingest(fakeExpense({ paperlessDocId: 'a', expenseDate: new Date('2099-03-01') }));
    await repo.ingest(fakeExpense({ paperlessDocId: 'b', expenseDate: new Date('2099-01-01') }));
    await repo.ingest(fakeExpense({ paperlessDocId: 'c', expenseDate: new Date('2099-02-01') }));

    const pending = await repo.findPendingReview();
    expect(pending.map((e) => e.paperlessDocId)).toEqual(['b', 'c', 'a']);
  });

  it('approve flips status, stamps reviewedAt, and accepts edits', async () => {
    const ingest = await repo.ingest(fakeExpense());
    if (!ingest.ingested) {
      throw new Error('precondition');
    }

    const updated = await repo.approve(ingest.row.id, { vendor: 'Acme Cables BV', category: 'hardware' });
    expect(updated?.status).toBe(ExpenseStatus.Approved);
    expect(updated?.vendor).toBe('Acme Cables BV');
    expect(updated?.category).toBe('hardware');
    expect(updated?.reviewedAt).toBeInstanceOf(Date);

    const pending = await repo.findPendingReview();
    expect(pending).toHaveLength(0);
  });

  it('reject flips status with optional notes', async () => {
    const ingest = await repo.ingest(fakeExpense());
    if (!ingest.ingested) {
      throw new Error('precondition');
    }

    const updated = await repo.reject(ingest.row.id, 'Personal expense, not business');
    expect(updated?.status).toBe(ExpenseStatus.Rejected);
    expect(updated?.notes).toBe('Personal expense, not business');
  });
});
