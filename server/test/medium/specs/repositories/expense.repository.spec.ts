import { Kysely } from 'kysely';
import { BankSource, ExpenseLocationClass, ExpenseStatus, MatchConfidence } from 'src/enum';
import { BankTransactionRepository } from 'src/repositories/bank-transaction.repository';
import { ExpenseRepository, NewExpense } from 'src/repositories/expense.repository';
import { WiseTransferRepository } from 'src/repositories/wise-transfer.repository';
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

async function ingestBankTx(db: Kysely<DB>) {
  const bankRepo = new BankTransactionRepository(db);
  const result = await bankRepo.ingest({
    source: BankSource.SnsCsv,
    externalId: `fee-${Math.floor(Math.random() * 1e9)}`,
    txDate: new Date('2099-05-01'),
    amountMinor: -182n,
    currency: 'EUR',
    counterpartyName: 'SNS Bank',
    counterpartyIban: null,
    description: 'Kosten Klantonderzoek 21% BTW BTW bedrag: 0,32',
    rawPayload: {},
  });
  if (!result.ingested) {
    throw new Error('precondition');
  }
  return result.row;
}

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

  // Regression: /expenses UI needs to know which rows already have a matched
  // bank_transaction so it can hide the "Link bank tx" button. Before this,
  // the list endpoint didn't expose that state.
  it('findMany surfaces matchedBankTxId for rows a bank_transaction points at', async () => {
    const bankRepo = new BankTransactionRepository(db);
    const linked = await repo.ingest(fakeExpense({ paperlessDocId: 'linked', vendor: 'Linked Vendor' }));
    const unlinked = await repo.ingest(fakeExpense({ paperlessDocId: 'unlinked', vendor: 'Unlinked Vendor' }));
    if (!linked.ingested || !unlinked.ingested) {
      throw new Error('precondition');
    }
    await repo.approve(linked.row.id);
    await repo.approve(unlinked.row.id);
    const tx = await ingestBankTx(db);
    await bankRepo.setMatch(tx.id, { type: 'expense', id: linked.row.id }, MatchConfidence.Manual);

    const page = await repo.findMany({ offset: 0, limit: 50 });
    const byVendor = Object.fromEntries(page.items.map((row) => [row.vendor, row]));
    expect(byVendor['Linked Vendor'].matchedBankTxId).toBe(tx.id);
    expect(byVendor['Unlinked Vendor'].matchedBankTxId).toBeNull();
  });

  // v0.9.2 fix — a Wise-flow expense doesn't need an SNS-side bank_tx to
  // count as "matched"; the sweep's own bank_tx handles the linking via
  // the wise_transfer FK. Without this, wise-linked rows surfaced on the
  // "Awaiting bank match" tile forever.
  it("findMany treats wise-linked expenses as matched (they don't need an SNS bank_tx)", async () => {
    const wiseTransferRepo = new WiseTransferRepository(db);
    const transfer = await wiseTransferRepo.create({
      wiseTransferId: 'WISE-MATCH-1',
      direction: 'out' as never,
      sourceAmountMinor: 100_000n,
      sourceCurrency: 'USD',
      targetAmountMinor: 85_000n,
      targetCurrency: 'EUR',
      fxRate: '0.85',
      feeMinor: 0n,
      feeCurrency: 'USD',
      state: 'outgoing_payment_sent' as never,
      stateUpdatedAt: new Date(),
    });
    const wiseFlow = await repo.ingest(
      fakeExpense({
        paperlessDocId: 'wise-flow',
        vendor: 'US Vendor',
        amountMinor: 15_000n,
        currency: 'USD',
        wiseTransferId: transfer.id,
      }),
    );
    const plain = await repo.ingest(fakeExpense({ paperlessDocId: 'plain-unmatched', vendor: 'Unmatched EUR Vendor' }));
    if (!wiseFlow.ingested || !plain.ingested) {
      throw new Error('precondition');
    }
    await repo.approve(wiseFlow.row.id);
    await repo.approve(plain.row.id);

    const unmatched = await repo.findMany({ matched: false, offset: 0, limit: 50 });
    const vendors = unmatched.items.map((row) => row.vendor);
    expect(vendors).toContain('Unmatched EUR Vendor');
    // The wise-linked one must NOT appear as unmatched.
    expect(vendors).not.toContain('US Vendor');

    const matched = await repo.findMany({ matched: true, offset: 0, limit: 50 });
    const matchedVendors = matched.items.map((row) => row.vendor);
    expect(matchedVendors).toContain('US Vendor');
    expect(matchedVendors).not.toContain('Unmatched EUR Vendor');
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

  describe('bank-fee source', () => {
    it('ingestFromBankFee creates an approved expense with sourceBankTxId set', async () => {
      const bankTx = await ingestBankTx(db);
      const result = await repo.ingestFromBankFee({
        sourceBankTxId: bankTx.id,
        paperlessDocId: null,
        vendor: 'Volksbank',
        expenseDate: new Date('2099-05-01'),
        amountMinor: 182n,
        currency: 'EUR',
        btwRateBps: 2100,
        btwMinor: 32n,
        locationClass: ExpenseLocationClass.Domestic,
        status: ExpenseStatus.Approved,
        reviewedAt: new Date(),
        notes: 'auto-created from bank fee',
      });
      expect(result.ingested).toBe(true);
      if (result.ingested) {
        expect(result.row.sourceBankTxId).toBe(bankTx.id);
        expect(result.row.paperlessDocId).toBeNull();
        expect(result.row.status).toBe(ExpenseStatus.Approved);
        expect(result.row.btwRateBps).toBe(2100);
      }
    });

    it('idempotent on duplicate sourceBankTxId', async () => {
      const bankTx = await ingestBankTx(db);
      const base = {
        sourceBankTxId: bankTx.id,
        paperlessDocId: null,
        vendor: 'Volksbank',
        expenseDate: new Date('2099-05-01'),
        amountMinor: 182n,
        currency: 'EUR',
        btwRateBps: 2100,
        btwMinor: 32n,
        locationClass: ExpenseLocationClass.Domestic,
        status: ExpenseStatus.Approved,
        reviewedAt: new Date(),
        notes: null,
      };
      const first = await repo.ingestFromBankFee(base);
      const second = await repo.ingestFromBankFee(base);
      expect(first.ingested).toBe(true);
      expect(second.ingested).toBe(false);
      if (!second.ingested && first.ingested) {
        expect(second.existingId).toBe(first.row.id);
      }
    });

    it('findBySourceBankTxId returns the auto-created expense', async () => {
      const bankTx = await ingestBankTx(db);
      const ingested = await repo.ingestFromBankFee({
        sourceBankTxId: bankTx.id,
        paperlessDocId: null,
        vendor: 'Volksbank',
        expenseDate: new Date('2099-05-01'),
        amountMinor: 182n,
        currency: 'EUR',
        btwRateBps: 2100,
        btwMinor: 32n,
        locationClass: ExpenseLocationClass.Domestic,
        status: ExpenseStatus.Approved,
        reviewedAt: new Date(),
        notes: null,
      });
      if (!ingested.ingested) {
        throw new Error('precondition');
      }
      const found = await repo.findBySourceBankTxId(bankTx.id);
      expect(found?.id).toBe(ingested.row.id);
    });

    it('rejects an expense with neither paperlessDocId nor sourceBankTxId (CHECK constraint)', async () => {
      await expect(
        repo.ingest({
          paperlessDocId: null,
          vendor: 'orphan',
          expenseDate: new Date('2099-05-01'),
          amountMinor: 100n,
          currency: 'EUR',
          btwRateBps: null,
          btwMinor: null,
          locationClass: ExpenseLocationClass.Domestic,
          category: '',
          notes: null,
          sourceEventId: null,
        } as NewExpense),
      ).rejects.toThrow();
    });
  });
});
