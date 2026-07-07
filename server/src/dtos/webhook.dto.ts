import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/**
 * Wise webhook envelope. The system stores `payload` verbatim in the events table
 * (jsonb), so this schema is used only to extract the fields we need for the row
 * (event_type, occurred_at, the resource id for `externalId` / `correlationId`).
 *
 * We intentionally don't lock down `data` strictly — Wise occasionally adds fields
 * within event types and we don't want a schema mismatch to block ingestion.
 */
const WiseWebhookSchema = z
  .object({
    event_type: z.string().min(1),
    schema_version: z.string().optional(),
    sent_at: z.string().optional(),
    subscription_id: z.string().optional(),
    data: z
      .object({
        occurred_at: z.string().optional(),
        resource: z
          .object({
            id: z.union([z.number(), z.string()]).optional(),
            type: z.string().optional(),
            profile_id: z.union([z.number(), z.string()]).optional(),
            account_id: z.union([z.number(), z.string()]).optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough()
  .meta({ id: 'WiseWebhookDto' });

export class WiseWebhookDto extends createZodDto(WiseWebhookSchema) {}

/**
 * Paperless-ngx workflow webhook envelope. paperless-ngx workflow actions of
 * type "Webhook" send an arbitrary user-defined JSON body — the only firm
 * requirement here is that *some* document identifier reaches us. Fields are
 * accepted as either strings or numbers because users wire workflow templates
 * with mixed types (`{doc_pk}` is numeric, `{document_id}` is string-ish).
 */
const PaperlessWebhookSchema = z
  .object({
    /** Numeric paperless document id; canonical name in our pipeline. */
    document_id: z.union([z.string(), z.number()]).optional(),
    /** Alias paperless workflow templates use for the same field. */
    id: z.union([z.string(), z.number()]).optional(),
    /** Alias used in some workflow templates ({doc_pk}). */
    doc_pk: z.union([z.string(), z.number()]).optional(),
    /** Vendor / correspondent name as plain text. */
    correspondent: z.string().optional(),
    correspondent_name: z.string().optional(),
    /** Document date — ISO-ish string from paperless OCR. */
    created: z.string().optional(),
    created_date: z.string().optional(),
    /** Optional event type when the workflow sets one ("document.consumed", etc). */
    event_type: z.string().optional(),
  })
  .passthrough()
  .refine((v) => v.document_id !== undefined || v.id !== undefined || v.doc_pk !== undefined, {
    message: 'paperless webhook body must include one of: document_id, id, doc_pk',
  })
  .refine(
    (v) => {
      // Paperless-ngx workflow webhook bodies are Jinja2 templates — values
      // MUST use `{{ doc_id }}` (double braces). Literal `{doc_pk}` or
      // `{{doc_id}}` arriving un-substituted usually means the workflow was
      // set up against an older placeholder guide, or paperless couldn't
      // resolve the variable for that trigger type. Reject up front rather
      // than silently trying to fetch a paperless doc with a placeholder
      // where an id should be.
      const values = [v.document_id, v.id, v.doc_pk, v.correspondent, v.created, v.created_date];
      // Match `{name}`, `{{name}}`, `{{ name }}` — any brace-wrapped identifier.
      const placeholderRe = /^\{\{?\s*[a-z_]+\s*\}?\}$/i;
      return values.every((value) => typeof value !== 'string' || !placeholderRe.test(value));
    },
    {
      message:
        'paperless webhook body has unresolved placeholder strings (e.g. `{doc_pk}` or literal `{{doc_id}}`); check the workflow webhook params — values must be Jinja2 (`{{doc_id}}`, `{{correspondent}}`, `{{created}}`) and `doc_pk` / `created_date` are not valid paperless placeholders',
    },
  )
  .meta({ id: 'PaperlessWebhookDto' });

export class PaperlessWebhookDto extends createZodDto(PaperlessWebhookSchema) {}
