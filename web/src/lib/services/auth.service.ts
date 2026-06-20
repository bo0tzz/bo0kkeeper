/**
 * Bypasses the api.ts wrapper deliberately:
 *   - `/api/auth/me` returning 401 means "not authenticated", which is a
 *     normal state on the login page — it must NOT trigger the auto-redirect
 *     that api.ts applies to ordinary 401s.
 *   - `/api/auth/logout` doesn't need refresh-on-401; it just clears the
 *     session cookie regardless of session validity.
 * Every other web call goes through `$lib/services/api.ts`. This file is the
 * single exception, scoped to auth.
 */

export type AuthMe = {
  sub: string;
  email?: string;
  name?: string;
};

export async function getMe(fetchFn: typeof fetch = fetch): Promise<AuthMe | null> {
  try {
    const res = await fetchFn('/api/auth/me');
    return res.ok ? ((await res.json()) as AuthMe) : null;
  } catch {
    return null;
  }
}

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST' });
}

export function loginUrl(returnTo: string): string {
  const params = new URLSearchParams({ return_to: returnTo });
  return `/api/auth/login?${params.toString()}`;
}
