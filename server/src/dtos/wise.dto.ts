import { createZodDto } from 'nestjs-zod';
import z from 'zod';

const DraftFromEventBodySchema = z
  .object({
    /**
     * Optional `TXN-NNNN` reference. Omit to auto-allocate from the
     * `wise_txn_sequence` Postgres sequence.
     */
    ourReference: z
      .string()
      .regex(/^TXN-\d{4,}$/, { error: 'Expected TXN-NNNN format' })
      .optional(),
  })
  .meta({ id: 'DraftFromEventDto' });
export class DraftFromEventDto extends createZodDto(DraftFromEventBodySchema) {}

const WiseTransferResponseSchema = z
  .object({
    id: z.string(),
    wiseTransferId: z.string(),
    direction: z.string(),
    state: z.string(),
    sourceAmountMinor: z.string(),
    sourceCurrency: z.string(),
    targetAmountMinor: z.string(),
    targetCurrency: z.string(),
    fxRate: z.string().nullable(),
    feeMinor: z.string(),
    feeCurrency: z.string(),
    ourReference: z.string().nullable(),
    correlationId: z.string().nullable(),
  })
  .meta({ id: 'WiseTransferResponseDto' });
export class WiseTransferResponseDto extends createZodDto(WiseTransferResponseSchema) {}
