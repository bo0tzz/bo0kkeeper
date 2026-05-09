/**
 * Capture a clipped screenshot of a route — full-page is too compressed
 * to read in the harness's image-rendering pipeline. Pass the route path
 * + an optional clip (yStart yHeight). Defaults to the top 1000px.
 *
 *   node tools/browser-harness/clip.mjs /banking 0 1000
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = resolve(__dirname, 'state.json');
const SCREENSHOT_DIR = resolve(__dirname, 'screenshots');
const BASE_URL = process.env.BO0K_BASE ?? 'http://localhost:3000';

mkdirSync(SCREENSHOT_DIR, { recursive: true });

const path = process.argv[2] ?? '/';
const yStart = Number(process.argv[3] ?? 0);
const yHeight = Number(process.argv[4] ?? 1000);
const slug = path.replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+|_+$/g, '') || 'root';
const file = resolve(SCREENSHOT_DIR, `${slug}_clip_${yStart}.png`);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  storageState: STATE_PATH,
  viewport: { width: 1440, height: yStart + yHeight + 100 },
});
const page = await context.newPage();
await page.goto(BASE_URL + path, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await page.screenshot({ path: file, clip: { x: 0, y: yStart, width: 1440, height: yHeight } });
await browser.close();
console.log(`Saved ${file}`);
