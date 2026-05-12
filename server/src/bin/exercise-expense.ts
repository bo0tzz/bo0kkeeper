/**
 * One-shot demo: ingest a pending-review expense, approve it, then synthesise
 * a matching SNS bank tx and manual-match it. The bank-tx match is the
 * canonical kasstelsel money-out signal — that's when the Expense row lands
 * in the configured Google sheet. (Approval itself is a pure DB state change
 * and intentionally writes nothing to the sheet.)
 *
 *   node ./dist/bin/exercise-expense.js                  # date = now
 *   node ./dist/bin/exercise-expense.js --date 2026-07-15  # explicit date
 */
import { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { loadConfig } from 'src/config';
import { ExpensesController } from 'src/controllers/expenses.controller';
import { ExpenseApproveDto } from 'src/dtos/expense.dto';
import { BankSource, ExpenseLocationClass } from 'src/enum';
import { BankTransactionRepository } from 'src/repositories/bank-transaction.repository';
import { ClientRepository } from 'src/repositories/client.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { ExpenseRepository } from 'src/repositories/expense.repository';
import { DB } from 'src/schema';
import { BankMatcherService } from 'src/services/bank-matcher.service';
import { PaperlessService } from 'src/services/paperless.service';
import { SettingsService } from 'src/services/settings.service';
import { SheetWriterService } from 'src/services/sheet-writer.service';
import { SheetsRepository } from 'src/repositories/sheets.repository';
import { WebhookService } from 'src/services/webhook.service';
import { getKyselyConfig } from 'src/utils/database';

if (process.env.NODE_ENV === 'production') {
  console.error('exercise-expense synthesizes fake expenses + bank txs; refusing to run with NODE_ENV=production.');
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
    const expenseRepo = new ExpenseRepository(db);
    const bankRepo = new BankTransactionRepository(db);
    const clientRepo = new ClientRepository(db);
    const eventRepo = new EventRepository(db);
    const sheetWriter = new SheetWriterService(new SheetsRepository());
    const matcher = new BankMatcherService(db, bankRepo, clientRepo, sheetWriter, eventRepo);
    const stubPaperless = {} as unknown as PaperlessService;
    const stubSettings = {} as unknown as SettingsService;
    const stubWebhook = {} as unknown as WebhookService;
    const controller = new ExpensesController(expenseRepo, eventRepo, stubPaperless, stubSettings, stubWebhook);

    const paperlessDocId = `demo-${randomUUID().slice(0, 8)}`;
    const ingest = await expenseRepo.ingest({
      paperlessDocId,
      vendor: 'Acme Cables',
      // The receipt date — under the new model this is just metadata; the
      // sheet date will come from the bank-tx below.
      expenseDate: txDate,
      amountMinor: 12_100n,
      currency: 'EUR',
      btwRateBps: 2100,
      btwMinor: 2100n,
      locationClass: ExpenseLocationClass.Domestic,
      category: 'hardware',
      notes: 'demo USB-C hub',
      sourceEventId: null,
    });
    if (!ingest.ingested) {
      console.error('Pending-review expense already existed — re-run with a fresh id.');
      process.exit(2);
    }
    console.log(
      `Created pending-review expense ${ingest.row.id} (paperlessDocId=${paperlessDocId}, ${ingest.row.amountMinor} ${ingest.row.currency} minor)`,
    );

    // Approval is a pure state flip now — no sheet write.
    const approved = await controller.approveExpense(ingest.row.id, {} as ExpenseApproveDto);
    console.log(`✓ approved expense ${approved.id} (status=${approved.status}, no sheet write yet)`);

    // Bank tx + manual-match is where the kasstelsel write fires.
    const externalId = `demo-exp-${randomUUID().slice(0, 8)}`;
    const bankIngest = await bankRepo.ingest({
      source: BankSource.SnsCsv,
      externalId,
      txDate,
      amountMinor: -12_100n,
      currency: 'EUR',
      counterpartyName: 'Acme Cables BV',
      counterpartyIban: 'NL00DEMO0000000000',
      description: `card payment Acme Cables ref ${paperlessDocId}`,
      rawPayload: { synthesized: true, by: 'exercise-expense' },
    });
    if (!bankIngest.ingested) {
      console.error('Bank tx already existed — re-run with a fresh id.');
      process.exit(2);
    }
    console.log(`Ingested bank tx ${bankIngest.row.id} (externalId=${externalId})`);

    await matcher.manualMatch(bankIngest.row.id, { type: 'expense', targetId: approved.id });
    console.log(`✓ manual-matched bank tx → expense ${approved.id}`);
    console.log(`  Check the dev sheet — a new Expense row dated ${txDate.toISOString().slice(0, 10)} should be there.`);
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
