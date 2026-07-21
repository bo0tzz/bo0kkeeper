import { createZodDto } from 'nestjs-zod';
import { paperlessPayloadShape } from 'src/utils/paperless-payload';
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
 * Paperless-ngx workflow webhook envelope. The field shape lives in
 * `utils/paperless-payload.ts` because it's shared with the read-time
 * parser inside job handlers — see that file for the full explanation.
 * This DTO adds inbound-only refines (must-have-id, no-placeholders)
 * that we don't want to re-run against historical events on read.
 */
const PaperlessWebhookSchema = paperlessPayloadShape
  .refine(
    (v) => v.document_id !== undefined || v.id !== undefined || v.doc_pk !== undefined || v.document_url !== undefined,
    {
      message: 'paperless webhook body must include one of: document_id, id, doc_pk, document_url',
    },
  )
  .refine(
    (v) => {
      // Paperless-ngx workflow webhook bodies are Jinja2 templates — values
      // MUST use `{{ doc_url }}` (double braces). Literal `{doc_pk}` or
      // `{{doc_id}}` arriving un-substituted usually means the workflow was
      // set up against an older placeholder guide, or paperless couldn't
      // resolve the variable for that trigger type. Reject up front rather
      // than silently trying to fetch a paperless doc with a placeholder
      // where an id should be.
      const values = [v.document_id, v.id, v.doc_pk, v.document_url, v.correspondent, v.created, v.created_date];
      // Match `{name}`, `{{name}}`, `{{ name }}` — any brace-wrapped identifier.
      const placeholderRe = /^\{\{?\s*[a-z_]+\s*\}?\}$/i;
      return values.every((value) => typeof value !== 'string' || !placeholderRe.test(value));
    },
    {
      message:
        'paperless webhook body has unresolved placeholder strings (e.g. `{doc_pk}` or literal `{{doc_id}}`); check the workflow webhook params — values must be Jinja2 (`{{doc_url}}`, `{{correspondent}}`, `{{created}}`). `doc_id` is only available on paperless ≥ v3.0.0-beta; on v2.20.x use `{{doc_url}}` (we peel the id off the URL).',
    },
  )
  .meta({ id: 'PaperlessWebhookDto' });

export class PaperlessWebhookDto extends createZodDto(PaperlessWebhookSchema) {}
