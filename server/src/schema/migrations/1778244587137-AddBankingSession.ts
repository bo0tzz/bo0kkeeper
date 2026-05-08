import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "banking_session" (
  "id" uuid NOT NULL DEFAULT uuidv7(),
  "oauthState" uuid NOT NULL,
  "aspspName" text NOT NULL,
  "aspspCountry" text NOT NULL,
  "psuType" text NOT NULL,
  "status" character varying NOT NULL,
  "applicationSessionId" text,
  "accountsJson" jsonb,
  "expiresAt" timestamp with time zone,
  "lastSyncedAt" timestamp with time zone,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "banking_session_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "banking_session_status_idx" ON "banking_session" ("status");`.execute(db);
  await sql`CREATE UNIQUE INDEX "banking_session_oauthState_uq" ON "banking_session" ("oauthState");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "banking_session";`.execute(db);
}
