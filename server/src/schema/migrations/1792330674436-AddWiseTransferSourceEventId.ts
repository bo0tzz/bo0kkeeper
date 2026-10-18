import { Kysely, sql } from 'kysely';

/**
 * `wise_transfer.sourceEventId` — nullable FK to the `event` row that spawned
 * this transfer. Set for outbound rows created from a `balances#credit` draft
 * trigger; null on inbound transfers and on legacy outbound rows pre-this
 * column. Powers the WiseDraftService idempotency check: a repeat
 * `draftFromEvent({eventId})` returns the existing row rather than spending
 * another Wise API call and allocating a second TXN reference.
 *
 * ON DELETE SET NULL to keep the FK soft — purging an event row should
 * NOT cascade-delete the wise_transfer that materially existed.
 *
 * The two hand-written CHECK constraints on `expense` (`expense_source_present_chk`,
 * `expense_foreign_currency_link_chk`) are not touched here — we don't ALTER
 * expense in this migration, so sql-tools's drift-drop can't hit them.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "wise_transfer" ADD "sourceEventId" uuid;`.execute(db);
  await sql`ALTER TABLE "wise_transfer" ADD CONSTRAINT "FK_wise_transfer_sourceEventId" FOREIGN KEY ("sourceEventId") REFERENCES "event" ("id") ON DELETE SET NULL;`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "wise_transfer" DROP CONSTRAINT "FK_wise_transfer_sourceEventId";`.execute(db);
  await sql`ALTER TABLE "wise_transfer" DROP COLUMN "sourceEventId";`.execute(db);
}
