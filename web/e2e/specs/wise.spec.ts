import { expect, test } from '@playwright/test';

test.describe('Wise drafts page', () => {
  test('renders pending balance-credit events with the auto-allocated TXN reference placeholder', async ({ page }) => {
    await page.goto('/wise');
    await expect(page.getByRole('heading', { level: 1, name: 'Wise drafts' })).toBeVisible();

    // The TXN reference column has a placeholder hint in each row's input.
    const placeholders = page.locator('input[placeholder="auto-allocated"]');
    // If there are pending events, there's at least one such input.
    const count = await placeholders.count();
    if (count === 0) {
      test.skip(true, 'no pending wise credits in dev DB');
    }
    await expect(placeholders.first()).toBeVisible();
    await expect(page.getByRole('button', { name: /^Draft transfer$/ }).first()).toBeVisible();
  });

  test('Reconcile button surfaces a queued message', async ({ page }) => {
    await page.goto('/wise');
    await page.getByRole('button', { name: /^Reconcile transfers$/ }).click();
    await expect(page.getByText(/Reconcile queued/i)).toBeVisible({ timeout: 5000 });
  });
});
