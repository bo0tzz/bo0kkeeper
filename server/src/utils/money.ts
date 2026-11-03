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

/** Absolute value of a minor-unit (cents) amount. */
export function absMinor(minor: bigint): bigint {
  return minor < 0n ? -minor : minor;
}

/**
 * BTW contained in a gross (BTW-inclusive) amount, in minor units:
 * `gross × rate / (100% + rate)`, truncated so the last cent goes to the
 * base. Same formula as the web's `deriveBtwMinor`, which the expense review
 * form uses when the operator edits the amount or rate.
 */
export function btwInGross(grossMinor: bigint, rateBps: number): bigint {
  return (grossMinor * BigInt(rateBps)) / BigInt(10_000 + rateBps);
}

/**
 * Split `totalMinor` across parts in proportion to `weights`, in whole minor
 * units, so the parts always sum to exactly `totalMinor`. Each part is rounded
 * down; the leftover cents go to the last part. Used to show per-line EUR on a
 * multi-line invoice whose EUR total is fixed by the Wise sweep.
 */
export function apportionMinor(totalMinor: bigint, weights: bigint[]): bigint[] {
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0n);
  if (weightSum === 0n) {
    return weights.map((_, index) => (index === weights.length - 1 ? totalMinor : 0n));
  }
  const parts = weights.map((weight) => (totalMinor * weight) / weightSum);
  const assigned = parts.reduce((sum, part) => sum + part, 0n);
  parts[parts.length - 1] += totalMinor - assigned;
  return parts;
}
