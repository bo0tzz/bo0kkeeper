import { majorToMinor, minorToMajor } from 'src/utils/money';
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
    expect(() => majorToMinor(Number.NaN)).toThrow(/minor units/);
    expect(() => majorToMinor(Number.POSITIVE_INFINITY)).toThrow(/minor units/);
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
