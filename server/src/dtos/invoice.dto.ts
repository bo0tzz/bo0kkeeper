import { createZodDto } from 'nestjs-zod';
import { InvoiceLine, InvoiceWithLines } from 'src/repositories/invoice.repository';
import { currencyCode, isoDateToDate, moneyMinor } from 'src/validation';
import z from 'zod';

const InvoiceLineInputSchema = z.object({
  description: z.string().min(1).max(500),
  unitLabel: z.string().max(50).optional(),
  quantity: z.string().max(50).optional(),
  lineTotalMinor: moneyMinor,
});

const InvoiceComposeSchema = z
  .object({
    clientId: z.uuid(),
    issuedAt: isoDateToDate,
    periodStart: isoDateToDate.optional(),
    periodEnd: isoDateToDate.optional(),
    currency: currencyCode,
    eurTotalMinor: moneyMinor.optional(),
    /** Decimal-string FX rate, e.g. "0.846991". */
    fxRate: z.string().optional(),
    btwRateBps: z.number().int().min(0).max(10_000).optional(),
    sourceEventId: z.uuid().optional(),
    lines: z.array(InvoiceLineInputSchema).min(1),
  })
  .meta({ id: 'InvoiceComposeDto' });
export class InvoiceComposeDto extends createZodDto(InvoiceComposeSchema) {}

const InvoiceLineResponseSchema = z.object({
  id: z.string(),
  ordinal: z.number().int(),
  description: z.string(),
  unitLabel: z.string().nullable(),
  quantity: z.string().nullable(),
  lineTotalMinor: z.string(),
});

const InvoiceResponseSchema = z
  .object({
    id: z.string(),
    number: z.string(),
    clientId: z.string(),
    issuedAt: z.iso.date(),
    periodStart: z.iso.date().nullable(),
    periodEnd: z.iso.date().nullable(),
    currency: z.string(),
    totalMinor: z.string(),
    eurTotalMinor: z.string().nullable(),
    fxRate: z.string().nullable(),
    btwRateBps: z.number().int().nullable(),
    btwMinor: z.string().nullable(),
    paperlessDocId: z.string().nullable(),
    sourceEventId: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    lines: z.array(InvoiceLineResponseSchema),
  })
  .meta({ id: 'InvoiceResponseDto' });
export class InvoiceResponseDto extends createZodDto(InvoiceResponseSchema) {}

const InvoiceComposeResponseSchema = z
  .object({
    invoice: InvoiceResponseSchema,
  })
  .meta({ id: 'InvoiceComposeResponseDto' });
export class InvoiceComposeResponseDto extends createZodDto(InvoiceComposeResponseSchema) {}

const InvoiceComposeFromWiseSchema = z
  .object({
    clientId: z.uuid(),
    issuedAt: isoDateToDate,
    periodStart: isoDateToDate.optional(),
    periodEnd: isoDateToDate.optional(),
    lines: z.array(InvoiceLineInputSchema).min(1),
  })
  .meta({ id: 'InvoiceComposeFromWiseDto' });
export class InvoiceComposeFromWiseDto extends createZodDto(InvoiceComposeFromWiseSchema) {}

const WiseInvoicePrefillSchema = z
  .object({
    wiseTransferId: z.string(),
    currency: z.string(),
    totalMinor: z.string(),
    eurTotalMinor: z.string(),
    ourReference: z.string().nullable(),
    suggestedClientId: z.string().nullable(),
  })
  .meta({ id: 'WiseInvoicePrefillDto' });
export class WiseInvoicePrefillDto extends createZodDto(WiseInvoicePrefillSchema) {}

const InvoiceListItemSchema = z
  .object({
    id: z.string(),
    number: z.string(),
    issuedAt: z.iso.date(),
    clientId: z.string(),
    clientName: z.string().nullable(),
    currency: z.string(),
    totalMinor: z.string(),
    eurTotalMinor: z.string().nullable(),
    btwRateBps: z.number().int().nullable(),
    btwMinor: z.string().nullable(),
    paperlessDocId: z.string().nullable(),
    paid: z.boolean(),
  })
  .meta({ id: 'InvoiceListItemDto' });
export class InvoiceListItemDto extends createZodDto(InvoiceListItemSchema) {}

const ListInvoicesQuerySchema = z
  .object({
    /** Filter to invoices issued in this year (YYYY). */
    year: z.coerce.number().int().min(2000).max(2100).optional(),
    /** 'open' = no matched bank tx; 'paid' = matched. */
    status: z.enum(['open', 'paid']).optional(),
    /** 1-indexed page; defaults to 1. */
    page: z.coerce.number().int().min(1).default(1),
    /** Page size; capped at 100. */
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .meta({ id: 'ListInvoicesQueryDto' });
export class ListInvoicesQueryDto extends createZodDto(ListInvoicesQuerySchema) {}

const ListInvoicesResponseSchema = z
  .object({
    items: z.array(InvoiceListItemSchema),
    total: z.number().int(),
  })
  .meta({ id: 'ListInvoicesResponseDto' });
export class ListInvoicesResponseDto extends createZodDto(ListInvoicesResponseSchema) {}

export function mapInvoice(invoice: InvoiceWithLines): InvoiceResponseDto {
  return {
    id: invoice.id,
    number: invoice.number,
    clientId: invoice.clientId,
    issuedAt: toIsoDate(invoice.issuedAt),
    periodStart: invoice.periodStart ? toIsoDate(invoice.periodStart) : null,
    periodEnd: invoice.periodEnd ? toIsoDate(invoice.periodEnd) : null,
    currency: invoice.currency,
    totalMinor: String(invoice.totalMinor),
    eurTotalMinor: invoice.eurTotalMinor === null ? null : String(invoice.eurTotalMinor),
    fxRate: invoice.fxRate,
    btwRateBps: invoice.btwRateBps,
    btwMinor: invoice.btwMinor === null ? null : String(invoice.btwMinor),
    paperlessDocId: invoice.paperlessDocId,
    sourceEventId: invoice.sourceEventId,
    createdAt: toIso(invoice.createdAt),
    updatedAt: toIso(invoice.updatedAt),
    lines: invoice.lines.map((line) => mapInvoiceLine(line)),
  } as InvoiceResponseDto;
}

function mapInvoiceLine(line: InvoiceLine) {
  return {
    id: line.id,
    ordinal: line.ordinal,
    description: line.description,
    unitLabel: line.unitLabel,
    quantity: line.quantity,
    lineTotalMinor: String(line.lineTotalMinor),
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toIsoDate(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return value.slice(0, 10);
}
