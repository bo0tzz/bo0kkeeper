/**
 * Minimal shared types + helpers for backend error rendering.
 *
 * Historically this file carried the whole fetch pipeline (apiGet/apiPost/
 * silent-refresh/ApiError). After the @bo0kkeeper/sdk migration every HTTP
 * call goes through the SDK's fetch; the silent-refresh wrapper moved to
 * $lib/sdk and the SDK's HttpError is bridged to our ApiFieldIssue shape
 * via extractApiError() there. All that's left here is the ApiFieldIssue
 * type that <ApiErrorAlert/> consumes and the path formatter it uses to
 * render ZodIssue paths like ['lines', 0, 'amount'] → 'lines[0].amount'.
 */

/** Per-field issue from the backend's Zod validation (matches ZodError.issues). */
export type ApiFieldIssue = {
  path: (string | number)[];
  message: string;
  code?: string;
};

export function formatIssuePath(path: (string | number)[]): string {
  return path
    .map((segment, i) => (typeof segment === 'number' ? `[${segment}]` : i === 0 ? segment : `.${segment}`))
    .join('');
}
