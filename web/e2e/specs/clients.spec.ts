import { expect, test } from '@playwright/test';

test.describe('Clients page', () => {
  test('renders the friendly labels for class + trade name', async ({ page }) => {
    await page.goto('/clients');
    await expect(page.getByRole('heading', { level: 1, name: 'Clients' })).toBeVisible();

    // Raw enums (it_services, non_eu, eu_reverse_charge, 3d) shouldn't surface
    // in the table cells. The friendly labels (IT Services / Non-EU / EU
    // (BTW charged) / 3D / Domestic) replace them.
    const table = page.getByRole('table');
    await expect(table).not.toContainText('it_services');
    await expect(table).not.toContainText('eu_reverse_charge');
    // At least one of the friendly labels lands somewhere.
    await expect(table).toContainText(/IT Services|3D|Domestic|Non-EU/);
  });

  test('New client button opens the create form, Cancel closes it', async ({ page }) => {
    await page.goto('/clients');
    await page.getByRole('button', { name: /^New client$/ }).click();

    // Form heading + a Name input + a Create button surface.
    await expect(page.getByRole('heading', { name: /^New client$/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Create client$/ })).toBeVisible();

    // Cancel collapses the form.
    await page.getByRole('button', { name: /^Cancel$/ }).click();
    await expect(page.getByRole('heading', { name: /^New client$/ })).toHaveCount(0);
  });
});
