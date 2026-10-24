import { Kysely, sql } from 'kysely';

/**
 * Operator-editable expense extraction settings on `app_settings`: the
 * operator's own names (skipped when picking a vendor) and the per-field
 * prompt descriptions. The existing row starts with no own names and the
 * descriptions the model was evaluated with; new installs get the same from
 * SettingsService's seed.
 */
export async function up(db: Kysely<any>): Promise<void> {
  const descriptions = {
    organizations: 'every company or person name that appears on this invoice, in order of appearance',
    invoice_date: 'ISO date YYYY-MM-DD',
    total_amount_eur: 'grand total paid including Dutch BTW (VAT), two decimals',
    btw_rate_percent: 'the Dutch BTW rate as a percent — one of 0, 9, or 21; null if invoice is non-EU/VAT-exempt',
    currency: 'ISO 4217 code, usually EUR',
  };
  await sql`ALTER TABLE "app_settings" ADD "extractOwnNames" jsonb NOT NULL DEFAULT '[]';`.execute(db);
  await sql`ALTER TABLE "app_settings" ADD "extractFieldDescriptions" jsonb NOT NULL DEFAULT ${sql.lit(JSON.stringify(descriptions))}::jsonb;`.execute(
    db,
  );
  await sql`ALTER TABLE "app_settings" ALTER COLUMN "extractOwnNames" DROP DEFAULT;`.execute(db);
  await sql`ALTER TABLE "app_settings" ALTER COLUMN "extractFieldDescriptions" DROP DEFAULT;`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "app_settings" DROP COLUMN "extractFieldDescriptions";`.execute(db);
  await sql`ALTER TABLE "app_settings" DROP COLUMN "extractOwnNames";`.execute(db);
}
