/**
 * Click-driven flow exercises. Each flow opens a page, performs a few
 * interactions, screenshots before/after, and reports findings.
 *
 *   node tools/browser-harness/flows.mjs [flow-name]
 *
 * Without a flow name, runs every flow.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = resolve(__dirname, 'state.json');
const SCREENSHOT_DIR = resolve(__dirname, 'screenshots/flows');
const BASE_URL = process.env.BO0K_BASE ?? 'http://localhost:3000';

mkdirSync(SCREENSHOT_DIR, { recursive: true });

const flows = {
  async 'settings-tag-check'(page) {
    await page.goto(`${BASE_URL}/settings`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/settings-tag-check_1_initial.png`, fullPage: true });

    // Type a typo into the expense tag textarea, then run check.
    const textarea = page.locator('textarea').first();
    await textarea.fill('Buisness, Bills');

    await page.click('button:has-text("Check tags exist")');
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/settings-tag-check_2_after.png`, fullPage: true });
    return 'screenshots saved';
  },

  async 'system-refresh'(page) {
    await page.goto(`${BASE_URL}/system`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/system_1_initial.png`, fullPage: true });
    await page.click('button:has-text("Refresh")');
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/system_2_refreshed.png`, fullPage: true });
    return 'screenshots saved';
  },

  async 'compose-empty-submit'(page) {
    await page.goto(`${BASE_URL}/invoices/compose`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/compose_1_empty.png`, fullPage: true });
    await page.click('button:has-text("Issue invoice")');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/compose_2_after_submit.png`, fullPage: true });
    return 'screenshots saved';
  },

  async 'banking-sync'(page) {
    await page.goto(`${BASE_URL}/banking`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/banking_1_initial.png`, fullPage: true });
    const syncBtn = page.locator('button:has-text("Sync now")').first();
    if ((await syncBtn.count()) > 0) {
      await syncBtn.click();
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `${SCREENSHOT_DIR}/banking_2_after_sync.png`, fullPage: true });
      return 'sync triggered';
    }
    return 'no Sync now button (no active session?)';
  },

  async 'banking-link-modal'(page) {
    await page.goto(`${BASE_URL}/banking`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    const linkBtn = page.locator('button:has-text("Link")').first();
    if ((await linkBtn.count()) === 0) {
      return 'no Link button (everything matched/categorized)';
    }
    await linkBtn.click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/banking-link_1_modal_open.png`, fullPage: true });
    // Try a search.
    const search = page.locator('input[placeholder*="TXN"]').first();
    if ((await search.count()) > 0) {
      await search.fill('TXN-0046');
      await page.click('button:has-text("Search")');
      await page.waitForTimeout(1000);
      await page.screenshot({ path: `${SCREENSHOT_DIR}/banking-link_2_after_search.png`, fullPage: true });
    }
    return 'modal exercised';
  },

  async 'expense-edit'(page) {
    await page.goto(`${BASE_URL}/expenses`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    const editBtn = page.locator('button:has-text("Edit")').first();
    const reviewBtn = page.locator('button:has-text("Review")').first();
    const target = (await reviewBtn.count()) > 0 ? reviewBtn : editBtn;
    if ((await target.count()) === 0) {
      return 'no expenses to edit';
    }
    await target.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/expense_1_edit_open.png`, fullPage: true });
    return 'edit form opened';
  },
};

const requested = process.argv[2];
const toRun = requested ? [requested] : Object.keys(flows);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  storageState: STATE_PATH,
  viewport: { width: 1440, height: 900 },
});
const page = await context.newPage();

const consoleMessages = [];
page.on('console', (msg) => {
  if (msg.type() === 'error' || msg.type() === 'warning') {
    consoleMessages.push({ type: msg.type(), text: msg.text(), url: page.url() });
  }
});
page.on('pageerror', (err) => {
  consoleMessages.push({ type: 'pageerror', text: err.message, url: page.url() });
});

for (const name of toRun) {
  const flow = flows[name];
  if (!flow) {
    console.error(`unknown flow: ${name}`);
    continue;
  }
  try {
    const result = await flow(page);
    console.log(`${name.padEnd(26)} → ${result}`);
  } catch (error) {
    console.error(`${name.padEnd(26)} → error: ${error.message}`);
  }
}

await browser.close();

if (consoleMessages.length > 0) {
  console.log('\n--- console errors / warnings ---');
  for (const m of consoleMessages) {
    console.log(`[${m.type}] (${m.url}) ${m.text}`);
  }
}
