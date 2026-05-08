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
    matchedAt: z.string().nullable(),
    matchConfidence: z.string().nullable(),
  })
  .meta({ id: 'BankTransactionResponseDto' });
export class BankTransactionResponseDto extends createZodDto(BankTransactionResponseSchema) {}
