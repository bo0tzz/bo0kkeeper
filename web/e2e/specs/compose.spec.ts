import { expect, test } from '@playwright/test';

test.describe('Invoice composer', () => {
  test('rejects empty submit with a "Pick a client first" alert', async ({ page }) => {
    await page.goto('/invoices/compose');
    await expect(page.getByRole('heading', { level: 1, name: 'Compose invoice' })).toBeVisible();

    await page.getByRole('button', { name: /^Issue invoice$/ }).click();
    await expect(page.getByText(/Pick a client first/i)).toBeVisible({ timeout: 5000 });
  });

  test('hides the Remove button when only one line, shows it when 2+', async ({ page }) => {
    await page.goto('/invoices/compose');
    // Single line by default — no Remove button.
    await expect(page.getByRole('button', { name: /^Remove$/ })).toHaveCount(0);

    await page.getByRole('button', { name: /^Add line$/ }).click();
    // Two lines now, Remove on each.
    await expect(page.getByRole('button', { name: /^Remove$/ })).toHaveCount(2);

    await page.getByRole('button', { name: /^Remove$/ }).first().click();
    await expect(page.getByRole('button', { name: /^Remove$/ })).toHaveCount(0);
  });
});
