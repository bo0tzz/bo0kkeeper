import { EventSource } from 'src/enum';
import z from 'zod';

/**
 * Field-shape schema for a paperless-ngx workflow webhook body.
 *
 * Owned here — not inside the HTTP DTO — because the same shape has to be
 * re-parseable at *two* boundaries: (a) inbound HTTP request in the webhook
 * controller, and (b) reading the stored `event.payload` (jsonb, typed as
 * `Record<string, unknown>`) inside job handlers. Keeping the shape out of
 * the DTO means job handlers get a strong type back at the queue boundary
 * instead of dispatching on unknown-shaped bags.
 *
 * paperless workflows are user-configurable JSON. In the wild we see:
 *   - `document_id`/`id`/`doc_pk` populated with `{{doc_id}}` (v3+ only)
 *   - `document_url` populated with `{{doc_url}}` (v2.20.x-friendly)
 *   - Any of the id keys mis-mapped to `{{doc_url}}` (URL in an id field)
 * All shapes converge through `resolvePaperlessDocId`.
 *
 * HTTP-time refines (must-have-id, no-placeholders) layer on top of this in
 * `webhook.dto.ts` — kept there because they're inbound-only validations we
 * don't want to re-run against historical events on read.
 */
export const paperlessPayloadShape = z
  .object({
    /** Numeric paperless document id; canonical name in our pipeline. */
    document_id: z.union([z.string(), z.number()]).optional(),
    /** Alias paperless workflow templates use for the same field. */
    id: z.union([z.string(), z.number()]).optional(),
    /** Alias used in some workflow templates ({doc_pk}). */
    doc_pk: z.union([z.string(), z.number()]).optional(),
    /**
     * Full paperless document URL — the only id-carrying variable available
     * on paperless v2.20.x. Format: `<base>/documents/<id>/`.
     * `resolvePaperlessDocId` peels the id off the URL tail.
     */
    document_url: z.string().optional(),
    /** Vendor / correspondent name as plain text. */
    correspondent: z.string().optional(),
    correspondent_name: z.string().optional(),
    /** Document date — ISO-ish string from paperless OCR. */
    created: z.string().optional(),
    created_date: z.string().optional(),
    /** Optional event type when the workflow sets one ("document.consumed", etc). */
    event_type: z.string().optional(),
  })
  .passthrough();

export type PaperlessPayload = z.infer<typeof paperlessPayloadShape>;

/**
 * Resolve the paperless document id from a payload, handling every shape a
 * user-configurable workflow can ship. Returns a bare digit string so the
 * `paperlessDocId` column and any `${baseUrl}/documents/${id}/` redirect
 * never contain a stray URL — that was the class of bug behind expense
 * `019f6b6c-…` in prod.
 */
export function resolvePaperlessDocId(payload: PaperlessPayload): string | undefined {
  const candidates = [payload.document_id, payload.id, payload.doc_pk, payload.document_url];
  for (const value of candidates) {
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === 'number') {
      if (Number.isSafeInteger(value) && value > 0) {
        return String(value);
      }
      continue;
    }
    const trimmed = value.trim();
    const numeric = Number(trimmed);
    if (Number.isSafeInteger(numeric) && numeric > 0 && String(numeric) === trimmed) {
      return String(numeric);
    }
    const fromUrl = extractDocumentIdFromUrl(trimmed);
    if (fromUrl !== undefined) {
      return String(fromUrl);
    }
  }
  return undefined;
}

/**
 * Re-parse a stored paperless event's payload back into `PaperlessPayload`.
 * Restores typing at the queue boundary — the events table stores jsonb as
 * `Record<string, unknown>`, so without this helper every job handler has
 * to poke at unknown fields with type assertions.
 *
 * Throws if the event isn't a paperless event or if the payload has drifted
 * from the shape (e.g. wildly wrong types). A drifted payload is a real
 * incident: fail loudly rather than silently misinterpret.
 */
export function readPaperlessEventPayload(event: { source: EventSource; payload: unknown }): PaperlessPayload {
  if (event.source !== EventSource.Paperless) {
    throw new Error(`readPaperlessEventPayload called with source=${event.source}`);
  }
  return paperlessPayloadShape.parse(event.payload);
}

function extractDocumentIdFromUrl(url: string): number | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  const documentsAt = segments.indexOf('documents');
  if (documentsAt === -1 || documentsAt === segments.length - 1) {
    return undefined;
  }
  const id = Number(segments[documentsAt + 1]);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}
