import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "bank_transaction" (
  "id" uuid NOT NULL DEFAULT uuidv7(),
  "source" character varying NOT NULL,
  "externalId" text NOT NULL,
  "txDate" date NOT NULL,
  "amountMinor" bigint NOT NULL,
  "currency" text NOT NULL,
  "counterpartyName" text,
  "counterpartyIban" text,
  "description" text NOT NULL,
  "rawPayload" jsonb NOT NULL,
  "matchedInvoiceId" uuid,
  "matchedTransferId" uuid,
  "matchedExpenseId" uuid,
  "matchedAt" timestamp with time zone,
  "matchConfidence" character varying,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "bank_transaction_matchedInvoiceId_fkey" FOREIGN KEY ("matchedInvoiceId") REFERENCES "invoice" ("id") ON UPDATE NO ACTION ON DELETE SET NULL,
  CONSTRAINT "bank_transaction_matchedTransferId_fkey" FOREIGN KEY ("matchedTransferId") REFERENCES "wise_transfer" ("id") ON UPDATE NO ACTION ON DELETE SET NULL,
  CONSTRAINT "bank_transaction_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "bank_transaction_matchedInvoiceId_idx" ON "bank_transaction" ("matchedInvoiceId");`.execute(
    db,
  );
  await sql`CREATE INDEX "bank_transaction_matchedTransferId_idx" ON "bank_transaction" ("matchedTransferId");`.execute(
    db,
  );
  await sql`CREATE INDEX "bank_transaction_txDate_idx" ON "bank_transaction" ("txDate");`.execute(db);
  await sql`CREATE UNIQUE INDEX "bank_transaction_source_externalId_unique" ON "bank_transaction" ("source", "externalId");`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "bank_transaction";`.execute(db);
}
