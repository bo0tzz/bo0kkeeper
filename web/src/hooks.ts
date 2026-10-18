import type { Reroute } from '@sveltejs/kit';

/**
 * Alias paths that render an existing entity page with a preset filter.
 * The browser URL stays as the alias (bookmarkable, nav-visible); the page
 * component detects which alias ran via `page.url.pathname` and applies the
 * preset. Keeps the "pretty" URL without duplicating the page body.
 */
const aliases: Record<string, string> = {
  '/expenses/pending': '/expenses',
  '/expenses/awaiting-bank': '/expenses',
  '/banking/unmatched': '/banking',
  '/events/failed': '/events',
};

export const reroute: Reroute = ({ url }) => aliases[url.pathname];
