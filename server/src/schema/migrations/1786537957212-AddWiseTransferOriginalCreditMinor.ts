import { Kysely, sql } from 'kysely';

/**
 * `wise_transfer.originalCreditMinor` — the credit-event amount the sweep
 * spawned from, in `sourceCurrency`. Equal to `sourceAmountMinor` under a
 * full-balance sweep, strictly greater when the sweep ran with
 * `allowUnderCredit=true` because Wise-flow expenses drew from the pool.
 *
 * Invoice compose uses this as the invoice total, not `sourceAmountMinor`,
 * so the composed invoice reflects what the client actually paid — not
 * what happened to remain after Wise-side spends. Null on historical
 * outbound rows; the compose helpers fall back to `sourceAmountMinor`.
 *
 * The two hand-written CHECK constraints (`expense_source_present_chk`,
 * `expense_foreign_currency_link_chk`) are preserved untouched —
 * sql-tools's diff drops them because they're not declared via a decorator
 * but the invariants are still ours.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "wise_transfer" ADD "originalCreditMinor" bigint;`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "wise_transfer" DROP COLUMN "originalCreditMinor";`.execute(db);
}
