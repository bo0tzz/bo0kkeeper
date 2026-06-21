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
import { EventRepository } from 'src/repositories/event.repository';
import { Expense, ExpenseRepository } from 'src/repositories/expense.repository';
import { InvoiceRepository } from 'src/repositories/invoice.repository';
import { WiseTransferRepository } from 'src/repositories/wise-transfer.repository';
import { DB } from 'src/schema';
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

async function seedWiseTransfer(db: Kysely<DB>, opts: { wiseId: string; ref: string }) {
  return await new WiseTransferRepository(db).create({
    wiseTransferId: opts.wiseId,
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
    ourReference: opts.ref,
  });
}

async function seedBankTx(bankRepo: BankTransactionRepository, externalId: string) {
  const result = await bankRepo.ingest({
    source: BankSource.SnsCsv,
    externalId,
    txDate: new Date('2099-01-15'),
    amountMinor: 404_572n,
    currency: 'EUR',
    counterpartyName: 'Wise',
    counterpartyIban: 'NL00WISE0000000000',
    description: 'Wise EUR payout',
    rawPayload: {},
  });
  if (!result.ingested) {
    throw new Error('precondition');
  }
  return result.row;
}

describe('SheetSyncService', () => {
  let db: Kysely<DB>;
  let bankRepo: BankTransactionRepository;
  let clientRepo: ClientRepository;
  let expenseRepo: ExpenseRepository;
  let sheetWriter: SheetWriterService & {
    writeIncomeRow: ReturnType<typeof vi.fn>;
    writeExpenseRow: ReturnType<typeof vi.fn>;
  };
  let sheetSync: SheetSyncService;

  beforeEach(async () => {
    db = await getKyselyDB();
    bankRepo = new BankTransactionRepository(db);
    clientRepo = new ClientRepository(db);
    expenseRepo = new ExpenseRepository(db);
    sheetWriter = {
      writeIncomeRow: vi.fn().mockResolvedValue(void 0),
      writeExpenseRow: vi.fn().mockResolvedValue(void 0),
    } as unknown as SheetWriterService & {
      writeIncomeRow: ReturnType<typeof vi.fn>;
      writeExpenseRow: ReturnType<typeof vi.fn>;
    };
    sheetSync = new SheetSyncService(
      bankRepo,
      clientRepo,
      expenseRepo,
      new InvoiceRepository(db),
      new WiseTransferRepository(db),
      sheetWriter,
      new EventRepository(db),
    );
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function seedApprovedExpense(): Promise<Expense> {
    const result = await expenseRepo.ingest({
      paperlessDocId: 'doc-1',
      vendor: 'Acme BV',
      expenseDate: new Date('2099-02-10'),
      amountMinor: 12_100n,
      currency: 'EUR',
      btwRateBps: 2100,
      btwMinor: 2100n,
      locationClass: ExpenseLocationClass.Domestic,
      status: ExpenseStatus.Approved,
    });
    if (!result.ingested) {
      throw new Error('precondition: expense not ingested');
    }
    return result.row;
  }

  describe('writeExpenseRowSafely', () => {
    it('writes the row, marks sheetRowAt, and returns true on success', async () => {
      const expense = await seedApprovedExpense();

      const isOk = await sheetSync.writeExpenseRowSafely(expense, new Date('2099-02-12'), 'bank-tx-1');

      expect(isOk).toBe(true);
      expect(sheetWriter.writeExpenseRow).toHaveBeenCalledOnce();
      // Id column carries the paperless doc id for traceability.
      expect(sheetWriter.writeExpenseRow.mock.calls[0][0]).toMatchObject({ id: 'doc-1', vendor: 'Acme BV' });
      const refetched = await expenseRepo.findById(expense.id);
      expect(refetched?.sheetRowAt).toBeInstanceOf(Date);
    });

    it('on sheet failure: returns false, leaves sheetRowAt null, records an audit event', async () => {
      const expense = await seedApprovedExpense();
      sheetWriter.writeExpenseRow.mockRejectedValueOnce(new Error('sheets down'));

      const isOk = await sheetSync.writeExpenseRowSafely(expense, new Date('2099-02-12'), 'bank-tx-1');

      expect(isOk).toBe(false);
      const refetched = await expenseRepo.findById(expense.id);
      expect(refetched?.sheetRowAt).toBeNull();

      const events = await db.selectFrom('event').selectAll().where('eventType', '=', 'sheet.write_failed').execute();
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({
        kind: 'expense',
        bankTxId: 'bank-tx-1',
        identifier: 'doc-1',
        message: 'sheets down',
      });
    });
  });

  describe('appendInvoiceIncomeRow', () => {
    it('writes an income row and marks the bank_tx sheetRowAt', async () => {
      const client = await clientRepo.create({
        name: 'DutchCo',
        class: ClientClass.Domestic,
        tradeName: TradeName.ItServices,
        address: { line1: 'Dorpsstraat 1', city: 'Amsterdam' },
      });
      const ingest = await bankRepo.ingest({
        source: BankSource.SnsCsv,
        externalId: '70:1',
        txDate: new Date('2099-03-05'),
        amountMinor: 121_000n,
        currency: 'EUR',
        counterpartyName: 'DutchCo',
        counterpartyIban: 'NL00BANK0123456789',
        description: 'payment 2099/001',
        rawPayload: {},
      });
      if (!ingest.ingested) {
        throw new Error('precondition');
      }

      await sheetSync.appendInvoiceIncomeRow(ingest.row, {
        clientId: client.id,
        number: '2099/001',
        btwRateBps: 2100,
        btwMinor: 21_000n,
      });

      expect(sheetWriter.writeIncomeRow).toHaveBeenCalledOnce();
      expect(sheetWriter.writeIncomeRow.mock.calls[0][0]).toMatchObject({
        invoiceNumber: '2099/001',
        eurAmountMinor: 121_000n,
        vatPercent: '21%',
        vatMinor: 21_000n,
      });
      const refetched = await bankRepo.findById(ingest.row.id);
      expect(refetched?.sheetRowAt).toBeInstanceOf(Date);
    });
  });

  describe('appendWiseIncomeRow', () => {
    it('uses TXN-NNNN ref when no invoice is linked to the wise_transfer', async () => {
      const client = await clientRepo.create({
        name: 'OverseasClientCo',
        class: ClientClass.NonEu,
        tradeName: TradeName.ItServices,
        address: { line1: '1 Fake Park Dr', city: 'Nullstate' },
      });
      const transfer = await seedWiseTransfer(db, { wiseId: 'WISE-NOINV', ref: 'TXN-0044' });
      const bankTx = await seedBankTx(bankRepo, 'wise-no-invoice');

      await sheetSync.appendWiseIncomeRow(bankTx, transfer);

      expect(sheetWriter.writeIncomeRow.mock.calls[0][0]).toMatchObject({
        invoiceNumber: 'TXN-0044',
        client: { name: client.name, class: ClientClass.NonEu },
      });
    });

    it('uses the linked invoice number + that invoice s client when one exists', async () => {
      const client = await clientRepo.create({
        name: 'FUTO',
        class: ClientClass.NonEu,
        tradeName: TradeName.ItServices,
        address: { line1: '1 Fake Park Dr', city: 'Nullstate' },
      });
      const transfer = await seedWiseTransfer(db, { wiseId: 'WISE-WITHINV', ref: 'TXN-0099' });
      const invoiceRepo = new InvoiceRepository(db);
      await invoiceRepo.issue({
        year: 2099,
        invoice: {
          clientId: client.id,
          issuedAt: new Date('2099-01-15'),
          currency: 'USD',
          totalMinor: 479_100n,
          eurTotalMinor: 404_572n,
          wiseTransferId: transfer.id,
        },
        lines: [{ ordinal: 0, description: 'Services', lineTotalMinor: 479_100n, unitLabel: null, quantity: null }],
      });
      const bankTx = await seedBankTx(bankRepo, 'wise-with-invoice');

      await sheetSync.appendWiseIncomeRow(bankTx, transfer);

      const row = sheetWriter.writeIncomeRow.mock.calls[0][0] as { invoiceNumber: string; client: { name: string } };
      // Invoice number, not TXN ref. Means the sheet row is keyed to the
      // actual composed invoice and the operator + accountant can trace it.
      expect(row.invoiceNumber).toBe('2099/001');
      expect(row.client.name).toBe('FUTO');
    });
  });
});
