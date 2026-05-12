import { Kysely, sql } from 'kysely';

/**
 * Sequence for `TXN-NNNN` references on outbound Wise transfers. Starts at
 * an offset so that auto-allocated references can continue an existing
 * manual numbering chain rather than colliding with it.
 *
 * sql-tools doesn't model Postgres sequences, hence this hand-written migration.
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE SEQUENCE "wise_txn_sequence" START WITH 44`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP SEQUENCE IF EXISTS "wise_txn_sequence"`.execute(db);
}
