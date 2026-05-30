/**
 * Parse a BTW (Dutch VAT) breakdown out of a bank-transaction description.
 *
 * SNS / Volksbank includes the BTW rate, amount, and bank's BTW number in the
 * description of fee debits — by design, since the bank doesn't issue a
 * separate factuur for these (the bank statement line is the *vereenvoudigde
 * factuur* under Art. 35a Wet OB).
 *
 * Observed format from SNS klantonderzoek debits:
 *   "Kosten Klantonderzoek <naam> <maand> 21% BTW BTW bedrag: 0,32 BTW
 *    BTW-nummer Volksbank: NL...B01"
 *
 * Returns null when no parseable rate+amount pair is present.
 */
import { majorToMinor } from 'src/utils/money';

export type ParsedBtw = {
  /** BTW rate in basis points (2100 = 21.00%). */
  rateBps: number;
  /** BTW amount in minor units (32 = €0.32). */
  amountMinor: bigint;
};

const RATE_RE = /\b(\d{1,2})%\s*BTW/i;
const AMOUNT_RE = /BTW\s*bedrag\s*:\s*(\d+(?:,\d{1,2})?)/i;

export function parseBtwFromDescription(description: string | null | undefined): ParsedBtw | null {
  if (!description) {
    return null;
  }
  const rateMatch = RATE_RE.exec(description);
  const amountMatch = AMOUNT_RE.exec(description);
  if (!rateMatch || !amountMatch) {
    return null;
  }
  const ratePercent = Number.parseInt(rateMatch[1], 10);
  if (!Number.isFinite(ratePercent) || ratePercent <= 0 || ratePercent > 100) {
    return null;
  }
  const amountStr = amountMatch[1].replace(',', '.');
  const amount = Number.parseFloat(amountStr);
  if (!Number.isFinite(amount) || amount < 0) {
    return null;
  }
  return {
    rateBps: ratePercent * 100,
    amountMinor: majorToMinor(amount),
  };
}
