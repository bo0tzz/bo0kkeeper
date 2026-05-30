import { Kysely } from 'kysely';
import {
  BankSource,
  ClientClass,
  EventSource,
  ExpenseLocationClass,
  ExpenseStatus,
  MatchConfidence,
  TradeName,
  WiseTransferDirection,
  WiseTransferState,
} from 'src/enum';
import { BankTransactionRepository } from 'src/repositories/bank-transaction.repository';
import { ClientRepository } from 'src/repositories/client.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { ExpenseRepository } from 'src/repositories/expense.repository';
import { InvoiceRepository } from 'src/repositories/invoice.repository';
import { WiseTransferRepository } from 'src/repositories/wise-transfer.repository';
import { DB } from 'src/schema';
import { BankMatcherService } from 'src/services/bank-matcher.service';
import { RecurringFeeService } from 'src/services/recurring-fee.service';
import { SheetSyncService } from 'src/services/sheet-sync.service';
import { SheetWriterService } from 'src/services/sheet-writer.service';
import { getKyselyDB } from 'test/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  process.env.OIDC_ISSUER ??= 'http://idp.test';
  process.env.OIDC_CLIENT_ID ??= 'test';
  process.env.OIDC_REDIRECT_URI ??= 'http://localhost/callback';
  process.env.CUTOVER_DATE ??= '2000-01-01';
});

async function ingestSnsFeeRow(repo: BankTransactionRepository, externalId: string, description: string) {
  const result = await repo.ingest({
    source: BankSource.SnsCsv,
    externalId,
    txDate: new Date('2099-04-01'),
    amountMinor: -182n,
    currency: 'EUR',
    counterpartyName: 'SNS Bank',
    counterpartyIban: null,
    description,
    rawPayload: {},
  });
  if (!result.ingested) {
    throw new Error('precondition');
  }
  return result.row;
}

