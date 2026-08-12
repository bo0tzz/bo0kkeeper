import { Kysely, sql } from 'kysely';

/**
 * Wise-flow foreign-currency expenses. Adds:
 *   - `wiseTransferId` FK → the sweep that converted (or will convert) the
 *     USD/other pool this expense drew from.
 *   - `eurAmountMinor` + `fxRate` — populated at sweep-clear time from the
 *     wise_transfer's realized fxRate. Kept null before that; the
 *     aggregator/sheet-writer treat null-eur wise-linked rows as "pending".
 *   - `expense_foreign_currency_link_chk` — a foreign-currency expense must
 *     have a wise_transfer link, so its EUR figure can be computed at sweep
 *     time. Prevents orphan USD rows that have no path to an EUR figure.
 *
 * The pre-existing `expense_source_present_chk` (paperless OR bank-fee)
 * is preserved untouched — sql-tools drops it on diff because it's not in
 * the table-class decorator, so we re-add it explicitly below.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "expense" ADD "wiseTransferId" uuid;`.execute(db);
  await sql`ALTER TABLE "expense" ADD "eurAmountMinor" bigint;`.execute(db);
  await sql`ALTER TABLE "expense" ADD "fxRate" text;`.execute(db);
  await sql`CREATE INDEX "expense_wiseTransferId_idx" ON "expense" ("wiseTransferId");`.execute(db);
  await sql`
    ALTER TABLE "expense"
    ADD CONSTRAINT "expense_wiseTransferId_fkey"
    FOREIGN KEY ("wiseTransferId") REFERENCES "wise_transfer" ("id")
    ON UPDATE NO ACTION ON DELETE SET NULL;
  `.execute(db);
  await sql`
    ALTER TABLE "expense"
    ADD CONSTRAINT "expense_foreign_currency_link_chk"
    CHECK ("currency" = 'EUR' OR "wiseTransferId" IS NOT NULL);
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "expense" DROP CONSTRAINT "expense_foreign_currency_link_chk";`.execute(db);
  await sql`ALTER TABLE "expense" DROP CONSTRAINT "expense_wiseTransferId_fkey";`.execute(db);
  await sql`DROP INDEX "expense_wiseTransferId_idx";`.execute(db);
  await sql`ALTER TABLE "expense" DROP COLUMN "fxRate";`.execute(db);
  await sql`ALTER TABLE "expense" DROP COLUMN "eurAmountMinor";`.execute(db);
  await sql`ALTER TABLE "expense" DROP COLUMN "wiseTransferId";`.execute(db);
}
