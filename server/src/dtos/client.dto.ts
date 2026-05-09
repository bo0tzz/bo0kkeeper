import { createZodDto } from 'nestjs-zod';
import { ClientClass, TradeName } from 'src/enum';
import { Client } from 'src/repositories/client.repository';
import { nonEmptyPartial } from 'src/validation';
import z from 'zod';

const AddressSchema = z
  .object({
    line1: z.string().optional(),
    line2: z.string().optional(),
    city: z.string().optional(),
    postalCode: z.string().optional(),
    countryCode: z.string().length(2).optional(),
  })
  .passthrough();

const ClientCreateSchema = z
  .object({
    name: z.string().min(1).max(200),
    class: z.enum(ClientClass),
    tradeName: z.enum(TradeName),
    address: AddressSchema.default({}),
    vatId: z.string().optional(),
    wiseSenderPattern: z.string().optional(),
    defaultDescription: z.string().default(''),
  })
  .meta({ id: 'ClientCreateDto' });
export class ClientCreateDto extends createZodDto(ClientCreateSchema) {}

const ClientUpdateSchema = nonEmptyPartial({
  name: z.string().min(1).max(200),
  class: z.enum(ClientClass),
  tradeName: z.enum(TradeName),
  address: AddressSchema,
  vatId: z.string().nullable(),
  wiseSenderPattern: z.string().nullable(),
  defaultDescription: z.string(),
}).meta({ id: 'ClientUpdateDto' });
export class ClientUpdateDto extends createZodDto(ClientUpdateSchema) {}

const ClientResponseSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    class: z.enum(ClientClass),
    tradeName: z.enum(TradeName),
    address: z.record(z.string(), z.unknown()),
    vatId: z.string().nullable(),
    wiseSenderPattern: z.string().nullable(),
    defaultDescription: z.string(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'ClientResponseDto' });
export class ClientResponseDto extends createZodDto(ClientResponseSchema) {}

export function mapClient(client: Client): ClientResponseDto {
  return {
    id: client.id,
    name: client.name,
    class: client.class,
    tradeName: client.tradeName,
    address: client.address as Record<string, unknown>,
    vatId: client.vatId,
    wiseSenderPattern: client.wiseSenderPattern,
    defaultDescription: client.defaultDescription,
    createdAt: toIso(client.createdAt),
    updatedAt: toIso(client.updatedAt),
  } as ClientResponseDto;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