describe('BankMatcherService', () => {
  let db: Kysely<DB>;
  let bankRepo: BankTransactionRepository;
  let transferRepo: WiseTransferRepository;
  let invoiceRepo: InvoiceRepository;
  let clientRepo: ClientRepository;
  let sheetWriter: SheetWriterService & {
    writeIncomeRow: ReturnType<typeof vi.fn>;
    writeExpenseRow: ReturnType<typeof vi.fn>;
  };
  let matcher: BankMatcherService;
  let sheetSync: SheetSyncService;
  let recurringFee: RecurringFeeService;

  beforeEach(async () => {
    db = await getKyselyDB();
    bankRepo = new BankTransactionRepository(db);
    transferRepo = new WiseTransferRepository(db);
    invoiceRepo = new InvoiceRepository(db);
    clientRepo = new ClientRepository(db);
    sheetWriter = {
      writeIncomeRow: vi.fn().mockResolvedValue(void 0),
      writeExpenseRow: vi.fn().mockResolvedValue(void 0),
    } as unknown as SheetWriterService & {
      writeIncomeRow: ReturnType<typeof vi.fn>;
      writeExpenseRow: ReturnType<typeof vi.fn>;
    };
    sheetSync = new SheetSyncService(db, clientRepo, sheetWriter, new EventRepository(db));
    recurringFee = new RecurringFeeService(bankRepo, new ExpenseRepository(db), new EventRepository(db), sheetSync);
    matcher = new BankMatcherService(db, bankRepo, sheetSync, new EventRepository(db), recurringFee);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('matches a bank tx to a wise_transfer via TXN-NNNN reference (auto_high)', async () => {
    // Seed a sole NonEu client so the sheet write picks it up by class.
    const nonEuClient = await clientRepo.create({
      name: 'OverseasClientCo',
      class: ClientClass.NonEu,
      tradeName: TradeName.ItServices,
      address: { line1: '1 Fake Park Dr', city: 'Nullstate' },
    });

    const transfer = await transferRepo.create({
      wiseTransferId: 'WISE-1',
      direction: WiseTransferDirection.Out,
      sourceAmountMinor: 479_100n,
      sourceCurrency: 'USD',
      targetAmountMinor: 404_572n,
      targetCurrency: 'EUR',
      fxRate: '0.846991',
      feeMinor: 1442n,
      feeCurrency: 'USD',
      state: WiseTransferState.OutgoingPaymentSent,
      stateUpdatedAt: new Date(),
      ourReference: 'TXN-0044',
      counterpartyName: null,
      correlationId: null,
    });

    const ingest = await bankRepo.ingest({
      source: BankSource.SnsCsv,
      externalId: '50:1',
      txDate: new Date('2099-01-15'),
      amountMinor: 404_572n,
      currency: 'EUR',
      counterpartyName: 'Test Account Holder',
      counterpartyIban: 'BE03967415006984',
      description: '1234567-BE03967415006984-Test Account Holder-TXN-0044',
      rawPayload: {},
    });
    expect(ingest.ingested).toBe(true);
    if (!ingest.ingested) {
      throw new Error('precondition');
    }

    const result = await matcher.tryMatch(ingest.row);
    expect(result.matched).toBe(true);
    if (result.matched && result.type === 'wise_transfer') {
      expect(result.transferId).toBe(transfer.id);
      expect(result.confidence).toBe(MatchConfidence.AutoHigh);
    }

    const refetched = await bankRepo.findById(ingest.row.id);
    expect(refetched?.matchedTransferId).toBe(transfer.id);
    expect(refetched?.matchConfidence).toBe(MatchConfidence.AutoHigh);
    expect(refetched?.matchedAt).toBeInstanceOf(Date);

    // Wise income row appended with the unique NonEu client and TXN ref as id.
    expect(sheetWriter.writeIncomeRow).toHaveBeenCalledOnce();
    const args = sheetWriter.writeIncomeRow.mock.calls[0][0] as {
      invoiceNumber: string;
      eurAmountMinor: bigint;
      client: { name: string; class: ClientClass };
      from?: string;
    };
    expect(args.invoiceNumber).toBe('TXN-0044');
    expect(args.eurAmountMinor).toBe(404_572n);
    expect(args.client.name).toBe(nonEuClient.name);
    expect(args.client.class).toBe(ClientClass.NonEu);
    // Do NOT carry the bank counterparty into From — that's "Wise" (the
    // routing service), not the originating Non-EU client. Falling through
    // lets writeIncomeRow default From to client.name.
    expect(args.from).toBeUndefined();
  });

  it('matches a bank tx to an invoice via YYYY/NNN reference', async () => {
    const client = await clientRepo.create({
      name: 'Acme Studio',
      class: ClientClass.Domestic,
      tradeName: TradeName.ItServices,
      address: { line1: 'X', city: 'Y' },
    });
    const invoice = await invoiceRepo.issue({
      year: 2099,
      invoice: {
        clientId: client.id,
        issuedAt: new Date('2099-03-05'),
        currency: 'EUR',
        totalMinor: 23_898n,
        btwRateBps: 2100,
        btwMinor: 4148n,
        sourceEventId: null,
      },
      lines: [{ ordinal: 0, description: 'Services', lineTotalMinor: 23_898n, unitLabel: null, quantity: null }],
    });

    const ingest = await bankRepo.ingest({
      source: BankSource.SnsCsv,
      externalId: '60:2',
      txDate: new Date('2099-03-05'),
      amountMinor: 23_898n,
      currency: 'EUR',
      counterpartyName: 'F. Acme Studio',
      counterpartyIban: 'NL00BANK0000000000',
      description: '3D print services (2099/001)',
      rawPayload: {},
    });
    if (!ingest.ingested) {
      throw new Error('precondition');
    }

    const result = await matcher.tryMatch(ingest.row);
    expect(result.matched).toBe(true);
    if (result.matched && result.type === 'invoice') {
      expect(result.invoiceId).toBe(invoice.id);
    }

    const refetched = await bankRepo.findById(ingest.row.id);
    expect(refetched?.matchedInvoiceId).toBe(invoice.id);

    // Sheet income row appended (kasstelsel — payment received in NL bank).
    expect(sheetWriter.writeIncomeRow).toHaveBeenCalledOnce();
    const args = sheetWriter.writeIncomeRow.mock.calls[0][0] as {
      invoiceNumber: string;
      eurAmountMinor: bigint;
      client: { name: string; class: ClientClass };
      from: string;
      source: string;
      vatPercent: string | undefined;
      vatMinor: bigint | undefined;
    };
    expect(args.invoiceNumber).toBe(invoice.number);
    expect(args.eurAmountMinor).toBe(23_898n);
    expect(args.client.name).toBe('Acme Studio');
    expect(args.client.class).toBe(ClientClass.Domestic);
    expect(args.from).toBe('F. Acme Studio');
    expect(args.source).toBe(`bank_tx/${ingest.row.id}`);
    // VAT plumbed through from the invoice row (21% / €41.48).
    expect(args.vatPercent).toBe('21%');
    expect(args.vatMinor).toBe(4148n);
  });

  it('absorbs sheet write failures so the match still persists', async () => {
    sheetWriter.writeIncomeRow.mockRejectedValueOnce(new Error('sheets api down'));

    const client = await clientRepo.create({
      name: 'Sheet-Failing Client',
      class: ClientClass.Domestic,
      tradeName: TradeName.ItServices,
      address: { line1: 'X', city: 'Y' },
    });
    const invoice = await invoiceRepo.issue({
      year: 2099,
      invoice: {
        clientId: client.id,
        issuedAt: new Date('2099-04-01'),
        currency: 'EUR',
        totalMinor: 12_100n,
        sourceEventId: null,
      },
      lines: [{ ordinal: 0, description: 'Services', lineTotalMinor: 12_100n, unitLabel: null, quantity: null }],
    });
    const ingest = await bankRepo.ingest({
      source: BankSource.SnsCsv,
      externalId: '60:fail',
      txDate: new Date('2099-04-01'),
      amountMinor: 12_100n,
      currency: 'EUR',
      counterpartyName: 'Sheet-Failing Client',
      counterpartyIban: null,
      description: `Payment for ${invoice.number}`,
      rawPayload: {},
    });
    if (!ingest.ingested) {
      throw new Error('precondition');
    }

    const result = await matcher.tryMatch(ingest.row);
    expect(result.matched).toBe(true);

    const refetched = await bankRepo.findById(ingest.row.id);
    expect(refetched?.matchedInvoiceId).toBe(invoice.id);

    // Audit event records the failure so the operator can act on it from /events.
    const events = await db
      .selectFrom('event')
      .selectAll()
      .where('eventType', '=', 'sheet.write_failed')
      .where('source', '=', EventSource.System)
      .execute();
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      kind: 'invoice',
      identifier: invoice.number,
      bankTxId: ingest.row.id,
    });

    // The bank_tx has no sheetRowAt because the write failed — it's now a
    // candidate for the retry job.
    expect(refetched?.sheetRowAt).toBeNull();

    // Recover: stop rejecting, run the retry job. It should pick up the
    // bank_tx, re-invoke the write, and mark sheetRowAt.
    sheetWriter.writeIncomeRow.mockResolvedValue(void 0);
    const retryResult = await sheetSync.retryFailedSheetWrites({});
    expect(retryResult.attempted).toBe(1);
    expect(retryResult.succeeded).toBe(1);
    const recovered = await bankRepo.findById(ingest.row.id);
    expect(recovered?.sheetRowAt).toBeInstanceOf(Date);
  });

  it('returns matched:false when no signal is present', async () => {
    const ingest = await bankRepo.ingest({
      source: BankSource.SnsCsv,
      externalId: '70:3',
      txDate: new Date('2099-04-01'),
      amountMinor: -1000n,
      currency: 'EUR',
      counterpartyName: 'Random Vendor',
      counterpartyIban: null,
      description: 'no recognizable references in this text',
      rawPayload: {},
    });
    if (!ingest.ingested) {
      throw new Error('precondition');
    }

    const result = await matcher.tryMatch(ingest.row);
    expect(result.matched).toBe(false);
  });

  it('does not re-match an already-matched row', async () => {
    const ingest = await bankRepo.ingest({
      source: BankSource.SnsCsv,
      externalId: '80:4',
      txDate: new Date(),
      amountMinor: 1n,
      currency: 'EUR',
      counterpartyName: 'X',
      counterpartyIban: null,
      description: 'no signal',
      rawPayload: {},
      matchedAt: new Date(),
      matchConfidence: MatchConfidence.Manual,
    });
    if (!ingest.ingested) {
      throw new Error('precondition');
    }

    const result = await matcher.tryMatch(ingest.row);
    expect(result.matched).toBe(false);
    if (!result.matched) {
      expect(result.reason).toContain('already matched');
    }
  });

  it('manualMatch to a pending_review expense flips it to approved and writes the sheet row', async () => {
    const expenseRepo = new ExpenseRepository(db);
    const expense = await expenseRepo.ingest({
      paperlessDocId: 'manual-doc-1',
      vendor: 'Acme Cables',
      expenseDate: new Date('2099-04-05'),
      amountMinor: 12_100n,
      currency: 'EUR',
      btwRateBps: 2100,
      btwMinor: 2100n,
      locationClass: ExpenseLocationClass.Domestic,
      category: '',
      notes: 'hub',
      sourceEventId: null,
    });
    if (!expense.ingested) {
      throw new Error('precondition');
    }
    const bankIngest = await bankRepo.ingest({
      source: BankSource.SnsCsv,
      externalId: 'manual-bank-1',
      txDate: new Date('2099-04-10'),
      amountMinor: -12_100n,
      currency: 'EUR',
      counterpartyName: 'Acme Cables BV',
      counterpartyIban: null,
      description: 'card payment',
      rawPayload: {},
    });
    if (!bankIngest.ingested) {
      throw new Error('precondition');
    }

    await matcher.manualMatch(bankIngest.row.id, { type: 'expense', targetId: expense.row.id });

    // Expense flipped to approved.
    const refetched = await db
      .selectFrom('expense')
      .selectAll()
      .where('id', '=', expense.row.id)
      .executeTakeFirstOrThrow();
    expect(refetched.status).toBe(ExpenseStatus.Approved);
    expect(refetched.reviewedAt).not.toBeNull();

    // Sheet row written with the bank-tx date (kasstelsel), not the receipt date.
    expect(sheetWriter.writeExpenseRow).toHaveBeenCalledOnce();
    const args = sheetWriter.writeExpenseRow.mock.calls[0][0] as {
      id: string;
      vendor: string;
      eurAmountMinor: bigint;
      date: Date;
      vatPercent: string | undefined;
      vatMinor: bigint | undefined;
      source: string;
    };
    expect(args.id).toBe('manual-doc-1');
    expect(args.vendor).toBe('Acme Cables');
    expect(args.eurAmountMinor).toBe(12_100n);
    expect(args.date.toISOString().slice(0, 10)).toBe('2099-04-10');
    expect(args.vatPercent).toBe('21%');
    expect(args.vatMinor).toBe(2100n);
    expect(args.source).toBe(`expense/${expense.row.id}`);
  });

  it('manualMatch to an already-approved expense writes the sheet row (approval no longer writes)', async () => {
    const expenseRepo = new ExpenseRepository(db);
    const expense = await expenseRepo.ingest({
      paperlessDocId: 'manual-doc-2',
      vendor: 'Acme Cables',
      expenseDate: new Date('2099-04-05'),
      amountMinor: 5000n,
      currency: 'EUR',
      btwRateBps: null,
      btwMinor: null,
      locationClass: ExpenseLocationClass.Domestic,
      category: '',
      notes: null,
      sourceEventId: null,
    });
    if (!expense.ingested) {
      throw new Error('precondition');
    }
    // Pre-flip to approved (the approval flow itself no longer writes a
    // sheet row, so we should still get exactly one write — from the
    // bank-tx match below).
    await expenseRepo.approve(expense.row.id);
    const bankIngest = await bankRepo.ingest({
      source: BankSource.SnsCsv,
      externalId: 'manual-bank-2',
      txDate: new Date('2099-04-10'),
      amountMinor: -5000n,
      currency: 'EUR',
      counterpartyName: 'Acme Cables',
      counterpartyIban: null,
      description: 'card payment',
      rawPayload: {},
    });
    if (!bankIngest.ingested) {
      throw new Error('precondition');
    }

    await matcher.manualMatch(bankIngest.row.id, { type: 'expense', targetId: expense.row.id });

    // Sheet row fires here (the canonical kasstelsel write); approval was
    // a no-op for the sheet.
    expect(sheetWriter.writeExpenseRow).toHaveBeenCalledOnce();
  });

  it('manualMatch to a rejected expense persists the link but skips the sheet row', async () => {
    const expenseRepo = new ExpenseRepository(db);
    const expense = await expenseRepo.ingest({
      paperlessDocId: 'manual-doc-3',
      vendor: 'TombstoneCo',
      expenseDate: new Date('2099-04-05'),
      amountMinor: 5000n,
      currency: 'EUR',
      btwRateBps: null,
      btwMinor: null,
      locationClass: ExpenseLocationClass.Domestic,
      category: '',
      notes: null,
      sourceEventId: null,
    });
    if (!expense.ingested) {
      throw new Error('precondition');
    }
    await expenseRepo.reject(expense.row.id);
    const bankIngest = await bankRepo.ingest({
      source: BankSource.SnsCsv,
      externalId: 'manual-bank-3',
      txDate: new Date('2099-04-10'),
      amountMinor: -5000n,
      currency: 'EUR',
      counterpartyName: 'TombstoneCo',
      counterpartyIban: null,
      description: 'card payment',
      rawPayload: {},
    });
    if (!bankIngest.ingested) {
      throw new Error('precondition');
    }

    await matcher.manualMatch(bankIngest.row.id, { type: 'expense', targetId: expense.row.id });

    // Link is recorded but rejected expenses don't make it to the books.
    const refetched = await bankRepo.findById(bankIngest.row.id);
    expect(refetched?.matchedExpenseId).toBe(expense.row.id);
    expect(sheetWriter.writeExpenseRow).not.toHaveBeenCalled();
  });

  it('matchAllUnmatched processes the queue and reports counts', async () => {
    await transferRepo.create({
      wiseTransferId: 'WISE-2',
      direction: WiseTransferDirection.Out,
      sourceAmountMinor: 1n,
      sourceCurrency: 'USD',
      targetAmountMinor: 1n,
      targetCurrency: 'EUR',
      feeMinor: 0n,
      feeCurrency: 'USD',
      state: WiseTransferState.OutgoingPaymentSent,
      stateUpdatedAt: new Date(),
      ourReference: 'TXN-0099',
      counterpartyName: null,
      correlationId: null,
      fxRate: null,
    });
    await bankRepo.ingest({
      source: BankSource.SnsCsv,
      externalId: '90:1',
      txDate: new Date(),
      amountMinor: 1n,
      currency: 'EUR',
      counterpartyName: 'X',
      counterpartyIban: null,
      description: 'reference TXN-0099',
      rawPayload: {},
    });
    await bankRepo.ingest({
      source: BankSource.SnsCsv,
      externalId: '90:2',
      txDate: new Date(),
      amountMinor: 1n,
      currency: 'EUR',
      counterpartyName: 'X',
      counterpartyIban: null,
      description: 'no signal here',
      rawPayload: {},
    });

    const summary = await matcher.matchAllUnmatched();
    expect(summary.matched).toBe(1);
    expect(summary.unmatched).toBe(1);
  });

  describe('recurring fee handling', () => {
    describe('without BTW (category branch)', () => {
      it('sets fee category for known SNS patterns and returns matched=false', async () => {
        const row = await ingestSnsFeeRow(bankRepo, 'fee:klantonderzoek', 'Kosten Klantonderzoek');

        const result = await recurringFee.tryHandleRecurringFee(row);
        expect(result).toEqual({ matched: false, reason: 'auto-categorized as fee' });

        const refetched = await bankRepo.findById(row.id);
        expect(refetched?.category).toBe('fee');
        expect(refetched?.matchedAt).toBeNull();
      });

      it('matches case-insensitively across the SNS fee patterns', async () => {
        const a = await ingestSnsFeeRow(bankRepo, 'fee:rekening', 'KOSTEN REKENING April');
        const b = await ingestSnsFeeRow(bankRepo, 'fee:betaalverzoek', 'Kosten betaalverzoek');
        const c = await ingestSnsFeeRow(bankRepo, 'fee:gebruik', 'Kosten gebruik betaalrekening April');

        const ra = await recurringFee.tryHandleRecurringFee(a);
        const rb = await recurringFee.tryHandleRecurringFee(b);
        const rc = await recurringFee.tryHandleRecurringFee(c);
        expect(ra?.matched).toBe(false);
        expect(rb?.matched).toBe(false);
        expect(rc?.matched).toBe(false);

        const ar = await bankRepo.findById(a.id);
        const br = await bankRepo.findById(b.id);
        const cr = await bankRepo.findById(c.id);
        expect(ar?.category).toBe('fee');
        expect(br?.category).toBe('fee');
        expect(cr?.category).toBe('fee');
      });

      it('returns null when no pattern matches', async () => {
        const row = await ingestSnsFeeRow(bankRepo, 'fee:none', 'Just a normal payment');
        const result = await recurringFee.tryHandleRecurringFee(row);
        expect(result).toBeNull();
        const refetched = await bankRepo.findById(row.id);
        expect(refetched?.category).toBeNull();
      });

      it('returns null on already-categorized rows (idempotent)', async () => {
        const row = await ingestSnsFeeRow(bankRepo, 'fee:already', 'Kosten rekening');
        await recurringFee.tryHandleRecurringFee(row);
        const refetched = await bankRepo.findById(row.id);
        const result = await recurringFee.tryHandleRecurringFee(refetched!);
        expect(result).toBeNull();
      });

      it('returns null on already-matched rows', async () => {
        const row = await ingestSnsFeeRow(bankRepo, 'fee:matched', 'Kosten Klantonderzoek');
        await db
          .updateTable('bank_transaction')
          .set({
            matchedAt: new Date(),
            matchConfidence: MatchConfidence.Manual,
            matchedExpenseId: '00000000-0000-0000-0000-000000000099',
          })
          .where('id', '=', row.id)
          .execute();
        const refetched = await bankRepo.findById(row.id);
        const result = await recurringFee.tryHandleRecurringFee(refetched!);
        expect(result).toBeNull();
      });

      it('tryMatch short-circuits when a row is auto-categorized first', async () => {
        const row = await ingestSnsFeeRow(bankRepo, 'fee:via-trymatch', 'Kosten betaalverzoek');
        const result = await matcher.tryMatch(row);
        expect(result.matched).toBe(false);
        if (!result.matched) {
          expect(result.reason).toContain('auto-categorized');
        }
        const refetched = await bankRepo.findById(row.id);
        expect(refetched?.category).toBe('fee');
      });
    });

    describe('with BTW (auto-create Expense branch)', () => {
      const KLANTONDERZOEK_DESC =
        'Kosten Klantonderzoek de Willigen IT Services Mei 2026 21% BTW BTW bedrag: 0,32 BTW BTW-nummer Volksbank: NL813633683B01';

      it('auto-creates an Approved Expense, links the bank-tx, writes the sheet row', async () => {
        const row = await ingestSnsFeeRow(bankRepo, 'fee:btw:1', KLANTONDERZOEK_DESC);

        const result = await recurringFee.tryHandleRecurringFee(row);
        expect(result?.matched).toBe(true);
        if (!result || !result.matched) {
          throw new Error('expected matched=true');
        }
        expect(result.type).toBe('expense');
        if (result.type !== 'expense') {
          throw new Error('expected type=expense');
        }
        expect(result.confidence).toBe(MatchConfidence.AutoHigh);

        const expense = await new ExpenseRepository(db).findById(result.expenseId);
        expect(expense).toBeDefined();
        expect(expense!.sourceBankTxId).toBe(row.id);
        expect(expense!.paperlessDocId).toBeNull();
        expect(expense!.status).toBe('approved');
        expect(expense!.reviewedAt).not.toBeNull();
        expect(expense!.vendor).toBe('Volksbank');
        expect(expense!.btwRateBps).toBe(2100);
        expect(String(expense!.btwMinor)).toBe('32');
        expect(String(expense!.amountMinor)).toBe('182');
        expect(expense!.locationClass).toBe('domestic');

        const refetched = await bankRepo.findById(row.id);
        expect(refetched?.matchedExpenseId).toBe(result.expenseId);
        expect(refetched?.category).toBeNull();
        expect(refetched?.matchConfidence).toBe(MatchConfidence.AutoHigh);

        // Sheet row was written via the normal expense path.
        expect(sheetWriter.writeExpenseRow).toHaveBeenCalledOnce();
      });

      it('is idempotent on repeat invocation (reprocess loop)', async () => {
        const row = await ingestSnsFeeRow(bankRepo, 'fee:btw:idempotent', KLANTONDERZOEK_DESC);
        const expenseRepo = new ExpenseRepository(db);

        const first = await recurringFee.tryHandleRecurringFee(row);
        if (!first || !first.matched || first.type !== 'expense') {
          throw new Error('expected matched expense outcome');
        }

        // Clear the match (simulating Unmatch in the UI), then re-run the rule.
        await db
          .updateTable('bank_transaction')
          .set({ matchedExpenseId: null, matchedAt: null, matchConfidence: null, category: null })
          .where('id', '=', row.id)
          .execute();
        const cleared = await bankRepo.findById(row.id);
        const second = await recurringFee.tryHandleRecurringFee(cleared!);
        if (!second || !second.matched || second.type !== 'expense') {
          throw new Error('expected matched expense outcome on second run');
        }

        expect(second.expenseId).toBe(first.expenseId);

        // Verify there's still exactly one fee-Expense for this bank-tx.
        const found = await expenseRepo.findBySourceBankTxId(row.id);
        expect(found?.id).toBe(first.expenseId);
      });

      it('records an audit event for the BTW expense match', async () => {
        const row = await ingestSnsFeeRow(bankRepo, 'fee:btw:event', KLANTONDERZOEK_DESC);
        await recurringFee.tryHandleRecurringFee(row);

        const events = await db
          .selectFrom('event')
          .selectAll()
          .where('eventType', '=', 'banking.tx.auto_fee_expense_matched')
          .execute();
        expect(events.length).toBeGreaterThanOrEqual(1);
        const payload = events[0].payload as Record<string, unknown>;
        expect(payload.bankTxId).toBe(row.id);
        expect(payload.btwRateBps).toBe(2100);
        expect(payload.btwMinor).toBe('32');
      });

      it('tryMatch returns the create-Expense outcome end-to-end', async () => {
        const row = await ingestSnsFeeRow(bankRepo, 'fee:btw:trymatch', KLANTONDERZOEK_DESC);
        const result = await matcher.tryMatch(row);
        expect(result.matched).toBe(true);
        if (result.matched && result.type === 'expense') {
          expect(result.confidence).toBe(MatchConfidence.AutoHigh);
        } else {
          throw new Error('expected matched expense outcome');
        }
      });
    });

    describe('reprocess', () => {
      const KLANTONDERZOEK_DESC =
        'Kosten Klantonderzoek de Willigen Mei 2026 21% BTW BTW bedrag: 0,32 BTW BTW-nummer Volksbank: NL813633683B01';

      it('clears stale category and re-runs the matcher (the klantonderzoek backfill case)', async () => {
        // Simulates the prod state today: a row was auto-categorised as `fee` by
        // the OLD rule (no BTW branch). After the rule change ships, Reprocess
        // should clear the category, rerun, and now create the Expense + match.
        const row = await ingestSnsFeeRow(bankRepo, 'fee:reprocess:1', KLANTONDERZOEK_DESC);
        await bankRepo.setCategory(row.id, 'fee' as never); // pretend old rule fired
        const before = await bankRepo.findById(row.id);
        expect(before?.category).toBe('fee');

        const { row: after, result } = await matcher.reprocess(row.id);
        expect(after.category).toBeNull();
        expect(after.matchedExpenseId).not.toBeNull();
        expect(result.matched).toBe(true);

        // Audit event recorded.
        const events = await db
          .selectFrom('event')
          .selectAll()
          .where('eventType', '=', 'banking.tx.reprocessed')
          .execute();
        expect(events.length).toBeGreaterThanOrEqual(1);
      });

      it('refuses to reprocess a matched row (must unlink first)', async () => {
        const row = await ingestSnsFeeRow(bankRepo, 'fee:reprocess:matched', KLANTONDERZOEK_DESC);
        // Hard-set a fake match to simulate a currently-matched state.
        await db
          .updateTable('bank_transaction')
          .set({
            matchedAt: new Date(),
            matchConfidence: MatchConfidence.Manual,
            matchedExpenseId: '00000000-0000-0000-0000-000000000099',
          })
          .where('id', '=', row.id)
          .execute();
        await expect(matcher.reprocess(row.id)).rejects.toThrow(/currently matched/);
      });

      it('throws on unknown bank-tx id', async () => {
        await expect(matcher.reprocess('00000000-0000-0000-0000-000000000999')).rejects.toThrow(/not found/);
      });
    });
  });

  describe('heuristic fallback (auto_low)', () => {
    let expenseRepo: ExpenseRepository;
    beforeEach(() => {
      expenseRepo = new ExpenseRepository(db);
    });

    it('matches an outflow to an expense by amount + date proximity + vendor substring', async () => {
      const ingestedExpense = await expenseRepo.ingest({
        paperlessDocId: 'pp-acme-cables-1',
        vendor: 'Acme Cables',
        expenseDate: new Date('2099-03-10'),
        amountMinor: 8500n,
        currency: 'EUR',
        btwRateBps: 2100,
        btwMinor: 1475n,
        locationClass: ExpenseLocationClass.Domestic,
        category: '',
        notes: null,
        sourceEventId: null,
      });
      if (!ingestedExpense.ingested) {
        throw new Error('precondition');
      }

      const ingest = await bankRepo.ingest({
        source: BankSource.SnsCsv,
        externalId: 'heuristic:1',
        txDate: new Date('2099-03-12'),
        amountMinor: -8500n,
        currency: 'EUR',
        counterpartyName: 'Acme Cables via PSP',
        counterpartyIban: null,
        description: 'opaque payment id with no TXN ref',
        rawPayload: {},
      });
      if (!ingest.ingested) {
        throw new Error('precondition');
      }

      const result = await matcher.tryMatch(ingest.row);
      expect(result.matched).toBe(true);
      if (result.matched && result.type === 'expense') {
        expect(result.expenseId).toBe(ingestedExpense.row.id);
        expect(result.confidence).toBe(MatchConfidence.AutoLow);
      }
      // Sheet write must NOT happen for auto_low — the user confirms first.
      expect(sheetWriter.writeIncomeRow).not.toHaveBeenCalled();
    });

    it('declines when there are multiple plausible expense candidates (ambiguous)', async () => {
      // Two expenses with the same vendor + amount + close dates → ambiguous.
      await expenseRepo.ingest({
        paperlessDocId: 'pp-amb-1',
        vendor: 'Online Cable Shop',
        expenseDate: new Date('2099-03-10'),
        amountMinor: 9500n,
        currency: 'EUR',
        btwRateBps: 2100,
        btwMinor: 1649n,
        locationClass: ExpenseLocationClass.Domestic,
        category: '',
        notes: null,
        sourceEventId: null,
      });
      await expenseRepo.ingest({
        paperlessDocId: 'pp-amb-2',
        vendor: 'Online Cable Shop',
        expenseDate: new Date('2099-03-12'),
        amountMinor: 9500n,
        currency: 'EUR',
        btwRateBps: 2100,
        btwMinor: 1649n,
        locationClass: ExpenseLocationClass.Domestic,
        category: '',
        notes: null,
        sourceEventId: null,
      });
      const ingest = await bankRepo.ingest({
        source: BankSource.SnsCsv,
        externalId: 'heuristic:2',
        txDate: new Date('2099-03-11'),
        amountMinor: -9500n,
        currency: 'EUR',
        counterpartyName: 'Online Cable Shop BV',
        counterpartyIban: null,
        description: 'no TXN ref',
        rawPayload: {},
      });
      if (!ingest.ingested) {
        throw new Error('precondition');
      }
      const result = await matcher.tryMatch(ingest.row);
      expect(result.matched).toBe(false);
    });

    it('does not match across the date window (≥7 days apart)', async () => {
      await expenseRepo.ingest({
        paperlessDocId: 'pp-old-1',
        vendor: 'Email Provider',
        expenseDate: new Date('2099-01-01'),
        amountMinor: 7680n,
        currency: 'EUR',
        btwRateBps: 2100,
        btwMinor: 1333n,
        locationClass: ExpenseLocationClass.Domestic,
        category: '',
        notes: null,
        sourceEventId: null,
      });
      const ingest = await bankRepo.ingest({
        source: BankSource.SnsCsv,
        externalId: 'heuristic:3',
        txDate: new Date('2099-03-11'),
        amountMinor: -7680n,
        currency: 'EUR',
        counterpartyName: 'Email Provider',
        counterpartyIban: null,
        description: 'no TXN ref',
        rawPayload: {},
      });
      if (!ingest.ingested) {
        throw new Error('precondition');
      }
      const result = await matcher.tryMatch(ingest.row);
      expect(result.matched).toBe(false);
    });
  });
});
