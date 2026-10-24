import { absMinor, btwInGross, majorToMinor, minorToMajor } from 'src/utils/money';
import { describe, expect, it } from 'vitest';

describe('majorToMinor', () => {
  it('converts numbers and period-decimal strings to cents', () => {
    expect(majorToMinor(12.34)).toBe(1234n);
    expect(majorToMinor('12.34')).toBe(1234n);
    expect(majorToMinor(0)).toBe(0n);
    expect(majorToMinor('4791.00')).toBe(479_100n);
  });

  it('rounds binary-float error to the nearest cent', () => {
    // 1.82 * 100 === 181.99999999999997 — must not truncate to 181.
    expect(majorToMinor(1.82)).toBe(182n);
    expect(majorToMinor('1.82')).toBe(182n);
    expect(majorToMinor(0.07)).toBe(7n);
  });

  it('handles negative amounts (debits)', () => {
    expect(majorToMinor('-29.85')).toBe(-2985n);
    expect(majorToMinor(-0.01)).toBe(-1n);
  });

  it('throws on non-finite input', () => {
    expect(() => majorToMinor('not a number')).toThrow(/minor units/);
    expect(() => majorToMinor(NaN)).toThrow(/minor units/);
    expect(() => majorToMinor(Infinity)).toThrow(/minor units/);
  });
});

describe('minorToMajor', () => {
  it('converts cents to a major-unit number', () => {
    expect(minorToMajor(1234n)).toBe(12.34);
    expect(minorToMajor(0n)).toBe(0);
    expect(minorToMajor(-2985n)).toBe(-29.85);
    expect(minorToMajor(479_100n)).toBe(4791);
  });
});

describe('absMinor', () => {
  it('returns the magnitude of a cents amount', () => {
    expect(absMinor(-2985n)).toBe(2985n);
    expect(absMinor(2985n)).toBe(2985n);
    expect(absMinor(0n)).toBe(0n);
  });
});

describe('btwInGross', () => {
  it('splits the BTW out of a gross amount', () => {
    expect(btwInGross(12_100n, 2100)).toBe(2100n);
    expect(btwInGross(10_900n, 900)).toBe(900n);
  });

  it('truncates so the remainder cent stays in the base', () => {
    // 1000 × 21/121 = 173.55…
    expect(btwInGross(1000n, 2100)).toBe(173n);
  });

  it('is zero at a zero rate', () => {
    expect(btwInGross(5000n, 0)).toBe(0n);
  });
});
