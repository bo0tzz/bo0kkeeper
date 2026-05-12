import { Kysely } from 'kysely';
import {
  BankSource,
  ClientClass,
  ExpenseLocationClass,
  ExpenseStatus,
  TradeName,
  WiseTransferDirection,
  WiseTransferState,
} from 'src/enum';
import { BankTransactionRepository } from 'src/repositories/bank-transaction.repository';
import { ClientRepository } from 'src/repositories/client.repository';
import { ExpenseRepository } from 'src/repositories/expense.repository';
import { InvoiceRepository } from 'src/repositories/invoice.repository';
import { WiseTransferRepository } from 'src/repositories/wise-transfer.repository';
import { DB } from 'src/schema';
import { QuarterlyAggregatorService, quarterRange } from 'src/services/quarterly-aggregator.service';
import { getKyselyDB } from 'test/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('quarterRange', () => {
  it('Q1 starts Jan 1 and ends Apr 1', () => {
    const r = quarterRange(2099, 1);
    expect(r.periodStart.toISOString()).toBe('2099-01-01T00:00:00.000Z');
    expect(r.periodEnd.toISOString()).toBe('2099-04-01T00:00:00.000Z');
  });

  it('Q4 ends at the start of the next year', () => {
    const r = quarterRange(2099, 4);
    expect(r.periodStart.toISOString()).toBe('2099-10-01T00:00:00.000Z');
    expect(r.periodEnd.toISOString()).toBe('2100-01-01T00:00:00.000Z');
  });
});

