import { Injectable, Logger } from '@nestjs/common';
import { ClientClass } from 'src/enum';
import { ColumnFormat, SheetsService } from 'src/services/sheets.service';

export type IncomeRowInput = {
  /** Payment-received date (kasstelsel). DD/MM/YYYY in the row. */
  date: Date;
  invoiceNumber: string;
  /** Always recorded in EUR on the sheet. */
  eurAmountMinor: bigint;
  client: { name: string; class: ClientClass };
  /** "From" column. Defaults to the client name (the party that paid). */
  from?: string;
  /** "To" column. Defaults derived from client class. */
  to?: string;
  /** BTW percent label (e.g. "21%"). Empty for Non-EU. */
  vatPercent?: string;
  /** BTW amount in EUR (minor). Empty for Non-EU. */
  vatMinor?: bigint;
  notes?: string;
  /**
   * Source-tag column. Audit trail for system-written rows
   * (e.g. `wise:transfer/12345`, `paperless:doc/678`).
   */
  source?: string;
};

const LOCATION_BY_CLASS: Record<ClientClass, string> = {
  [ClientClass.NonEu]: 'Non-EU',
  [ClientClass.Eu]: 'EU',
  [ClientClass.EuReverseCharge]: 'EU',
  [ClientClass.Domestic]: 'Domestic',
};

/**
 * Header row for newly-created quarter tabs. Matches the column order below.
 * Existing manual tabs are left alone — only tabs SheetWriterService creates
 * get this header.
 */
export const QUARTER_TAB_HEADERS: string[] = [
  'Date',
  'Id',
  'Type',
  'Location',
  'From',
  'To',
  'Amount',
  'VAT %',
  'VAT',
  'Notes',
  'Source',
];

/**
 * Per-column number formats applied to rows 2+ of newly-created tabs. Header
 * row is excluded automatically by SheetsService.initTab.
 *   A (Date)   — DATE format renders the ISO-written date as DD/MM/YYYY
 *   G (Amount) — CURRENCY with euro symbol
 *   H (VAT %)  — PERCENT (Sheets parses "21%" string into 0.21 under USER_ENTERED)
 *   I (VAT)    — CURRENCY with euro symbol
 */
export const QUARTER_TAB_COLUMN_FORMATS: ColumnFormat[] = [
  { index: 0, type: 'DATE', pattern: 'dd/mm/yyyy' },
  { index: 6, type: 'CURRENCY', pattern: '"€"#,##0.00' },
  { index: 7, type: 'PERCENT', pattern: '0%' },
  { index: 8, type: 'CURRENCY', pattern: '"€"#,##0.00' },
];

/**
 * Composes sheet rows in the existing column layout and writes them via
 * SheetsService. Encapsulates the kasstelsel convention (sheet date = payment
 * received date) and the existing tab naming (`YYYY QN` per calendar quarter).
 *
 * Sheet column order — must stay aligned with the existing manual sheet:
 *   Date | Id | Type | Location | From | To | Amount | VAT % | VAT | Notes | (source)
 */
@Injectable()
export class SheetWriterService {
  private readonly logger = new Logger(SheetWriterService.name);

  constructor(private readonly sheets: SheetsService) {}

  /** Append an Income row for an invoice and ensure the quarter tab exists. */
  async writeIncomeRow(input: IncomeRowInput): Promise<void> {
    const tab = quarterTabName(input.date);
    await this.sheets.ensureTab(tab, {
      headers: QUARTER_TAB_HEADERS,
      columnFormats: QUARTER_TAB_COLUMN_FORMATS,
    });

    const row: (string | number | null)[] = [
      formatIsoDate(input.date),
      input.invoiceNumber,
      'Income',
      LOCATION_BY_CLASS[input.client.class],
      input.from ?? input.client.name,
      input.to ?? defaultIncomeTarget(input.client.class),
      formatEur(input.eurAmountMinor),
      input.vatPercent ?? '',
      input.vatMinor === undefined ? '' : formatEur(input.vatMinor),
      input.notes ?? '',
      input.source ?? '',
    ];

    this.logger.log(`Sheet append: tab=${tab} id=${input.invoiceNumber}`);
    await this.sheets.appendRow(tab, row);
  }
}

/** Calendar-quarter tab name in the existing sheet's convention. */
export function quarterTabName(date: Date): string {
  const year = date.getUTCFullYear();
  const quarter = Math.floor(date.getUTCMonth() / 3) + 1;
  return `${year} Q${quarter}`;
}

/**
 * ISO date string. Sheets parses YYYY-MM-DD unambiguously regardless of
 * spreadsheet locale, and the DATE column format renders it as DD/MM/YYYY on
 * screen — so the user sees Dutch-style dates and Sheets stores real date
 * values it can sort/filter by.
 */
function formatIsoDate(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const year = date.getUTCFullYear();
  return `${year}-${month}-${day}`;
}

function formatEur(minor: bigint): number {
  // Sheet stores numbers, not strings — Google parses USER_ENTERED values.
  return Number(minor) / 100;
}

function defaultIncomeTarget(cls: ClientClass): string {
  return cls === ClientClass.NonEu ? 'Wise' : 'SNS Account';
}
