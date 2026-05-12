/**
 * One-shot demo: ingest a fake pending-review expense, approve it via the
 * controller path (so the sheet append fires), watch the Expense row land
 * in the configured Google sheet's quarter tab.
 *
 *   node ./dist/bin/exercise-expense.js                  # date = now
 *   node ./dist/bin/exercise-expense.js --date 2026-07-15  # explicit date
 */
import { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { loadConfig } from 'src/config';
import { ExpensesController } from 'src/controllers/expenses.controller';
import { ExpenseApproveDto } from 'src/dtos/expense.dto';
import { ExpenseLocationClass } from 'src/enum';
import { EventRepository } from 'src/repositories/event.repository';
import { ExpenseRepository } from 'src/repositories/expense.repository';
import { DB } from 'src/schema';
import { PaperlessService } from 'src/services/paperless.service';
import { SettingsService } from 'src/services/settings.service';
import { SheetWriterService } from 'src/services/sheet-writer.service';
import { SheetsService } from 'src/services/sheets.service';
import { WebhookService } from 'src/services/webhook.service';
import { getKyselyConfig } from 'src/utils/database';

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
  const expenseDate = parseDateArg();

  try {
    const expenseRepo = new ExpenseRepository(db);
    const eventRepo = new EventRepository(db);
    const sheetWriter = new SheetWriterService(new SheetsService());
    // The controller's rescan path is unused here; stub out the rescan deps.
    const stubPaperless = {} as unknown as PaperlessService;
    const stubSettings = {} as unknown as SettingsService;
    const stubWebhook = {} as unknown as WebhookService;
    const controller = new ExpensesController(
      expenseRepo,
      eventRepo,
      stubPaperless,
      stubSettings,
      stubWebhook,
      sheetWriter,
    );

    const paperlessDocId = `demo-${randomUUID().slice(0, 8)}`;
    const ingest = await expenseRepo.ingest({
      paperlessDocId,
      vendor: 'Acme Cables',
      expenseDate,
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
    console.log(`Using expense-date ${expenseDate.toISOString().slice(0, 10)} (→ quarter tab will reflect this date)`);

    const result = await controller.approveExpense(ingest.row.id, {} as ExpenseApproveDto);
    console.log(`✓ approved expense ${result.id} (status=${result.status})`);
    console.log(`  Check the dev sheet — a new Expense row in the current quarter tab should be there.`);
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
