import { createZodDto } from 'nestjs-zod';
import z from 'zod';

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
