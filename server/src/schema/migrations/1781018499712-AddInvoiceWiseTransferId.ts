import { Kysely, sql } from 'kysely';

/**
 * Link an invoice to the Wise transfer that triggered it. Drives the
 * "auto-invoice from incoming Wise payment" flow — once an outbound Wise
 * transfer reaches `outgoing_payment_sent`, the operator composes an invoice
 * for it, and we persist the link so subsequent bank-tx matches (and the
 * sheet income row) can carry the invoice number instead of a placeholder
 * TXN-NNNN reference.
 *
 * Nullable: existing invoices (composed via the Domestic flow or before this
 * column existed) have no Wise transfer. Unique: one invoice per Wise
 * transfer in MVP; multi-paycheck split (one transfer → multiple invoices)
 * is deferred.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "invoice" ADD COLUMN "wiseTransferId" uuid;`.execute(db);
  await sql`
    ALTER TABLE "invoice"
    ADD CONSTRAINT "invoice_wiseTransferId_fkey"
    FOREIGN KEY ("wiseTransferId") REFERENCES "wise_transfer" ("id")
    ON UPDATE NO ACTION ON DELETE SET NULL;
  `.execute(db);
  await sql`ALTER TABLE "invoice" ADD CONSTRAINT "invoice_wiseTransferId_uq" UNIQUE ("wiseTransferId");`.execute(db);
  await sql`CREATE INDEX "invoice_wiseTransferId_idx" ON "invoice" ("wiseTransferId");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX "invoice_wiseTransferId_idx";`.execute(db);
  await sql`ALTER TABLE "invoice" DROP CONSTRAINT "invoice_wiseTransferId_uq";`.execute(db);
  await sql`ALTER TABLE "invoice" DROP CONSTRAINT "invoice_wiseTransferId_fkey";`.execute(db);
  await sql`ALTER TABLE "invoice" DROP COLUMN "wiseTransferId";`.execute(db);
}
