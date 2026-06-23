import {
  applyDescriptionTemplate,
  nextHalfMonth,
  resolveDescription,
  SUPPORTED_PLACEHOLDERS,
} from 'src/utils/description-template';
import { describe, expect, it } from 'vitest';

const period = {
  start: new Date('2026-06-01T00:00:00Z'),
  end: new Date('2026-06-15T00:00:00Z'),
};

describe('applyDescriptionTemplate', () => {
  it('substitutes {period.range} into the half-month form the user types in defaultDescription', () => {
    expect(applyDescriptionTemplate('Provided services, {period.range}', { period })).toBe(
      'Provided services, June 1 - June 15',
    );
  });

  it('substitutes individual date formatters via dotted paths', () => {
    expect(
      applyDescriptionTemplate('{period.start.month_long} {period.start.day}, {period.end.day} ({period.start.iso})', {
        period,
      }),
    ).toBe('June 1, 15 (2026-06-01)');
  });

  it('renders {period.iso} as the ISO date range', () => {
    expect(applyDescriptionTemplate('Period: {period.iso}', { period })).toBe('Period: 2026-06-01 to 2026-06-15');
  });

  it('leaves unknown placeholders literal (visible failure beats silent dropping)', () => {
    expect(applyDescriptionTemplate('Type {foo.bar} mismatch', { period })).toBe('Type {foo.bar} mismatch');
    expect(applyDescriptionTemplate('Bad fmt: {period.start.century}', { period })).toBe(
      'Bad fmt: {period.start.century}',
    );
  });

  it('leaves period placeholders literal when no period is supplied', () => {
    expect(applyDescriptionTemplate('Services, {period.range}', {})).toBe('Services, {period.range}');
  });

  it("doesn't touch text that has no placeholders", () => {
    expect(applyDescriptionTemplate('Just a regular line', { period })).toBe('Just a regular line');
  });

  it('handles multiple placeholders of the same kind', () => {
    expect(applyDescriptionTemplate('{period.start.day}-{period.end.day}', { period })).toBe('1-15');
  });
});

describe('resolveDescription', () => {
  it('uses the line description when non-empty', () => {
    expect(
      resolveDescription({
        line: 'Custom line',
        defaultDescription: 'Provided services, {period.range}',
        vars: { period },
      }),
    ).toBe('Custom line');
  });

  it('falls back to defaultDescription when the line is empty', () => {
    expect(
      resolveDescription({
        line: '',
        defaultDescription: 'Provided services, {period.range}',
        vars: { period },
      }),
    ).toBe('Provided services, June 1 - June 15');
  });

  it('also templates the line text itself (placeholders work in custom descriptions too)', () => {
    expect(
      resolveDescription({
        line: 'Consulting for {period.start.month_long}',
        defaultDescription: null,
        vars: { period },
      }),
    ).toBe('Consulting for June');
  });

  it('returns empty string when both inputs are blank', () => {
    expect(resolveDescription({ line: null, defaultDescription: null, vars: {} })).toBe('');
    expect(resolveDescription({ line: ' '.repeat(3), defaultDescription: '', vars: {} })).toBe('');
  });
});

describe('SUPPORTED_PLACEHOLDERS', () => {
  it('lists every placeholder the engine resolves', () => {
    // Smoke test against the curated list — keeps the UI hint in lockstep
    // with the registry. If a formatter is added below in description-template.ts,
    // this assertion forces the expected list to be updated.
    expect(SUPPORTED_PLACEHOLDERS).toEqual([
      'period.range',
      'period.iso',
      'period.start.day',
      'period.end.day',
      'period.start.month_long',
      'period.end.month_long',
      'period.start.iso',
      'period.end.iso',
    ]);
  });

  it('every listed placeholder actually resolves for a given period', () => {
    for (const path of SUPPORTED_PLACEHOLDERS) {
      const out = applyDescriptionTemplate(`{${path}}`, { period });
      expect(out, `placeholder ${path} should resolve, got ${out}`).not.toBe(`{${path}}`);
    }
  });
});

describe('nextHalfMonth', () => {
  it('moves from a 15th-end to the second half of the same month', () => {
    const result = nextHalfMonth({ previousPeriodEnd: new Date('2026-06-15T00:00:00Z'), today: new Date() });
    expect(result.start.toISOString().slice(0, 10)).toBe('2026-06-16');
    expect(result.end.toISOString().slice(0, 10)).toBe('2026-06-30');
  });

  it('rolls into the next month from an EOM end (June 30 → July 1-15)', () => {
    const result = nextHalfMonth({ previousPeriodEnd: new Date('2026-06-30T00:00:00Z'), today: new Date() });
    expect(result.start.toISOString().slice(0, 10)).toBe('2026-07-01');
    expect(result.end.toISOString().slice(0, 10)).toBe('2026-07-15');
  });

  it('respects 28-day February (Feb 28 EOM → Mar 1-15)', () => {
    const result = nextHalfMonth({ previousPeriodEnd: new Date('2027-02-28T00:00:00Z'), today: new Date() });
    expect(result.start.toISOString().slice(0, 10)).toBe('2027-03-01');
    expect(result.end.toISOString().slice(0, 10)).toBe('2027-03-15');
  });

  it('respects 29-day Feb on a leap year (Feb 29 EOM → Mar 1-15)', () => {
    const result = nextHalfMonth({ previousPeriodEnd: new Date('2028-02-29T00:00:00Z'), today: new Date() });
    expect(result.start.toISOString().slice(0, 10)).toBe('2028-03-01');
    expect(result.end.toISOString().slice(0, 10)).toBe('2028-03-15');
  });

  it('falls back to the current half-month from today when no prior end (today in first half)', () => {
    const result = nextHalfMonth({ today: new Date('2026-06-07T00:00:00Z') });
    expect(result.start.toISOString().slice(0, 10)).toBe('2026-06-01');
    expect(result.end.toISOString().slice(0, 10)).toBe('2026-06-15');
  });

  it('falls back to the current half-month from today when no prior end (today in second half)', () => {
    const result = nextHalfMonth({ today: new Date('2026-06-23T00:00:00Z') });
    expect(result.start.toISOString().slice(0, 10)).toBe('2026-06-16');
    expect(result.end.toISOString().slice(0, 10)).toBe('2026-06-30');
  });
});
