/**
 * Smoke-test the Google Sheets dev setup.
 *
 *   pnpm --filter bo0kkeeper exec tsx src/bin/sheets-smoke.ts        # read-only — list tabs
 *   pnpm --filter bo0kkeeper exec tsx src/bin/sheets-smoke.ts --write # also append a marker row to a "smoke-test" tab
 *
 * Verifies in order:
 *   1. SHEETS_SERVICE_ACCOUNT_* + SPREADSHEET_ID env vars are set.
 *   2. Service-account JWT mints an access token (good private key + email).
 *   3. The spreadsheet is reachable + the service account has access (correct
 *      share + Sheets API enabled on the GCP project).
 *   4. (--write) appending to a fresh tab succeeds.
 *
 * If any step throws, the message contains enough hint to point you at the
 * right setup step. `walk through Sheets dev setup` in the project README.
 */
import { loadConfig } from 'src/config';
import { SheetsRepository } from 'src/repositories/sheets.repository';

const IS_WRITE = process.argv.includes('--write');
const SMOKE_TAB = 'smoke-test';

async function main(): Promise<void> {
  const cfg = loadConfig().sheets;
  if (!cfg.serviceAccountEmail || !cfg.serviceAccountPrivateKey || !cfg.spreadsheetId) {
    throw new Error(
      'Sheets env not configured. Set SHEETS_SERVICE_ACCOUNT_EMAIL, SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY, SHEETS_SPREADSHEET_ID.',
    );
  }

  const service = new SheetsRepository();
  console.log(`spreadsheet: ${cfg.spreadsheetId}`);
  console.log(`service account: ${cfg.serviceAccountEmail}`);

  const tabs = await service.listTabs();
  console.log(`✓ listed ${tabs.length} tab(s):`);
  for (const t of tabs) {
    console.log(`    ${t.title} (sheetId=${t.sheetId})`);
  }

  if (IS_WRITE) {
    const now = new Date().toISOString();
    await service.ensureTab(SMOKE_TAB);
    await service.appendRow(SMOKE_TAB, [now, 'sheets-smoke', 'OK', `from ${process.env.HOSTNAME ?? 'unknown'}`]);
    console.log(`✓ appended a marker row to "${SMOKE_TAB}" tab`);
  } else {
    console.log('(read-only — pass --write to append a marker row to a "smoke-test" tab)');
  }
}

main().catch((error: unknown) => {
  console.error('✗ sheets-smoke failed');
  console.error((error as Error).message);
  process.exitCode = 1;
});
