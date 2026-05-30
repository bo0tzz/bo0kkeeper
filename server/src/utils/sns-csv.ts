import { BankSource } from 'src/enum';
import { NewBankTransaction } from 'src/repositories/bank-transaction.repository';
import { majorToMinor } from 'src/utils/money';

/**
 * Parse the SNS bank export CSV (semicolon-separated for some banks; SNS
 * uses comma-separated with the Dutch header below).
 *
 * Header row (Dutch):
 *   Datum,Je rekening,Van / naar,Naam,Adres,Postcode,Woonplaats,
 *   Valuta saldo,Saldo voor boeking,Valuta,Bedrag bij / af,
 *   Verwerkingsdatum,Valutadatum,Code,Type,Volgnummer,Betalingskenmerk,
 *   Omschrijving,Afschriftnummer
 *
 * `Volgnummer` is a per-statement-line sequence — combined with the
 * statement number (`Afschriftnummer`) it's unique enough to dedupe; we
 * key on `Afschriftnummer:Volgnummer`. Date format is `DD-MM-YYYY`.
 *
 * Tolerant of trailing whitespace and quoted fields with embedded commas.
 */

export type SnsCsvRow = NewBankTransaction;

export function parseSnsCsv(content: string, accountIban: string): SnsCsvRow[] {
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return [];
  }
  const headers = parseCsvLine(lines[0]);
  const indexOf = (name: string) => {
    const i = headers.findIndex((h) => h.trim() === name);
    if (i === -1) {
      throw new Error(`SNS CSV missing column: ${name}`);
    }
    return i;
  };
  const datumIdx = indexOf('Datum');
  const naamIdx = indexOf('Naam');
  const valutaIdx = indexOf('Valuta');
  const bedragIdx = indexOf('Bedrag bij / af');
  const vanNaarIdx = indexOf('Van / naar');
  const omschrijvingIdx = indexOf('Omschrijving');
  const volgnummerIdx = indexOf('Volgnummer');
  const afschriftnummerIdx = indexOf('Afschriftnummer');

  const rows: SnsCsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    if (cells.length < headers.length) {
      // Tolerate short rows (occasional trailing-comma artifact in the user's exports).
      while (cells.length < headers.length) {
        cells.push('');
      }
    }
    const datum = cells[datumIdx];
    const naam = cells[naamIdx];
    const valuta = cells[valutaIdx];
    const bedrag = cells[bedragIdx];
    const vanNaar = cells[vanNaarIdx];
    const omschrijving = stripSurroundingQuotes(cells[omschrijvingIdx]);
    const volgnummer = cells[volgnummerIdx];
    const afschriftnummer = cells[afschriftnummerIdx];

    rows.push({
      source: BankSource.SnsCsv,
      externalId: `${afschriftnummer}:${volgnummer}`,
      txDate: parseDutchDate(datum),
      amountMinor: parseAmountMinor(bedrag),
      currency: valuta,
      counterpartyName: naam || null,
      counterpartyIban: vanNaar || null,
      description: omschrijving,
      rawPayload: Object.fromEntries(headers.map((h, idx) => [h, cells[idx]])) as Record<string, unknown>,
      matchedInvoiceId: null,
      matchedTransferId: null,
      matchedExpenseId: null,
      matchedAt: null,
      matchConfidence: null,
    });
    void accountIban;
  }
  return rows;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === ',') {
      out.push(current);
      current = '';
    } else if (ch === '"') {
      inQuotes = true;
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}

function stripSurroundingQuotes(s: string): string {
  const trimmed = s.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseDutchDate(s: string): Date {
  // Tolerant of D[D]-M[M]-YYYY.
  const match = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(s.trim());
  if (!match) {
    throw new Error(`Invalid date in SNS CSV: ${s}`);
  }
  const [, dd, mm, yyyy] = match;
  return new Date(`${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T00:00:00Z`);
}

function parseAmountMinor(s: string): bigint {
  // SNS amounts are decimal with period or comma; signed (negative for debit).
  // Normalise the Dutch comma decimal, then centralise the rounding.
  return majorToMinor(s.trim().replaceAll(',', '.'));
}
