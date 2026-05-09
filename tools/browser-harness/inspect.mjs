/**
 * Dump the outer HTML of a CSS selector match on a route — used while
 * writing flow scripts to figure out what the @immich/ui components
 * actually render.
 *
 *   node tools/browser-harness/inspect.mjs /aggregator 'select, [role="combobox"]'
 */
import { chromium } from 'playwright';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = resolve(__dirname, 'state.json');
const BASE_URL = process.env.BO0K_BASE ?? 'http://localhost:3000';

const path = process.argv[2] ?? '/';
const selector = process.argv[3] ?? 'select';

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState: STATE_PATH });
const page = await context.newPage();
await page.goto(BASE_URL + path, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
const matches = await page.locator(selector).all();
console.log(`${matches.length} matches for ${selector}`);
for (let i = 0; i < Math.min(matches.length, 5); i++) {
  const html = await matches[i].evaluate((el) => el.outerHTML.slice(0, 500));
  console.log(`---[${i}]---`);
  console.log(html);
}
await browser.close();
