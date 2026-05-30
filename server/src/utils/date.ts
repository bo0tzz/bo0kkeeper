/**
 * Coerce a value that may be a Date or a date-ish string/number into a Date.
 * Kysely reads some timestamp/date columns back as strings depending on the
 * driver/codec, so service code that does date math defends with this. No-op
 * when the value is already a Date.
 */
export function toDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value);
}
