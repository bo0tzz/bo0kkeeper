import { createZodDto } from 'nestjs-zod';
import z from 'zod';

const StartAuthBodySchema = z
  .object({
    /** ASPSP name as listed by Enable Banking. Default to Mock ASPSP for dev. */
    aspspName: z.string().min(1).default('Mock ASPSP'),
    aspspCountry: z.string().length(2).default('NL'),
    psuType: z.enum(['personal', 'business']).default('personal'),
  })
  .meta({ id: 'BankingStartAuthDto' });
export class BankingStartAuthDto extends createZodDto(StartAuthBodySchema) {}

const StartAuthResponseSchema = z
  .object({
    sessionId: z.uuid(),
    redirectUrl: z.url(),
  })
  .meta({ id: 'BankingStartAuthResponseDto' });
export class BankingStartAuthResponseDto extends createZodDto(StartAuthResponseSchema) {}

const SessionAccountSchema = z.object({
  uid: z.string(),
  iban: z.string().nullable().optional(),
  currency: z.string(),
  name: z.string().nullable().optional(),
  product: z.string().nullable().optional(),
});

const SessionResponseSchema = z
  .object({
    id: z.uuid(),
    status: z.string(),
    aspspName: z.string(),
    aspspCountry: z.string(),
    psuType: z.string(),
    expiresAt: z.string().nullable(),
    lastSyncedAt: z.string().nullable(),
    accounts: z.array(SessionAccountSchema),
    createdAt: z.string(),
  })
  .meta({ id: 'BankingSessionResponseDto' });
export class BankingSessionResponseDto extends createZodDto(SessionResponseSchema) {}
