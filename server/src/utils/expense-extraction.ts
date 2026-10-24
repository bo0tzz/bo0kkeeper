import { ExpensePrefill } from 'src/types';
import { majorToMinor } from 'src/utils/money';

const BTW_RATES_PERCENT = new Set([0, 9, 21]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL = /^\d+(\.\d{1,2})?$/;

/**
 * NuExtract template for receipts. Asking for every organization name and
 * dropping our own beats asking for "the vendor" directly: the model often
 * answers with the billed party (us) for the latter.
 */
export const EXPENSE_EXTRACT_TEMPLATE = {
  organizations: ['string'],
  invoice_date: 'string',
  total_amount_eur: 'number',
  btw_rate_percent: 'integer',
  currency: 'string',
};

/** Per-field instructions for the template above; operator-editable on /settings. */
export type ExpenseExtractFieldDescriptions = Record<keyof typeof EXPENSE_EXTRACT_TEMPLATE, string>;

/** The descriptions the model was evaluated with. */
export const DEFAULT_EXPENSE_EXTRACT_FIELD_DESCRIPTIONS: ExpenseExtractFieldDescriptions = {
  organizations: 'every company or person name that appears on this invoice, in order of appearance',
  invoice_date: 'ISO date YYYY-MM-DD',
  total_amount_eur: 'grand total paid including Dutch BTW (VAT), two decimals',
  btw_rate_percent: 'the Dutch BTW rate as a percent — one of 0, 9, or 21; null if invoice is non-EU/VAT-exempt',
  currency: 'ISO 4217 code, usually EUR',
};

/** Render the `### Field descriptions` block, in template order; blank descriptions are left out. */
export function renderFieldDescriptions(descriptions: ExpenseExtractFieldDescriptions): string {
  return Object.keys(EXPENSE_EXTRACT_TEMPLATE)
    .map((field) => [field, descriptions[field as keyof ExpenseExtractFieldDescriptions]?.trim()])
    .filter(([, description]) => description)
    .map(([field, description]) => `- ${field}: ${description}`)
    .join('\n');
}

/** Longer receipts are cut; the totals block is almost always on the first page. */
export const EXPENSE_EXTRACT_MAX_CHARS = 8000;

/**
 * Validate raw model output down to the fields worth prefilling. Anything
 * missing or malformed is left out rather than guessed at, so the operator
 * fills it in as before. `ownNames` are the operator's own names (matched
 * case-insensitively as substrings): they show up on receipts as the billed
 * party and are skipped when picking the vendor.
 */
export function toExpensePrefill(raw: unknown, ownNames: string[]): ExpensePrefill {
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  const output = raw as Record<string, unknown>;
  const prefill: ExpensePrefill = {};

  const own = ownNames.map((name) => name.trim().toLowerCase()).filter(Boolean);
  const organizations = Array.isArray(output.organizations) ? output.organizations : [];
  const vendor = organizations
    .filter((name): name is string => typeof name === 'string')
    .map((name) => name.trim())
    .find((name) => name && own.every((ownName) => !name.toLowerCase().includes(ownName)));
  if (vendor) {
    prefill.vendor = vendor;
  }

  if (typeof output.invoice_date === 'string' && isValidIsoDate(output.invoice_date)) {
    prefill.expenseDate = output.invoice_date;
  }

  // Expenses in other currencies need a Wise sweep link before an amount
  // can be saved; leave those to the operator.
  const currency = typeof output.currency === 'string' ? output.currency.trim().toUpperCase() : null;
  const amountMinor = parseDecimal(output.total_amount_eur);
  if (currency === 'EUR' && amountMinor !== null && amountMinor > 0n) {
    prefill.amountMinor = amountMinor.toString();
  }

  const rate = output.btw_rate_percent;
  if (typeof rate === 'number' && BTW_RATES_PERCENT.has(rate)) {
    prefill.btwRateBps = rate * 100;
  }

  return prefill;
}

function parseDecimal(value: unknown): bigint | null {
  if ((typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && DECIMAL.test(value))) {
    return majorToMinor(value);
  }
  return null;
}

function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}
