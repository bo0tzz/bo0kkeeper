import { toDate } from 'src/utils/date';
import { describe, expect, it } from 'vitest';

describe('toDate', () => {
  it('returns a Date unchanged', () => {
    const d = new Date('2099-01-15T00:00:00Z');
    expect(toDate(d)).toBe(d);
  });

  it('parses ISO date strings', () => {
    expect(toDate('2099-01-15T00:00:00Z').toISOString()).toBe('2099-01-15T00:00:00.000Z');
  });

  it('accepts epoch-millis numbers', () => {
    expect(toDate(0).toISOString()).toBe('1970-01-01T00:00:00.000Z');
  });
});
