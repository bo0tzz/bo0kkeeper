import z from 'zod';

/**
 * Like z.object().partial(), but rejects objects where every field is undefined.
 * Use for update/patch DTOs where at least one field must be provided.
 */
export function nonEmptyPartial<T extends z.ZodRawShape>(shape: T) {
  return z
    .object(shape)
    .partial()
    .refine((data) => Object.values(data as Record<string, unknown>).some((value) => value !== undefined), {
      message: 'At least one field must be provided',
    });
}

/**
 * Parse ISO date strings to Date objects.
 */
export const isoDateToDate = z
  .codec(
    z.iso.date({
      error: (iss) => `Invalid input: expected ISO date string (YYYY-MM-DD), received ${typeof iss.input}`,
    }),
    z.date(),
    {
      decode: (isoString) => new Date(isoString),
      encode: (date) => date.toISOString().slice(0, 10),
    },
  )
  .meta({ example: '2024-01-01' });

/**
 * Money minor units (cents). On the wire: integer-string ("100", "-182"); in
 * TypeScript: bigint. Modelled as a Zod codec so JSON Schema (and the generated
 * OpenAPI SDK) sees a string — plain `z.coerce.bigint()` makes
 * zod-to-json-schema throw ("BigInt cannot be represented in JSON Schema") and
 * every downstream DTO falls back to `any`.
 */
export const moneyMinor = z
  .codec(z.string().regex(/^-?\d+$/, { error: 'Expected integer-string minor units' }), z.bigint(), {
    decode: BigInt,
    encode: (b) => b.toString(),
  })
  .meta({ example: '100' });

/** ISO 4217 currency code, uppercase. */
export const currencyCode = z
  .string()
  .regex(/^[A-Z]{3}$/, { error: 'Expected ISO 4217 currency code (3 uppercase letters)' });
