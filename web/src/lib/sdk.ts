/**
 * SDK wiring layer. The generated `@bo0kkeeper/sdk` bakes the OpenAPI
 * `server` as `defaults.baseUrl = "/api"` and its path strings also start
 * with `/api/...` (controllers declare @Controller('/api/foo')). Prepending
 * the baseUrl would double it to `/api/api/foo` — set it to empty so the
 * paths resolve as-is until a server-side @Controller cleanup moves to
 * app.setGlobalPrefix('api').
 *
 * fetch override: route every SDK request through our silent-refresh
 * wrapper so cookie expiry is handled the same way the hand-written
 * services do (single in-flight /api/auth/refresh, replay the original
 * request, redirect to /api/auth/login if the refresh itself fails).
 * Without this, SDK calls would hit the full login-redirect on every
 * access-token rollover (~5 min) and silently log the user out of their
 * in-progress page.
 *
 * The wrapper only touches the fetch layer. oazapfts still parses the
 * Response and throws its own `HttpError` on non-2xx; call sites that
 * need field-level validation issues can bridge via `apiErrorFromHttpError`
 * (see api.ts).
 */
import type { ApiFieldIssue } from '$lib/services/api';
import { defaults, isHttpError } from '@bo0kkeeper/sdk';

defaults.baseUrl = '';

let refreshInFlight: Promise<boolean> | null = null;

function attemptRefresh(): Promise<boolean> {
  if (refreshInFlight) {
    return refreshInFlight;
  }
  refreshInFlight = (async () => {
    try {
      // eslint-disable-next-line no-restricted-syntax -- SDK wiring layer: direct fetch is intentional here (we're the fetch-override implementation that the services rule is meant to funnel every other call through).
      const res = await fetch('/api/auth/refresh', { method: 'POST' });
      return res.ok;
    } catch {
      return false;
    } finally {
      queueMicrotask(() => {
        refreshInFlight = null;
      });
    }
  })();
  return refreshInFlight;
}

/**
 * Pull a `{message, issues}` pair out of whatever an SDK call might throw —
 * `HttpError` for well-formed non-2xx responses (field-level issues come from
 * the backend's Zod validator in `data.errors`), native `Error` for network
 * failures, unknown for everything else. Feeds `<ApiErrorAlert>` directly.
 */
export function extractApiError(error: unknown): { message: string; issues: ApiFieldIssue[] } {
  if (isHttpError(error)) {
    const data = error.data;
    const issues = Array.isArray(data?.errors) ? (data.errors as ApiFieldIssue[]) : [];
    return { message: data?.message ?? `HTTP ${error.status}`, issues };
  }
  if (error instanceof Error) {
    return { message: error.message, issues: [] };
  }
  return { message: 'Unknown error', issues: [] };
}

defaults.fetch = async (input, init) => {
  // eslint-disable-next-line no-restricted-syntax -- SDK wiring layer: direct fetch is intentional here (we're the fetch-override implementation that the services rule is meant to funnel every other call through).
  const first = await fetch(input, init);
  if (first.status !== 401) {
    return first;
  }
  // Skip the refresh dance if we're already in the auth flow — avoids
  // looping on the refresh endpoint itself returning 401.
  if (typeof location !== 'undefined' && location.pathname.startsWith('/api/auth/')) {
    return first;
  }
  const isRefreshed = await attemptRefresh();
  if (!isRefreshed) {
    // Full-page redirect to the login flow; don't let oazapfts throw
    // HttpError, that bubbles up as a visible error toast before the
    // navigation completes.
    if (typeof location !== 'undefined') {
      const returnTo = location.pathname + location.search;
      location.replace(`/api/auth/login?return_to=${encodeURIComponent(returnTo)}`);
      await new Promise<never>(() => {});
    }
    return first;
  }
  // eslint-disable-next-line no-restricted-syntax -- SDK wiring layer: direct fetch is intentional here (we're the fetch-override implementation that the services rule is meant to funnel every other call through).
  return await fetch(input, init);
};
