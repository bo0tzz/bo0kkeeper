/**
 * Minimal fetch wrapper for the bo0kkeeper backend.
 *
 * Adds default error handling and JSON parsing. Cookies (auth) are sent
 * automatically by the browser since same-origin.
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

export async function apiGet<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const fetchFn = options.fetch ?? fetch;
  const url = options.query ? `${path}?${buildQuery(options.query)}` : path;
  const res = await fetchFn(url, { method: 'GET' });
  return parse<T>(res);
}

export async function apiPost<T>(path: string, body: unknown, options: ApiOptions = {}): Promise<T> {
  const fetchFn = options.fetch ?? fetch;
  const res = await fetchFn(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return parse<T>(res);
}

export async function apiPatch<T>(path: string, body: unknown, options: ApiOptions = {}): Promise<T> {
  const fetchFn = options.fetch ?? fetch;
  const res = await fetchFn(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return parse<T>(res);
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  const data: unknown = text ? safeParseJson(text) : undefined;
  if (!res.ok) {
    // 401 mid-session typically means the ID-token cookie expired. Bounce the
    // user through /api/auth/login → IDP → callback so we get a fresh cookie
    // and they end up back where they were. Skip if we're already in the auth
    // flow, otherwise we'd loop.
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
