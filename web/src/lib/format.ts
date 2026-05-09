/**
 * Date / time formatters in the canonical YYYY-MM-DD HH:MM shape used
 * across the app. Dates and times are rendered in the user's local
 * timezone — not UTC — since the user is operating the system from one
 * fixed locale (NL) and seeing wall-clock times match their day matters
 * more than transport-stable UTC strings would.
 */
export function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function formatDateTime(d: Date): string {
  return `${formatDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function formatTime(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
