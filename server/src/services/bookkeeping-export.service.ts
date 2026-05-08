import { Injectable, Logger, Optional } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { Kysely } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { join, resolve } from 'node:path';
import { ClientClass, ExpenseLocationClass, ExpenseStatus } from 'src/enum';
import { DB } from 'src/schema';
import { Quarter } from 'src/services/quarterly-aggregator.service';

/**
 * Renders the accountant's "Bookkeeping list" XLSX for a quarter — the same
 * shape they've been getting hand-typed for years.
 *
 * Approach: we ship the accountant's blank template under `src/templates/
 * bookkeeping-list.xlsx`, load it, and inject the line-item data into the
 * pre-styled section rows. The template has a fixed number of reserved
 * rows per (section × class); when we have more data than the reserve, we
 * duplicate the last reserved row to grow the section in place. Formatting
 * (cell styles, borders, fonts) is preserved by `duplicateRow` and by
 * writing values into the existing pre-styled cells.
 *
 * Section markers ("Domestic:", "EU:", "Non EU:") in column A are how we
 * locate sections — same string the human-typed file uses, no magic
 * row-number constants. We process bottom-up so growing one section
 * doesn't shift the cached row numbers of the sections above.
 */

export const TEMPLATES_DIR = resolve(process.cwd(), 'src/templates');
const TEMPLATE_FILENAME = 'bookkeeping-list.xlsx';

@Injectable()
export class BookkeepingExportService {
  private readonly logger = new Logger(BookkeepingExportService.name);
  private readonly templatesDir: string;

  constructor(
    @InjectKysely() private readonly db: Kysely<DB>,
    @Optional() templatesDir: string = TEMPLATES_DIR,
  ) {
    this.templatesDir = templatesDir;
  }

  async exportQuarter(year: number, quarter: Quarter): Promise<{ buffer: Buffer; filename: string }> {
    const periodStart = new Date(Date.UTC(year, (quarter - 1) * 3, 1));
    const periodEnd = new Date(Date.UTC(year, quarter * 3, 1));
    const inclusiveEnd = new Date(periodEnd.getTime() - 24 * 60 * 60 * 1000);

    const invoices = await this.loadInvoices(periodStart, periodEnd);
    const expenses = await this.loadExpenses(periodStart, periodEnd);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(join(this.templatesDir, TEMPLATE_FILENAME));
    const sheet = workbook.worksheets[0];

    // Period header.
    const periodRow = findRowByColA(sheet, 'PERIOD:');
    sheet.getCell(`B${periodRow}`).value = `${formatDate(periodStart)}-${formatDate(inclusiveEnd)}`;

    // Locate all section markers. They appear in this fixed order:
    //   OUTBOUND … (Domestic / EU / Non EU)
    //   INBOUND … (Domestic / EU / Non EU)
    // Column A carries either the OUTBOUND/INBOUND header or one of the
    // class labels; we walk top-to-bottom and bin them.
    const markers = collectMarkers(sheet);
    const ob = markers.outbound;
    const ib = markers.inbound;

    // Process bottom-up: each section's row numbers are stable until something
    // *below* it is grown. Inbound Non EU is last in the file; grow it first.
    fillSection(sheet, ib.nonEu, ib.afterEnd, expenses.filter((e) => e.classification === ExpenseLocationClass.NonEu));
    fillSection(sheet, ib.eu, ib.nonEu, expenses.filter((e) =>
      e.classification === ExpenseLocationClass.Eu || e.classification === ExpenseLocationClass.EuReverseCharge,
    ));
    fillSection(sheet, ib.domestic, ib.eu, expenses.filter((e) => e.classification === ExpenseLocationClass.Domestic));
    fillSection(sheet, ob.nonEu, ob.afterEnd, invoices.filter((i) => i.classification === ClientClass.NonEu));
    fillSection(sheet, ob.eu, ob.nonEu, invoices.filter((i) =>
      i.classification === ClientClass.Eu || i.classification === ClientClass.EuReverseCharge,
    ));
    fillSection(sheet, ob.domestic, ob.eu, invoices.filter((i) => i.classification === ClientClass.Domestic));

    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const filename = `Bookkeeping list ${formatDateForFilename(periodStart)}-${formatDateForFilename(inclusiveEnd)}.xlsx`;
    this.logger.log(`exported ${invoices.length} invoice(s) + ${expenses.length} expense(s) for ${year} Q${quarter}`);
    return { buffer, filename };
  }

