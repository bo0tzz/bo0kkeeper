import { Kysely } from 'kysely';
import { ExpenseLocationClass, ExpenseStatus } from 'src/enum';
import { ExpenseRepository } from 'src/repositories/expense.repository';
import { LlmRepository } from 'src/repositories/llm.repository';
import { PaperlessRepository } from 'src/repositories/paperless.repository';
import { DB } from 'src/schema';
import { ExpenseExtractionService } from 'src/services/expense-extraction.service';
import { SettingsService } from 'src/services/settings.service';
import { DEFAULT_EXPENSE_EXTRACT_FIELD_DESCRIPTIONS } from 'src/utils/expense-extraction';
import { getKyselyDB } from 'test/utils';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

const MODEL_OUTPUT = {
  organizations: ['Jansen Design', 'Acme Supplies B.V.'],
  invoice_date: '2099-03-14',
  total_amount_eur: 121,
  btw_rate_percent: 21,
  currency: 'EUR',
};

function fakePaperless(content: string): PaperlessRepository {
  return {
    getDocument: vi.fn().mockResolvedValue({ id: 1, title: '', content, tags: [], created: '', added: '' }),
  } as unknown as PaperlessRepository;
}

function fakeSettings(ownNames: string[]): SettingsService {
  return {
    getExpenseExtraction: vi.fn().mockResolvedValue({
      ownNames,
      fieldDescriptions: { ...DEFAULT_EXPENSE_EXTRACT_FIELD_DESCRIPTIONS, currency: 'always EUR here' },
    }),
  } as unknown as SettingsService;
}

describe('ExpenseExtractionService', () => {
  let db: Kysely<DB>;
  let expenseRepo: ExpenseRepository;
  let extract: Mock<LlmRepository['extract']>;
  let service: ExpenseExtractionService;

  function buildService(opts: { content?: string; ownNames?: string[] } = {}) {
    return new ExpenseExtractionService(
      expenseRepo,
      { extract } as unknown as LlmRepository,
      fakePaperless(opts.content ?? 'INVOICE Acme Supplies B.V. …'),
      fakeSettings(opts.ownNames ?? ['Jansen']),
    );
  }

  beforeEach(async () => {
    db = await getKyselyDB();
    expenseRepo = new ExpenseRepository(db);
    extract = vi.fn<LlmRepository['extract']>().mockResolvedValue(MODEL_OUTPUT);
    service = buildService();
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function seedExpense(vendor = '') {
    const result = await expenseRepo.ingest({
      paperlessDocId: '9001',
      vendor,
      expenseDate: new Date('2099-03-15'),
      amountMinor: 0n,
      currency: 'EUR',
      btwRateBps: null,
      btwMinor: null,
      locationClass: ExpenseLocationClass.Domestic,
    });
    if (!result.ingested) {
      throw new Error('precondition');
    }
    return result.row;
  }

  it('prefills the extracted fields and derives the BTW amount', async () => {
    const expense = await seedExpense();

    await service.handleExtractExpenseFields({ expenseId: expense.id });

    const after = await expenseRepo.findById(expense.id);
    expect(after).toMatchObject({
      vendor: 'Acme Supplies B.V.',
      amountMinor: '12100',
      btwRateBps: 2100,
      btwMinor: '2100',
      status: ExpenseStatus.PendingReview,
      prefilled: { vendor: 'Acme Supplies B.V.', expenseDate: '2099-03-14', amountMinor: '12100', btwRateBps: 2100 },
    });
    expect(after?.expenseDate).toEqual(new Date('2099-03-14'));
  });

  it('builds the prompt from the settings descriptions', async () => {
    const expense = await seedExpense();

    await service.handleExtractExpenseFields({ expenseId: expense.id });

    expect(extract).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ descriptions: expect.stringContaining('- currency: always EUR here') }),
    );
  });

  it('uses the configured own names to pick the vendor', async () => {
    service = buildService({ ownNames: [] });
    const expense = await seedExpense();

    await service.handleExtractExpenseFields({ expenseId: expense.id });

    const after = await expenseRepo.findById(expense.id);
    expect(after?.vendor).toBe('Jansen Design');
  });

  it('keeps a vendor that ingest already set', async () => {
    const expense = await seedExpense('Acme');

    await service.handleExtractExpenseFields({ expenseId: expense.id });

    const after = await expenseRepo.findById(expense.id);
    expect(after?.vendor).toBe('Acme');
    expect(after?.prefilled).not.toHaveProperty('vendor');
    expect(after?.amountMinor).toBe('12100');
  });

  it("doesn't overwrite an operator edit made while the model ran", async () => {
    const expense = await seedExpense();
    extract.mockImplementation(async () => {
      await expenseRepo.update(expense.id, { amountMinor: 4000n });
      return MODEL_OUTPUT;
    });

    await service.handleExtractExpenseFields({ expenseId: expense.id });

    const after = await expenseRepo.findById(expense.id);
    expect(after?.amountMinor).toBe('4000');
    expect(after?.vendor).toBe('');
    expect(after?.prefilled).toBeNull();
  });

  it('skips expenses that already left review', async () => {
    const expense = await seedExpense();
    await expenseRepo.reject(expense.id);

    await service.handleExtractExpenseFields({ expenseId: expense.id });

    expect(extract).not.toHaveBeenCalled();
  });

  it('skips documents without text', async () => {
    service = buildService({ content: '  \n' });
    const expense = await seedExpense();

    await service.handleExtractExpenseFields({ expenseId: expense.id });

    expect(extract).not.toHaveBeenCalled();
    const after = await expenseRepo.findById(expense.id);
    expect(after?.prefilled).toBeNull();
  });
});
