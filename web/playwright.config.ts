import { defineConfig, devices } from '@playwright/test';

/**
 * Browser e2e for the SvelteKit admin UI. Targets the running dev stack
 * at http://localhost:3000 (mise run dev + start:dev + vite).
 *
 * Auth: tests reuse the saved storage state at
 * `tools/browser-harness/state.json`. To bootstrap or refresh:
 *   node tools/browser-harness/refresh-state.mjs
 *
 * Run:
 *   pnpm --filter web test:browser
 *   pnpm --filter web test:browser -- --ui   (interactive debug)
 */
export default defineConfig({
  testDir: './e2e/specs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.BO0K_BASE ?? 'http://localhost:3000',
    storageState: '../tools/browser-harness/state.json',
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
