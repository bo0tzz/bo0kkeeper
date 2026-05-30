/**
 * Money is stored as integer minor units (cents) in `bigint` — never as a JS
 * `number`, which can't represent every cent value exactly. These two helpers
 * are the single home for the major<->minor conversion and, critically, the
 * `Math.round(x * 100)` that absorbs binary-float error in 2-decimal inputs
 * (e.g. `1.82 * 100 === 181.99999999999997`, which would truncate to 181).
 *
 * Use them at every boundary where a decimal amount crosses into or out of
 * storage: CSV/API ingest, external-API request bodies, display formatting.
 */

/**
 * Major-unit amount → minor units (cents), rounded to the nearest cent.
 * Accepts a number or a period-decimal string (`12.34` or `"12.34"`). Callers
 * with locale-specific strings (comma decimals, thousands separators) must
 * normalise to a period decimal before calling. Throws on non-finite input.
 */
export function majorToMinor(major: string | number): bigint {
  const n = typeof major === 'number' ? major : Number.parseFloat(major);
  if (!Number.isFinite(n)) {
    throw new TypeError(`Cannot convert to minor units: ${JSON.stringify(major)}`);
  }
  return BigInt(Math.round(n * 100));
}

/** Minor units (cents) → major-unit number, for display + external APIs that take decimals. */
export function minorToMajor(minor: bigint): number {
  return Number(minor) / 100;
}
