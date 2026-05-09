import { loadConfig } from 'src/config';

export type CutoverDecision =
  | { allowed: true }
  | { allowed: false; reason: 'no_cutover_configured' }
  | { allowed: false; reason: 'before_cutover'; cutover: string };

/**
 * System-wide cutover gate for ingestion. Every live ingestion path (Wise
 * webhooks, paperless webhooks, bank-tx sync) calls this before persisting
 * to drop events that predate go-live.
 *
 * Returns one of three states:
 *  - allowed: ingest the row.
 *  - no_cutover_configured: env not set; refuse all ingest. Fresh deployments
 *    sit silent until the operator picks a cutover.
 *  - before_cutover: the event's own date is older than the floor.
 */
export function checkCutover(eventDate: Date): CutoverDecision {
  const cutover = loadConfig().cutoverDate;
  if (!cutover) {
    return { allowed: false, reason: 'no_cutover_configured' };
  }
  if (eventDate < new Date(cutover)) {
    return { allowed: false, reason: 'before_cutover', cutover };
  }
  return { allowed: true };
}
