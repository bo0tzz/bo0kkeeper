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
    // Wait for the page's session card to render before checking for the button.
    await expect(page.getByRole('heading', { level: 1, name: 'Banking' })).toBeVisible();
    await page.waitForLoadState('networkidle');

    const syncBtn = page.getByRole('button', { name: /^Sync now$/ }).first();
    if ((await syncBtn.count()) === 0) {
      test.skip(true, 'no active session — Sync now hidden');
    }
    await syncBtn.click();
    await expect(page.getByText(/Sync queued/i)).toBeVisible({ timeout: 5000 });
  });
});
