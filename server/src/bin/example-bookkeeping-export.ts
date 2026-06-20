/**
 * One-shot: render the bookkeeping list xlsx for a given quarter against
 * the dev DB and write the file to disk. Used to spot-check the export
 * shape without going through the HTTP path.
 *
 * Usage: pnpm tsx src/bin/example-bookkeeping-export.ts <year> <quarter> [outPath]
 */
import { Kysely } from 'kysely';
import { writeFileSync } from 'node:fs';
import { loadConfig } from 'src/config';
import { ExpenseRepository } from 'src/repositories/expense.repository';
import { InvoiceRepository } from 'src/repositories/invoice.repository';
import { DB } from 'src/schema';
import { BookkeepingExportService } from 'src/services/bookkeeping-export.service';
import { Quarter } from 'src/services/quarterly-aggregator.service';
import { getKyselyConfig } from 'src/utils/database';

async function main(): Promise<void> {
  const year = Number.parseInt(process.argv[2] ?? '', 10);
  const quarter = Number.parseInt(process.argv[3] ?? '', 10) as Quarter;
  const outPath = process.argv[4] ?? `/tmp/bookkeeping-${year}-Q${quarter}.xlsx`;
  if (!year || !quarter || quarter < 1 || quarter > 4) {
    throw new Error('usage: example-bookkeeping-export <year> <quarter> [outPath]');
  }

  const cfg = loadConfig();
  const db = new Kysely<DB>(getKyselyConfig(cfg.database));
  try {
    const service = new BookkeepingExportService(new InvoiceRepository(db), new ExpenseRepository(db));
    const { buffer, filename } = await service.exportQuarter(year, quarter);
    writeFileSync(outPath, buffer);
    console.log(`wrote ${outPath} (server filename would be: ${filename})`);
  } finally {
    await db.destroy();
  }
}

void main().catch((error) => {
  console.error('FAIL:', error?.message);
  console.error(error?.stack);
  process.exit(1);
});
