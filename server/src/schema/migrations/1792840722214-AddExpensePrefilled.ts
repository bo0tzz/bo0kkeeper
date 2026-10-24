import { Kysely, sql } from 'kysely';

/**
 * `expense.prefilled` — the fields the extraction model filled in after
 * ingest (vendor, date, amount, BTW rate), so the review UI can mark them as
 * unverified. Null for rows the model didn't touch.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "expense" ADD "prefilled" jsonb;`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "expense" DROP COLUMN "prefilled";`.execute(db);
}
