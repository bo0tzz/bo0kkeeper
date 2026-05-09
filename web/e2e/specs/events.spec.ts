import { expect, test } from '@playwright/test';

test.describe('Events page', () => {
  test('?status=failed deep-link initializes the filter and matches by API', async ({ page }) => {
    let lastQuery: URLSearchParams | null = null;
    page.on('request', (req) => {
      const url = new URL(req.url());
      if (url.pathname === '/api/events') {
        lastQuery = url.searchParams;
      }
    });

    await page.goto('/events?status=failed');
    await expect(page.getByRole('heading', { level: 1, name: 'Events' })).toBeVisible();
    await page.waitForLoadState('networkidle');

    expect(lastQuery, 'an /api/events request fired').not.toBeNull();
    expect(lastQuery!.get('status')).toBe('failed');
  });

  test('renders source as a friendly label rather than the raw enum', async ({ page }) => {
    await page.goto('/events');
    await expect(page.getByRole('heading', { level: 1, name: 'Events' })).toBeVisible();

    const tableBody = page.locator('table tbody');
    // Wait for at least one row to render.
    await expect(tableBody.locator('tr').first()).toBeVisible();
    // Raw enum values shouldn't surface in a cell.
    await expect(tableBody).not.toContainText(/^\s*(?:wise|paperless|manual|system|bank)\s*$/m);
  });
});
