/**
 * Minimal fetch wrapper for the bo0kkeeper backend.
 *
 * Adds default error handling and JSON parsing. Cookies (auth) are sent
 * automatically by the browser since same-origin.
 *
 * On 401, attempts a silent refresh against `/api/auth/refresh` (which
 * uses the path-scoped refresh-token cookie set at login) and retries
 * the original request once. If the refresh itself fails, falls through
 * to the login redirect.
 */
type ApiOptions = {
  fetch?: typeof fetch;
  query?: Record<string, string | number | undefined>;
};

/** Per-field issue from the backend's Zod validation (matches ZodError.issues). */
export type ApiFieldIssue = {
  path: (string | number)[];
  message: string;
  code?: string;
};

/**
 * Pretty-print a ZodIssue path like ['lines', 0, 'amount'] → 'lines[0].amount',
 * matching how Immich renders backend errors.
 */
export function formatIssuePath(path: (string | number)[]): string {
  return path
    .map((segment, i) => (typeof segment === 'number' ? `[${segment}]` : i === 0 ? segment : `.${segment}`))
    .join('');
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
    message: string,
    public issues: ApiFieldIssue[] = [],
  ) {
    super(message);
  }

  /** Return all issues for the given dotted path (e.g. 'currency'). */
  issuesFor(path: string): ApiFieldIssue[] {
    return this.issues.filter((issue) => formatIssuePath(issue.path) === path);
  }

  /** Render `field: message` lines, joined — useful for a single-line summary. */
  formattedIssues(): string {
    return this.issues
      .map((issue) => {
        const path = formatIssuePath(issue.path);
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join('\n');
  }
}

/**
 * Single in-flight refresh promise: when N requests fire concurrently and
 * all hit a 401, only one /api/auth/refresh round trip happens; the rest
 * await the same promise. Cleared after the refresh resolves either way
 * so a later 401 (e.g. another expiry cycle) re-triggers a fresh refresh.
 */
let refreshInFlight: Promise<boolean> | null = null;

function attemptRefresh(fetchFn: typeof fetch): Promise<boolean> {
  if (refreshInFlight) {
    return refreshInFlight;
  }
  refreshInFlight = (async () => {
    try {
      const res = await fetchFn('/api/auth/refresh', { method: 'POST' });
      return res.ok;
    } catch {
      return false;
    } finally {
      // Defer the clear by a microtask so siblings that await this call
      // observe the same result; the next call (after they all resolve)
      // gets a fresh promise.
      queueMicrotask(() => {
        refreshInFlight = null;
      });
    }
  })();
  return refreshInFlight;
}

type RequestSpec = {
  url: string;
  init: RequestInit;
};

async function request<T>(spec: RequestSpec, options: ApiOptions): Promise<T> {
  const fetchFn = options.fetch ?? fetch;
  const first = await fetchFn(spec.url, spec.init);
  if (first.status !== 401) {
    return parse<T>(first);
  }

  // The 401 happened on a non-auth endpoint — try to silently refresh and
  // replay the original. Skip the refresh if we're already inside an auth
  // route (e.g. the refresh endpoint itself returning 401), otherwise we'd
  // loop on the same request.
  if (globalThis.location !== undefined && globalThis.location.pathname.startsWith('/api/auth/')) {
    return parse<T>(first);
  }
  const refreshed = await attemptRefresh(fetchFn);
  if (!refreshed) {
    return parse<T>(first);
  }
  const second = await fetchFn(spec.url, spec.init);
  return parse<T>(second);
}

export async function apiGet<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const url = options.query ? `${path}?${buildQuery(options.query)}` : path;
  return request<T>({ url, init: { method: 'GET' } }, options);
}

export async function apiPost<T>(path: string, body: unknown, options: ApiOptions = {}): Promise<T> {
  return request<T>(
    {
      url: path,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      },
    },
    options,
  );
}

export async function apiPatch<T>(path: string, body: unknown, options: ApiOptions = {}): Promise<T> {
  return request<T>(
    {
      url: path,
      init: {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      },
    },
    options,
  );
}

export async function apiPut<T>(path: string, body: unknown, options: ApiOptions = {}): Promise<T> {
  return request<T>(
    {
      url: path,
      init: {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      },
    },
    options,
  );
}

export async function apiDelete<T>(path: string, options: ApiOptions = {}): Promise<T> {
  return request<T>({ url: path, init: { method: 'DELETE' } }, options);
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  const data: unknown = text ? safeParseJson(text) : undefined;
  if (!res.ok) {
    // 401 reaching here means either the original request 401'd AND silent
    // refresh failed, OR we're inside an auth flow already. Bounce the user
    // through the login redirect so they end up back where they started.
    if (res.status === 401 && globalThis.location && !globalThis.location.pathname.startsWith('/api/auth/')) {
      const returnTo = globalThis.location.pathname + globalThis.location.search;
      globalThis.location.replace(`/api/auth/login?return_to=${encodeURIComponent(returnTo)}`);
      // Fall through and throw so the awaiting code unwinds — the navigation may not be instant.
    }
    const obj = (data && typeof data === 'object' ? (data as Record<string, unknown>) : null) ?? null;
    const message = (obj && typeof obj.message === 'string' ? obj.message : null) ?? `HTTP ${res.status}`;
    const issues = Array.isArray(obj?.errors) ? (obj.errors as ApiFieldIssue[]) : [];
    throw new ApiError(res.status, data, message, issues);
  }
  return data as T;
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') {
      search.set(key, String(value));
    }
  }
  return search.toString();
}
