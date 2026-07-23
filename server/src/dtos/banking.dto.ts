import { createZodDto } from 'nestjs-zod';
import z from 'zod';

const StartAuthBodySchema = z
  .object({
    /** ASPSP name as listed in Enable Banking's `/aspsps` catalog. */
    aspspName: z.string().min(1),
    aspspCountry: z.string().length(2),
    psuType: z.enum(['personal', 'business']).default('personal'),
  })
  .meta({ id: 'BankingStartAuthDto' });
export class BankingStartAuthDto extends createZodDto(StartAuthBodySchema) {}

const AspspsQuerySchema = z
  .object({
    /** ISO-3166 alpha-2 country code. Default NL — the only relevant one today. */
    country: z.string().length(2).default('NL'),
  })
  .meta({ id: 'BankingAspspsQueryDto' });
export class BankingAspspsQueryDto extends createZodDto(AspspsQuerySchema) {}

const AspspsResponseSchema = z
  .object({
    aspsps: z.array(
      z.object({
        name: z.string(),
        country: z.string(),
        psuTypes: z.array(z.enum(['personal', 'business'])),
      }),
    ),
  })
  .meta({ id: 'BankingAspspsResponseDto' });
export class BankingAspspsResponseDto extends createZodDto(AspspsResponseSchema) {}

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
  balance: z
    .object({
      amountMinor: z.string(),
      currency: z.string(),
      asOf: z.string(),
    })
    .nullable()
    .optional(),
  /** Sum of baseline + ingested tx since baseline; should match `balance` if all tx are accounted for. */
  expectedBalanceMinor: z.string().nullable().optional(),
  /** balance.amountMinor − expectedBalanceMinor. Non-zero = something drifted. */
  balanceDiscrepancyMinor: z.string().nullable().optional(),
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

const MatchTargetType = z.enum(['wise_transfer', 'invoice', 'expense']);

const SetMatchBodySchema = z
  .object({
    type: MatchTargetType,
    targetId: z.uuid(),
  })
  .meta({ id: 'BankTxSetMatchDto' });
export class BankTxSetMatchDto extends createZodDto(SetMatchBodySchema) {}

const TransferCandidateSchema = z.object({
  id: z.uuid(),
  wiseTransferId: z.string(),
  ourReference: z.string().nullable(),
  state: z.string(),
  sourceCurrency: z.string(),
  sourceAmountMinor: z.string(),
  targetCurrency: z.string(),
  targetAmountMinor: z.string(),
  createdAt: z.string(),
});
const InvoiceCandidateSchema = z.object({
  id: z.uuid(),
  number: z.string(),
  totalMinor: z.string(),
  currency: z.string(),
  issuedAt: z.string(),
  clientName: z.string().nullable(),
});
const ExpenseCandidateSchema = z.object({
  id: z.uuid(),
  vendor: z.string(),
  amountMinor: z.string(),
  currency: z.string(),
  expenseDate: z.string(),
  status: z.string(),
});
const MatchCandidatesResponseSchema = z
  .object({
    transfers: z.array(TransferCandidateSchema),
    invoices: z.array(InvoiceCandidateSchema),
    expenses: z.array(ExpenseCandidateSchema),
  })
  .meta({ id: 'BankTxMatchCandidatesDto' });
export class BankTxMatchCandidatesDto extends createZodDto(MatchCandidatesResponseSchema) {}

const BankTxCategoryEnum = z.enum(['tax', 'drawings', 'self_transfer', 'fee', 'ignored']);
const BankTransactionResponseSchema = z
  .object({
    id: z.uuid(),
    source: z.string(),
    externalId: z.string(),
    txDate: z.string(),
    amountMinor: z.string(),
    currency: z.string(),
    counterpartyName: z.string().nullable(),
    counterpartyIban: z.string().nullable(),
    description: z.string(),
    matchedTransferId: z.uuid().nullable(),
    matchedInvoiceId: z.uuid().nullable(),
    matchedExpenseId: z.uuid().nullable(),
    /** Wise transfer's `ourReference` (e.g. TXN-0044), when matchedTransferId is set. */
    matchedTransferLabel: z.string().nullable(),
    /** Invoice number (e.g. 2099/007), when matchedInvoiceId is set. */
    matchedInvoiceLabel: z.string().nullable(),
    /** Expense vendor name, when matchedExpenseId is set. */
    matchedExpenseLabel: z.string().nullable(),
    matchedAt: z.string().nullable(),
    matchConfidence: z.string().nullable(),
    category: BankTxCategoryEnum.nullable(),
  })
  .meta({ id: 'BankTransactionResponseDto' });
export class BankTransactionResponseDto extends createZodDto(BankTransactionResponseSchema) {}

const SetCategoryBodySchema = z
  .object({
    category: BankTxCategoryEnum.nullable(),
  })
  .meta({ id: 'BankTxSetCategoryDto' });
export class BankTxSetCategoryDto extends createZodDto(SetCategoryBodySchema) {}

const ListBankTransactionsQuerySchema = z
  .object({
    /** ISO YYYY-MM-DD; rows on or after this date. */
    dateFrom: z.iso.date().optional(),
    /** ISO YYYY-MM-DD; rows on or before this date. */
    dateTo: z.iso.date().optional(),
    /**
     * Coarse resolution status:
     *  - matched     → linked to a transfer/invoice/expense
     *  - categorized → manually categorized as ignorable
     *  - unmatched   → no link, no category — needs operator attention
     */
    status: z.enum(['matched', 'categorized', 'unmatched']).optional(),
    /** 1-indexed page; defaults to 1. */
    page: z.coerce.number().int().min(1).default(1),
    /** Page size; capped at 100. */
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .meta({ id: 'ListBankTransactionsQueryDto' });
export class ListBankTransactionsQueryDto extends createZodDto(ListBankTransactionsQuerySchema) {}

const ListBankTransactionsResponseSchema = z
  .object({
    items: z.array(BankTransactionResponseSchema),
    total: z.number().int(),
  })
  .meta({ id: 'ListBankTransactionsResponseDto' });
export class ListBankTransactionsResponseDto extends createZodDto(ListBankTransactionsResponseSchema) {}
