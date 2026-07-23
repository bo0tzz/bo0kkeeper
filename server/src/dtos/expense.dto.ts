import { createZodDto } from 'nestjs-zod';
import { ExpenseLocationClass, ExpenseStatus } from 'src/enum';
import { Expense, ExpenseWithMatch } from 'src/repositories/expense.repository';
import { currencyCode, isoDateToDate, moneyMinor, nonEmptyPartial } from 'src/validation';
import z from 'zod';

const ListExpensesQuerySchema = z
  .object({
    status: z.enum(ExpenseStatus).optional(),
    locationClass: z.enum(ExpenseLocationClass).optional(),
    /** YYYY-MM-DD inclusive lower bound on expense date. */
    from: isoDateToDate.optional(),
    /** YYYY-MM-DD inclusive upper bound on expense date. */
    to: isoDateToDate.optional(),
    /**
     * Whether the expense has been matched to a bank_transaction.
     * `false` → unmatched only (drives the "approved, unmatched" dashboard
     * tile). `true` → matched only. Omit for no filter.
     */
    matched: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .meta({ id: 'ListExpensesQueryDto' });
export class ListExpensesQueryDto extends createZodDto(ListExpensesQuerySchema) {}

const ExpensePatchShape = {
  vendor: z.string().min(1).max(200),
  expenseDate: isoDateToDate,
  amountMinor: moneyMinor,
  currency: currencyCode,
  btwRateBps: z.number().int().min(0).max(10_000).nullable(),
  btwMinor: moneyMinor.nullable(),
  locationClass: z.enum(ExpenseLocationClass),
  category: z.string().max(200),
  notes: z.string().nullable(),
};

const ExpenseUpdateSchema = nonEmptyPartial(ExpensePatchShape).meta({ id: 'ExpenseUpdateDto' });
export class ExpenseUpdateDto extends createZodDto(ExpenseUpdateSchema) {}

const ExpenseApproveSchema = z.object(ExpensePatchShape).partial().meta({ id: 'ExpenseApproveDto' });
export class ExpenseApproveDto extends createZodDto(ExpenseApproveSchema) {}

const ExpenseRejectSchema = z
  .object({
    notes: z.string().max(2000).optional(),
  })
  .meta({ id: 'ExpenseRejectDto' });
export class ExpenseRejectDto extends createZodDto(ExpenseRejectSchema) {}

const ExpenseResponseSchema = z
  .object({
    id: z.string(),
    paperlessDocId: z.string(),
    vendor: z.string(),
    expenseDate: z.iso.date(),
    amountMinor: z.string(),
    currency: z.string(),
    btwRateBps: z.number().int().nullable(),
    btwMinor: z.string().nullable(),
    locationClass: z.enum(ExpenseLocationClass),
    category: z.string(),
    status: z.enum(ExpenseStatus),
    reviewedAt: z.iso.datetime().nullable(),
    notes: z.string().nullable(),
    sourceEventId: z.string().nullable(),
    /**
     * ID of the bank_transaction that matched this expense, if any. Populated
     * on list responses (joined from bank_transaction) so the UI can hide the
     * "Link bank tx" affordance for already-matched rows. Individual expense
     * endpoints return null — callers there don't need the state.
     */
    matchedBankTxId: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'ExpenseResponseDto' });
export class ExpenseResponseDto extends createZodDto(ExpenseResponseSchema) {}

const ListExpensesResponseSchema = z
  .object({
    items: z.array(ExpenseResponseSchema),
    total: z.number().int(),
    hasMore: z.boolean(),
  })
  .meta({ id: 'ListExpensesResponseDto' });
export class ListExpensesResponseDto extends createZodDto(ListExpensesResponseSchema) {}

const RescanPaperlessResponseSchema = z
  .object({
    /** Documents returned by the paperless query. */
    scanned: z.number().int().nonnegative(),
    /** New events created (and ProcessPaperlessDocument enqueued for each). */
    enqueued: z.number().int().nonnegative(),
    /** Docs whose paperless event already existed (idempotent no-op). */
    alreadyIngested: z.number().int().nonnegative(),
    /** Docs whose `created` was before CUTOVER_DATE — defensive count, should be 0 since the query also filters. */
    droppedBeforeCutover: z.number().int().nonnegative(),
  })
  .meta({ id: 'RescanPaperlessResponseDto' });
export class RescanPaperlessResponseDto extends createZodDto(RescanPaperlessResponseSchema) {}

export function mapExpense(row: Expense | ExpenseWithMatch): ExpenseResponseDto {
  const withMatch = row as Partial<ExpenseWithMatch>;
  return {
    id: row.id,
    paperlessDocId: row.paperlessDocId,
    vendor: row.vendor,
    expenseDate: toIsoDate(row.expenseDate),
    amountMinor: String(row.amountMinor),
    currency: row.currency,
    btwRateBps: row.btwRateBps,
    btwMinor: row.btwMinor === null ? null : String(row.btwMinor),
    locationClass: row.locationClass,
    category: row.category,
    status: row.status,
    reviewedAt: row.reviewedAt ? toIso(row.reviewedAt) : null,
    notes: row.notes,
    sourceEventId: row.sourceEventId,
    matchedBankTxId: withMatch.matchedBankTxId ?? null,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  } as ExpenseResponseDto;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toIsoDate(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  // Already a string from pg date column — strip any time portion.
  return value.slice(0, 10);
}
