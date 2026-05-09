import { expect, test } from '@playwright/test';

test.describe('Settings page', () => {
  test('tag-check button surfaces missing tags from a typo', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();

    // Type a typo into the expense tag-gate textarea.
    const expenseTextarea = page.locator('textarea').first();
    const original = await expenseTextarea.inputValue();
    await expenseTextarea.fill('Buisness, Bills');

    await page.getByRole('button', { name: /check tags exist/i }).click();

    // The warning alert spells out which tag is missing.
    await expect(page.getByText(/not found in paperless: Buisness/i)).toBeVisible({ timeout: 10000 });

    // Restore the textarea so we don't accidentally save the typo if a
    // subsequent test does a Save.
    await expenseTextarea.fill(original);
  });

  test('save round-trip updates the Last saved timestamp', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();

    const beforeSavedRow = await page.getByText(/^Last saved /).textContent();

    // Click Save without changing anything; should still bump updatedAt.
    await page.getByRole('button', { name: /^Save$/ }).click();

    // Toast appears.
    await expect(page.getByText(/Saved at \d{2}:\d{2}/)).toBeVisible({ timeout: 5000 });

    // Reload and confirm the footer changed (or at least is present in the new format).
    await page.reload();
    await expect(page.getByText(/Last saved \d{4}-\d{2}-\d{2} \d{2}:\d{2}/)).toBeVisible();
    const afterSavedRow = await page.getByText(/^Last saved /).textContent();
    expect(afterSavedRow).not.toEqual(beforeSavedRow);
  });
});
