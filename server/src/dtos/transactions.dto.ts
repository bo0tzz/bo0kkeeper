import { createZodDto } from 'nestjs-zod';
import z from 'zod';

const ListTransactionsQuerySchema = z
  .object({
    /** ISO YYYY-MM-DD; rows on or after this date. */
    dateFrom: z.iso.date().optional(),
    /** ISO YYYY-MM-DD; rows on or before this date. */
    dateTo: z.iso.date().optional(),
    /** 'bank' | 'wise' | undefined (all). */
    source: z.enum(['bank', 'wise']).optional(),
  })
  .meta({ id: 'ListTransactionsQueryDto' });
export class ListTransactionsQueryDto extends createZodDto(ListTransactionsQuerySchema) {}

/**
 * Unified row shape for the all-transactions view. Bank rows and Wise
 * transfer rows share columns where possible (date, amount, counterparty);
 * source-specific extras (match info for bank, state for wise) are nullable.
 */
const TransactionRowSchema = z.object({
  /** Composite id: `bank:<uuid>` or `wise:<uuid>` — unique across sources. */
  id: z.string(),
  source: z.enum(['bank', 'wise']),
  date: z.string(),
  /** Signed amount in minor units (negative = outflow). */
  amountMinor: z.string(),
  currency: z.string(),
  counterparty: z.string().nullable(),
  /**
   * Human label of what this row represents:
   *   bank rows: 'Income (invoice 2026/001)' / 'Expense (Acme Cables)' / 'Tax' /
   *              'Drawings' / 'Self-transfer' / 'Fee' / 'Unmatched'
   *   wise rows: 'Wise USD→EUR' (or whichever direction)
   */
  type: z.string(),
  /** TXN-NNNN, YYYY/NNN, wise transfer id, or whatever identifies the row. */
  reference: z.string().nullable(),
  description: z.string(),
  /** Match metadata for bank rows (always null for wise). */
  match: z
    .object({
      kind: z.enum(['wise_transfer', 'invoice', 'expense']),
      id: z.string(),
      confidence: z.string().nullable(),
    })
    .nullable(),
  /** State for wise rows (always null for bank). */
  state: z.string().nullable(),
});

const ListTransactionsResponseSchema = z
  .object({
    items: z.array(TransactionRowSchema),
    total: z.number().int(),
  })
  .meta({ id: 'ListTransactionsResponseDto' });
export class ListTransactionsResponseDto extends createZodDto(ListTransactionsResponseSchema) {}
