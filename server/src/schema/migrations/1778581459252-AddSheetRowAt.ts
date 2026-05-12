import { Kysely, sql } from 'kysely';

/**
 * Add `sheetRowAt timestamptz` to `bank_transaction` and `expense`. Null
 * means "no sheet row has been written for this entity yet"; non-null is
 * the timestamp of the successful write. The new sheet-write retry job
 * picks up any entity that should have a row but doesn't.
 *
 * Backfill: every currently-matched bank_tx and every currently-approved
 * expense (with a matched bank_tx) is treated as "already has a row" so the
 * retry doesn't double-write what's been written manually or via the prior
 * no-retry behaviour.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "bank_transaction" ADD COLUMN "sheetRowAt" timestamp with time zone NULL;`.execute(db);
  await sql`ALTER TABLE "expense" ADD COLUMN "sheetRowAt" timestamp with time zone NULL;`.execute(db);

  // Backfill bank_transaction: anything matched at auto_high or manual to a
  // wise_transfer or invoice is assumed to have its sheet row already.
  await sql`
    UPDATE "bank_transaction"
    SET "sheetRowAt" = NOW()
    WHERE "matchedAt" IS NOT NULL
      AND "matchConfidence" IN ('auto_high', 'manual')
      AND ("matchedTransferId" IS NOT NULL OR "matchedInvoiceId" IS NOT NULL);
  `.execute(db);

  // Backfill expense: approved and bank-tx-matched via manual confidence
  // are assumed to have their sheet row already.
  await sql`
    UPDATE "expense"
    SET "sheetRowAt" = NOW()
    WHERE "status" = 'approved'
      AND EXISTS (
        SELECT 1 FROM "bank_transaction"
        WHERE "bank_transaction"."matchedExpenseId" = "expense"."id"
          AND "bank_transaction"."matchConfidence" = 'manual'
      );
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "expense" DROP COLUMN "sheetRowAt";`.execute(db);
  await sql`ALTER TABLE "bank_transaction" DROP COLUMN "sheetRowAt";`.execute(db);
}
