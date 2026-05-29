import { Kysely, sql } from 'kysely';

/**
 * Generalise the expense source. The original schema assumed every expense
 * is sourced from a Paperless document (`paperlessDocId NOT NULL UNIQUE`).
 * That assumption breaks for SNS service fees that carry 21% BTW
 * (klantonderzoek, etc.) — Dutch banks don't issue a separate factuur for
 * these because the bank statement line itself is the *vereenvoudigde factuur*
 * under Art. 35a Wet OB. The bank-tx description is the legal documentation;
 * there is no PDF to upload to Paperless.
 *
 * After this migration an expense has at least one source: either a
 * `paperlessDocId` (the Paperless-document path) or a `sourceBankTxId` (the
 * bank-fee path). The CHECK constraint enforces that invariant.
 *
 * Uniqueness on `paperlessDocId` is preserved via a partial index that
 * ignores NULLs (Postgres unique constraints already permit multiple NULLs,
 * but we drop and recreate the index for clarity). `sourceBankTxId` is also
 * unique — one auto-created fee-expense per bank-tx by construction.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "expense" ALTER COLUMN "paperlessDocId" DROP NOT NULL;`.execute(db);
  await sql`ALTER TABLE "expense" ADD COLUMN "sourceBankTxId" uuid;`.execute(db);
  await sql`
    ALTER TABLE "expense"
    ADD CONSTRAINT "expense_sourceBankTxId_fkey"
    FOREIGN KEY ("sourceBankTxId") REFERENCES "bank_transaction" ("id")
    ON UPDATE NO ACTION ON DELETE SET NULL;
  `.execute(db);
  await sql`
    ALTER TABLE "expense"
    ADD CONSTRAINT "expense_source_present_chk"
    CHECK ("paperlessDocId" IS NOT NULL OR "sourceBankTxId" IS NOT NULL);
  `.execute(db);
  await sql`ALTER TABLE "expense" ADD CONSTRAINT "expense_sourceBankTxId_uq" UNIQUE ("sourceBankTxId");`.execute(db);
  await sql`CREATE INDEX "expense_sourceBankTxId_idx" ON "expense" ("sourceBankTxId");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX "expense_sourceBankTxId_idx";`.execute(db);
  await sql`ALTER TABLE "expense" DROP CONSTRAINT "expense_sourceBankTxId_uq";`.execute(db);
  await sql`ALTER TABLE "expense" DROP CONSTRAINT "expense_source_present_chk";`.execute(db);
  await sql`ALTER TABLE "expense" DROP CONSTRAINT "expense_sourceBankTxId_fkey";`.execute(db);
  await sql`ALTER TABLE "expense" DROP COLUMN "sourceBankTxId";`.execute(db);
  await sql`ALTER TABLE "expense" ALTER COLUMN "paperlessDocId" SET NOT NULL;`.execute(db);
}
