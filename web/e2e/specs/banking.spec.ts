import { expect, test } from '@playwright/test';

test.describe('Banking page', () => {
  test('Link button on an unmatched row opens the candidate-search modal', async ({ page }) => {
    await page.goto('/banking');
    await expect(page.getByRole('heading', { level: 1, name: 'Banking' })).toBeVisible();

    // Use exact-match — `:has-text` is substring and would catch "Unlink" too.
    const linkBtn = page.getByRole('button', { name: /^Link$/, exact: true }).first();
    if ((await linkBtn.count()) === 0) {
      test.skip(true, 'no unmatched rows in dev DB to test the link modal');
    }
    await linkBtn.click();

    // Modal renders with the title + the search input. The Immich Modal title
    // doesn't use a heading element; match by visible text + placeholder.
    await expect(page.getByText('Link bank transaction')).toBeVisible({ timeout: 5000 });
    await expect(page.getByPlaceholder(/TXN ref/i)).toBeVisible();
  });

  test('Sync now button surfaces a queued-toast', async ({ page }) => {
    await page.goto('/banking');
    await expect(page.getByRole('heading', { level: 1, name: 'Banking' })).toBeVisible();
    await page.waitForLoadState('networkidle');

    const syncBtn = page.getByRole('button', { name: /^Sync now$/ }).first();
    if ((await syncBtn.count()) === 0) {
      test.skip(true, 'no active session — Sync now hidden');
    }
    await syncBtn.click();
    await expect(page.getByText(/Sync queued/i)).toBeVisible({ timeout: 5000 });
  });

  test('Date filter sends dateFrom + dateTo on Apply', async ({ page }) => {
    let lastQuery: URLSearchParams | null = null;
    page.on('request', (req) => {
      const url = new URL(req.url());
      if (url.pathname === '/api/banking/transactions') {
        lastQuery = url.searchParams;
      }
    });

    await page.goto('/banking');
    await expect(page.getByRole('heading', { level: 1, name: 'Banking' })).toBeVisible();

    // Field label uses aria-labelledby, which playwright's getByLabel doesn't
    // always resolve cleanly. Position-pick — From/To are the only date inputs.
    const dateInputs = page.locator('input[type="date"]');
    await dateInputs.nth(0).fill('2026-04-01');
    await dateInputs.nth(1).fill('2026-04-30');
    await page.getByRole('button', { name: /^Apply$/ }).click();
    await page.waitForLoadState('networkidle');

    expect(lastQuery, '/api/banking/transactions request fired').not.toBeNull();
    expect(lastQuery!.get('dateFrom')).toBe('2026-04-01');
    expect(lastQuery!.get('dateTo')).toBe('2026-04-30');
  });

  test('Link modal search refetches /match-candidates with the query', async ({ page }) => {
    let candidatesQ: string | null = null;
    page.on('request', (req) => {
      const url = new URL(req.url());
      if (url.pathname === '/api/banking/match-candidates' && url.searchParams.has('q')) {
        candidatesQ = url.searchParams.get('q');
      }
    });

    await page.goto('/banking');
    await expect(page.getByRole('heading', { level: 1, name: 'Banking' })).toBeVisible();
    await page.waitForLoadState('networkidle');

    const linkBtn = page.getByRole('button', { name: /^Link$/, exact: true }).first();
    if ((await linkBtn.count()) === 0) {
      test.skip(true, 'no unmatched rows');
    }
    await linkBtn.click();
    await expect(page.getByText('Link bank transaction')).toBeVisible();

    await page.getByPlaceholder(/TXN ref/i).fill('TXN-0046');
    await page.getByRole('button', { name: /^Search$/ }).click();
    await page.waitForLoadState('networkidle');

    expect(candidatesQ).toBe('TXN-0046');
  });
});
