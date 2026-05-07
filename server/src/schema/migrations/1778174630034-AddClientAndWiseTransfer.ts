import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "client" (
  "id" uuid NOT NULL DEFAULT uuidv7(),
  "name" text NOT NULL,
  "class" character varying NOT NULL,
  "tradeName" character varying NOT NULL,
  "address" jsonb NOT NULL,
  "vatId" text,
  "wiseSenderPattern" text,
  "defaultDescription" text NOT NULL DEFAULT '',
  "defaultInvoiceTemplate" text NOT NULL DEFAULT '',
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "client_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "client_wiseSenderPattern_idx" ON "client" ("wiseSenderPattern");`.execute(db);
  await sql`CREATE TABLE "wise_transfer" (
  "id" uuid NOT NULL DEFAULT uuidv7(),
  "wiseTransferId" text NOT NULL,
  "direction" character varying NOT NULL,
  "sourceAmountMinor" bigint NOT NULL,
  "sourceCurrency" text NOT NULL,
  "targetAmountMinor" bigint NOT NULL,
  "targetCurrency" text NOT NULL,
  "fxRate" double precision,
  "feeMinor" bigint NOT NULL DEFAULT 0,
  "feeCurrency" text NOT NULL DEFAULT '',
  "state" character varying NOT NULL,
  "stateUpdatedAt" timestamp with time zone NOT NULL,
  "ourReference" text,
  "counterpartyName" text,
  "correlationId" uuid,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "wise_transfer_wiseTransferId_uq" UNIQUE ("wiseTransferId"),
  CONSTRAINT "wise_transfer_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "wise_transfer_correlationId_idx" ON "wise_transfer" ("correlationId");`.execute(db);
  await sql`CREATE INDEX "wise_transfer_state_idx" ON "wise_transfer" ("state");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "client";`.execute(db);
  await sql`DROP TABLE "wise_transfer";`.execute(db);
}
