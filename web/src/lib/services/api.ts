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

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
    message: string,
  ) {
    super(message);
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
    const message =
      (data && typeof data === 'object' && 'message' in data && typeof data.message === 'string'
        ? data.message
        : null) ?? `HTTP ${res.status}`;
    throw new ApiError(res.status, data, message);
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
