import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "invoice" (
  "id" uuid NOT NULL DEFAULT uuidv7(),
  "number" text NOT NULL,
  "clientId" uuid NOT NULL,
  "issuedAt" date NOT NULL,
  "periodStart" date,
  "periodEnd" date,
  "currency" text NOT NULL,
  "totalMinor" bigint NOT NULL,
  "eurTotalMinor" bigint,
  "fxRate" text,
  "btwRateBps" integer,
  "btwMinor" bigint,
  "paperlessDocId" text,
  "sourceEventId" uuid,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "invoice_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client" ("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "invoice_sourceEventId_fkey" FOREIGN KEY ("sourceEventId") REFERENCES "event" ("id") ON UPDATE NO ACTION ON DELETE SET NULL,
  CONSTRAINT "invoice_number_uq" UNIQUE ("number"),
  CONSTRAINT "invoice_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "invoice_issuedAt_idx" ON "invoice" ("issuedAt");`.execute(db);
  await sql`CREATE INDEX "invoice_clientId_idx" ON "invoice" ("clientId");`.execute(db);
  await sql`CREATE INDEX "invoice_sourceEventId_idx" ON "invoice" ("sourceEventId");`.execute(db);
  await sql`CREATE TABLE "invoice_line" (
  "id" uuid NOT NULL DEFAULT uuidv7(),
  "invoiceId" uuid NOT NULL,
  "ordinal" integer NOT NULL,
  "description" text NOT NULL,
  "unitLabel" text,
  "quantity" text,
  "lineTotalMinor" bigint NOT NULL,
  CONSTRAINT "invoice_line_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoice" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "invoice_line_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "invoice_line_invoiceId_idx" ON "invoice_line" ("invoiceId");`.execute(db);
  await sql`CREATE TABLE "invoice_number_sequence" (
  "year" integer NOT NULL,
  "lastNumber" integer NOT NULL DEFAULT 0,
  CONSTRAINT "invoice_number_sequence_pkey" PRIMARY KEY ("year")
);`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "invoice_line";`.execute(db);
  await sql`DROP TABLE "invoice";`.execute(db);
  await sql`DROP TABLE "invoice_number_sequence";`.execute(db);
}
