import { Injectable, Logger } from '@nestjs/common';
import { BankTxCategory, EventSource, ExpenseLocationClass, ExpenseStatus, MatchConfidence } from 'src/enum';
import { BankTransaction, BankTransactionRepository } from 'src/repositories/bank-transaction.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { Expense, ExpenseRepository } from 'src/repositories/expense.repository';
import type { MatchResult } from 'src/services/bank-matcher.service';
import { SheetSyncService } from 'src/services/sheet-sync.service';
import { parseBtwFromDescription } from 'src/utils/btw-description';

/**
 * Description-substring rules for recurring bank-fee rows. Two outcomes per
 * rule, depending on whether the bank-tx description carries a parseable BTW
 * breakdown ("21% BTW BTW bedrag: 0,32"):
 *
 * - With BTW (e.g. SNS klantonderzoek): an Approved Expense is auto-created
 *   with `sourceBankTxId` set, the bank-tx is matched to it, the sheet row
 *   fires through the normal expense path, and the BTW lands in the
 *   quarterly aggregator's deductible total. The bank statement line is the
 *   *vereenvoudigde factuur* (Art. 35a Wet OB) — no separate document needed.
 * - Without BTW: the bank-tx is categorized to `fallbackCategory`, which
 *   excludes it from matching + sheet writes (the row has no further
 *   bookkeeping side-effect).
 *
 * Code constant rather than a DB table because the set is small, stable, and
 * reviewed in PR. All current rules target SNS service fees from Volksbank
 * (the legal entity SNS/ASN/RegioBank trade under, per the BTW number on the
 * bank statement).
 */
type RecurringFeeRule = {
  /** Substring match against bank description, case-insensitive. */
  descriptionContains: string;
  /** Operator-readable explanation that lands in the audit event. */
  reason: string;
  /** Vendor field on the auto-created Expense when BTW parses. */
  vendor: string;
  /** Location class on the auto-created Expense when BTW parses. */
  locationClass: ExpenseLocationClass;
  /** Category applied to the bank-tx when no BTW parses. */
  fallbackCategory: BankTxCategory;
};

const SNS_VENDOR = 'Volksbank';

const RECURRING_FEE_RULES: readonly RecurringFeeRule[] = [
  {
    descriptionContains: 'klantonderzoek',
    reason: 'SNS Klantonderzoek monthly fee',
    vendor: SNS_VENDOR,
    locationClass: ExpenseLocationClass.Domestic,
    fallbackCategory: BankTxCategory.Fee,
  },
  {
    descriptionContains: 'kosten rekening',
    reason: 'SNS account maintenance fee',
    vendor: SNS_VENDOR,
    locationClass: ExpenseLocationClass.Domestic,
    fallbackCategory: BankTxCategory.Fee,
  },
  {
    descriptionContains: 'kosten gebruik betaalrekening',
    reason: 'SNS payment-account usage fee',
    vendor: SNS_VENDOR,
    locationClass: ExpenseLocationClass.Domestic,
    fallbackCategory: BankTxCategory.Fee,
  },
  {
    descriptionContains: 'kosten betaalverzoek',
    reason: 'SNS payment-request fee',
    vendor: SNS_VENDOR,
    locationClass: ExpenseLocationClass.Domestic,
    fallbackCategory: BankTxCategory.Fee,
  },
];

const FEE_EXPENSE_NOTE = 'Auto-created from bank-tx; statement line is vereenvoudigde factuur (Art. 35a Wet OB).';

/**
 * Recognises recurring bank-fee rows (SNS service fees) and resolves them
 * without operator review: BTW-parseable fees become an auto-created Approved
 * Expense + match; BTW-less fees are categorised out of the matching flow.
 *
 * Extracted from BankMatcherService — the matcher calls this before its
 * generic heuristics, but the rules engine + auto-Expense creation is a
 * self-contained domain concern.
 */
@Injectable()
export class RecurringFeeService {
  private readonly logger = new Logger(RecurringFeeService.name);

  constructor(
    private readonly bankTransactionRepository: BankTransactionRepository,
    private readonly expenseRepository: ExpenseRepository,
    private readonly eventRepository: EventRepository,
    private readonly sheetSync: SheetSyncService,
  ) {}

