/**
 * One-shot demo: ingest a fake SNS bank tx that lands a Wise transfer's
 * EUR payout, run the matcher, watch the Non-EU income row appear in the
 * configured Google sheet.
 *
 * Picks the first unmatched wise_transfer and synthesises an SNS bank tx
 * whose description carries its TXN-XXXX reference + targetAmountMinor.
 * The matcher's TXN-ref rule auto_high-matches → SheetWriterService writes
 * a Non-EU income row to the current-quarter tab.
 *
 *   node ./dist/bin/exercise-wise.js                  # tx-date = now
 *   node ./dist/bin/exercise-wise.js --date 2026-07-15  # explicit tx-date
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
  console.error('exercise-wise synthesizes fake bank txs; refusing to run with NODE_ENV=production.');
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
    const openTransfer = await db
      .selectFrom('wise_transfer')
      .leftJoin('bank_transaction', 'bank_transaction.matchedTransferId', 'wise_transfer.id')
      .where('bank_transaction.id', 'is', null)
      .where('wise_transfer.ourReference', 'is not', null)
      .select([
        'wise_transfer.id',
        'wise_transfer.ourReference',
        'wise_transfer.targetAmountMinor',
        'wise_transfer.targetCurrency',
        'wise_transfer.state',
      ])
      .orderBy('wise_transfer.createdAt', 'asc')
      .executeTakeFirst();

    if (!openTransfer || !openTransfer.ourReference) {
      console.error('No unmatched wise_transfer rows with a TXN-XXXX ref.');
      process.exit(2);
    }

    console.log(
      `Targeting wise_transfer ${openTransfer.ourReference} (state=${openTransfer.state}, ${openTransfer.targetAmountMinor} ${openTransfer.targetCurrency} minor)`,
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

    const externalId = `demo-wise-${randomUUID().slice(0, 8)}`;
    console.log(`Using tx-date ${txDate.toISOString().slice(0, 10)} (→ quarter tab will reflect this date)`);
    const ingested = await bankRepo.ingest({
      source: BankSource.SnsCsv,
      externalId,
      txDate,
      amountMinor: BigInt(openTransfer.targetAmountMinor as unknown as string),
      currency: openTransfer.targetCurrency,
      counterpartyName: 'Wise',
      counterpartyIban: 'NL00WISE0000000000',
      description: `Wise EUR payout ${openTransfer.ourReference}`,
      rawPayload: { synthesized: true, by: 'exercise-wise' },
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
    if (match.type !== 'wise_transfer') {
      console.error(`Matched the wrong kind: ${match.type}`);
      process.exit(1);
    }
    console.log(`✓ matched bank tx → wise_transfer ${openTransfer.ourReference} (confidence=${match.confidence})`);
    console.log(`  Check the dev sheet — a new row in the current quarter tab should be there.`);
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
