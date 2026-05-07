import { createPostgres, DatabaseConnectionParams } from '@immich/sql-tools';
import { Logger as NestLogger } from '@nestjs/common';
import { KyselyConfig, Logger } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';

const logger = new NestLogger('Kysely');

const queryLogger: Logger = (event) => {
  if (event.level === 'error') {
    logger.error(`Query failed (${event.queryDurationMillis.toFixed(0)}ms): ${event.error}`, {
      sql: event.query.sql,
      params: event.query.parameters,
    });
  }
};

export function getKyselyConfig(connection: DatabaseConnectionParams): KyselyConfig {
  return {
    dialect: new PostgresJSDialect({
      postgres: createPostgres({
        connection,
        onNotice: (notice) => {
          if (notice['severity'] !== 'NOTICE') {
            logger.warn(`Postgres notice: ${JSON.stringify(notice)}`);
          }
        },
      }),
    }),
    log: queryLogger,
  };
}
