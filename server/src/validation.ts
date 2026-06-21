import { ArgumentMetadata, Injectable, ParseUUIDPipe } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import sanitize from 'sanitize-filename';
import { isIP, isIPRange } from 'validator';
import z from 'zod';

export type IsIPRangeOptions = { requireCIDR?: boolean };

function isIPOrRange(value: string, options?: IsIPRangeOptions): boolean {
  const { requireCIDR = true } = options ?? {};
  if (isIPRange(value)) {
    return true;
  }
  return Boolean(!requireCIDR && isIP(value));
}

/**
 * Zod schema that validates an array of strings as IP addresses or IP/CIDR ranges.
 * When requireCIDR is true (default), plain IPs are rejected; only CIDR ranges are allowed.
 */
export function IsIPRange(options?: IsIPRangeOptions) {
  return z
    .array(z.string())
    .refine((arr) => arr.every((item) => isIPOrRange(item, options)), 'Must be an ip address or ip address range');
}

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
 * Sibling-exclusion refinement for object schemas.
 * Validation passes when the target property is missing, or when none of the sibling properties are present.
 */
export function IsNotSiblingOf<
  TSchema extends z.ZodObject<z.ZodRawShape>,
  TKey extends z.infer<ReturnType<TSchema['keyof']>> & keyof z.infer<TSchema>,
>(_schema: TSchema, property: TKey, siblings: TKey[]) {
  type T = z.infer<TSchema>;
  const message = `${String(property)} cannot exist alongside ${siblings.join(' or ')}`;
  return z.custom<T>().refine(
    (data) => {
      if (data[property] === undefined) {
        return true;
      }
      return siblings.every((sibling) => data[sibling] === undefined);
    },
    { message },
  );
}

@Injectable()
export class ParseMeUUIDPipe extends ParseUUIDPipe {
  async transform(value: string, metadata: ArgumentMetadata) {
    if (value == 'me') {
      return value;
    }
    return super.transform(value, metadata);
  }
}

const UUIDParamSchema = z.object({
  // Accept any UUID version. The DB defaults to uuidv7 (uuidv7() in migrations);
  // strict v4 validation rejects every real id we hand out.
  id: z.uuid(),
});

export class UUIDParamDto extends createZodDto(UUIDParamSchema) {}

const FilenameParamSchema = z.object({
  filename: z.string().regex(/^[a-zA-Z0-9_\-.]+$/, {
    error: 'Filename contains invalid characters',
  }),
});

export class FilenameParamDto extends createZodDto(FilenameParamSchema) {}

export const isValidInteger = (value: number, options: { min?: number; max?: number }): value is number => {
  const { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = options;
  return Number.isSafeInteger(value) && value >= min && value <= max;
};

/**
 * Email: lowercase + HTML5 regex.
 */
export const toEmail = z
  .email({
    pattern: z.regexes.html5Email,
    error: (iss) => `Invalid input: expected email, received ${typeof iss.input}`,
  })
  .transform((val) => val.toLowerCase());

/**
 * Parse ISO 8601 datetime strings to Date objects.
 */
export const isoDatetimeToDate = z
  .codec(
    z.iso.datetime({
      error: (iss) => `Invalid input: expected ISO 8601 datetime string, received ${typeof iss.input}`,
    }),
    z.date(),
    {
      decode: (isoString) => new Date(isoString),
      encode: (date) => date.toISOString(),
    },
  )
  .meta({ example: '2024-01-01T00:00:00.000Z' });

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
 * Parse Dutch DD-MM-YYYY date strings (used by SNS bank CSVs and some other Dutch sources).
 */
export const dutchDateToDate = z
  .codec(
    z.string().regex(/^\d{2}-\d{2}-\d{4}$/, {
      error: 'Expected DD-MM-YYYY date string',
    }),
    z.date(),
    {
      decode: (s) => {
        const [dd, mm, yyyy] = s.split('-');
        return new Date(`${yyyy}-${mm}-${dd}T00:00:00.000Z`);
      },
      encode: (date) => {
        const dd = String(date.getUTCDate()).padStart(2, '0');
        const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
        const yyyy = date.getUTCFullYear();
        return `${dd}-${mm}-${yyyy}`;
      },
    },
  )
  .meta({ example: '07-05-2026' });

/**
 * Parse string to boolean. Use for query/path params; use plain z.boolean() for body fields.
 */
export const stringToBool = z
  .stringbool({ truthy: ['true'], falsy: ['false'], case: 'sensitive' })
  .meta({ type: 'boolean' });

/** Parse JSON strings from multipart/form-data. */
export const JsonParsed = z.transform((val, ctx) => {
  if (typeof val === 'string') {
    try {
      return JSON.parse(val);
    } catch {
      ctx.issues.push({
        code: 'custom',
        message: `Invalid input: expected JSON string, received ${typeof val}`,
        input: val,
      });
      return z.NEVER;
    }
  }
  return val;
});

/**
 * Hex color validation/normalization. Accepts #RGB, #RGBA, #RRGGBB, #RRGGBBAA (with or without # prefix).
 */
const hexColorRegex = /^#?([0-9A-Fa-f]{3}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;
export const hexColor = z
  .string()
  .regex(hexColorRegex)
  .transform((val) => (val.startsWith('#') ? val : `#${val}`));

/** Transform empty strings to null. Inner schema must accept null. */
export const emptyStringToNull = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((val) => (val === '' ? null : val), schema);

export const sanitizeFilename = z.string().transform((val) => sanitize(val.replaceAll('.', '')));

/**
 * Money minor units (cents). Always stored as bigint; never use number for money.
 */
export const moneyMinor = z.coerce.bigint();

/** ISO 4217 currency code, uppercase. */
export const currencyCode = z
  .string()
  .regex(/^[A-Z]{3}$/, { error: 'Expected ISO 4217 currency code (3 uppercase letters)' });

/** Loosely-formatted IBAN (no checksum verification — that lives in a dedicated checker). */
export const ibanLoose = z
  .string()
  .regex(/^[A-Z]{2}\d{2}[A-Z0-9 ]{11,30}$/, { error: 'Invalid IBAN format' })
  .transform((val) => val.replaceAll(/\s+/g, ''));
