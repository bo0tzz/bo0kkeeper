/**
 * Money crosses the API as integer minor-unit (cent) *strings* — bigint can't
 * JSON-serialise and `number` loses precision past 2^53. These helpers convert
 * between that wire form and major-unit display/input strings.
 *
 * Sibling of the server's `src/utils/money.ts`, kept string-based because the
 * web never does arithmetic on amounts — it only parses form input and formats
 * for display.
 */

/** Major-unit input string ("165", "12.34", "12,34", "-9.9") → minor-unit (cents) string. */
export function majorToMinor(major: string): string {
  // Accept comma decimal separator — Dutch keyboards + local receipts both
  // use commas, and forcing users to retype confuses the numeric parsing
  // (a comma silently reads as 0 cents in the fractional half, e.g. 126,97
  // resolves to 12600 instead of 12697).
  const trimmed = major.trim().replace(',', '.');
  if (!trimmed) {
    return '0';
  }
  const isNegative = trimmed.startsWith('-');
  const body = isNegative ? trimmed.slice(1) : trimmed;
  const [whole, frac = ''] = body.split('.');
  const cents = (frac + '00').slice(0, 2);
  const total = BigInt(whole || '0') * 100n + BigInt(cents || '0');
  return (isNegative ? -total : total).toString();
}

/**
 * Derive the Dutch gross-inclusive BTW for a gross amount + basis-point
 * rate, in minor units. Pure integer math: no float, no locale, no
 * rounding surprises.
 *
 *   btwMinor = grossMinor × rateBps / (10000 + rateBps)
 *
 * (2100 bps = 21%; 100% is 10000 bps.) Truncates toward zero — the last
 * cent goes to the base, matching how Belastingdienst rounds gross→base
 * splits in the sample invoices. Callers pass `0n` / `null` explicitly
 * when the rate is 0/undefined; this function doesn't guard.
 */
export function deriveBtwMinor(grossMinor: bigint, rateBps: number): bigint {
  return (grossMinor * BigInt(rateBps)) / BigInt(10_000 + rateBps);
}

/** Minor-unit (cents) string → major-unit string ("1234" → "12.34", "-1234" → "-12.34"). */
export function minorToMajor(minor: string): string {
  const cents = BigInt(minor);
  const isNegative = cents < 0n;
  const abs = isNegative ? -cents : cents;
  const major = abs / 100n;
  const tail = (abs % 100n).toString().padStart(2, '0');
  return `${isNegative ? '-' : ''}${major}.${tail}`;
}

/** Minor-unit (cents) string → euro display string ("1234" → "€12.34", "-1234" → "-€12.34"). */
export function formatEur(minor: string): string {
  const major = minorToMajor(minor);
  return major.startsWith('-') ? `-€${major.slice(1)}` : `€${major}`;
}
