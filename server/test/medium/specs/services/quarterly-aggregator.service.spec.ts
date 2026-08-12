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
    aggregator = new QuarterlyAggregatorService(invoiceRepo, transferRepo, expenseRepo, bankRepo);
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

  // Kasstelsel: paid-in-Q2, receipt-arrived-in-Q3 belongs in the Q2 rollup
  // even though the paperless doc (expenseDate) is dated Q3. Regression: the
  // aggregator used to filter approved expenses by expenseDate directly, so
  // this class of expense silently dropped out of the paying quarter's
  // deductible-BTW total.
  it('counts an approved expense in the quarter of its matched bank-tx date (not expenseDate)', async () => {
    const ingest = await expenseRepo.ingest({
      paperlessDocId: 'doc-cross-quarter',
      vendor: 'Late-Arriving Vendor',
      // Receipt date is in Q3 — the paperless doc came in weeks after payment.
      expenseDate: new Date('2099-08-15'),
      amountMinor: 12_100n,
      currency: 'EUR',
      btwRateBps: 2100,
      btwMinor: 2100n,
      locationClass: ExpenseLocationClass.Domestic,
      category: 'hardware',
      notes: null,
      sourceEventId: null,
    });
    if (!ingest.ingested) {
      throw new Error('precondition');
    }
    await expenseRepo.approve(ingest.row.id);
    // Bank transaction cleared in Q2 — this is the payment.
    await bankRepo.ingest({
      source: BankSource.SnsCsv,
      externalId: 'cross-quarter-payment',
      txDate: new Date('2099-05-15'),
      amountMinor: -12_100n,
      currency: 'EUR',
      counterpartyName: 'Late-Arriving Vendor',
      counterpartyIban: null,
      description: 'Hardware invoice',
      rawPayload: {},
      matchedExpenseId: ingest.row.id,
      matchedAt: new Date('2099-05-15'),
    });

    const q2 = await aggregator.aggregate(2099, 2);
    expect(q2.expenses.grossEurMinor).toBe(12_100n);
    expect(q2.expenses.deductibleBtwEurMinor).toBe(2100n);

    // And absent from Q3 — receipt date lives there but payment doesn't.
    const q3 = await aggregator.aggregate(2099, 3);
    expect(q3.expenses.grossEurMinor).toBe(0n);
    expect(q3.expenses.deductibleBtwEurMinor).toBe(0n);
  });

  // Opposite-direction cross-quarter case: receipt arrived early but the
  // payment didn't clear until the next quarter (e.g. invoice terms of
  // net-30, or a vendor delay). The expense belongs in the quarter the
  // money actually left the account.
  it('counts an approved expense in the payment quarter when receipt predates payment', async () => {
    const ingest = await expenseRepo.ingest({
      paperlessDocId: 'doc-early-receipt',
      vendor: 'Slow-Pay Vendor',
      // Receipt in Q2 — invoice arrived early, sat in the queue.
      expenseDate: new Date('2099-05-25'),
      amountMinor: 8000n,
      currency: 'EUR',
      btwRateBps: 2100,
      btwMinor: 1388n,
      locationClass: ExpenseLocationClass.Domestic,
      category: 'services',
      notes: null,
      sourceEventId: null,
    });
    if (!ingest.ingested) {
      throw new Error('precondition');
    }
    await expenseRepo.approve(ingest.row.id);
    // Payment cleared in Q3.
    await bankRepo.ingest({
      source: BankSource.SnsCsv,
      externalId: 'slow-pay-payment',
      txDate: new Date('2099-08-05'),
      amountMinor: -8000n,
      currency: 'EUR',
      counterpartyName: 'Slow-Pay Vendor',
      counterpartyIban: null,
      description: 'Consulting fee',
      rawPayload: {},
      matchedExpenseId: ingest.row.id,
      matchedAt: new Date('2099-08-05'),
    });

    const q2 = await aggregator.aggregate(2099, 2);
    expect(q2.expenses.grossEurMinor).toBe(0n);
    expect(q2.expenses.deductibleBtwEurMinor).toBe(0n);

    const q3 = await aggregator.aggregate(2099, 3);
    expect(q3.expenses.grossEurMinor).toBe(8000n);
    expect(q3.expenses.deductibleBtwEurMinor).toBe(1388n);
  });

  // Partial-payment case: if one expense is settled by multiple bank_txs
  // across quarters, the latest txDate wins — the expense is only fully
  // paid on the last transaction. Partial-payment attribution per quarter
  // would need per-payment amounts, which we don't model today.
  it('uses the latest bank-tx date when multiple payments match one expense across quarters', async () => {
    const ingest = await expenseRepo.ingest({
      paperlessDocId: 'doc-partial-pay',
      vendor: 'Split-Pay Vendor',
      expenseDate: new Date('2099-05-01'),
      amountMinor: 20_000n,
      currency: 'EUR',
      btwRateBps: 2100,
      btwMinor: 3471n,
      locationClass: ExpenseLocationClass.Domestic,
      category: 'services',
      notes: null,
      sourceEventId: null,
    });
    if (!ingest.ingested) {
      throw new Error('precondition');
    }
    await expenseRepo.approve(ingest.row.id);
    // First half paid in Q2, second half in Q3.
    await bankRepo.ingest({
      source: BankSource.SnsCsv,
      externalId: 'partial-pay-1',
      txDate: new Date('2099-05-20'),
      amountMinor: -10_000n,
      currency: 'EUR',
      counterpartyName: 'Split-Pay Vendor',
      counterpartyIban: null,
      description: 'Partial 1/2',
      rawPayload: {},
      matchedExpenseId: ingest.row.id,
      matchedAt: new Date('2099-05-20'),
    });
    await bankRepo.ingest({
      source: BankSource.SnsCsv,
      externalId: 'partial-pay-2',
      txDate: new Date('2099-07-10'),
      amountMinor: -10_000n,
      currency: 'EUR',
      counterpartyName: 'Split-Pay Vendor',
      counterpartyIban: null,
      description: 'Partial 2/2',
      rawPayload: {},
      matchedExpenseId: ingest.row.id,
      matchedAt: new Date('2099-07-10'),
    });

    const q2 = await aggregator.aggregate(2099, 2);
    expect(q2.expenses.grossEurMinor).toBe(0n);

    const q3 = await aggregator.aggregate(2099, 3);
    expect(q3.expenses.grossEurMinor).toBe(20_000n);
    expect(q3.expenses.deductibleBtwEurMinor).toBe(3471n);
  });

  // Wise-flow foreign-currency expense: linked to a wise_transfer sweep,
  // EUR back-filled at sweep-clear time from the sweep's realized rate,
  // and counted in the sweep's quarter (matching how invoice income is
  // counted for the same USD pool).
  it('counts a wise-flow USD expense at proportional-EUR in the sweep quarter', async () => {
    // Sweep: $4791 USD → €4045.72 EUR, cleared in Q3 (bank_tx txDate Q3).
    const transfer = await transferRepo.create({
      wiseTransferId: 'WISE-Q3',
      direction: WiseTransferDirection.Out,
      sourceAmountMinor: 479_100n,
      sourceCurrency: 'USD',
      targetAmountMinor: 404_572n,
      targetCurrency: 'EUR',
      fxRate: '0.846991',
      feeMinor: 1442n,
      feeCurrency: 'USD',
      state: WiseTransferState.OutgoingPaymentSent,
      stateUpdatedAt: new Date('2099-08-20'),
      ourReference: 'TXN-0099',
      counterpartyName: null,
      correlationId: null,
    });
    await bankRepo.ingest({
      source: BankSource.SnsCsv,
      externalId: 'sweep-q3',
      txDate: new Date('2099-08-20'),
      amountMinor: 404_572n,
      currency: 'EUR',
      counterpartyName: 'Wise',
      counterpartyIban: null,
      description: 'TXN-0099',
      rawPayload: {},
      matchedTransferId: transfer.id,
      matchedAt: new Date('2099-08-20'),
    });

    // The USD card charge itself: dated Q2 on the receipt, but the sweep
    // that will realize its EUR value cleared in Q3.
    const ingest = await expenseRepo.ingest({
      paperlessDocId: 'doc-wise-flow',
      vendor: 'US Vendor',
      expenseDate: new Date('2099-05-10'),
      amountMinor: 15_000n,
      currency: 'USD',
      wiseTransferId: transfer.id,
      // EUR/fxRate back-filled by the app at sweep-clear; here we seed
      // them directly since we're testing the aggregator, not the matcher.
      eurAmountMinor: 12_666n,
      fxRate: '0.846991',
      btwRateBps: null,
      btwMinor: null,
      locationClass: ExpenseLocationClass.NonEu,
      category: 'services',
      notes: null,
      sourceEventId: null,
    });
    if (!ingest.ingested) {
      throw new Error('precondition');
    }
    await expenseRepo.approve(ingest.row.id);

    // Absent from Q2 (the charge quarter) — recognition follows the sweep.
    const q2 = await aggregator.aggregate(2099, 2);
    expect(q2.expenses.grossEurMinor).toBe(0n);

    // Counted in Q3 at the back-filled EUR value. Non-EU location →
    // contributes gross but not deductible BTW.
    const q3 = await aggregator.aggregate(2099, 3);
    expect(q3.expenses.grossEurMinor).toBe(12_666n);
    expect(q3.expenses.deductibleBtwEurMinor).toBe(0n);
  });

  // Fallback path: an approved expense with no matched bank_tx (cash purchase
  // or manual entry) still counts by expenseDate. Confirms the coalesce works.
  it('falls back to expenseDate when the approved expense has no matched bank-tx', async () => {
    const ingest = await expenseRepo.ingest({
      paperlessDocId: 'doc-unmatched',
      vendor: 'Cash Purchase',
      expenseDate: new Date('2099-02-10'),
      amountMinor: 5000n,
      currency: 'EUR',
      btwRateBps: 2100,
      btwMinor: 868n,
      locationClass: ExpenseLocationClass.Domestic,
      category: 'supplies',
      notes: null,
      sourceEventId: null,
    });
    if (!ingest.ingested) {
      throw new Error('precondition');
    }
    await expenseRepo.approve(ingest.row.id);

    const q1 = await aggregator.aggregate(2099, 1);
    expect(q1.expenses.grossEurMinor).toBe(5000n);
    expect(q1.expenses.deductibleBtwEurMinor).toBe(868n);
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

  it('does not flag Wise-flow invoices as awaiting payment', async () => {
    // Wise-flow invoices link to the bank-tx via wise_transfer (not via
    // bank_tx.matchedInvoiceId), AND only exist post-outgoing_payment_sent.
    // The naive unmatched query would treat them as unpaid forever; this
    // test guards against that regression.
    const nonEu = await clientRepo.create({
      name: 'FUTO',
      class: ClientClass.NonEu,
      tradeName: TradeName.ItServices,
      address: { line1: 'X', city: 'Y' },
    });
    const transfer = await transferRepo.create({
      wiseTransferId: 'WISE-AGG-1',
      direction: WiseTransferDirection.Out,
      sourceAmountMinor: 479_100n,
      sourceCurrency: 'USD',
      targetAmountMinor: 404_572n,
      targetCurrency: 'EUR',
      fxRate: '0.846991',
      feeMinor: 1442n,
      feeCurrency: 'USD',
      state: WiseTransferState.OutgoingPaymentSent,
      stateUpdatedAt: new Date('2099-02-10'),
      ourReference: 'TXN-AGG-1',
    });
    await invoiceRepo.issue({
      year: 2099,
      invoice: {
        clientId: nonEu.id,
        issuedAt: new Date('2099-02-15'),
        currency: 'USD',
        totalMinor: 479_100n,
        eurTotalMinor: 404_572n,
        wiseTransferId: transfer.id,
      },
      lines: [{ ordinal: 0, description: 'X', lineTotalMinor: 479_100n, unitLabel: null, quantity: null }],
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
