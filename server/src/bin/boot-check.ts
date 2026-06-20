/**
 * Boot smoke: replay our Kysely migrations + start pg-boss against the
 * configured DB, then exit. CI runs this script twice — once on `main`,
 * then on the PR head against the same DB — so any version transition
 * that breaks startup (forward-only migrations that don't replay, pg-boss
 * schema upgrades that need missing steps, etc.) fails the PR.
 *
 * Connection params from DB_HOST/PORT/USERNAME/PASSWORD/DATABASE_NAME or
 * DB_URL — same env vars as the production server. The script doesn't go
 * through loadConfig() so it avoids needing OIDC/Wise/Paperless creds set
 * just to verify the schema upgrade path.
 */
import { DatabaseConnectionParams } from '@immich/sql-tools';
import { PgBoss } from 'pg-boss';
import { runMigrations } from 'src/utils/migrations';

function dbConfig(): DatabaseConnectionParams {
  if (process.env.DB_URL) {
    return { connectionType: 'url', url: process.env.DB_URL };
  }
  const required = ['DB_HOST', 'DB_PORT', 'DB_USERNAME', 'DB_PASSWORD', 'DB_DATABASE_NAME'];
  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(`Missing ${key} (set DB_URL or DB_HOST/PORT/USERNAME/PASSWORD/DATABASE_NAME)`);
    }
  }
  return {
    connectionType: 'parts',
    host: process.env.DB_HOST!,
    port: Number(process.env.DB_PORT),
    username: process.env.DB_USERNAME!,
    password: process.env.DB_PASSWORD!,
    database: process.env.DB_DATABASE_NAME!,
  };
}

async function main(): Promise<void> {
  const config = dbConfig();

  console.log('Replaying Kysely migrations…');
  await runMigrations(config);

  console.log('Starting pg-boss…');
  const connectionString =
    config.connectionType === 'url'
      ? config.url
      : `postgres://${config.username}:${config.password}@${config.host}:${config.port}/${config.database}`;
  const boss = new PgBoss({ connectionString });
  await boss.start();
  console.log('pg-boss started');
  await boss.stop({ graceful: false });
  console.log('boot-check OK');
}

main().catch((error: unknown) => {
  console.error('boot-check FAILED:', error);
  process.exit(1);
});
