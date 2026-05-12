import { DatabaseConnectionParams } from '@immich/sql-tools';
import { Logger } from '@nestjs/common';
import { Kysely } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DB } from 'src/schema';
import { getKyselyConfig } from 'src/utils/database';

/**
 * Migrate the database to the latest revision before the server starts
 * serving traffic. Built-in (Immich-style) so deploys don't need a
 * separate init container or pre-deploy job.
 *
 * Uses Kysely's `Migrator` directly against the same `kysely_migrations`
 * + `kysely_migrations_lock` tables that `@immich/sql-tools migrations
 * run` writes to — so a DB previously migrated via the CLI is in lock-step
 * with what this runner expects.
 *
 * The lock table makes concurrent migrators safe: only one pod actually
 * runs the migrations, the rest wait and find nothing to do.
 */
export async function runMigrations(connection: DatabaseConnectionParams): Promise<void> {
  const logger = new Logger('Migrations');
  // Standalone Kysely client just for the migration pass. We close it
  // before Nest's own KyselyModule wires up the application-lifetime one.
  const db = new Kysely<DB>(getKyselyConfig(connection));
  try {
    const migrator = new Migrator({
      db,
      migrationTableName: 'kysely_migrations',
      migrationLockTableName: 'kysely_migrations_lock',
      provider: new FileMigrationProvider({
        fs: { readdir },
        path: { join },
        // Relative to this file's compiled location (dist/utils/) →
        // dist/schema/migrations/*.js. In dev (tsx) the same relative path
        // resolves to src/schema/migrations/*.ts; tsx handles loading.
        migrationFolder: join(__dirname, '..', 'schema/migrations'),
      }),
    });

    logger.log('Checking for pending migrations…');
    const { error, results } = await migrator.migrateToLatest();

    for (const result of results ?? []) {
      if (result.status === 'Success') {
        logger.log(`Applied migration ${result.migrationName}`);
      } else if (result.status === 'Error') {
        logger.error(`Migration failed: ${result.migrationName}`);
      }
    }

    if (error) {
      throw error;
    }

    if (!results || results.length === 0) {
      logger.log('Database schema is up to date');
    } else {
      logger.log(`Applied ${results.length} migration(s)`);
    }
  } finally {
    await db.destroy();
  }
}
