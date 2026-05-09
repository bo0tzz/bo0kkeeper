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
    // Exact-text match — `:has-text` is substring, would catch "Unlink" too.
    const linkBtn = page.getByRole('button', { name: /^Link$/, exact: true }).first();
    if ((await linkBtn.count()) === 0) {
      return 'no exact-text Link button (everything matched/categorized)';
    }
    await linkBtn.click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/banking-link_1_modal_open.png`, fullPage: true });
    // Search for a known TXN ref.
    const search = page.locator('input[placeholder*="TXN"]').first();
    if ((await search.count()) > 0) {
      await search.fill('TXN-0046');
      await page.getByRole('button', { name: /^Search$/ }).click();
      await page.waitForTimeout(1000);
      await page.screenshot({ path: `${SCREENSHOT_DIR}/banking-link_2_after_search.png`, fullPage: true });
    }
    return 'modal exercised';
  },

  async 'compose-add-remove-line'(page) {
    await page.goto(`${BASE_URL}/invoices/compose`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);

    // Add line, screenshot, then remove via Remove button.
    await page.getByRole('button', { name: /^Add line$/ }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/compose-line_1_two_lines.png`, fullPage: true });

    await page.getByRole('button', { name: /^Remove$/ }).first().click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/compose-line_2_after_remove.png`, fullPage: true });
    return 'compose line add/remove exercised';
  },

  async 'aggregator-quarter'(page) {
    await page.goto(`${BASE_URL}/aggregator`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/aggregator_1_initial.png`, fullPage: true });

    // Immich UI Select renders a button + popup; click the trigger then the option.
    const quarterTrigger = page.locator('[data-select-trigger]').nth(1);
    await quarterTrigger.click();
    await page.waitForTimeout(300);
    await page.locator('[role="option"]', { hasText: 'Q1' }).click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/aggregator_2_q1.png`, fullPage: true });
    return 'aggregator quarter changed';
  },

  async 'expenses-status-filter'(page) {
    await page.goto(`${BASE_URL}/expenses`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    const statusTrigger = page.locator('[data-select-trigger]').first();
    await statusTrigger.click();
    await page.waitForTimeout(300);
    await page.locator('[role="option"]', { hasText: 'Approved' }).click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/expenses_1_approved.png`, fullPage: true });
    return 'expenses status filter exercised';
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
