import { expect, test } from '@playwright/test';

test.describe('Aggregator page', () => {
  test('quarter selector switches the rollup period', async ({ page }) => {
    await page.goto('/aggregator');
    await expect(page.getByRole('heading', { level: 1, name: /BTW-aangifte rollup/ })).toBeVisible();

    // Immich UI Select renders a button trigger + popup; not a native <select>.
    const quarterTrigger = page.locator('[data-select-trigger]').nth(1);
    await quarterTrigger.click();
    await page.getByRole('option', { name: 'Q1' }).click();

    // Period footer in the Net BTW card should now reflect Q1 dates.
    await expect(page.getByText(/Period 2026-01-01 – 2026-04-01/)).toBeVisible({ timeout: 5000 });
  });
});
