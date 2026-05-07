import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "expense" (
  "id" uuid NOT NULL DEFAULT uuidv7(),
  "paperlessDocId" text NOT NULL,
  "vendor" text NOT NULL,
  "expenseDate" date NOT NULL,
  "amountMinor" bigint NOT NULL,
  "currency" text NOT NULL,
  "btwRateBps" integer,
  "btwMinor" bigint,
  "locationClass" character varying NOT NULL,
  "category" text NOT NULL DEFAULT '',
  "status" character varying NOT NULL DEFAULT 'pending_review',
  "reviewedAt" timestamp with time zone,
  "notes" text,
  "sourceEventId" uuid,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "expense_sourceEventId_fkey" FOREIGN KEY ("sourceEventId") REFERENCES "event" ("id") ON UPDATE NO ACTION ON DELETE SET NULL,
  CONSTRAINT "expense_paperlessDocId_uq" UNIQUE ("paperlessDocId"),
  CONSTRAINT "expense_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "expense_expenseDate_idx" ON "expense" ("expenseDate");`.execute(db);
  await sql`CREATE INDEX "expense_status_idx" ON "expense" ("status");`.execute(db);
  await sql`CREATE INDEX "expense_paperlessDocId_idx" ON "expense" ("paperlessDocId");`.execute(db);
  await sql`CREATE INDEX "expense_sourceEventId_idx" ON "expense" ("sourceEventId");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "expense";`.execute(db);
}
