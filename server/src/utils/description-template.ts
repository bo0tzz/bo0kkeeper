/**
 * Templating layer for invoice line descriptions.
 *
 * Description text can contain `{path}` placeholders that resolve against a
 * `TemplateVars` object. The substitution is dotted-path-based:
 *
 *   {period.range}        → "June 1 - June 15"
 *   {period.iso}          → "2026-06-01 to 2026-06-15"
 *   {period.start.day}    → "1"
 *   {period.start.month_long} → "June"
 *   {period.end.iso}      → "2026-06-15"
 *
 * Unknown paths stay literal in the output (visible failure beats silent
 * dropping). Missing vars (e.g. no period available) also stay literal —
 * callers that compose without a period get the placeholder back, which
 * tells them they need to supply it.
 *
 * Variables expose `Date` objects rather than pre-formatted strings so the
 * format function (day, month_long, iso) is independent of the data — adding
 * a new format is a one-line entry in the registry.
 */

/** Half-open period — both bounds inclusive for display, callers pass start/end as the dates the customer sees. */
export type Period = {
  start: Date;
  end: Date;
};

export type TemplateVars = {
  period?: Period;
};

const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** Formatters applied to a `Date` (used at the leaf of e.g. `period.start.<format>`). */
const dateFormatters = {
  day: (d: Date) => String(d.getUTCDate()),
  month_long: (d: Date) => MONTHS_LONG[d.getUTCMonth()],
  iso: (d: Date) => d.toISOString().slice(0, 10),
} satisfies Record<string, (d: Date) => string>;

/** Formatters applied to a whole `Period` (used at the leaf of e.g. `period.<format>`). */
const periodFormatters = {
  range: (p: Period) =>
    `${MONTHS_LONG[p.start.getUTCMonth()]} ${p.start.getUTCDate()} - ${MONTHS_LONG[p.end.getUTCMonth()]} ${p.end.getUTCDate()}`,
  iso: (p: Period) => `${dateFormatters.iso(p.start)} to ${dateFormatters.iso(p.end)}`,
} satisfies Record<string, (p: Period) => string>;

function resolvePath(path: string, vars: TemplateVars): string | null {
  const segments = path.split('.');
  if (segments[0] !== 'period') {
    return null;
  }
  const period = vars.period;
  if (!period) {
    return null;
  }
  if (segments.length === 2) {
    const formatter = periodFormatters[segments[1] as keyof typeof periodFormatters];
    return formatter ? formatter(period) : null;
  }
  if (segments.length === 3 && (segments[1] === 'start' || segments[1] === 'end')) {
    const date = period[segments[1]];
    const formatter = dateFormatters[segments[2] as keyof typeof dateFormatters];
    return formatter ? formatter(date) : null;
  }
  return null;
}

const PLACEHOLDER_RE = /\{([\w.]+)\}/g;

/**
 * Substitute `{path}` placeholders in `template` against `vars`. Unknown
 * placeholders are left in place (rendered verbatim) so the operator sees
 * which variables they need to define rather than getting silent gaps.
 */
export function applyDescriptionTemplate(template: string, vars: TemplateVars): string {
  return template.replaceAll(PLACEHOLDER_RE, (full, path: string) => {
    const value = resolvePath(path, vars);
    return value ?? full;
  });
}

/**
 * Resolve the description text used in an invoice line. Encapsulates two
 * concerns that callers shouldn't have to repeat:
 *   1. Fall back from the line's own description to `client.defaultDescription`
 *      when the line was left blank.
 *   2. Run any `{path}` placeholders through the template engine with the
 *      provided vars.
 *
 * The result is the final, customer-visible string.
 */
export function resolveDescription(input: {
  line?: string | null;
  defaultDescription?: string | null;
  vars: TemplateVars;
}): string {
  const template = input.line?.trim() || input.defaultDescription?.trim() || '';
  return applyDescriptionTemplate(template, input.vars);
}

/**
 * All `{path}` placeholders the template engine knows about. Used by the
 * /clients edit page to surface the supported set under the
 * `defaultDescription` input so the operator doesn't have to read this file.
 * Single source of truth — if a formatter is added below, it shows up here
 * automatically.
 */
export const SUPPORTED_PLACEHOLDERS: readonly string[] = [
  ...Object.keys(periodFormatters).map((key) => `period.${key}`),
  ...Object.keys(dateFormatters).flatMap((key) => [`period.start.${key}`, `period.end.${key}`]),
];

/**
 * Compute the next half-month period after a previous `periodEnd`. The
 * convention is 1st-15th, then 16th-EOM, repeated monthly. When no prior
 * end is supplied the current half-month for `today` is returned.
 *
 * Used by `prefillFromWise` to suggest the period the operator is most
 * likely to want when composing the next FUTO invoice; they can still
 * override.
 */
export function nextHalfMonth(input: { previousPeriodEnd?: Date | null; today: Date }): Period {
  const anchor = input.previousPeriodEnd ? addDays(input.previousPeriodEnd, 1) : input.today;
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth();
  const day = anchor.getUTCDate();
  if (day <= 15) {
    return {
      start: new Date(Date.UTC(year, month, 1)),
      end: new Date(Date.UTC(year, month, 15)),
    };
  }
  // Last day of `month`: day 0 of `month+1`, normalised by Date.UTC.
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return {
    start: new Date(Date.UTC(year, month, 16)),
    end: new Date(Date.UTC(year, month, lastDay)),
  };
}

function addDays(d: Date, days: number): Date {
  const next = new Date(d);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}
