import { Kysely } from 'kysely';
import {
  BankSource,
  BankTxCategory,
  ClientClass,
  ExpenseLocationClass,
  MatchConfidence,
  TradeName,
  WiseTransferDirection,
  WiseTransferState,
} from 'src/enum';
import { BankTransactionRepository, NewBankTransaction } from 'src/repositories/bank-transaction.repository';
import { ClientRepository } from 'src/repositories/client.repository';
import { ExpenseRepository } from 'src/repositories/expense.repository';
import { InvoiceRepository } from 'src/repositories/invoice.repository';
import { WiseTransferRepository } from 'src/repositories/wise-transfer.repository';
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

    // Regression: the /banking UI needs an identifier for whichever entity a
    // row is matched to — before this, all it saw was a raw UUID.
    it('surfaces the matched entity label alongside its FK', async () => {
      const expenseRepo = new ExpenseRepository(db);
      const invoiceRepo = new InvoiceRepository(db);
      const clientRepo = new ClientRepository(db);
      const transferRepo = new WiseTransferRepository(db);

      // Expense with a clear vendor to assert against.
      const expenseIngest = await expenseRepo.ingest({
        paperlessDocId: 'doc-labels-1',
        vendor: 'Acme Cables',
        expenseDate: new Date('2099-04-01'),
        amountMinor: 12_100n,
        currency: 'EUR',
        btwRateBps: 2100,
        btwMinor: 2100n,
        locationClass: ExpenseLocationClass.Domestic,
        category: 'hardware',
        notes: null,
        sourceEventId: null,
      });
      if (!expenseIngest.ingested) {
        throw new Error('precondition: expense');
      }

      // Invoice with a real number to assert against.
      const client = await clientRepo.create({
        name: 'Big Client',
        class: ClientClass.Domestic,
        tradeName: TradeName.ItServices,
        address: { line1: 'X', city: 'Y' },
      });
      const invoice = await invoiceRepo.issue({
        year: 2099,
        invoice: {
          clientId: client.id,
          issuedAt: new Date('2099-04-10'),
          currency: 'EUR',
          totalMinor: 121_000n,
          btwRateBps: 2100,
          btwMinor: 21_000n,
          sourceEventId: null,
        },
        lines: [{ ordinal: 0, description: 'Services', lineTotalMinor: 121_000n, unitLabel: null, quantity: null }],
      });

      // Wise transfer with a real ourReference to assert against.
      const transfer = await transferRepo.create({
        wiseTransferId: 'WISE-LABEL-1',
        direction: WiseTransferDirection.Out,
        sourceAmountMinor: 100_000n,
        sourceCurrency: 'USD',
        targetAmountMinor: 90_000n,
        targetCurrency: 'EUR',
        fxRate: '0.9',
        feeMinor: 500n,
        feeCurrency: 'USD',
        state: WiseTransferState.OutgoingPaymentSent,
        stateUpdatedAt: new Date('2099-04-15'),
        ourReference: 'TXN-0099',
        counterpartyName: null,
        correlationId: null,
      });

      const matchedToExpense = await ingest('m-expense', '2099-04-02');
      const matchedToInvoice = await ingest('m-invoice', '2099-04-11');
      const matchedToTransfer = await ingest('m-transfer', '2099-04-16');
      const unmatched = await ingest('m-none', '2099-04-20');
      await repo.setMatch(matchedToExpense.id, { type: 'expense', id: expenseIngest.row.id }, MatchConfidence.Manual);
      await repo.setMatch(matchedToInvoice.id, { type: 'invoice', id: invoice.id }, MatchConfidence.Manual);
      await repo.setMatch(matchedToTransfer.id, { type: 'wise_transfer', id: transfer.id }, MatchConfidence.Manual);

      const result = await repo.findPaginated({ offset: 0, limit: 50 });
      const byExternal = Object.fromEntries(result.items.map((row) => [row.externalId, row]));

      expect(byExternal['m-expense'].matchedExpenseLabel).toBe('Acme Cables');
      expect(byExternal['m-expense'].matchedInvoiceLabel).toBeNull();
      expect(byExternal['m-expense'].matchedTransferLabel).toBeNull();

      expect(byExternal['m-invoice'].matchedInvoiceLabel).toBe(invoice.number);
      expect(byExternal['m-invoice'].matchedExpenseLabel).toBeNull();

      expect(byExternal['m-transfer'].matchedTransferLabel).toBe('TXN-0099');
      expect(byExternal['m-transfer'].matchedInvoiceLabel).toBeNull();

      expect(byExternal['m-none'].matchedExpenseLabel).toBeNull();
      expect(byExternal['m-none'].matchedInvoiceLabel).toBeNull();
      expect(byExternal['m-none'].matchedTransferLabel).toBeNull();
      expect(unmatched.id).toBe(byExternal['m-none'].id);
    });
  });
});
