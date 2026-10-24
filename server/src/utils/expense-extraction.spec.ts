import {
  DEFAULT_EXPENSE_EXTRACT_FIELD_DESCRIPTIONS,
  renderFieldDescriptions,
  toExpensePrefill,
} from 'src/utils/expense-extraction';
import { describe, expect, it } from 'vitest';

describe('toExpensePrefill', () => {
  const ownNames = ['Jansen'];
  const complete = {
    organizations: ['Jansen Design', 'Acme Supplies B.V.', 'Example Bank N.V.'],
    invoice_date: '2099-03-14',
    total_amount_eur: 121,
    btw_rate_percent: 21,
    currency: 'EUR',
  };

  it('maps a complete extraction', () => {
    expect(toExpensePrefill(complete, ownNames)).toEqual({
      vendor: 'Acme Supplies B.V.',
      expenseDate: '2099-03-14',
      amountMinor: '12100',
      btwRateBps: 2100,
    });
  });

  it('skips own names case-insensitively and as substrings', () => {
    const output = { organizations: ['P. Jansen', 'JANSEN DESIGN', '  Acme Supplies B.V. '] };
    expect(toExpensePrefill(output, ownNames)).toEqual({ vendor: 'Acme Supplies B.V.' });
  });

  it('leaves the vendor empty when only own names were found', () => {
    expect(toExpensePrefill({ organizations: ['Jansen Design', '', null] }, ownNames)).toEqual({});
  });

  it('takes the first organization when no own names are configured', () => {
    expect(toExpensePrefill(complete, []).vendor).toBe('Jansen Design');
    expect(toExpensePrefill(complete, ['  ']).vendor).toBe('Jansen Design');
  });

  it('only prefills the amount for EUR receipts', () => {
    expect(toExpensePrefill({ ...complete, currency: 'USD' }, ownNames).amountMinor).toBeUndefined();
    expect(toExpensePrefill({ ...complete, currency: null }, ownNames).amountMinor).toBeUndefined();
    expect(toExpensePrefill({ ...complete, currency: ' eur ' }, ownNames).amountMinor).toBe('12100');
  });

  it('accepts period-decimal strings but not ambiguous comma decimals', () => {
    expect(toExpensePrefill({ ...complete, total_amount_eur: '24.50' }, ownNames).amountMinor).toBe('2450');
    expect(toExpensePrefill({ ...complete, total_amount_eur: '24,50' }, ownNames).amountMinor).toBeUndefined();
    expect(toExpensePrefill({ ...complete, total_amount_eur: 0 }, ownNames).amountMinor).toBeUndefined();
    expect(toExpensePrefill({ ...complete, total_amount_eur: -5 }, ownNames).amountMinor).toBeUndefined();
  });

  it('only accepts Dutch BTW rates', () => {
    expect(toExpensePrefill({ ...complete, btw_rate_percent: 9 }, ownNames).btwRateBps).toBe(900);
    expect(toExpensePrefill({ ...complete, btw_rate_percent: 0 }, ownNames).btwRateBps).toBe(0);
    expect(toExpensePrefill({ ...complete, btw_rate_percent: 19 }, ownNames).btwRateBps).toBeUndefined();
    expect(toExpensePrefill({ ...complete, btw_rate_percent: null }, ownNames).btwRateBps).toBeUndefined();
  });

  it('drops dates that are not real ISO dates', () => {
    expect(toExpensePrefill({ ...complete, invoice_date: '14-03-2099' }, ownNames).expenseDate).toBeUndefined();
    expect(toExpensePrefill({ ...complete, invoice_date: '2099-02-30' }, ownNames).expenseDate).toBeUndefined();
  });

  it('returns nothing for non-object output', () => {
    expect(toExpensePrefill(null, ownNames)).toEqual({});
    expect(toExpensePrefill('nope', ownNames)).toEqual({});
  });
});

describe('renderFieldDescriptions', () => {
  it('renders one line per field in template order', () => {
    expect(renderFieldDescriptions(DEFAULT_EXPENSE_EXTRACT_FIELD_DESCRIPTIONS).split('\n')).toEqual([
      expect.stringMatching(/^- organizations: /),
      expect.stringMatching(/^- invoice_date: /),
      expect.stringMatching(/^- total_amount_eur: /),
      expect.stringMatching(/^- btw_rate_percent: /),
      expect.stringMatching(/^- currency: /),
    ]);
  });

  it('leaves out blank descriptions', () => {
    const descriptions = { ...DEFAULT_EXPENSE_EXTRACT_FIELD_DESCRIPTIONS, invoice_date: ' ', currency: '' };
    expect(renderFieldDescriptions(descriptions)).not.toMatch(/invoice_date|currency/);
  });
});
