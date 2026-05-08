import { createZodDto } from 'nestjs-zod';
import { WiseTransferState } from 'src/enum';
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

const ListWiseTransfersQuerySchema = z
  .object({
    /** Filter to a specific Wise state. */
    state: z.enum(WiseTransferState).optional(),
    /** 1-indexed page; defaults to 1. */
    page: z.coerce.number().int().min(1).default(1),
    /** Page size; capped at 100. */
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .meta({ id: 'ListWiseTransfersQueryDto' });
export class ListWiseTransfersQueryDto extends createZodDto(ListWiseTransfersQuerySchema) {}

const ListWiseTransfersResponseSchema = z
  .object({
    items: z.array(WiseTransferResponseSchema),
    total: z.number().int(),
  })
  .meta({ id: 'ListWiseTransfersResponseDto' });
export class ListWiseTransfersResponseDto extends createZodDto(ListWiseTransfersResponseSchema) {}
