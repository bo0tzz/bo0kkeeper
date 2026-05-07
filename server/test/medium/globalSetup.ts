import { DatabaseConnectionParams } from '@immich/sql-tools';
import { FileMigrationProvider, Kysely, Migrator } from 'kysely';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DB } from 'src/schema';
import { getKyselyConfig } from 'src/utils/database';
import { GenericContainer, Wait } from 'testcontainers';

/**
 * Boots a single Postgres container for the whole vitest run, applies all migrations
 * to a "template" database, then exposes its connection params to specs via env vars.
 *
 * Each spec creates a fresh database per test via `CREATE DATABASE x WITH TEMPLATE template`,
 * giving ~50ms-clean DBs without re-running migrations. See `test/utils.ts:getKyselyDB`.
 */

const TEMPLATE_DB_NAME = 'bo0kkeeper_template';
const POSTGRES_USER = 'postgres';
const POSTGRES_PASSWORD = 'postgres';

const globalSetup = async () => {
  const container = await new GenericContainer('postgres:18')
    .withExposedPorts(5432)
    .withEnvironment({
      POSTGRES_USER,
      POSTGRES_PASSWORD,
      POSTGRES_DB: TEMPLATE_DB_NAME,
    })
    .withCommand(['postgres', '-c', 'fsync=off', '-c', 'full_page_writes=off', '-c', 'synchronous_commit=off'])
    .withWaitStrategy(Wait.forAll([Wait.forLogMessage('database system is ready to accept connections', 2)]))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);

  process.env.BO0KKEEPER_TEST_POSTGRES_HOST = host;
  process.env.BO0KKEEPER_TEST_POSTGRES_PORT = String(port);
  process.env.BO0KKEEPER_TEST_POSTGRES_USER = POSTGRES_USER;
  process.env.BO0KKEEPER_TEST_POSTGRES_PASSWORD = POSTGRES_PASSWORD;
  process.env.BO0KKEEPER_TEST_POSTGRES_TEMPLATE = TEMPLATE_DB_NAME;

  const connection: DatabaseConnectionParams = {
    connectionType: 'parts',
    host,
    port,
    username: POSTGRES_USER,
    password: POSTGRES_PASSWORD,
    database: TEMPLATE_DB_NAME,
  };

  const db = new Kysely<DB>(getKyselyConfig(connection));

  try {
    const migrator = new Migrator({
      db,
      provider: new FileMigrationProvider({
        fs,
        path,
        migrationFolder: path.resolve(process.cwd(), 'src/schema/migrations'),
      }),
    });
    const { error, results } = await migrator.migrateToLatest();
    if (error) {
      throw error;
    }
    if (results?.some((r) => r.status === 'Error')) {
      throw new Error(`One or more migrations failed: ${JSON.stringify(results)}`);
    }
  } finally {
    await db.destroy();
  }
};

export default globalSetup;
