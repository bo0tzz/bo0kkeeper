import { authManager } from '$lib/managers/auth-manager.svelte';
import { redirect } from '@sveltejs/kit';
import type { LayoutLoad } from './$types';

export const ssr = false;
export const csr = true;
export const prerender = false;

const PUBLIC_PATHS = new Set<string>(['/api/auth/login', '/api/auth/callback']);

export const load: LayoutLoad = async ({ fetch, url }) => {
  await authManager.load(fetch);

  if (!authManager.authenticated && !PUBLIC_PATHS.has(url.pathname)) {
    redirect(307, authManager.loginUrl(url.pathname + url.search));
  }

  return {
    meta: { title: 'bo0kkeeper' },
  };
};