  private async loadInvoices(periodStart: Date, periodEnd: Date): Promise<InvoiceExportRow[]> {
    const rows = await this.db
      .selectFrom('invoice')
      .innerJoin('client', 'client.id', 'invoice.clientId')
      // invoice_line ordinals are 0-indexed (set by invoice-composer.service);
      // the first line carries the canonical description for the accountant.
      .leftJoin('invoice_line', (join_) =>
        join_.onRef('invoice_line.invoiceId', '=', 'invoice.id').on('invoice_line.ordinal', '=', 0),
      )
      .select([
        'invoice.number',
        'invoice.issuedAt',
        'invoice.totalMinor',
        'invoice.eurTotalMinor',
        'invoice.btwMinor',
        'invoice.currency',
        'client.name as clientName',
        'client.class as clientClass',
        'client.vatId',
        'client.defaultDescription',
        'invoice_line.description as lineDescription',
      ])
      .where('invoice.issuedAt', '>=', periodStart)
      .where('invoice.issuedAt', '<', periodEnd)
      .orderBy('invoice.issuedAt', 'asc')
      .execute();

    return rows.map((r) => {
      const totalIncMinor = r.eurTotalMinor === null ? BigInt(r.totalMinor) : BigInt(r.eurTotalMinor);
      const vatMinor = r.btwMinor === null ? 0n : BigInt(r.btwMinor);
      const exclVatMinor = vatMinor === 0n ? null : totalIncMinor - vatMinor;
      return {
        date: new Date(r.issuedAt),
        counterparty: r.clientName,
        description: r.lineDescription ?? r.defaultDescription ?? '',
        vatId: r.vatId,
        totalIncMinor,
        exclVatMinor,
        vatMinor,
        classification: r.clientClass as ClientClass,
      };
    });
  }

  private async loadExpenses(periodStart: Date, periodEnd: Date): Promise<ExpenseExportRow[]> {
    const rows = await this.db
      .selectFrom('expense')
      .selectAll()
      .where('status', '=', ExpenseStatus.Approved)
      .where('expenseDate', '>=', periodStart)
      .where('expenseDate', '<', periodEnd)
      .orderBy('expenseDate', 'asc')
      .execute();

    return rows.map((r) => {
      const totalIncMinor = BigInt(r.amountMinor);
      const vatMinor = r.btwMinor === null ? 0n : BigInt(r.btwMinor);
      const exclVatMinor = vatMinor === 0n ? null : totalIncMinor - vatMinor;
      return {
        date: new Date(r.expenseDate),
        counterparty: r.vendor,
        description: r.notes ?? '',
        vatId: null,
        totalIncMinor,
        exclVatMinor,
        vatMinor,
        classification: r.locationClass as ExpenseLocationClass,
      };
    });
  }
}

type ExportRow = {
  date: Date;
  counterparty: string;
  description: string;
  vatId: string | null;
  totalIncMinor: bigint;
  exclVatMinor: bigint | null;
  vatMinor: bigint;
};
type InvoiceExportRow = ExportRow & { classification: ClientClass };
type ExpenseExportRow = ExportRow & { classification: ExpenseLocationClass };

type SectionMarkers = {
  domestic: number;
  eu: number;
  nonEu: number;
  /** Row index right after this section group ends (exclusive bound for Non EU). */
  afterEnd: number;
};

function findRowByColA(sheet: ExcelJS.Worksheet, value: string): number {
  for (let r = 1; r <= sheet.rowCount; r += 1) {
    if (asString(sheet.getCell(r, 1).value) === value) {
      return r;
    }
  }
  throw new Error(`Template missing row with column A = ${JSON.stringify(value)}`);
}

