import { Kysely, sql } from 'kysely';

/**
 * Drop the unused `defaultInvoiceTemplate` column on `client`. The render
 * pipeline collapsed to a single generic `invoice.typ` template; this field
 * was passed through controller/DTO/web type but never read for template
 * selection.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "client" DROP COLUMN "defaultInvoiceTemplate";`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "client" ADD COLUMN "defaultInvoiceTemplate" text NOT NULL DEFAULT '';`.execute(db);
}
