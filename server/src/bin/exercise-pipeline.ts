/**
 * One-shot demo: ingest a fake SNS bank tx that pays an existing invoice,
 * run the matcher, and watch a row land in the configured Google sheet.
 *
 * Picks the first open (unmatched) invoice in the DB and synthesises a
 * matching bank tx with that invoice number in the description. The matcher
 * sees the number → auto_high match → SheetWriterService appends the income
 * row to the current-quarter tab.
 *
 *   node ./dist/bin/exercise-pipeline.js                  # tx-date = now
 *   node ./dist/bin/exercise-pipeline.js --date 2026-07-15  # tx-date = explicit
 *
 * The `--date` form is handy when you want to land a row in a quarter tab
 * that doesn't exist yet — useful for verifying the header / formatting
 * behaviour on a fresh tab.
 */
import { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { loadConfig } from 'src/config';
import { BankSource } from 'src/enum';
import { BankTransactionRepository } from 'src/repositories/bank-transaction.repository';
import { ClientRepository } from 'src/repositories/client.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { ExpenseRepository } from 'src/repositories/expense.repository';
import { InvoiceRepository } from 'src/repositories/invoice.repository';
import { SheetsRepository } from 'src/repositories/sheets.repository';
import { DB } from 'src/schema';
import { BankMatcherService } from 'src/services/bank-matcher.service';
import { RecurringFeeService } from 'src/services/recurring-fee.service';
import { SheetSyncService } from 'src/services/sheet-sync.service';
import { SheetWriterService } from 'src/services/sheet-writer.service';
import { getKyselyConfig } from 'src/utils/database';

if (process.env.NODE_ENV === 'production') {
  console.error('exercise-pipeline synthesizes fake bank txs; refusing to run with NODE_ENV=production.');
  process.exit(1);
}

function parseDateArg(): Date {
  const idx = process.argv.indexOf('--date');
  if (idx === -1) {
    return new Date();
  }
  const value = process.argv[idx + 1];
  if (!value) {
    throw new Error('--date requires a YYYY-MM-DD value');
  }
  const parsed = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError(`--date value "${value}" is not a valid ISO date`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const db = new Kysely<DB>(getKyselyConfig(config.database));
  const txDate = parseDateArg();

  try {
    const openInvoice = await db
      .selectFrom('invoice')
      .leftJoin('bank_transaction', 'bank_transaction.matchedInvoiceId', 'invoice.id')
      .innerJoin('client', 'client.id', 'invoice.clientId')
      .where('bank_transaction.id', 'is', null)
      .select([
        'invoice.id',
        'invoice.number',
        'invoice.totalMinor',
        'invoice.currency',
        'invoice.issuedAt',
        'client.name as clientName',
      ])
      .orderBy('invoice.issuedAt', 'asc')
      .executeTakeFirst();

    if (!openInvoice) {
      console.error('No open invoices to match against. Issue one via /invoices/compose first.');
      process.exit(2);
    }

    console.log(
      `Targeting invoice ${openInvoice.number} (${openInvoice.clientName}, ${openInvoice.totalMinor} ${openInvoice.currency} minor)`,
    );

    const bankRepo = new BankTransactionRepository(db);
    const clientRepo = new ClientRepository(db);
    const invoiceRepo = new InvoiceRepository(db);
    const expenseRepo = new ExpenseRepository(db);
    const sheetWriter = new SheetWriterService(new SheetsRepository());
    const eventRepo = new EventRepository(db);
    const sheetSync = new SheetSyncService(db, clientRepo, invoiceRepo, sheetWriter, eventRepo);
    const recurringFee = new RecurringFeeService(bankRepo, expenseRepo, eventRepo, sheetSync);
    const matcher = new BankMatcherService(db, bankRepo, sheetSync, eventRepo, recurringFee);

    const externalId = `demo-${randomUUID().slice(0, 8)}`;
    console.log(`Using tx-date ${txDate.toISOString().slice(0, 10)} (→ quarter tab will reflect this date)`);
    const ingested = await bankRepo.ingest({
      source: BankSource.SnsCsv,
      externalId,
      txDate,
      amountMinor: BigInt(openInvoice.totalMinor as unknown as string),
      currency: openInvoice.currency,
      counterpartyName: openInvoice.clientName,
      counterpartyIban: 'NL00DEMO0000000000',
      description: `Demo payment for invoice ${openInvoice.number}`,
      rawPayload: { synthesized: true, by: 'exercise-pipeline' },
    });
    if (!ingested.ingested) {
      console.error('Bank tx already existed — re-run with a fresh id.');
      process.exit(2);
    }

    console.log(`Ingested bank tx ${ingested.row.id} (externalId=${externalId})`);

    const match = await matcher.tryMatch(ingested.row);
    if (!match.matched) {
      console.error(`Matcher didn't latch: ${match.reason}`);
      process.exit(1);
    }
    if (match.type !== 'invoice') {
      console.error(`Matched the wrong kind: ${match.type}`);
      process.exit(1);
    }
    console.log(`✓ matched bank tx → invoice ${openInvoice.number} (confidence=${match.confidence})`);
    console.log(`  Check the dev sheet — a new row in the current quarter tab should be there.`);
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
