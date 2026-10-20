import { Kysely, sql } from 'kysely';

/**
 * `wise_transfer.invoiceDismissedAt` — timestamp set when the operator marks a
 * settled outbound transfer as "not invoiceable" (e.g. an own-account move,
 * a fee reimbursement, something that reached outgoing_payment_sent but never
 * corresponds to a client-billable invoice). The dashboard "Wise transfer
 * awaiting invoice" tile excludes dismissed rows, and the auto-compose job
 * declines with reason `invoice_dismissed`. Null for everything else.
 *
 * One-way for now — un-dismissing is a direct DB flip if it comes up.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "wise_transfer" ADD "invoiceDismissedAt" timestamp with time zone;`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "wise_transfer" DROP COLUMN "invoiceDismissedAt";`.execute(db);
}
