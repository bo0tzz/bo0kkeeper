/**
 * Browser-harness driver. Reads a saved auth-state file and walks a list
 * of paths, screenshotting each. Used for visual exploration / regression
 * checks while the dev stack is running.
 *
 * One-time setup (assumes dev stack on :3000):
 *   pnpm exec playwright codegen --save-storage=tools/browser-harness/state.json http://localhost:3000
 *   # Click 'Login' / let it redirect to Authentik / sign in / close.
 *
 * Then run:
 *   node tools/browser-harness/walk.mjs [path1] [path2] ...
 *   # Defaults to a sweep of every nav-linked page.
 */
import { chromium } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = resolve(__dirname, 'state.json');
const SCREENSHOT_DIR = resolve(__dirname, 'screenshots');
const BASE_URL = process.env.BO0K_BASE ?? 'http://localhost:3000';

const DEFAULT_PATHS = [
  '/',
  '/wise',
  '/wise/transfers',
  '/expenses',
  '/invoices',
  '/invoices/compose',
  '/transactions',
  '/aggregator',
  '/clients',
  '/banking',
  '/events',
  '/system',
  '/settings',
];

mkdirSync(SCREENSHOT_DIR, { recursive: true });

if (!existsSync(STATE_PATH)) {
  console.error(`No saved auth state at ${STATE_PATH}.`);
  console.error(`Run once: pnpm exec playwright codegen --save-storage=tools/browser-harness/state.json ${BASE_URL}`);
  console.error(`Log in, close the browser, then re-run this script.`);
  process.exit(1);
}

const args = process.argv.slice(2);
const paths = args.length > 0 ? args : DEFAULT_PATHS;

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

const results = [];
for (const path of paths) {
  const url = BASE_URL + path;
  const slug = path.replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+|_+$/g, '') || 'root';
  const file = resolve(SCREENSHOT_DIR, `${slug}.png`);
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
    // Briefly wait for any post-render flicker (skeleton → content).
    await page.waitForTimeout(500);
    await page.screenshot({ path: file, fullPage: true });
    const status = page.url() === url ? 'ok' : `redirected-to:${page.url()}`;
    results.push({ path, status, file });
    console.log(`${path.padEnd(24)} → ${status} (${file})`);
  } catch (error) {
    results.push({ path, status: `error:${error.message}` });
    console.error(`${path.padEnd(24)} → error: ${error.message}`);
  }
}

await browser.close();

if (consoleMessages.length > 0) {
  console.log('\n--- console errors / warnings ---');
  for (const m of consoleMessages) {
    console.log(`[${m.type}] (${m.url}) ${m.text}`);
  }
}

console.log('\nDone. Screenshots in tools/browser-harness/screenshots/');
