import { createZodDto } from 'nestjs-zod';
import { ClientClass } from 'src/enum';
import { QuarterlyAggregate } from 'src/services/quarterly-aggregator.service';
import z from 'zod';

const QuarterSchema = z.coerce.number().int().min(1).max(4) as unknown as z.ZodType<1 | 2 | 3 | 4>;

const QuarterlyAggregateQuerySchema = z
  .object({
    year: z.coerce.number().int().min(2000).max(2200),
    quarter: QuarterSchema,
  })
  .meta({ id: 'QuarterlyAggregateQueryDto' });
export class QuarterlyAggregateQueryDto extends createZodDto(QuarterlyAggregateQuerySchema) {}

const IncomeBucketSchema = z.object({
  invoiceCount: z.number().int(),
  grossEurMinor: z.string(),
  btwEurMinor: z.string(),
});

const AggregatorWarningSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('invoice_unmatched'),
    count: z.number().int(),
    sampleNumbers: z.array(z.string()),
  }),
  z.object({
    kind: z.literal('expense_pending_review'),
    count: z.number().int(),
    sampleVendors: z.array(z.string()),
  }),
  z.object({
    kind: z.literal('expense_low_confidence_match'),
    count: z.number().int(),
    sampleIds: z.array(z.string()),
  }),
]);

const QuarterlyAggregateResponseSchema = z
  .object({
    year: z.number().int(),
    quarter: z.number().int().min(1).max(4),
    periodStart: z.iso.datetime(),
    periodEnd: z.iso.datetime(),
    income: z.object({
      byClass: z.object({
        [ClientClass.NonEu]: IncomeBucketSchema,
        [ClientClass.Eu]: IncomeBucketSchema,
        [ClientClass.EuReverseCharge]: IncomeBucketSchema,
        [ClientClass.Domestic]: IncomeBucketSchema,
      }),
      totalGrossEurMinor: z.string(),
      totalBtwEurMinor: z.string(),
    }),
    expenses: z.object({
      grossEurMinor: z.string(),
      deductibleBtwEurMinor: z.string(),
    }),
    netBtwEurMinor: z.string(),
    warnings: z.array(AggregatorWarningSchema),
    /** ISO timestamp when the user marked this period as filed; null = open. */
    closedAt: z.string().nullable(),
  })
  .meta({ id: 'QuarterlyAggregateResponseDto' });
export class QuarterlyAggregateResponseDto extends createZodDto(QuarterlyAggregateResponseSchema) {}

const ClosePeriodBodySchema = z
  .object({
    notes: z.string().optional(),
  })
  .meta({ id: 'ClosePeriodDto' });
export class ClosePeriodDto extends createZodDto(ClosePeriodBodySchema) {}

export function mapAggregate(value: QuarterlyAggregate, closedAt: Date | null = null): QuarterlyAggregateResponseDto {
  return {
    year: value.year,
    quarter: value.quarter,
    periodStart: value.periodStart.toISOString(),
    periodEnd: value.periodEnd.toISOString(),
    income: {
      byClass: {
        [ClientClass.NonEu]: bucketOut(value.income.byClass[ClientClass.NonEu]),
        [ClientClass.Eu]: bucketOut(value.income.byClass[ClientClass.Eu]),
        [ClientClass.EuReverseCharge]: bucketOut(value.income.byClass[ClientClass.EuReverseCharge]),
        [ClientClass.Domestic]: bucketOut(value.income.byClass[ClientClass.Domestic]),
      },
      totalGrossEurMinor: String(value.income.totalGrossEurMinor),
      totalBtwEurMinor: String(value.income.totalBtwEurMinor),
    },
    expenses: {
      grossEurMinor: String(value.expenses.grossEurMinor),
      deductibleBtwEurMinor: String(value.expenses.deductibleBtwEurMinor),
    },
    netBtwEurMinor: String(value.netBtwEurMinor),
    warnings: [...value.warnings],
    closedAt: closedAt ? closedAt.toISOString() : null,
  } as QuarterlyAggregateResponseDto;
}

function bucketOut(bucket: { invoiceCount: number; grossEurMinor: bigint; btwEurMinor: bigint }) {
  return {
    invoiceCount: bucket.invoiceCount,
    grossEurMinor: String(bucket.grossEurMinor),
    btwEurMinor: String(bucket.btwEurMinor),
  };
}
