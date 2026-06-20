import { Injectable, Logger } from '@nestjs/common';
import { EventSource, MatchConfidence } from 'src/enum';
import { BankTransaction, BankTransactionRepository } from 'src/repositories/bank-transaction.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { ExpenseMatchCandidate, ExpenseRepository } from 'src/repositories/expense.repository';
import { InvoiceMatchCandidate, InvoiceRepository } from 'src/repositories/invoice.repository';
import {
  WiseTransferMatchCandidate,
  WiseTransferRepository,
  WiseTransferRow,
} from 'src/repositories/wise-transfer.repository';
import { RecurringFeeService } from 'src/services/recurring-fee.service';
import { SheetSyncService } from 'src/services/sheet-sync.service';
import { toDate } from 'src/utils/date';
import { absMinor } from 'src/utils/money';

const TXN_REF_PATTERN = /\bTXN-\d{4,}\b/;
const INVOICE_NUMBER_PATTERN = /\b\d{4}\/\d{3}\b/;

export type MatchResult =
  | { matched: true; type: 'wise_transfer'; transferId: string; confidence: MatchConfidence }
  | { matched: true; type: 'invoice'; invoiceId: string; confidence: MatchConfidence }
  | { matched: true; type: 'expense'; expenseId: string; confidence: MatchConfidence }
  | { matched: false; reason: string };

/** Substring fuzzy-match cutoff — names shorter than this don't qualify. */
const FUZZY_MIN_LENGTH = 4;
/** Days of slack on either side of an expense's expenseDate for heuristic match. */
const EXPENSE_DATE_TOLERANCE_DAYS = 7;
/** Max days from invoice issue to bank tx for the heuristic to consider it. */
const INVOICE_PAYMENT_WINDOW_DAYS = 60;
/**
 * Days around a wise_transfer's createdAt to look for the invoice that pays
 * it. Wider than the bank-tx-side window because the invoice is typically
 * issued before the Wise outgoing payout completes — sometimes weeks earlier
 * for a slow-paying export client.
 */
const WISE_INVOICE_LINK_WINDOW_DAYS = 90;

export type MatchCandidates = {
  transfers: WiseTransferMatchCandidate[];
  invoices: InvoiceMatchCandidate[];
  expenses: ExpenseMatchCandidate[];
};

/**
 * Tries to link bank_transaction rows to their counterpart in the system.
 *
 * Strategies in priority order:
 *   1. TXN-NNNN reference in description → wise_transfer (auto_high). Same
 *      reference we set on outbound Wise transfers, surfaces verbatim in
 *      the bank's Omschrijving column.
 *   2. YYYY/NNN invoice number in description → invoice (auto_high). Used
 *      by domestic clients paying via SEPA/iDEAL who include the invoice
 *      number as the payment reference.
 *   3. Heuristic match (auto_low). For outflows, looks for an unmatched
 *      expense with the same amount + currency, within a 7-day window of
 *      the bank tx, and a counterparty/vendor substring match. For inflows,
 *      looks for an unmatched invoice with matching amount + currency, paid
 *      within 60 days of issue, and a counterparty/client substring match.
 *      Auto-low matches do NOT trigger sheet writes — the user confirms or
 *      rejects via the /banking link UI before they hit the accountant
 *      sheet.
 */
@Injectable()
export class BankMatcherService {
  private readonly logger = new Logger(BankMatcherService.name);

  constructor(
    private readonly bankTransactionRepository: BankTransactionRepository,
    private readonly expenseRepository: ExpenseRepository,
    private readonly invoiceRepository: InvoiceRepository,
    private readonly wiseTransferRepository: WiseTransferRepository,
    private readonly sheetSync: SheetSyncService,
    private readonly eventRepository: EventRepository,
    private readonly recurringFee: RecurringFeeService,
  ) {}