  /**
   * Handle a bank-tx that matches a known recurring-fee rule. Returns the
   * resulting MatchResult (which the caller threads through) or null when no
   * rule applies / the row is already handled.
   *
   * Two outcomes when a rule matches:
   * - description has a parseable BTW breakdown → auto-create an Approved
   *   Expense, link the bank-tx, write the sheet row, return matched=true
   * - description has no BTW → categorise the bank-tx, audit-event it,
   *   return matched=false (the row is dealt with — it's just outside the
   *   bookkeeping flow)
   *
   * Idempotent on repeat invocation: a second call against the same bank-tx
   * after a previous match was cleared finds the existing fee-Expense by
   * `sourceBankTxId` and re-links rather than creating a duplicate.
   */
  async tryHandleRecurringFee(bankTx: BankTransaction): Promise<MatchResult | null> {
    if (bankTx.matchedAt || bankTx.category) {
      return null;
    }
    const description = bankTx.description ?? '';
    const lower = description.toLowerCase();
    const rule = RECURRING_FEE_RULES.find((r) => lower.includes(r.descriptionContains));
    if (!rule) {
      return null;
    }

    const btw = parseBtwFromDescription(description);
    if (btw) {
      const expense = await this.createOrFindFeeExpense(bankTx, rule, btw);
      await this.bankTransactionRepository.setMatch(
        bankTx.id,
        { type: 'expense', id: expense.id },
        MatchConfidence.AutoHigh,
      );
      await this.eventRepository.recordAction({
        source: EventSource.System,
        eventType: 'banking.tx.auto_fee_expense_matched',
        payload: {
          bankTxId: bankTx.id,
          expenseId: expense.id,
          rule: rule.reason,
          btwRateBps: btw.rateBps,
          btwMinor: String(btw.amountMinor),
        },
      });
      this.logger.log(
        `bank_tx ${bankTx.id} → fee expense ${expense.id} (${rule.reason}, BTW ${btw.rateBps / 100}% €${(Number(btw.amountMinor) / 100).toFixed(2)})`,
      );
      const txDate = bankTx.txDate instanceof Date ? bankTx.txDate : new Date(bankTx.txDate);
      await this.sheetSync.writeExpenseRowSafely(expense, txDate, bankTx.id);
      return {
        matched: true,
        type: 'expense',
        expenseId: expense.id,
        confidence: MatchConfidence.AutoHigh,
      };
    }

    await this.bankTransactionRepository.setCategory(bankTx.id, rule.fallbackCategory);
    await this.eventRepository.recordAction({
      source: EventSource.System,
      eventType: 'banking.tx.auto_categorized',
      payload: { bankTxId: bankTx.id, category: rule.fallbackCategory, reason: rule.reason },
    });
    this.logger.log(`bank_tx ${bankTx.id} auto-categorized as ${rule.fallbackCategory} (${rule.reason})`);
    return { matched: false, reason: `auto-categorized as ${rule.fallbackCategory}` };
  }

  /**
   * Idempotent: looks up an existing fee-Expense by `sourceBankTxId`, or
   * creates a new Approved one if none exists. Reprocessing the same bank-tx
   * does NOT create duplicates.
   */
  private async createOrFindFeeExpense(
    bankTx: BankTransaction,
    rule: RecurringFeeRule,
    btw: { rateBps: number; amountMinor: bigint },
  ): Promise<Expense> {
    const existing = await this.expenseRepository.findBySourceBankTxId(bankTx.id);
    if (existing) {
      return existing;
    }
    const txDate = bankTx.txDate instanceof Date ? bankTx.txDate : new Date(bankTx.txDate);
    const now = new Date();
    const rawMinor = BigInt(bankTx.amountMinor as bigint | number | string);
    const grossMinor = rawMinor < 0n ? -rawMinor : rawMinor;
    const result = await this.expenseRepository.ingestFromBankFee({
      sourceBankTxId: bankTx.id,
      paperlessDocId: null,
      vendor: rule.vendor,
      expenseDate: txDate,
      amountMinor: grossMinor,
      currency: bankTx.currency,
      btwRateBps: btw.rateBps,
      btwMinor: btw.amountMinor,
      locationClass: rule.locationClass,
      status: ExpenseStatus.Approved,
      reviewedAt: now,
      notes: FEE_EXPENSE_NOTE,
    });
    if (result.ingested) {
      return result.row;
    }
    // Lost the race: another caller inserted in between our find and create.
    const row = await this.expenseRepository.findById(result.existingId);
    if (!row) {
      throw new Error(`expense ${result.existingId} disappeared after race`);
    }
    return row;
  }
}
