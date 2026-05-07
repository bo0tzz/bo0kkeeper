import { Kysely, sql } from 'kysely';

/**
 * Sequence for `TXN-NNNN` references on outbound Wise transfers. The user's
 * existing manual sheet is at TXN-0001 at go-live, so we start at 44 — the
 * first auto-allocated reference will be TXN-0044, continuing the chain.
 *
 * sql-tools doesn't model Postgres sequences, hence this hand-written migration.
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE SEQUENCE "wise_txn_sequence" START WITH 44`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP SEQUENCE IF EXISTS "wise_txn_sequence"`.execute(db);
}
