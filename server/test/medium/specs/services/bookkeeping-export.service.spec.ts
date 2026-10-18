import ExcelJS from 'exceljs';
import { Kysely } from 'kysely';
import {
  BankSource,
  ClientClass,
  ExpenseLocationClass,
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
import { BookkeepingExportService } from 'src/services/bookkeeping-export.service';
import { getKyselyDB } from 'test/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

beforeEach(() => {
  process.env.OIDC_ISSUER ??= 'http://idp.test';
  process.env.OIDC_CLIENT_ID ??= 'test';
  process.env.OIDC_REDIRECT_URI ??= 'http://localhost/callback';
  process.env.CUTOVER_DATE ??= '2000-01-01';
});

async function readXlsxStrings(buffer: Buffer): Promise<string[]> {
  const wb = new ExcelJS.Workbook();
  // exceljs's typings predate Node's Buffer<ArrayBufferLike> narrowing; the
  // value is a real Buffer, the typedef just hasn't kept up.
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = wb.worksheets[0];
  const cells: string[] = [];
  sheet.eachRow((row) => {
    row.eachCell((cell) => {
      const v = cell.value;
      if (v !== null && v !== undefined) {
        cells.push(typeof v === 'object' && 'text' in v ? String((v as { text: unknown }).text) : String(v));
      }
    });
  });
  return cells;
}

describe('BookkeepingExportService', () => {
  let db: Kysely<DB>;
  let clientRepo: ClientRepository;
  let invoiceRepo: InvoiceRepository;
  let expenseRepo: ExpenseRepository;
  let bankRepo: BankTransactionRepository;
  let service: BookkeepingExportService;

  beforeEach(async () => {
    db = await getKyselyDB();
    clientRepo = new ClientRepository(db);
    invoiceRepo = new InvoiceRepository(db);
    expenseRepo = new ExpenseRepository(db);
    bankRepo = new BankTransactionRepository(db);
    service = new BookkeepingExportService(invoiceRepo, expenseRepo);
  });

  afterEach(async () => {
    await db.destroy();
  });

  // Strict kasstelsel: the export filters by payment date (bank_tx.txDate),
  // so every invoice/expense setup needs a matching bank_tx or it's absent
  // from the quarterly export. These helpers keep per-test setup terse.
  const payInvoice = (opts: { invoiceId: string; txDate: Date; amountMinor: bigint; externalId: string }) =>
    bankRepo.ingest({
      source: BankSource.SnsCsv,
      externalId: opts.externalId,
      txDate: opts.txDate,
      amountMinor: opts.amountMinor,
      currency: 'EUR',
      counterpartyName: null,
      counterpartyIban: null,
      description: '',
      rawPayload: {},
      matchedInvoiceId: opts.invoiceId,
      matchedAt: opts.txDate,
    });
  const payExpense = (opts: { expenseId: string; txDate: Date; amountMinor: bigint; externalId: string }) =>
    bankRepo.ingest({
      source: BankSource.SnsCsv,
      externalId: opts.externalId,
      txDate: opts.txDate,
      amountMinor: opts.amountMinor,
      currency: 'EUR',
      counterpartyName: null,
      counterpartyIban: null,
      description: '',
      rawPayload: {},
      matchedExpenseId: opts.expenseId,
      matchedAt: opts.txDate,
    });
  const payWiseTransfer = (opts: { transferId: string; txDate: Date; amountMinor: bigint; externalId: string }) =>
    bankRepo.ingest({
      source: BankSource.SnsCsv,
      externalId: opts.externalId,
      txDate: opts.txDate,
      amountMinor: opts.amountMinor,
      currency: 'EUR',
      counterpartyName: 'Wise',
      counterpartyIban: null,
      description: '',
      rawPayload: {},
      matchedTransferId: opts.transferId,
      matchedAt: opts.txDate,
    });

  it('produces a non-empty xlsx with PERIOD header for an empty quarter', async () => {
    const { buffer, filename } = await service.exportQuarter(2099, 1);
    expect(buffer.length).toBeGreaterThan(0);
    expect(filename).toBe('Bookkeeping list 01_01_2099-31_03_2099.xlsx');
    const cells = await readXlsxStrings(buffer);
    expect(cells).toContain('PERIOD:');
    expect(cells).toContain('01/01/2099-31/03/2099');
    expect(cells.some((c) => c.includes('OUTBOUND INVOICES'))).toBe(true);
    expect(cells.some((c) => c.includes('INBOUND INVOICES'))).toBe(true);
    expect(cells).toContain('Domestic:');
    expect(cells).toContain('EU:');
    expect(cells).toContain('Non EU:');
  });

  it('routes invoices to the right outbound subsection by client class and writes the line description', async () => {
    const domestic = await clientRepo.create({
      name: 'F. Acme Studio',
      class: ClientClass.Domestic,
      tradeName: TradeName.ThreeD,
      address: { line1: 'X', city: 'Y' },
    });
    const nonEu = await clientRepo.create({
      name: 'OverseasClientCo',
      class: ClientClass.NonEu,
      tradeName: TradeName.ItServices,
      address: { line1: 'X', city: 'Y' },
    });
    const domesticInvoice = await invoiceRepo.issue({
      year: 2099,
      invoice: {
        clientId: domestic.id,
        issuedAt: new Date('2099-02-15'),
        currency: 'EUR',
        totalMinor: 23_898n,
        btwRateBps: 2100,
        btwMinor: 4148n,
        sourceEventId: null,
      },
      lines: [
        {
          ordinal: 0,
          description: '3D design & print services',
          lineTotalMinor: 23_898n,
          unitLabel: null,
          quantity: null,
        },
      ],
    });
    await payInvoice({
      invoiceId: domesticInvoice.id,
      txDate: new Date('2099-02-20'),
      amountMinor: 23_898n,
      externalId: 'q1:route-domestic',
    });
    const nonEuInvoice = await invoiceRepo.issue({
      year: 2099,
      invoice: {
        clientId: nonEu.id,
        issuedAt: new Date('2099-02-20'),
        currency: 'USD',
        totalMinor: 300_000n,
        eurTotalMinor: 308_055n,
        btwRateBps: null,
        btwMinor: null,
        sourceEventId: null,
      },
      lines: [
        { ordinal: 0, description: 'Immich development', lineTotalMinor: 300_000n, unitLabel: null, quantity: null },
      ],
    });
    await payInvoice({
      invoiceId: nonEuInvoice.id,
      txDate: new Date('2099-02-25'),
      amountMinor: 308_055n,
      externalId: 'q1:route-noneu',
    });

    const { buffer } = await service.exportQuarter(2099, 1);
    const cells = await readXlsxStrings(buffer);
    expect(cells).toContain('F. Acme Studio');
    expect(cells).toContain('3D design & print services');
    expect(cells).toContain('OverseasClientCo');
    expect(cells).toContain('Immich development');
  });

  it('writes total / excl-VAT / VAT money columns with excl-VAT = total - BTW', async () => {
    // Pins the accountant's money columns: stored amount is gross (BTW-inclusive),
    // VAT is the component, and the excl-VAT base is gross - VAT. The same
    // gross/net relationship the invoice composer must produce.
    const domestic = await clientRepo.create({
      name: 'F. ColumnCheck',
      class: ClientClass.Domestic,
      tradeName: TradeName.ThreeD,
      address: { line1: 'X', city: 'Y' },
    });
    const colInvoice = await invoiceRepo.issue({
      year: 2099,
      invoice: {
        clientId: domestic.id,
        issuedAt: new Date('2099-02-15'),
        currency: 'EUR',
        totalMinor: 23_898n, // gross €238,98
        btwRateBps: 2100,
        btwMinor: 4148n, // VAT €41,48 → excl-VAT €197,50
        sourceEventId: null,
      },
      lines: [{ ordinal: 0, description: 'Design work', lineTotalMinor: 23_898n, unitLabel: null, quantity: null }],
    });
    await payInvoice({
      invoiceId: colInvoice.id,
      txDate: new Date('2099-02-20'),
      amountMinor: 23_898n,
      externalId: 'q1:col-invoice',
    });
    const ingested = await expenseRepo.ingest({
      paperlessDocId: 'pp-cols',
      vendor: 'ColCheckCo',
      expenseDate: new Date('2099-02-10'),
      amountMinor: 2985n, // gross €29,85
      currency: 'EUR',
      btwRateBps: 2100,
      btwMinor: 518n, // VAT €5,18 → excl-VAT €24,67
      locationClass: ExpenseLocationClass.Domestic,
      category: '',
      notes: 'materials',
      sourceEventId: null,
    });
    if (ingested.ingested) {
      await expenseRepo.approve(ingested.row.id);
      await payExpense({
        expenseId: ingested.row.id,
        txDate: new Date('2099-02-15'),
        amountMinor: -2985n,
        externalId: 'q1:col-expense',
      });
    }

    const { buffer } = await service.exportQuarter(2099, 1);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = wb.worksheets[0];

    const moneyRowFor = (counterparty: string): { total: number; excl: number; vat: number } => {
      for (let r = 1; r <= sheet.rowCount; r += 1) {
        if (String(sheet.getCell(r, 3).value ?? '') === counterparty) {
          return {
            total: Number(sheet.getCell(r, 6).value),
            excl: Number(sheet.getCell(r, 7).value),
            vat: Number(sheet.getCell(r, 8).value),
          };
        }
      }
      throw new Error(`row for ${counterparty} not found`);
    };

    const invoice = moneyRowFor('F. ColumnCheck');
    expect(invoice.total).toBeCloseTo(238.98, 2);
    expect(invoice.vat).toBeCloseTo(41.48, 2);
    expect(invoice.excl).toBeCloseTo(197.5, 2);
    expect(invoice.total - invoice.vat).toBeCloseTo(invoice.excl, 2);

    const expense = moneyRowFor('ColCheckCo');
    expect(expense.total).toBeCloseTo(29.85, 2);
    expect(expense.vat).toBeCloseTo(5.18, 2);
    expect(expense.excl).toBeCloseTo(24.67, 2);
  });

  // v0.9.2 fix — Wise-flow (foreign-currency) expenses have `amountMinor`
  // in the source currency (e.g. USD cents); the accountant sheet is EUR
  // everywhere, so the export must use `eurAmountMinor` (back-filled from
  // the sweep's realized rate) instead. Before this, a $150 expense
  // exported as €150.00 — quiet corruption of the BTW rollup.
  it('exports Wise-flow expenses at eurAmountMinor, not the source-currency amountMinor', async () => {
    // $150 USD expense, EUR back-filled at €126.66 from the sweep rate.
    const wiseTransferRepo = new WiseTransferRepository(db);
    const transfer = await wiseTransferRepo.create({
      wiseTransferId: 'WISE-EXPORT-1',
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
      ourReference: 'TXN-2001',
    });
    // Sweep lands in Q1 so the Wise-flow expense's effective date resolves
    // to a Q1 bank_tx (via its wiseTransferId link).
    await payWiseTransfer({
      transferId: transfer.id,
      txDate: new Date('2099-02-12'),
      amountMinor: 404_572n,
      externalId: 'q1:wise-sweep',
    });
    const ingest = await expenseRepo.ingest({
      paperlessDocId: 'pp-wise-usd',
      vendor: 'US Vendor',
      expenseDate: new Date('2099-02-10'),
      amountMinor: 15_000n, // $150.00 USD
      currency: 'USD',
      wiseTransferId: transfer.id,
      eurAmountMinor: 12_666n, // back-filled: 15_000 × 404_572 / 479_100 = 12_666
      fxRate: '0.846991',
      btwRateBps: null,
      btwMinor: null,
      locationClass: ExpenseLocationClass.NonEu,
      category: '',
      notes: 'Wise card charge',
      sourceEventId: null,
    });
    if (ingest.ingested) {
      await expenseRepo.approve(ingest.row.id);
    }

    const { buffer } = await service.exportQuarter(2099, 1);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = wb.worksheets[0];
    for (let r = 1; r <= sheet.rowCount; r += 1) {
      if (String(sheet.getCell(r, 3).value ?? '') === 'US Vendor') {
        const total = Number(sheet.getCell(r, 6).value);
        // 126.66 EUR, not 150.00 (which would be the USD cents misread as EUR).
        expect(total).toBeCloseTo(126.66, 2);
        return;
      }
    }
    throw new Error('row for US Vendor not found');
  });

  it('only includes approved expenses in the inbound section', async () => {
    await expenseRepo.ingest({
      paperlessDocId: 'pp-1',
      vendor: 'PrintCo',
      expenseDate: new Date('2099-02-10'),
      amountMinor: 2985n,
      currency: 'EUR',
      btwRateBps: 2100,
      btwMinor: 518n,
      locationClass: ExpenseLocationClass.Domestic,
      category: '',
      notes: '3D print materials',
      sourceEventId: null,
    });
    const pending = await expenseRepo.ingest({
      paperlessDocId: 'pp-2',
      vendor: 'PendingVendor',
      expenseDate: new Date('2099-02-12'),
      amountMinor: 5000n,
      currency: 'EUR',
      btwRateBps: 2100,
      btwMinor: 868n,
      locationClass: ExpenseLocationClass.Domestic,
      category: '',
      notes: 'should not appear',
      sourceEventId: null,
    });
    if (pending.ingested) {
      // leave pending row in pending_review state — should be excluded.
    }
    // approve the first one
    const all = await expenseRepo.findPendingReview();
    const tofakapprove = all.find((e) => e.vendor === 'PrintCo');
    if (tofakapprove) {
      await expenseRepo.approve(tofakapprove.id);
      await payExpense({
        expenseId: tofakapprove.id,
        txDate: new Date('2099-02-15'),
        amountMinor: -2985n,
        externalId: 'q1:printco-pay',
      });
    }

    const { buffer } = await service.exportQuarter(2099, 1);
    const cells = await readXlsxStrings(buffer);
    expect(cells).toContain('PrintCo');
    expect(cells).not.toContain('PendingVendor');
  });

  it('grows a section past its reserved-row capacity (no label leakage)', async () => {
    // Outbound Non-EU has 5 reserved rows in the template; push 8 invoices
    // so the section has to expand. Verify all 8 rows appear and that the
    // section label isn't smeared down the column.
    const nonEu = await clientRepo.create({
      name: 'BulkClient',
      class: ClientClass.NonEu,
      tradeName: TradeName.ItServices,
      address: { line1: 'X', city: 'Y' },
    });
    for (let i = 0; i < 8; i += 1) {
      const invoice = await invoiceRepo.issue({
        year: 2099,
        invoice: {
          clientId: nonEu.id,
          issuedAt: new Date(`2099-02-${String(i + 1).padStart(2, '0')}`),
          currency: 'EUR',
          totalMinor: 10_000n + BigInt(i),
          btwRateBps: null,
          btwMinor: null,
          sourceEventId: null,
        },
        lines: [
          {
            ordinal: 0,
            description: `Invoice ${i + 1}`,
            lineTotalMinor: 10_000n + BigInt(i),
            unitLabel: null,
            quantity: null,
          },
        ],
      });
      await payInvoice({
        invoiceId: invoice.id,
        txDate: new Date(`2099-02-${String(i + 1).padStart(2, '0')}`),
        amountMinor: 10_000n + BigInt(i),
        externalId: `q1:bulk-${i}`,
      });
    }

    const { buffer } = await service.exportQuarter(2099, 1);
    // Re-open and locate the Non EU outbound section by walking col A.
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = wb.worksheets[0];
    let nonEuStart = -1;
    let inboundStart = -1;
    for (let r = 1; r <= sheet.rowCount; r += 1) {
      const v = String(sheet.getCell(r, 1).value ?? '');
      if (v === 'Non EU:' && nonEuStart < 0) {
        nonEuStart = r;
      }
      if (v.includes('INBOUND')) {
        inboundStart = r;
        break;
      }
    }
    expect(nonEuStart).toBeGreaterThan(0);
    expect(inboundStart).toBeGreaterThan(nonEuStart);
    // 8 data rows in the section.
    expect(inboundStart - nonEuStart).toBeGreaterThanOrEqual(8);
    // Only the first row of the section carries the label.
    for (let r = nonEuStart + 1; r < inboundStart; r += 1) {
      expect(String(sheet.getCell(r, 1).value ?? '')).not.toBe('Non EU:');
    }
    // Each of the 8 invoice descriptions appears once.
    const descriptions: string[] = [];
    for (let r = nonEuStart; r < inboundStart; r += 1) {
      const v = sheet.getCell(r, 4).value;
      if (typeof v === 'string') {
        descriptions.push(v);
      }
    }
    for (let i = 1; i <= 8; i += 1) {
      expect(descriptions).toContain(`Invoice ${i}`);
    }
  });

  it('omits invoices outside the quarter window (payment date, not issue date)', async () => {
    const domestic = await clientRepo.create({
      name: 'InRangeClient',
      class: ClientClass.Domestic,
      tradeName: TradeName.ThreeD,
      address: { line1: 'X', city: 'Y' },
    });
    const invoice = await invoiceRepo.issue({
      year: 2099,
      invoice: {
        clientId: domestic.id,
        issuedAt: new Date('2099-04-15'), // Q2
        currency: 'EUR',
        totalMinor: 12_100n,
        btwRateBps: 2100,
        btwMinor: 2100n,
        sourceEventId: null,
      },
      lines: [{ ordinal: 0, description: 'Out of range', lineTotalMinor: 12_100n, unitLabel: null, quantity: null }],
    });
    await payInvoice({
      invoiceId: invoice.id,
      txDate: new Date('2099-04-20'), // paid in Q2
      amountMinor: 12_100n,
      externalId: 'q2:in-range',
    });

    const { buffer } = await service.exportQuarter(2099, 1);
    const cells = await readXlsxStrings(buffer);
    expect(cells).not.toContain('InRangeClient');
    expect(cells).not.toContain('Out of range');
    // Sanity: paid in Q2 → appears in Q2 export.
    const q2 = await service.exportQuarter(2099, 2);
    const q2cells = await readXlsxStrings(q2.buffer);
    expect(q2cells).toContain('InRangeClient');
  });

  // Regression: strict kasstelsel. An invoice issued in one quarter but paid
  // in the next lands in the paying quarter, not the issuing one — matching
  // what the Belastingdienst sees on the BTW return. Previously the export
  // filtered on `issuedAt`, so a Dec/Jan invoice straddled quarters
  // inconsistently between this export and the quarterly aggregator.
  it('invoice issued Q4, paid Q1-next-year lands in Q1 only', async () => {
    const domestic = await clientRepo.create({
      name: 'StraddleClient',
      class: ClientClass.Domestic,
      tradeName: TradeName.ItServices,
      address: { line1: 'X', city: 'Y' },
    });
    const invoice = await invoiceRepo.issue({
      year: 2099,
      invoice: {
        clientId: domestic.id,
        issuedAt: new Date('2099-12-20'),
        currency: 'EUR',
        totalMinor: 24_200n,
        btwRateBps: 2100,
        btwMinor: 4200n,
        sourceEventId: null,
      },
      lines: [{ ordinal: 0, description: 'Dec work', lineTotalMinor: 24_200n, unitLabel: null, quantity: null }],
    });
    await payInvoice({
      invoiceId: invoice.id,
      txDate: new Date('2100-01-10'),
      amountMinor: 24_200n,
      externalId: 'straddle-pay',
    });

    const q4 = await service.exportQuarter(2099, 4);
    const q4Cells = await readXlsxStrings(q4.buffer);
    expect(q4Cells).not.toContain('StraddleClient');
    expect(q4Cells).not.toContain('Dec work');

    const q1 = await service.exportQuarter(2100, 1);
    const q1Cells = await readXlsxStrings(q1.buffer);
    expect(q1Cells).toContain('StraddleClient');
    expect(q1Cells).toContain('Dec work');
  });

  // Issued-but-unpaid invoice is silently absent from the export under
  // strict kasstelsel. Operator relies on the dashboard's unmatched-invoice
  // warning to catch stragglers before running the export.
  it('invoice issued but never paid is excluded entirely', async () => {
    const domestic = await clientRepo.create({
      name: 'DeadbeatClient',
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
        totalMinor: 12_100n,
        btwRateBps: 2100,
        btwMinor: 2100n,
        sourceEventId: null,
      },
      lines: [{ ordinal: 0, description: 'Unpaid work', lineTotalMinor: 12_100n, unitLabel: null, quantity: null }],
    });

    const q1 = await service.exportQuarter(2099, 1);
    const cells = await readXlsxStrings(q1.buffer);
    expect(cells).not.toContain('DeadbeatClient');
    expect(cells).not.toContain('Unpaid work');
  });
});
