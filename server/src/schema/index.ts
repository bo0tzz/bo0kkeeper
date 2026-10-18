import { Database, Extensions, Generated, Int8 } from '@immich/sql-tools';
import { AppSettingsTable } from 'src/schema/tables/app-settings.table';
import { BankTransactionTable } from 'src/schema/tables/bank-transaction.table';
import { BankingSessionTable } from 'src/schema/tables/banking-session.table';
import { ClientTable } from 'src/schema/tables/client.table';
import { EventTable } from 'src/schema/tables/event.table';
import { ExpenseTable } from 'src/schema/tables/expense.table';
import { InvoiceLineTable } from 'src/schema/tables/invoice-line.table';
import { InvoiceNumberSequenceTable } from 'src/schema/tables/invoice-number-sequence.table';
import { InvoiceTable } from 'src/schema/tables/invoice.table';
import { PeriodCloseTable } from 'src/schema/tables/period-close.table';
import { WiseTransferTable } from 'src/schema/tables/wise-transfer.table';

// Decorator-driven schema registration — @Database is sql-tools's hook to
// discover tables (which this class lists) at migrations:generate time.
// No TypeScript code imports the class by name, but the decorator side-effect
// is load-bearing, so keep it exported to silence unused-var lints.
@Extensions(['uuid-ossp', 'plpgsql'])
@Database({ name: 'bo0kkeeper' })
export class Bo0kkeeperDatabase {
  tables = [
    EventTable,
    ClientTable,
    WiseTransferTable,
    InvoiceTable,
    InvoiceLineTable,
    InvoiceNumberSequenceTable,
    BankTransactionTable,
    ExpenseTable,
    BankingSessionTable,
    PeriodCloseTable,
    AppSettingsTable,
  ];
  functions = [];
  enum = [];
}

interface Migrations {
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
  invoice: InvoiceTable;
  invoice_line: InvoiceLineTable;
  invoice_number_sequence: InvoiceNumberSequenceTable;
  bank_transaction: BankTransactionTable;
  expense: ExpenseTable;
  banking_session: BankingSessionTable;
  period_close: PeriodCloseTable;
  app_settings: AppSettingsTable;
}
