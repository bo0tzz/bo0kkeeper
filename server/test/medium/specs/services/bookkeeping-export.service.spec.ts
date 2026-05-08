import ExcelJS from 'exceljs';
import { Kysely } from 'kysely';
import { ClientClass, ExpenseLocationClass, TradeName } from 'src/enum';
import { ClientRepository } from 'src/repositories/client.repository';
import { ExpenseRepository } from 'src/repositories/expense.repository';
import { InvoiceRepository } from 'src/repositories/invoice.repository';
import { DB } from 'src/schema';
import { BookkeepingExportService } from 'src/services/bookkeeping-export.service';
import { getKyselyDB } from 'test/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

beforeEach(() => {
  process.env.OIDC_ISSUER ??= 'http://idp.test';
  process.env.OIDC_CLIENT_ID ??= 'test';
  process.env.OIDC_REDIRECT_URI ??= 'http://localhost/callback';
});

async function readXlsxStrings(buffer: Buffer): Promise<string[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
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
  let service: BookkeepingExportService;

  beforeEach(async () => {
    db = await getKyselyDB();
    clientRepo = new ClientRepository(db);
    invoiceRepo = new InvoiceRepository(db);
    expenseRepo = new ExpenseRepository(db);
    service = new BookkeepingExportService(db);
  });

  afterEach(async () => {
    await db.destroy();
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
    await invoiceRepo.issue({
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
    await invoiceRepo.issue({
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

    const { buffer } = await service.exportQuarter(2099, 1);
    const cells = await readXlsxStrings(buffer);
    expect(cells).toContain('F. Acme Studio');
    expect(cells).toContain('3D design & print services');
    expect(cells).toContain('OverseasClientCo');
    expect(cells).toContain('Immich development');
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
      await invoiceRepo.issue({
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
    }

    const { buffer } = await service.exportQuarter(2099, 1);
    // Re-open and locate the Non EU outbound section by walking col A.
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
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

  it('omits invoices outside the quarter window', async () => {
    const domestic = await clientRepo.create({
      name: 'InRangeClient',
      class: ClientClass.Domestic,
      tradeName: TradeName.ThreeD,
      address: { line1: 'X', city: 'Y' },
    });
    await invoiceRepo.issue({
      year: 2099,
      invoice: {
        clientId: domestic.id,
        issuedAt: new Date('2099-04-15'), // Q2, not Q1
        currency: 'EUR',
        totalMinor: 12_100n,
        btwRateBps: 2100,
        btwMinor: 2100n,
        sourceEventId: null,
      },
      lines: [{ ordinal: 0, description: 'Out of range', lineTotalMinor: 12_100n, unitLabel: null, quantity: null }],
    });
    const { buffer } = await service.exportQuarter(2099, 1);
    const cells = await readXlsxStrings(buffer);
    expect(cells).not.toContain('InRangeClient');
    expect(cells).not.toContain('Out of range');
    // Sanity: with the same data, Q2 should include it.
    const q2 = await service.exportQuarter(2099, 2);
    const q2cells = await readXlsxStrings(q2.buffer);
    expect(q2cells).toContain('InRangeClient');
  });
});