  async tryMatch(bankTx: BankTransaction): Promise<MatchResult> {
    if (bankTx.matchedAt) {
      return { matched: false, reason: 'already matched' };
    }
    if (bankTx.category) {
      // Operator labelled this as not a real income/expense (tax, self-transfer,
      // fee, etc.); the matcher should leave it alone.
      return { matched: false, reason: `categorized as ${bankTx.category}` };
    }

    // Recognised recurring bank-fee rows handle here before the heuristics.
    // Two outcomes: BTW-parseable fees become an auto-created Approved
    // Expense (and a real match); BTW-less fees get categorised to skip the
    // matcher entirely. Either way, the caller is done with this row.
    const feeOutcome = await this.recurringFee.tryHandleRecurringFee(bankTx);
    if (feeOutcome) {
      return feeOutcome;
    }

    const description = bankTx.description ?? '';

    const txnRef = TXN_REF_PATTERN.exec(description)?.[0];
    if (txnRef) {
      const transfer = await this.wiseTransferRepository.findByOurReference(txnRef);
      if (transfer) {
        await this.bankTransactionRepository.setMatch(
          bankTx.id,
          { type: 'wise_transfer', id: transfer.id },
          MatchConfidence.AutoHigh,
        );
        this.logger.log(`bank_tx ${bankTx.id} → wise_transfer ${transfer.id} via ${txnRef}`);
        await this.tryAutoLinkInvoiceToTransfer(transfer);
        await this.sheetSync.appendWiseIncomeRow(bankTx, transfer);
        return { matched: true, type: 'wise_transfer', transferId: transfer.id, confidence: MatchConfidence.AutoHigh };
      }
    }

    const invoiceNumber = INVOICE_NUMBER_PATTERN.exec(description)?.[0];
    if (invoiceNumber) {
      const invoice = await this.invoiceRepository.findByNumber(invoiceNumber);
      if (invoice) {
        await this.bankTransactionRepository.setMatch(
          bankTx.id,
          { type: 'invoice', id: invoice.id },
          MatchConfidence.AutoHigh,
        );
        this.logger.log(`bank_tx ${bankTx.id} → invoice ${invoice.id} via ${invoiceNumber}`);
        await this.sheetSync.appendInvoiceIncomeRow(bankTx, invoice);
        return { matched: true, type: 'invoice', invoiceId: invoice.id, confidence: MatchConfidence.AutoHigh };
      }
    }

    // No high-confidence signal — fall through to heuristics. Outflows look
    // for an expense, inflows look for an invoice. Sheet-write deliberately
    // skipped on auto_low; promotion to manual via the link UI handles that.
    const isOutflow = BigInt(bankTx.amountMinor as bigint | number | string) < 0n;
    const heuristic = isOutflow ? await this.tryExpenseHeuristic(bankTx) : await this.tryInvoiceHeuristic(bankTx);
    if (heuristic) {
      return heuristic;
    }

    return { matched: false, reason: 'no high-confidence signal' };
  }

  private async tryExpenseHeuristic(bankTx: BankTransaction): Promise<MatchResult | null> {
    const counterparty = bankTx.counterpartyName?.trim();
    if (!counterparty || counterparty.length < FUZZY_MIN_LENGTH) {
      return null;
    }
    const absAmount = absMinor(BigInt(bankTx.amountMinor as bigint | number | string));
    const txDate = toDate(bankTx.txDate);
    const dateLow = addDays(txDate, -EXPENSE_DATE_TOLERANCE_DAYS);
    const dateHigh = addDays(txDate, EXPENSE_DATE_TOLERANCE_DAYS);

    const candidates = await this.expenseRepository.findUnmatchedAmountAndDateWindow({
      amountMinor: absAmount,
      currency: bankTx.currency,
      dateLow,
      dateHigh,
    });

    const matches = candidates.filter((e) => fuzzyContains(counterparty, e.vendor));
    if (matches.length !== 1) {
      return null;
    }
    const expense = matches[0];
    await this.bankTransactionRepository.setMatch(
      bankTx.id,
      { type: 'expense', id: expense.id },
      MatchConfidence.AutoLow,
    );
    this.logger.log(
      `bank_tx ${bankTx.id} → expense ${expense.id} via heuristic (vendor "${expense.vendor}", amount ${absAmount})`,
    );
    return { matched: true, type: 'expense', expenseId: expense.id, confidence: MatchConfidence.AutoLow };
  }