describe('QuarterlyAggregatorService', () => {
  let db: Kysely<DB>;
  let bankRepo: BankTransactionRepository;
  let invoiceRepo: InvoiceRepository;
  let clientRepo: ClientRepository;
  let expenseRepo: ExpenseRepository;
  let transferRepo: WiseTransferRepository;
  let aggregator: QuarterlyAggregatorService;

  beforeEach(async () => {
    db = await getKyselyDB();
    bankRepo = new BankTransactionRepository(db);
    invoiceRepo = new InvoiceRepository(db);
    clientRepo = new ClientRepository(db);
    expenseRepo = new ExpenseRepository(db);
    transferRepo = new WiseTransferRepository(db);
    aggregator = new QuarterlyAggregatorService(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('aggregates income by client class on bank-tx date (kasstelsel)', async () => {
    const domestic = await clientRepo.create({
      name: 'Acme Studio',
      class: ClientClass.Domestic,
      tradeName: TradeName.ItServices,
      address: { line1: 'X', city: 'Y' },
    });

    // Domestic invoice issued and paid in Q1: 1000.00 + 21% BTW = 1210.00.
    const paidInvoice = await invoiceRepo.issue({
      year: 2099,
      invoice: {
        clientId: domestic.id,
        issuedAt: new Date('2099-02-15'),
        currency: 'EUR',
        totalMinor: 121_000n,
        btwRateBps: 2100,
        btwMinor: 21_000n,
        sourceEventId: null,
      },
      lines: [{ ordinal: 0, description: 'Services', lineTotalMinor: 121_000n, unitLabel: null, quantity: null }],
    });
    await bankRepo.ingest({
      source: BankSource.SnsCsv,
      externalId: 'q1:domestic-paid',
      txDate: new Date('2099-02-20'),
      amountMinor: 121_000n,
      currency: 'EUR',
      counterpartyName: 'Acme Studio',
      counterpartyIban: null,
      description: `Payment for ${paidInvoice.number}`,
      rawPayload: {},
      matchedInvoiceId: paidInvoice.id,
      matchedAt: new Date('2099-02-20'),
    });

    // Non-EU income: USD invoice was issued but hasn't been paid yet, AND a
    // separate Wise transfer landed in the quarter — that's the income.
    const nonEu = await clientRepo.create({
      name: 'OverseasClientCo',
      class: ClientClass.NonEu,
      tradeName: TradeName.ItServices,
      address: { line1: 'X', city: 'Y' },
    });
    await invoiceRepo.issue({
      year: 2099,
      invoice: {
        clientId: nonEu.id,
        issuedAt: new Date('2099-03-15'),
        currency: 'USD',
        totalMinor: 500_000n,
        eurTotalMinor: 450_000n,
        fxRate: '0.9',
        btwRateBps: null,
        btwMinor: null,
        sourceEventId: null,
      },
      lines: [{ ordinal: 0, description: 'Services', lineTotalMinor: 500_000n, unitLabel: null, quantity: null }],
    });
    const transfer = await transferRepo.create({
      wiseTransferId: 'WISE-Q1',
      direction: WiseTransferDirection.Out,
      sourceAmountMinor: 500_000n,
      sourceCurrency: 'USD',
      targetAmountMinor: 450_000n,
      targetCurrency: 'EUR',
      fxRate: '0.9',
      feeMinor: 1500n,
      feeCurrency: 'USD',
      state: WiseTransferState.OutgoingPaymentSent,
      stateUpdatedAt: new Date('2099-03-20'),
      ourReference: 'TXN-0044',
      counterpartyName: null,
      correlationId: null,
    });
    await bankRepo.ingest({
      source: BankSource.SnsCsv,
      externalId: 'q1:wise-landed',
      txDate: new Date('2099-03-20'),
      amountMinor: 450_000n,
      currency: 'EUR',
      counterpartyName: 'Wise',
      counterpartyIban: null,
      description: 'TXN-0044',
      rawPayload: {},
      matchedTransferId: transfer.id,
      matchedAt: new Date('2099-03-20'),
    });

    // Invoice issued in Q1 but paid in Q2 — must NOT count toward Q1 income.
    const unpaidInvoice = await invoiceRepo.issue({
      year: 2099,
      invoice: {
        clientId: domestic.id,
        issuedAt: new Date('2099-03-30'),
        currency: 'EUR',
        totalMinor: 50_000n,
        btwRateBps: 2100,
        btwMinor: 8678n,
        sourceEventId: null,
      },
      lines: [{ ordinal: 0, description: 'Late', lineTotalMinor: 50_000n, unitLabel: null, quantity: null }],
    });
    await bankRepo.ingest({
      source: BankSource.SnsCsv,
      externalId: 'q2:domestic-late',
      txDate: new Date('2099-04-05'),
      amountMinor: 50_000n,
      currency: 'EUR',
      counterpartyName: 'Acme Studio',
      counterpartyIban: null,
      description: `Payment for ${unpaidInvoice.number}`,
      rawPayload: {},
      matchedInvoiceId: unpaidInvoice.id,
      matchedAt: new Date('2099-04-05'),
    });

    const result = await aggregator.aggregate(2099, 1);

    expect(result.income.byClass[ClientClass.Domestic]).toEqual({
      invoiceCount: 1,
      grossEurMinor: 121_000n,
      btwEurMinor: 21_000n,
    });
    expect(result.income.byClass[ClientClass.NonEu]).toEqual({
      invoiceCount: 1,
      grossEurMinor: 450_000n,
      btwEurMinor: 0n,
    });
    expect(result.income.totalGrossEurMinor).toBe(571_000n);
    expect(result.income.totalBtwEurMinor).toBe(21_000n);
  });

  it('subtracts deductible expense BTW from collected to compute net', async () => {
    // No income, just two approved expenses in Q1.
    await expenseRepo.ingest({
      paperlessDocId: 'doc-A',
      vendor: 'Acme Cables',
      expenseDate: new Date('2099-02-01'),
      amountMinor: 12_100n,
      currency: 'EUR',
      btwRateBps: 2100,
      btwMinor: 2100n,
      locationClass: ExpenseLocationClass.Domestic,
      category: 'hardware',
      notes: null,
      sourceEventId: null,
    });
    const second = await expenseRepo.ingest({
      paperlessDocId: 'doc-B',
      vendor: 'Cloud Hosting',
      expenseDate: new Date('2099-03-01'),
      amountMinor: 10_000n,
      currency: 'EUR',
      btwRateBps: 0,
      btwMinor: 0n,
      locationClass: ExpenseLocationClass.EuReverseCharge,
      category: 'hosting',
      notes: null,
      sourceEventId: null,
    });
    if (!second.ingested) {
      throw new Error('precondition');
    }
    // One must be approved before it's counted.
    await expenseRepo.approve(second.row.id);
    const firstIngest = await expenseRepo.findPendingReview();
    await expenseRepo.approve(firstIngest[0].id);

    const result = await aggregator.aggregate(2099, 1);
    expect(result.expenses.grossEurMinor).toBe(22_100n);
    // Only domestic expense yields deductible BTW (reverse-charge doesn't).
    expect(result.expenses.deductibleBtwEurMinor).toBe(2100n);
    expect(result.netBtwEurMinor).toBe(-2100n);
  });

  it('warning count matches the sample (regression: count was filtered to period-only)', async () => {
    // Invoice issued in Q1, viewed from Q2's rollup. The sample query picks it
    // up (issued before Q2 end, unmatched). The count must too — a previous
    // bug filtered the count by `>= periodStart`, returning 0 even when
    // sampleNumbers had entries.
    const domestic = await clientRepo.create({
      name: 'Acme Studio',
      class: ClientClass.Domestic,
      tradeName: TradeName.ItServices,
      address: { line1: 'X', city: 'Y' },
    });
    await invoiceRepo.issue({
      year: 2099,
      invoice: {
        clientId: domestic.id,
        issuedAt: new Date('2099-02-15'),
        currency: 'EUR',
        totalMinor: 100n,
        btwRateBps: 2100,
        btwMinor: 17n,
        sourceEventId: null,
      },
      lines: [{ ordinal: 0, description: 'X', lineTotalMinor: 100n, unitLabel: null, quantity: null }],
    });

    const result = await aggregator.aggregate(2099, 2);
    const unmatched = result.warnings.find((w) => w.kind === 'invoice_unmatched');
    expect(unmatched).toBeDefined();
    if (unmatched && unmatched.kind === 'invoice_unmatched') {
      expect(unmatched.count).toBe(1);
      expect(unmatched.sampleNumbers).toHaveLength(1);
    }
  });

  it('flags unmatched invoices and pending-review expenses as warnings', async () => {
    const domestic = await clientRepo.create({
      name: 'Acme Studio',
      class: ClientClass.Domestic,
      tradeName: TradeName.ItServices,
      address: { line1: 'X', city: 'Y' },
    });
    await invoiceRepo.issue({
      year: 2099,
      invoice: {
        clientId: domestic.id,
        issuedAt: new Date('2099-02-15'),
        currency: 'EUR',
        totalMinor: 100n,
        btwRateBps: 2100,
        btwMinor: 17n,
        sourceEventId: null,
      },
      lines: [{ ordinal: 0, description: 'X', lineTotalMinor: 100n, unitLabel: null, quantity: null }],
    });
    await expenseRepo.ingest({
      paperlessDocId: 'doc-pending',
      vendor: 'Pending Vendor',
      expenseDate: new Date('2099-02-20'),
      amountMinor: 100n,
      currency: 'EUR',
      btwRateBps: null,
      btwMinor: null,
      locationClass: ExpenseLocationClass.Domestic,
      category: '',
      notes: null,
      sourceEventId: null,
    });

    const result = await aggregator.aggregate(2099, 1);
    const kinds = result.warnings.map((w) => w.kind);
    expect(kinds).toContain('invoice_unmatched');
    expect(kinds).toContain('expense_pending_review');
  });

  it('counts the invoice as matched when a bank tx links to it', async () => {
    const domestic = await clientRepo.create({
      name: 'Acme Studio',
      class: ClientClass.Domestic,
      tradeName: TradeName.ItServices,
      address: { line1: 'X', city: 'Y' },
    });
    const invoice = await invoiceRepo.issue({
      year: 2099,
      invoice: {
        clientId: domestic.id,
        issuedAt: new Date('2099-02-15'),
        currency: 'EUR',
        totalMinor: 100n,
        btwRateBps: 2100,
        btwMinor: 17n,
        sourceEventId: null,
      },
      lines: [{ ordinal: 0, description: 'X', lineTotalMinor: 100n, unitLabel: null, quantity: null }],
    });
    await bankRepo.ingest({
      source: BankSource.SnsCsv,
      externalId: 'q1:matched',
      txDate: new Date('2099-02-16'),
      amountMinor: 100n,
      currency: 'EUR',
      counterpartyName: 'Acme Studio',
      counterpartyIban: null,
      description: `payment for ${invoice.number}`,
      rawPayload: {},
      matchedInvoiceId: invoice.id,
      matchedAt: new Date('2099-02-16'),
    });

    const result = await aggregator.aggregate(2099, 1);
    expect(result.warnings.find((w) => w.kind === 'invoice_unmatched')).toBeUndefined();
  });

  it('returns zeroed buckets when the quarter has no activity', async () => {
    const result = await aggregator.aggregate(2099, 3);
    expect(result.income.totalGrossEurMinor).toBe(0n);
    expect(result.income.totalBtwEurMinor).toBe(0n);
    expect(result.expenses.grossEurMinor).toBe(0n);
    expect(result.netBtwEurMinor).toBe(0n);
    expect(result.warnings).toEqual([]);

    // ExpenseStatus enum is referenced to silence the unused-import lint.
    expect(ExpenseStatus.Approved).toBeDefined();
  });
});
