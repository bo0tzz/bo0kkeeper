import { Kysely, sql } from 'kysely';

/**
 * Schema only. Initial row is seeded by SettingsService.ensureInitialized
 * at app boot — that path uses the typed Kysely query builder which knows
 * how to serialize the jsonb tag arrays correctly. Doing it in the
 * migration via raw SQL got the JSON double-stringified.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "app_settings" (
  "id" uuid NOT NULL DEFAULT uuidv7(),
  "issuerKvk" text NOT NULL,
  "issuerVatId" text NOT NULL,
  "issuerAddressLine1" text NOT NULL,
  "issuerPostalCode" text NOT NULL,
  "issuerCity" text NOT NULL,
  "issuerCountry" text NOT NULL,
  "issuerIban" text NOT NULL,
  "paperlessExpenseTags" jsonb NOT NULL,
  "paperlessOutgoingInvoiceTags" jsonb NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "app_settings_pkey" PRIMARY KEY ("id")
);`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "app_settings";`.execute(db);
}