  private async tryInvoiceHeuristic(bankTx: BankTransaction): Promise<MatchResult | null> {
    const counterparty = bankTx.counterpartyName?.trim();
    if (!counterparty || counterparty.length < FUZZY_MIN_LENGTH) {
      return null;
    }
    const absAmount = absMinor(BigInt(bankTx.amountMinor as bigint | number | string));
    const txDate = toDate(bankTx.txDate);
    const issuedAfter = addDays(txDate, -INVOICE_PAYMENT_WINDOW_DAYS);
    const issuedBefore = addDays(txDate, 1);

    // For non-EUR invoices we'd need a currency conversion to compare against
    // the EUR-denominated bank row; that's a meaningful slice of false-negatives
    // for the non-EU/USD flow, but those are already TXN-NNNN-matched (auto_high)
    // so the heuristic skipping them is fine.
    const candidates = await this.invoiceRepository.findUnmatchedAmountAndIssueWindow({
      totalMinor: absAmount,
      currency: bankTx.currency,
      issuedAfter,
      issuedBefore,
    });

    const matches = candidates.filter((i) => i.clientName && fuzzyContains(counterparty, i.clientName));
    if (matches.length !== 1) {
      return null;
    }
    const invoice = matches[0];
    await this.bankTransactionRepository.setMatch(
      bankTx.id,
      { type: 'invoice', id: invoice.invoiceId },
      MatchConfidence.AutoLow,
    );
    this.logger.log(
      `bank_tx ${bankTx.id} → invoice ${invoice.number} via heuristic (client "${invoice.clientName}", amount ${absAmount})`,
    );
    return { matched: true, type: 'invoice', invoiceId: invoice.invoiceId, confidence: MatchConfidence.AutoLow };
  }

  /**
   * Once a bank_tx → wise_transfer match lands (high-confidence via TXN
   * ref), wire the corresponding invoice to that wise_transfer if it
   * isn't linked already. Closes the gap left by the manual-compose
   * flow: the user issues an invoice before the Wise outgoing payout
   * completes (compose-from-wise refuses until then), so wiseTransferId
   * stays NULL — and the dashboard's unmatched-invoices warning would
   * fire forever otherwise.
   *
   * Match key is the wise_transfer's source side (currency + amount) —
   * for an export-non-EU flow that's exactly what the client paid
   * (e.g. 4791.00 USD), which equals invoice.totalMinor / currency. We
   * require a unique candidate; ambiguity (multiple invoices matching)
   * is logged and left for manual resolution.
   */
  private async tryAutoLinkInvoiceToTransfer(transfer: WiseTransferRow): Promise<void> {
    const sourceAmount = BigInt(transfer.sourceAmountMinor as bigint | number | string);
    const createdAt = toDate(transfer.createdAt);
    const issuedAfter = addDays(createdAt, -WISE_INVOICE_LINK_WINDOW_DAYS);
    const issuedBefore = addDays(createdAt, WISE_INVOICE_LINK_WINDOW_DAYS);

    const candidates = await this.invoiceRepository.findUnlinkedToWiseInWindow({
      totalMinor: sourceAmount,
      currency: transfer.sourceCurrency,
      issuedAfter,
      issuedBefore,
    });

    if (candidates.length === 0) {
      return;
    }
    if (candidates.length > 1) {
      this.logger.warn(
        `wise_transfer ${transfer.id} matches ${candidates.length} unlinked invoices ` +
          `(${transfer.sourceCurrency} ${sourceAmount}) — skipping auto-link, resolve manually`,
      );
      return;
    }
    const invoice = candidates[0];
    await this.invoiceRepository.setWiseTransferId(invoice.invoiceId, transfer.id);
    this.logger.log(
      `invoice ${invoice.number} → wise_transfer ${transfer.id} (auto-link, ${transfer.sourceCurrency} ${sourceAmount})`,
    );
  }

