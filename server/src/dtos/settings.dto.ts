import { createZodDto } from 'nestjs-zod';
import { ExpenseExtractFieldDescriptions } from 'src/utils/expense-extraction';
import z from 'zod';

/** Keyed by the extraction template's field names, which the model sees verbatim. */
const ExtractFieldDescriptionsSchema = z.object({
  organizations: z.string().max(500),
  invoice_date: z.string().max(500),
  total_amount_eur: z.string().max(500),
  btw_rate_percent: z.string().max(500),
  currency: z.string().max(500),
}) satisfies z.ZodType<ExpenseExtractFieldDescriptions>;

const SettingsResponseSchema = z
  .object({
    issuer: z.object({
      kvk: z.string(),
      vatId: z.string(),
      addressLine1: z.string(),
      postalCode: z.string(),
      city: z.string(),
      country: z.string(),
      iban: z.string(),
    }),
    paperless: z.object({
      expenseTags: z.array(z.string()),
      outgoingInvoiceTags: z.array(z.string()),
    }),
    extraction: z.object({
      /** Case-insensitive substrings; organizations containing one are never picked as vendor. */
      ownNames: z.array(z.string()),
      fieldDescriptions: ExtractFieldDescriptionsSchema,
    }),
    drawings: z.object({
      /** Personal account IBANs; outgoing salary transfers to these are categorised as drawings. */
      ibans: z.array(z.string()),
      /** Case-insensitive phrase a salary transfer's description contains. */
      descriptionContains: z.string(),
    }),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'SettingsResponseDto' });
export class SettingsResponseDto extends createZodDto(SettingsResponseSchema) {}

const UpdateSettingsBodySchema = z
  .object({
    issuer: z
      .object({
        kvk: z.string().min(1),
        vatId: z.string().min(1),
        addressLine1: z.string().min(1),
        postalCode: z.string().min(1),
        city: z.string().min(1),
        country: z.string().min(1),
        iban: z.string().min(1),
      })
      .partial(),
    paperless: z
      .object({
        expenseTags: z.array(z.string()),
        outgoingInvoiceTags: z.array(z.string()),
      })
      .partial(),
    extraction: z
      .object({
        ownNames: z.array(z.string().min(1).max(200)),
        fieldDescriptions: ExtractFieldDescriptionsSchema,
      })
      .partial(),
    drawings: z
      .object({
        ibans: z.array(z.string().regex(/^[A-Z]{2}\d{2}[A-Z0-9 ]{10,34}$/i, { error: 'Not an IBAN' })),
        descriptionContains: z.string().max(200),
      })
      .partial(),
  })
  .partial()
  .meta({ id: 'UpdateSettingsDto' });
export class UpdateSettingsDto extends createZodDto(UpdateSettingsBodySchema) {}

const PaperlessTagCheckBodySchema = z
  .object({
    tags: z.array(z.string()).min(1).max(50),
  })
  .meta({ id: 'PaperlessTagCheckDto' });
export class PaperlessTagCheckDto extends createZodDto(PaperlessTagCheckBodySchema) {}

const PaperlessTagCheckResponseSchema = z
  .object({
    results: z.array(
      z.object({
        name: z.string(),
        exists: z.boolean(),
        id: z.number().int().nullable(),
      }),
    ),
  })
  .meta({ id: 'PaperlessTagCheckResponseDto' });
export class PaperlessTagCheckResponseDto extends createZodDto(PaperlessTagCheckResponseSchema) {}
