import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "bank_transaction" ADD "category" character varying;`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "bank_transaction" DROP COLUMN "category";`.execute(db);
}
