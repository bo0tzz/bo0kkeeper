import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, Selectable, Updateable } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { ExpenseStatus } from 'src/enum';
import { DB } from 'src/schema';
import { ExpenseTable } from 'src/schema/tables/expense.table';

export type Expense = Selectable<ExpenseTable>;
export type NewExpense = Insertable<ExpenseTable>;
export type ExpenseUpdate = Updateable<ExpenseTable>;

export type IngestResult = { ingested: true; row: Expense } | { ingested: false; existingId: string };

@Injectable()
export class ExpenseRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /**
   * Idempotent insert keyed on `paperlessDocId`. Re-firing the post-consume
   * webhook is safe; the existing row's status is preserved.
   */
  async ingest(input: NewExpense): Promise<IngestResult> {
    const inserted = (await this.db
      .insertInto('expense')
      .values(input)
      .onConflict((oc) => oc.column('paperlessDocId').doNothing())
      .returningAll()
      .executeTakeFirst()) as Expense | undefined;

    if (inserted) {
      return { ingested: true, row: inserted };
    }

    const existing = await this.db
      .selectFrom('expense')
      .select('id')
      .where('paperlessDocId', '=', input.paperlessDocId as string)
      .executeTakeFirstOrThrow();

    return { ingested: false, existingId: existing.id };
  }

  findById(id: string): Promise<Expense | undefined> {
    return this.db.selectFrom('expense').selectAll().where('id', '=', id).executeTakeFirst() as Promise<
      Expense | undefined
    >;
  }

  /** Pending review queue, oldest first (oldest receipts probably need attention sooner). */
  findPendingReview(limit = 100): Promise<Expense[]> {
    return this.db
      .selectFrom('expense')
      .selectAll()
      .where('status', '=', ExpenseStatus.PendingReview)
      .orderBy('expenseDate', 'asc')
      .limit(limit)
      .execute() as Promise<Expense[]>;
  }

  /** Apply review edits + flip status. Idempotent for the same `status`. */
  async update(id: string, patch: ExpenseUpdate): Promise<Expense | undefined> {
    const updated = (await this.db
      .updateTable('expense')
      .set({ ...patch, updatedAt: new Date() })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst()) as Expense | undefined;
    return updated;
  }

  async approve(id: string, patch: Omit<ExpenseUpdate, 'status' | 'reviewedAt'> = {}): Promise<Expense | undefined> {
    return this.update(id, { ...patch, status: ExpenseStatus.Approved, reviewedAt: new Date() });
  }

  async reject(id: string, notes?: string): Promise<Expense | undefined> {
    return this.update(id, {
      status: ExpenseStatus.Rejected,
      reviewedAt: new Date(),
      ...(notes ? { notes } : {}),
    });
  }
}
