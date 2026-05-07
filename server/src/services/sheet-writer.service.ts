import { Injectable, Logger } from '@nestjs/common';
import { ClientClass } from 'src/enum';
import { SheetsService } from 'src/services/sheets.service';

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
    await this.sheets.ensureTab(tab);

    const row: (string | number | null)[] = [
      formatDutchDate(input.date),
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

function formatDutchDate(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const year = date.getUTCFullYear();
  return `${day}/${month}/${year}`;
}

function formatEur(minor: bigint): number {
  // Sheet stores numbers, not strings — Google parses USER_ENTERED values.
  return Number(minor) / 100;
}

function defaultIncomeTarget(cls: ClientClass): string {
  return cls === ClientClass.NonEu ? 'Wise' : 'SNS Account';
}
