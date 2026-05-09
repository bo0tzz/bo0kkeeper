import { expect, test } from '@playwright/test';

test.describe('Expenses page', () => {
  test('Backfill from paperless button is visible on the header', async ({ page }) => {
    await page.goto('/expenses');
    await expect(page.getByRole('heading', { level: 1, name: 'Expenses' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Backfill from paperless/i })).toBeVisible();
  });

  test('Status filter sends ?status= when changed', async ({ page }) => {
    let lastQuery: URLSearchParams | null = null;
    page.on('request', (req) => {
      const url = new URL(req.url());
      if (url.pathname === '/api/expenses') {
        lastQuery = url.searchParams;
      }
    });

    await page.goto('/expenses');
    await expect(page.getByRole('heading', { level: 1, name: 'Expenses' })).toBeVisible();
    await page.waitForLoadState('networkidle');

    // Immich UI Select renders a button trigger + popup.
    await page.locator('[data-select-trigger]').first().click();
    await page.getByRole('option', { name: /^Approved$/ }).click();
    await page.waitForLoadState('networkidle');

    expect(lastQuery, '/api/expenses request fired').not.toBeNull();
    expect(lastQuery!.get('status')).toBe('approved');
  });
});
