import { Database, Extensions, Generated, Int8 } from '@immich/sql-tools';
import { ClientTable } from 'src/schema/tables/client.table';
import { EventTable } from 'src/schema/tables/event.table';
import { WiseTransferTable } from 'src/schema/tables/wise-transfer.table';

@Extensions(['uuid-ossp', 'plpgsql'])
@Database({ name: 'bo0kkeeper' })
export class Bo0kkeeperDatabase {
  tables = [EventTable, ClientTable, WiseTransferTable];
  functions = [];
  enum = [];
}

export interface Migrations {
  id: Generated<number>;
  name: string;
  timestamp: Int8;
}

/** The Kysely DB shape. Each tableName key matches @Table('...') exactly. */
export interface DB {
  kysely_migrations: { timestamp: string; name: string };
  migrations: Migrations;

  event: EventTable;
  client: ClientTable;
  wise_transfer: WiseTransferTable;
}
