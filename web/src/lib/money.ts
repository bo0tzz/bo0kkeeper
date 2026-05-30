/**
 * Money crosses the API as integer minor-unit (cent) *strings* — bigint can't
 * JSON-serialise and `number` loses precision past 2^53. These helpers convert
 * between that wire form and major-unit display/input strings.
 *
 * Sibling of the server's `src/utils/money.ts`, kept string-based because the
 * web never does arithmetic on amounts — it only parses form input and formats
 * for display.
 */

/** Major-unit input string ("165", "12.34", "-9.9") → minor-unit (cents) string. */
export function majorToMinor(major: string): string {
  const trimmed = major.trim();
  if (!trimmed) {
    return '0';
  }
  const negative = trimmed.startsWith('-');
  const body = negative ? trimmed.slice(1) : trimmed;
  const [whole, frac = ''] = body.split('.');
  const cents = (frac + '00').slice(0, 2);
  const total = BigInt(whole || '0') * 100n + BigInt(cents || '0');
  return (negative ? -total : total).toString();
}

/** Minor-unit (cents) string → major-unit string ("1234" → "12.34", "-1234" → "-12.34"). */
export function minorToMajor(minor: string): string {
  const cents = BigInt(minor);
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const major = abs / 100n;
  const tail = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${major}.${tail}`;
}

/** Minor-unit (cents) string → euro display string ("1234" → "€12.34", "-1234" → "-€12.34"). */
export function formatEur(minor: string): string {
  const major = minorToMajor(minor);
  return major.startsWith('-') ? `-€${major.slice(1)}` : `€${major}`;
}
