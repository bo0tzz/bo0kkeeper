import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Kysely } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { Authenticated } from 'src/decorators';
import { ListTransactionsResponseDto } from 'src/dtos/transactions.dto';
import { BankTransaction, BankTransactionRepository } from 'src/repositories/bank-transaction.repository';
import { WiseTransferRepository, WiseTransferRow } from 'src/repositories/wise-transfer.repository';
import { DB } from 'src/schema';

/**
 * Unified "all money flows" view — the in-system equivalent of the
 * accountant's hand-typed transactions sheet. Pulls from every source
 * that records movement (bank_transaction, wise_transfer) and surfaces
 * each row with a derived `type` label so the user can scan a single
 * chronological list rather than juggling /banking + /wise/transfers.
 *
 * No pagination yet — single-zzp volume is small enough that the last
 * 200 rows is plenty. If that changes, key the cursor on (date, source,
 * id) and switch to SQL-side merge.
 */
@ApiTags('Transactions')
@Controller('/api/transactions')
export class TransactionsController {
  constructor(
    @InjectKysely() private readonly db: Kysely<DB>,
    private readonly bankTransactionRepository: BankTransactionRepository,
    private readonly wiseTransferRepository: WiseTransferRepository,
  ) {}

  @Get()
  @Authenticated()
  async list(): Promise<ListTransactionsResponseDto> {
    const [bankRows, wiseRows] = await Promise.all([
      this.bankTransactionRepository.findRecent(200),
      this.wiseTransferRepository.findRecent(200),
    ]);

    // Resolve the labels we'll need for matched bank rows in one round trip
    // each, rather than per-row N+1.
    const matchedTransferIds = unique(bankRows.map((r) => r.matchedTransferId).filter(notNull));
    const matchedInvoiceIds = unique(bankRows.map((r) => r.matchedInvoiceId).filter(notNull));
    const matchedExpenseIds = unique(bankRows.map((r) => r.matchedExpenseId).filter(notNull));
    const transferRefs = await this.lookupTransferRefs(matchedTransferIds);
    const invoiceNumbers = await this.lookupInvoiceNumbers(matchedInvoiceIds);
    const expenseVendors = await this.lookupExpenseVendors(matchedExpenseIds);

    const items = [
      ...bankRows.map((r) => mapBankRow(r, { transferRefs, invoiceNumbers, expenseVendors })),
      ...wiseRows.map((r) => mapWiseRow(r)),
    ].sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0));

    return { items, total: items.length };
  }

  private async lookupTransferRefs(ids: string[]): Promise<Map<string, string | null>> {
    if (ids.length === 0) {
      return new Map();
    }
    const rows = await this.db
      .selectFrom('wise_transfer')
      .select(['id', 'ourReference'])
      .where('id', 'in', ids)
      .execute();
    return new Map(rows.map((r) => [r.id, r.ourReference]));
  }

  private async lookupInvoiceNumbers(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) {
      return new Map();
    }
    const rows = await this.db
      .selectFrom('invoice')
      .select(['id', 'number'])
      .where('id', 'in', ids)
      .execute();
    return new Map(rows.map((r) => [r.id, r.number]));
  }

  private async lookupExpenseVendors(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) {
      return new Map();
    }
    const rows = await this.db
      .selectFrom('expense')
      .select(['id', 'vendor'])
      .where('id', 'in', ids)
      .execute();
    return new Map(rows.map((r) => [r.id, r.vendor]));
  }
}

type Resolved = {
  transferRefs: Map<string, string | null>;
  invoiceNumbers: Map<string, string>;
  expenseVendors: Map<string, string>;
};

function mapBankRow(row: BankTransaction, resolved: Resolved): ListTransactionsResponseDto['items'][number] {
  const txDate = row.txDate instanceof Date ? row.txDate : new Date(row.txDate);
  let type = 'Unmatched';
  let reference: string | null = null;
  let match: ListTransactionsResponseDto['items'][number]['match'] = null;

  if (row.matchedTransferId) {
    const ref = resolved.transferRefs.get(row.matchedTransferId);
    type = `Transfer (${ref ?? 'wise'})`;
    reference = ref ?? null;
    match = { kind: 'wise_transfer', id: row.matchedTransferId, confidence: row.matchConfidence };
  } else if (row.matchedInvoiceId) {
    const number = resolved.invoiceNumbers.get(row.matchedInvoiceId);
    type = `Income (${number ?? 'invoice'})`;
    reference = number ?? null;
    match = { kind: 'invoice', id: row.matchedInvoiceId, confidence: row.matchConfidence };
  } else if (row.matchedExpenseId) {
    const vendor = resolved.expenseVendors.get(row.matchedExpenseId);
    type = `Expense (${vendor ?? 'unknown'})`;
    match = { kind: 'expense', id: row.matchedExpenseId, confidence: row.matchConfidence };
  } else if (row.category) {
    type = capitalize(row.category.replaceAll('_', ' '));
  }

  return {
    id: `bank:${row.id}`,
    source: 'bank',
    date: txDate.toISOString().slice(0, 10),
    amountMinor: String(row.amountMinor),
    currency: row.currency,
    counterparty: row.counterpartyName,
    type,
    reference,
    description: row.description,
    match,
    state: null,
  };
}

function mapWiseRow(row: WiseTransferRow): ListTransactionsResponseDto['items'][number] {
  const date = row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt);
  // wise_transfer rows are USD-side (the source side of a Wise conversion);
  // negative because money's leaving Wise USD into our SNS EUR.
  return {
    id: `wise:${row.id}`,
    source: 'wise',
    date: date.toISOString().slice(0, 10),
    amountMinor: `-${row.sourceAmountMinor}`,
    currency: row.sourceCurrency,
    counterparty: row.counterpartyName,
    type: `Wise ${row.sourceCurrency}→${row.targetCurrency}`,
    reference: row.ourReference,
    description: `${row.sourceCurrency} ${(Number(row.sourceAmountMinor) / 100).toFixed(2)} → ${row.targetCurrency} ${(Number(row.targetAmountMinor) / 100).toFixed(2)}`,
    match: null,
    state: row.state,
  };
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function notNull<T>(value: T | null): value is T {
  return value !== null;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}
