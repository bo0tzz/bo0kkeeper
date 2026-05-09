/**
 * Re-bootstrap the saved auth state by walking through /api/auth/login.
 * Authentik SSO recognises the existing session cookies in state.json and
 * redirects straight to the bo0kkeeper callback, which sets the new
 * id_token + refresh_token cookies. We then save the updated state.
 *
 * Avoids needing the user to re-run `playwright codegen` every time the
 * id_token expires (5 min on this Authentik config).
 */
import { chromium } from 'playwright';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = resolve(__dirname, 'state.json');
const BASE_URL = process.env.BO0K_BASE ?? 'http://localhost:3000';

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState: STATE_PATH });
const page = await context.newPage();

await page.goto(`${BASE_URL}/api/auth/login?return_to=/`, { waitUntil: 'networkidle', timeout: 30000 });
const finalUrl = page.url();
console.log('landed on:', finalUrl);

await context.storageState({ path: STATE_PATH });
await browser.close();
console.log('saved updated state');
