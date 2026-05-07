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
