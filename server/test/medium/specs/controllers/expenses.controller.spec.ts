import { NotFoundException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { ExpensesController } from 'src/controllers/expenses.controller';
import {
  ExpenseApproveDto,
  ExpenseRejectDto,
  ExpenseResponseDto,
  ExpenseUpdateDto,
  ListExpensesQueryDto,
} from 'src/dtos/expense.dto';
import { ExpenseLocationClass, ExpenseStatus } from 'src/enum';
import { ExpenseRepository, NewExpense } from 'src/repositories/expense.repository';
import { DB } from 'src/schema';
import { getKyselyDB } from 'test/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const fakeExpense = (overrides: Partial<NewExpense> = {}): NewExpense => ({
  paperlessDocId: 'paperless-' + Math.random().toString(36).slice(2, 8),
  vendor: 'Acme Cables',
  expenseDate: new Date('2099-04-05'),
  amountMinor: 20_940n,
  currency: 'EUR',
  btwRateBps: 2100,
  btwMinor: 3634n,
  locationClass: ExpenseLocationClass.Domestic,
  category: '',
  notes: null,
  sourceEventId: null,
  ...overrides,
});

describe('ExpensesController', () => {
  let db: Kysely<DB>;
  let repo: ExpenseRepository;
  let controller: ExpensesController;

  beforeEach(async () => {
    db = await getKyselyDB();
    repo = new ExpenseRepository(db);
    controller = new ExpensesController(repo);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('lists expenses with pending_review surfacing first by status sort', async () => {
    const a = await repo.ingest(fakeExpense({ paperlessDocId: 'a', expenseDate: new Date('2099-01-15') }));
    const b = await repo.ingest(fakeExpense({ paperlessDocId: 'b', expenseDate: new Date('2099-02-15') }));
    const c = await repo.ingest(fakeExpense({ paperlessDocId: 'c', expenseDate: new Date('2099-03-15') }));
    if (!a.ingested || !b.ingested || !c.ingested) {
      throw new Error('precondition');
    }
    // Approve B → it should drop below the still-pending A and C in status order.
    await repo.approve(b.row.id);

    const result = await controller.listExpenses({ limit: 50, offset: 0 } as ListExpensesQueryDto);
    expect(result.total).toBe(3);
    // Status group first, then expense_date desc within each.
    expect(result.items.map((row: ExpenseResponseDto) => row.paperlessDocId)).toEqual(['c', 'a', 'b']);
  });

  it('filters by status and locationClass', async () => {
    await repo.ingest(fakeExpense({ paperlessDocId: 'd-1', locationClass: ExpenseLocationClass.Domestic }));
    await repo.ingest(fakeExpense({ paperlessDocId: 'eu-1', locationClass: ExpenseLocationClass.Eu }));

    const onlyDomestic = await controller.listExpenses({
      limit: 50,
      offset: 0,
      locationClass: ExpenseLocationClass.Domestic,
    } as ListExpensesQueryDto);
    expect(onlyDomestic.items).toHaveLength(1);
    expect(onlyDomestic.items[0].paperlessDocId).toBe('d-1');
  });

  it('approve patches editable fields atomically with the status flip', async () => {
    const ingest = await repo.ingest(
      fakeExpense({ paperlessDocId: 'approve-test', vendor: 'Old Vendor', amountMinor: 1000n }),
    );
    if (!ingest.ingested) {
      throw new Error('precondition');
    }

    const result = await controller.approveExpense(ingest.row.id, {
      vendor: 'Acme Cables BV',
      amountMinor: 9999n,
      category: 'hardware',
    } as unknown as ExpenseApproveDto);

    expect(result.status).toBe(ExpenseStatus.Approved);
    expect(result.vendor).toBe('Acme Cables BV');
    expect(result.amountMinor).toBe('9999');
    expect(result.category).toBe('hardware');
    expect(result.reviewedAt).not.toBeNull();
  });

  it('reject sets the notes string', async () => {
    const ingest = await repo.ingest(fakeExpense({ paperlessDocId: 'reject-test' }));
    if (!ingest.ingested) {
      throw new Error('precondition');
    }

    const result = await controller.rejectExpense(ingest.row.id, {
      notes: 'Personal expense — not business.',
    } as ExpenseRejectDto);

    expect(result.status).toBe(ExpenseStatus.Rejected);
    expect(result.notes).toBe('Personal expense — not business.');
  });

  it('patch updates without changing status', async () => {
    const ingest = await repo.ingest(fakeExpense({ paperlessDocId: 'patch-test', amountMinor: 0n }));
    if (!ingest.ingested) {
      throw new Error('precondition');
    }

    const result = await controller.updateExpense(ingest.row.id, {
      amountMinor: 12_345n,
      category: 'ingredients',
    } as unknown as ExpenseUpdateDto);

    expect(result.status).toBe(ExpenseStatus.PendingReview);
    expect(result.amountMinor).toBe('12345');
    expect(result.category).toBe('ingredients');
  });

  it('returns 404 for missing expense ids', async () => {
    const missingId = '00000000-0000-0000-0000-000000000000';
    await expect(controller.getExpense(missingId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.approveExpense(missingId, {} as ExpenseApproveDto)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(controller.rejectExpense(missingId, {} as ExpenseRejectDto)).rejects.toBeInstanceOf(NotFoundException);
  });
});