function collectMarkers(sheet: ExcelJS.Worksheet): { outbound: SectionMarkers; inbound: SectionMarkers } {
  const outboundHeader = findContains(sheet, 'OUTBOUND');
  const inboundHeader = findContains(sheet, 'INBOUND');
  const outbound = readMarkers(sheet, outboundHeader, inboundHeader);
  const inbound = readMarkers(sheet, inboundHeader, sheet.rowCount + 1);
  return { outbound, inbound };
}

function readMarkers(sheet: ExcelJS.Worksheet, sectionStart: number, sectionEnd: number): SectionMarkers {
  let domestic = -1;
  let eu = -1;
  let nonEu = -1;
  for (let r = sectionStart; r < sectionEnd; r += 1) {
    const v = asString(sheet.getCell(r, 1).value);
    switch (v) {
      case 'Domestic:': {
        domestic = r;
        break;
      }
      case 'EU:': {
        eu = r;
        break;
      }
      case 'Non EU:': {
        nonEu = r;
        break;
      }
    }
  }
  if (domestic < 0 || eu < 0 || nonEu < 0) {
    throw new Error(`Template missing one of Domestic / EU / Non EU markers in [${sectionStart}, ${sectionEnd})`);
  }
  return { domestic, eu, nonEu, afterEnd: sectionEnd };
}

function findContains(sheet: ExcelJS.Worksheet, fragment: string): number {
  for (let r = 1; r <= sheet.rowCount; r += 1) {
    const v = asString(sheet.getCell(r, 1).value);
    if (v.includes(fragment)) {
      return r;
    }
  }
  throw new Error(`Template missing row with column A containing ${JSON.stringify(fragment)}`);
}

/**
 * Write `data` into the section starting at `sectionStart` and bounded by
 * the next section's start (`sectionEnd`, exclusive). The section's first
 * row already carries its label in column A — we leave that intact and
 * write data starting from column B onwards.
 *
 * If we have more rows than the template reserved, duplicate the last
 * reserved row (using ExcelJS's row duplication, which copies styles and
 * shifts subsequent rows down) before writing.
 */
function fillSection(
  sheet: ExcelJS.Worksheet,
  sectionStart: number,
  sectionEnd: number,
  data: ExportRow[],
): void {
  const reserved = sectionEnd - sectionStart;
  const overflow = data.length - reserved;
  if (overflow > 0) {
    // duplicateRow(srcRow, numRows, insertShift) — copies the source row
    // numRows times immediately after srcRow, shifting later rows down.
    sheet.duplicateRow(sectionEnd - 1, overflow, true);
    // If the donor row was the section's marker (single-row sections like
    // inbound Non EU), the duplicates inherit its column-A label. Wipe so
    // only the section's first row keeps its marker.
    for (let r = sectionEnd; r < sectionEnd + overflow; r += 1) {
      sheet.getCell(r, 1).value = null;
    }
  }

  for (let i = 0; i < data.length; i += 1) {
    const row = sectionStart + i;
    const item = data[i];
    sheet.getCell(row, 2).value = item.date;
    sheet.getCell(row, 2).numFmt = sheet.getCell(row, 2).numFmt || 'mm/dd/yyyy';
    sheet.getCell(row, 3).value = item.counterparty;
    sheet.getCell(row, 4).value = item.description;
    sheet.getCell(row, 5).value = item.vatId ?? 'N/a';
    sheet.getCell(row, 6).value = minorToMajor(item.totalIncMinor);
    if (item.exclVatMinor !== null) {
      sheet.getCell(row, 7).value = minorToMajor(item.exclVatMinor);
    }
    sheet.getCell(row, 8).value = minorToMajor(item.vatMinor);
  }
}

function asString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'object' && 'text' in value && typeof (value as { text: unknown }).text === 'string') {
    return (value as { text: string }).text;
  }
  return String(value);
}

function minorToMajor(minor: bigint): number {
  return Number(minor) / 100;
}

function formatDate(d: Date): string {
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

function formatDateForFilename(d: Date): string {
  return `${pad(d.getUTCDate())}_${pad(d.getUTCMonth() + 1)}_${d.getUTCFullYear()}`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