  /**
   * Operator-driven match. Sets exactly one of the matched* FKs (clearing the
   * others), marks confidence=manual, and runs the same sheet-append we'd run
   * on an auto-match — manual matches earn the same sheet row treatment.
   *
   * Returns the updated row so the UI can refresh in place.
   */
  /**
   * Things the user might want to manually link a bank tx to. With a free-
   * text query, this is a substring match on the most useful identifier per
   * type. Without one, we exclude candidates that are already matched to
   * another bank_transaction — there's no reason to surface a transfer or
   * invoice that's already accounted for elsewhere. With a query the user
   * is searching on purpose, so we include matched rows too (they might be
   * looking at a wrong existing match).
   */
  async findMatchCandidates(query: string | undefined, limit = 20): Promise<MatchCandidates> {
    const q = query?.trim().toLowerCase();
    const args = { query: q || undefined, limit };
    const [transfers, invoices, expenses] = await Promise.all([
      this.wiseTransferRepository.findMatchCandidates(args),
      this.invoiceRepository.findMatchCandidates(args),
      this.expenseRepository.findMatchCandidates(args),
    ]);
    return { transfers, invoices, expenses };
  }

  async manualMatch(
    bankTxId: string,
    target: { type: 'wise_transfer' | 'invoice' | 'expense'; targetId: string },
  ): Promise<BankTransaction> {
    const bankTx = await this.bankTransactionRepository.findById(bankTxId);
    if (!bankTx) {
      throw new Error(`bank_transaction ${bankTxId} not found`);
    }

    if (target.type === 'wise_transfer') {
      const transfer = await this.wiseTransferRepository.findById(target.targetId);
      if (!transfer) {
        throw new Error(`wise_transfer ${target.targetId} not found`);
      }
      await this.bankTransactionRepository.setMatch(
        bankTxId,
        { type: 'wise_transfer', id: transfer.id },
        MatchConfidence.Manual,
      );
      this.logger.log(`bank_tx ${bankTxId} → wise_transfer ${transfer.id} (manual)`);
      await this.sheetSync.appendWiseIncomeRow(bankTx, transfer);
    } else if (target.type === 'invoice') {
      const invoice = await this.invoiceRepository.findById(target.targetId);
      if (!invoice) {
        throw new Error(`invoice ${target.targetId} not found`);
      }
      await this.bankTransactionRepository.setMatch(
        bankTxId,
        { type: 'invoice', id: invoice.id },
        MatchConfidence.Manual,
      );
      this.logger.log(`bank_tx ${bankTxId} → invoice ${invoice.id} (manual)`);
      await this.sheetSync.appendInvoiceIncomeRow(bankTx, invoice);
    } else {
      const expense = await this.expenseRepository.findById(target.targetId);
      if (!expense) {
        throw new Error(`expense ${target.targetId} not found`);
      }
      await this.bankTransactionRepository.setMatch(
        bankTxId,
        { type: 'expense', id: expense.id },
        MatchConfidence.Manual,
      );
      this.logger.log(`bank_tx ${bankTxId} → expense ${expense.id} (manual)`);
      // Sheet row writes IFF the expense is already approved — otherwise
      // we'd be committing a half-filled pending_review row (no amount,
      // no BTW, no locationClass) to the accountant sheet. Previously this
      // path silently flipped pending → approved at link time and wrote
      // the row immediately, which corrupted the sheet whenever an
      // operator linked first and reviewed later.
      //
      // The mirror call lives on `approveExpense` — whichever event
      // completes (matched ∧ approved) triggers the write. The helper is
      // idempotent and status-gated, so this is a safe no-op for
      // pending_review (and rejected).
      await this.sheetSync.writeExpenseRowIfReady(expense.id);
    }

    const refreshed = await this.bankTransactionRepository.findById(bankTxId);
    if (!refreshed) {
      throw new Error(`bank_transaction ${bankTxId} disappeared after match`);
    }
    await this.eventRepository.recordAction({
      source: EventSource.Manual,
      eventType: 'banking.tx.linked',
      payload: {
        bankTxId,
        targetType: target.type,
        targetId: target.targetId,
      },
    });
    return refreshed;
  }

