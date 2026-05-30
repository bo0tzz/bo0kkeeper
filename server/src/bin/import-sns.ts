/**
 * Import a SNS CSV bank statement into bank_transaction, then run the
 * BankMatcher across newly-ingested rows.
 *
 * Usage:
 *   pnpm import-sns <path/to/sns.csv>
 *
 * Idempotent: the (source, externalId) unique index makes re-imports of the
 * same CSV a no-op for rows that already landed.
 */
import { Kysely } from 'kysely';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from 'src/config';
import { BankTransactionRepository } from 'src/repositories/bank-transaction.repository';
import { ClientRepository } from 'src/repositories/client.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { ExpenseRepository } from 'src/repositories/expense.repository';
import { SheetsRepository } from 'src/repositories/sheets.repository';
import { DB } from 'src/schema';
import { BankMatcherService } from 'src/services/bank-matcher.service';
import { RecurringFeeService } from 'src/services/recurring-fee.service';
import { SheetSyncService } from 'src/services/sheet-sync.service';
import { SheetWriterService } from 'src/services/sheet-writer.service';
import { getKyselyConfig } from 'src/utils/database';
import { parseSnsCsv } from 'src/utils/sns-csv';

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error('Usage: import-sns <path-to-csv>');
    process.exit(2);
  }

  const config = loadConfig();
  const db = new Kysely<DB>(getKyselyConfig(config.database));

  try {
    const content = await readFile(resolve(process.cwd(), csvPath), 'utf8');
    const rows = parseSnsCsv(content, 'unknown');
    console.log(`Parsed ${rows.length} rows from ${csvPath}`);

    const bankRepo = new BankTransactionRepository(db);
    const clientRepo = new ClientRepository(db);
    const expenseRepo = new ExpenseRepository(db);
    const sheetWriter = new SheetWriterService(new SheetsRepository());
    const eventRepo = new EventRepository(db);
    const sheetSync = new SheetSyncService(db, clientRepo, sheetWriter, eventRepo);
    const recurringFee = new RecurringFeeService(bankRepo, expenseRepo, eventRepo, sheetSync);
    const matcher = new BankMatcherService(db, bankRepo, sheetSync, eventRepo, recurringFee);

    let ingested = 0;
    let duplicates = 0;
    for (const row of rows) {
      const result = await bankRepo.ingest(row);
      if (result.ingested) {
        ingested++;
      } else {
        duplicates++;
      }
    }
    console.log(`Ingested ${ingested} new, ${duplicates} duplicates`);

    const summary = await matcher.matchAllUnmatched();
    console.log(`Matched ${summary.matched}, unmatched ${summary.unmatched}`);
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
