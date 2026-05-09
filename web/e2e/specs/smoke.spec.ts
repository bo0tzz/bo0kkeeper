import { expect, test } from '@playwright/test';

/**
 * Smoke: every nav-linked route should at least render its <h1> without
 * a console pageerror. Catches the dumb regressions — TS errors that
 * don't surface in svelte-check, missing components, broken imports.
 */
const ROUTES: Array<{ path: string; heading: RegExp }> = [
  { path: '/', heading: /bo0kkeeper/i },
  { path: '/wise', heading: /wise drafts/i },
  { path: '/wise/transfers', heading: /wise transfers/i },
  { path: '/expenses', heading: /expenses/i },
  { path: '/invoices', heading: /^invoices$/i },
  { path: '/invoices/compose', heading: /compose invoice/i },
  { path: '/transactions', heading: /all transactions/i },
  { path: '/aggregator', heading: /btw-aangifte rollup/i },
  { path: '/clients', heading: /^clients$/i },
  { path: '/banking', heading: /^banking$/i },
  { path: '/events', heading: /^events$/i },
  { path: '/system', heading: /^system$/i },
  { path: '/settings', heading: /^settings$/i },
];

for (const { path, heading } of ROUTES) {
  test(`${path} renders without page errors`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    const res = await page.goto(path);
    expect(res?.status()).toBeLessThan(400);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(heading);
    expect(errors, 'pageerrors during render').toEqual([]);
  });
}
