import { isSalaryPayout } from 'src/utils/drawings';
import { describe, expect, it } from 'vitest';

describe('isSalaryPayout', () => {
  const rule = { ibans: ['NL91 ABNA 0417 1643 00'], descriptionContains: 'salaris' };
  const salary = { amountMinor: -250_000n, counterpartyIban: 'NL91ABNA0417164300', description: 'Salaris' };

  it('matches an outgoing salary transfer to a personal IBAN', () => {
    expect(isSalaryPayout(salary, rule)).toBe(true);
  });

  it('ignores IBAN spacing and case', () => {
    expect(isSalaryPayout({ ...salary, counterpartyIban: 'nl91 abna 0417 1643 00' }, rule)).toBe(true);
    expect(isSalaryPayout({ ...salary, amountMinor: '-250000', description: 'SALARIS oktober' }, rule)).toBe(true);
  });

  it('leaves other transfers to the personal IBAN alone', () => {
    expect(isSalaryPayout({ ...salary, description: 'Acme Supplies (reimbursement)' }, rule)).toBe(false);
  });

  it('only matches outflows to a configured IBAN', () => {
    expect(isSalaryPayout({ ...salary, amountMinor: 250_000n }, rule)).toBe(false);
    expect(isSalaryPayout({ ...salary, counterpartyIban: 'DE89370400440532013000' }, rule)).toBe(false);
    expect(isSalaryPayout({ ...salary, counterpartyIban: null }, rule)).toBe(false);
    expect(isSalaryPayout(salary, { ...rule, ibans: [] })).toBe(false);
  });

  it('matches any description when no phrase is configured', () => {
    expect(isSalaryPayout({ ...salary, description: null }, { ...rule, descriptionContains: ' ' })).toBe(true);
  });
});
