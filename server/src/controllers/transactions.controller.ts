import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiQueryFromDto, Authenticated } from 'src/decorators';
import { ListTransactionsQueryDto, ListTransactionsResponseDto } from 'src/dtos/transactions.dto';
import { BankTransaction, BankTransactionRepository } from 'src/repositories/bank-transaction.repository';
import { ExpenseRepository } from 'src/repositories/expense.repository';
import { InvoiceRepository } from 'src/repositories/invoice.repository';
import { WiseTransferRepository, WiseTransferRow } from 'src/repositories/wise-transfer.repository';

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
    private readonly bankTransactionRepository: BankTransactionRepository,
    private readonly wiseTransferRepository: WiseTransferRepository,
    private readonly invoiceRepository: InvoiceRepository,
    private readonly expenseRepository: ExpenseRepository,
  ) {}

  @Get()
  @Authenticated()
  @ApiQueryFromDto(ListTransactionsQueryDto)
  async list(@Query() query: ListTransactionsQueryDto): Promise<ListTransactionsResponseDto> {
    // The merge is in-memory, so we either fetch generously or accept that
    // the date filter trims things on the way out. Bumped to 500 each which
    // covers a single-zzp's whole year of activity comfortably.
    const isWantBank = query.source === undefined || query.source === 'bank';
    const isWantWise = query.source === undefined || query.source === 'wise';
    const [bankRows, wiseRows] = await Promise.all([
      isWantBank ? this.bankTransactionRepository.findRecent(500) : Promise.resolve([] as BankTransaction[]),
      isWantWise ? this.wiseTransferRepository.findRecent(500) : Promise.resolve([] as WiseTransferRow[]),
    ]);

    // Resolve the labels we'll need for matched bank rows in one round trip
    // each, rather than per-row N+1.
    const matchedTransferIds = unique(bankRows.map((r) => r.matchedTransferId).filter((v) => v !== null));
    const matchedInvoiceIds = unique(bankRows.map((r) => r.matchedInvoiceId).filter((v) => v !== null));
    const matchedExpenseIds = unique(bankRows.map((r) => r.matchedExpenseId).filter((v) => v !== null));
    const [transferRefs, invoiceNumbers, expenseVendors] = await Promise.all([
      this.wiseTransferRepository.findOurReferencesByIds(matchedTransferIds),
      this.invoiceRepository.findNumbersByIds(matchedInvoiceIds),
      this.expenseRepository.findVendorsByIds(matchedExpenseIds),
    ]);

    const all = [
      ...bankRows.map((r) => mapBankRow(r, { transferRefs, invoiceNumbers, expenseVendors })),
      ...wiseRows.map((r) => mapWiseRow(r)),
    ];
    const filtered = all.filter((r) => {
      if (query.dateFrom && r.date < query.dateFrom) {
        return false;
      }
      return !(query.dateTo && r.date > query.dateTo);
    });
    filtered.sort((a, b) => b.date.localeCompare(a.date));
    return { items: filtered, total: filtered.length };
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

function capitalize(s: string): string {
  return s.length === 0 ? s : s.at(0)!.toUpperCase() + s.slice(1);
}
