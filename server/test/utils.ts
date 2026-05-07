import { Kysely, sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import { DB } from 'src/schema';
import { getKyselyConfig } from 'src/utils/database';

function templateConnection() {
  const required = [
    'BO0KKEEPER_TEST_POSTGRES_HOST',
    'BO0KKEEPER_TEST_POSTGRES_PORT',
    'BO0KKEEPER_TEST_POSTGRES_USER',
    'BO0KKEEPER_TEST_POSTGRES_PASSWORD',
    'BO0KKEEPER_TEST_POSTGRES_TEMPLATE',
  ];
  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(`Missing test env: ${key}. Did globalSetup run?`);
    }
  }

  return {
    host: process.env.BO0KKEEPER_TEST_POSTGRES_HOST!,
    port: Number(process.env.BO0KKEEPER_TEST_POSTGRES_PORT),
    username: process.env.BO0KKEEPER_TEST_POSTGRES_USER!,
    password: process.env.BO0KKEEPER_TEST_POSTGRES_PASSWORD!,
    template: process.env.BO0KKEEPER_TEST_POSTGRES_TEMPLATE!,
  };
}

/**
 * Create a fresh per-test database by cloning the template, then return a Kysely
 * instance pointed at it. `CREATE DATABASE ... WITH TEMPLATE` makes this ~50ms.
 *
 * Caller is responsible for `await db.destroy()` (typically in afterEach).
 */
export async function getKyselyDB(): Promise<Kysely<DB>> {
  const tpl = templateConnection();
  const dbName = `bo0kkeeper_test_${randomBytes(6).toString('hex')}`;

  const admin = new Kysely<DB>(
    getKyselyConfig({
      connectionType: 'parts',
      host: tpl.host,
      port: tpl.port,
      username: tpl.username,
      password: tpl.password,
      database: tpl.template,
    }),
  );

  try {
    await sql`CREATE DATABASE ${sql.id(dbName)} WITH TEMPLATE ${sql.id(tpl.template)} OWNER ${sql.id(tpl.username)}`.execute(
      admin,
    );
  } finally {
    await admin.destroy();
  }

  return new Kysely<DB>(
    getKyselyConfig({
      connectionType: 'parts',
      host: tpl.host,
      port: tpl.port,
      username: tpl.username,
      password: tpl.password,
      database: dbName,
    }),
  );
}
