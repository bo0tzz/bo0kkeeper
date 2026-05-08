import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "period_close" (
  "id" uuid NOT NULL DEFAULT uuidv7(),
  "year" integer NOT NULL,
  "quarter" integer NOT NULL,
  "closedAt" timestamp with time zone NOT NULL,
  "notes" text,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "period_close_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE UNIQUE INDEX "period_close_year_quarter_uq" ON "period_close" ("year", "quarter");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "period_close";`.execute(db);
}
