import { Kysely, sql } from 'kysely';

/**
 * `app_settings` fields for recognising salary payouts: the operator's
 * personal IBANs and the description phrase that marks a transfer to them as
 * salary (as opposed to e.g. a reimbursement). No IBANs = rule off.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "app_settings" ADD "drawingsIbans" jsonb NOT NULL DEFAULT '[]';`.execute(db);
  await sql`ALTER TABLE "app_settings" ADD "drawingsDescriptionContains" text NOT NULL DEFAULT 'salaris';`.execute(db);
  await sql`ALTER TABLE "app_settings" ALTER COLUMN "drawingsIbans" DROP DEFAULT;`.execute(db);
  await sql`ALTER TABLE "app_settings" ALTER COLUMN "drawingsDescriptionContains" DROP DEFAULT;`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "app_settings" DROP COLUMN "drawingsDescriptionContains";`.execute(db);
  await sql`ALTER TABLE "app_settings" DROP COLUMN "drawingsIbans";`.execute(db);
}
