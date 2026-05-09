import { expect, test } from '@playwright/test';

test.describe('System page', () => {
  test('shows per-integration health rows', async ({ page }) => {
    await page.goto('/system');
    await expect(page.getByRole('heading', { level: 1, name: 'System' })).toBeVisible();

    // Find the OIDC row by its name cell, then assert healthy on the same row.
    const oidcRow = page.locator('tr', { has: page.getByRole('cell', { name: 'OIDC', exact: true }) });
    await expect(oidcRow).toContainText(/healthy/i);

    // Cutover row visible (status depends on env).
    const cutoverRow = page.locator('tr', { has: page.getByRole('cell', { name: 'Cutover', exact: true }) });
    await expect(cutoverRow).toBeVisible();
  });

  test('Refresh button re-fetches without page errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/system');
    await page.getByRole('button', { name: /^Refresh$/ }).click();
    const oidcRow = page.locator('tr', { has: page.getByRole('cell', { name: 'OIDC', exact: true }) });
    await expect(oidcRow).toContainText(/healthy/i);
    expect(errors).toEqual([]);
  });
});
