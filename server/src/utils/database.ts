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
        // sql-tools's default is to parseInt bigint columns into JS `number`,
        // which silently loses precision past 2^53 AND defeats the schema's
        // `ColumnType<bigint>` declarations — call-site code ended up doing
        // `BigInt(row.amountMinor as unknown as string)` everywhere because
        // the runtime type didn't match the declared one. Opt out: the driver
        // then returns the raw postgres text ("479100") that the schema types
        // want BigInt applied to. Still not actually `bigint` at runtime, but
        // consistently stringly-typed and precision-preserving.
        convertBigIntToNumber: false,
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