  /**
   * Operator-driven re-run of the matcher against an existing row. Closes the
   * rule-evolution loop: when `RECURRING_FEE_RULES` (or any other matcher
   * heuristic) gains a new pattern or branch, the operator can re-process
   * rows already stuck in their pre-change state through the UI instead of
   * needing a SQL/script backfill.
   *
   * Initial scope: categorised-but-not-matched rows. For matched rows the
   * operator unmatches first (existing affordance), then reprocesses.
   * Already-unmatched rows are also fine — the matcher just re-runs.
   */
  async reprocess(bankTxId: string): Promise<{ row: BankTransaction; result: MatchResult }> {
    const before = await this.bankTransactionRepository.findById(bankTxId);
    if (!before) {
      throw new Error(`bank_transaction ${bankTxId} not found`);
    }
    if (before.matchedAt) {
      throw new Error(`bank_transaction ${bankTxId} is currently matched; unmatch first before reprocessing`);
    }
    // Clear any stale category so tryMatch's early-return doesn't short-circuit.
    if (before.category) {
      await this.bankTransactionRepository.setCategory(bankTxId, null);
    }
    const refreshed = await this.bankTransactionRepository.findById(bankTxId);
    if (!refreshed) {
      throw new Error(`bank_transaction ${bankTxId} disappeared during reprocess`);
    }
    const result = await this.tryMatch(refreshed);
    const after = await this.bankTransactionRepository.findById(bankTxId);
    if (!after) {
      throw new Error(`bank_transaction ${bankTxId} disappeared during reprocess`);
    }
    await this.eventRepository.recordAction({
      source: EventSource.Manual,
      eventType: 'banking.tx.reprocessed',
      payload: {
        bankTxId,
        priorCategory: before.category,
        result: result.matched
          ? { matched: true, type: result.type, confidence: result.confidence }
          : { matched: false, reason: result.reason },
      },
    });
    this.logger.log(
      `bank_tx ${bankTxId} reprocessed: ${result.matched ? `matched (${result.type})` : `unmatched (${result.reason})`}`,
    );
    return { row: after, result };
  }

  /** Operator unlink: clears all match fields. Sheet rows aren't rewound. */
  async clearMatch(bankTxId: string): Promise<BankTransaction> {
    const refreshed = await this.bankTransactionRepository.clearMatch(bankTxId);
    if (!refreshed) {
      throw new Error(`bank_transaction ${bankTxId} not found`);
    }
    this.logger.log(`bank_tx ${bankTxId} → match cleared`);
    await this.eventRepository.recordAction({
      source: EventSource.Manual,
      eventType: 'banking.tx.unlinked',
      payload: { bankTxId },
    });
    return refreshed;
  }

  /** Bulk match every unmatched bank tx. Returns counts. */
  async matchAllUnmatched(): Promise<{ matched: number; unmatched: number }> {
    const rows = await this.bankTransactionRepository.findUnmatched(500);
    let matched = 0;
    let unmatched = 0;
    for (const row of rows) {
      const result = await this.tryMatch(row);
      if (result.matched) {
        matched++;
      } else {
        unmatched++;
      }
    }
    return { matched, unmatched };
  }
}

/**
 * "Either name contains the other" — handles the common case where the bank
 * statement and the paperless-ingested receipt list a vendor under slightly
 * different forms (corporate suffix, PSP-routing prefix, etc.).
 * Case-insensitive, with a length floor enforced by the caller so generic
 * names like "Wise" don't match overly-broadly.
 */
function fuzzyContains(a: string, b: string): boolean {
  const al = a.trim().toLowerCase();
  const bl = b.trim().toLowerCase();
  if (al.length < FUZZY_MIN_LENGTH || bl.length < FUZZY_MIN_LENGTH) {
    return false;
  }
  return al.includes(bl) || bl.includes(al);
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 24 * 60 * 60 * 1000);
}
