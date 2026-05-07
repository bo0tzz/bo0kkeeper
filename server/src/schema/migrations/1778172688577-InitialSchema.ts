import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`.execute(db);
  await sql`CREATE TABLE "event" (
  "id" uuid NOT NULL DEFAULT uuidv7(),
  "source" character varying NOT NULL,
  "eventType" text NOT NULL,
  "externalId" text NOT NULL,
  "occurredAt" timestamp with time zone NOT NULL,
  "receivedAt" timestamp with time zone NOT NULL DEFAULT now(),
  "payload" jsonb NOT NULL,
  "status" character varying NOT NULL DEFAULT 'pending',
  "attempts" integer NOT NULL DEFAULT 0,
  "lastError" jsonb,
  "processedAt" timestamp with time zone,
  "correlationId" uuid,
  "relatedEventId" uuid,
  CONSTRAINT "event_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "event_correlationId_idx" ON "event" ("correlationId");`.execute(db);
  await sql`CREATE INDEX "event_eventType_occurredAt_idx" ON "event" ("eventType", "occurredAt");`.execute(db);
  await sql`CREATE INDEX "event_status_receivedAt_idx" ON "event" ("status", "receivedAt");`.execute(db);
  await sql`CREATE UNIQUE INDEX "event_source_externalId_unique" ON "event" ("source", "externalId");`.execute(db);
  await sql`CREATE INDEX "event_relatedEventId_idx" ON "event" ("relatedEventId");`.execute(db);
  await sql`ALTER TABLE "event" ADD CONSTRAINT "event_relatedEventId_fkey" FOREIGN KEY ("relatedEventId") REFERENCES "event" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP EXTENSION "uuid-ossp";`.execute(db);
  await sql`ALTER TABLE "event" DROP CONSTRAINT "event_relatedEventId_fkey";`.execute(db);
  await sql`DROP TABLE "event";`.execute(db);
}
