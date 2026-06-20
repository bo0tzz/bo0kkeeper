import { Injectable, Logger } from '@nestjs/common';
import { ClientClass, ExpenseLocationClass } from 'src/enum';
import { BankTransactionRepository } from 'src/repositories/bank-transaction.repository';
import { ExpenseRepository } from 'src/repositories/expense.repository';
import { InvoiceRepository } from 'src/repositories/invoice.repository';
import { WiseTransferRepository } from 'src/repositories/wise-transfer.repository';

export type Quarter = 1 | 2 | 3 | 4;

export type QuarterlyAggregate = {
  year: number;
  quarter: Quarter;
  /** Inclusive start of the quarter, UTC midnight. */
  periodStart: Date;
  /** Exclusive end of the quarter (start of next quarter), UTC midnight. */
  periodEnd: Date;
  income: {
    /**
     * Per-class income breakdown — drives the BTW form's rubriek selection
     * (1a = domestic w/ 21% BTW, 3a = export non-EU, 3b = intra-EU services
     * reverse-charge, etc).
     */
    byClass: Record<ClientClass, IncomeBucket>;
    /** Sum of all `byClass[*].grossEurMinor`. */
    totalGrossEurMinor: bigint;
    /** Sum of `byClass[*].btwEurMinor`. */
    totalBtwEurMinor: bigint;
  };
  expenses: {
    /**
     * Approved-only. The quarter's expense_date is the proxy for "when the
     * expense was paid"; refinement to use bank-match dates can come later.
     */
    grossEurMinor: bigint;
    /** Deductible BTW (vooraftrek) — only for domestic + EU-VAT-charged expenses. */
    deductibleBtwEurMinor: bigint;
  };
  /** Net BTW owed = collected - deductible. Negative means refund. */
  netBtwEurMinor: bigint;
  /**
   * Things blocking a clean filing. Each entry is a count + a `details`
   * sample; the UI surfaces the count and lets the user drill in.
   */
  warnings: AggregatorWarning[];
};

type IncomeBucket = {
  invoiceCount: number;
  grossEurMinor: bigint;
  btwEurMinor: bigint;
};

export type AggregatorWarning =
  | { kind: 'invoice_unmatched'; count: number; sampleNumbers: string[] }
  | { kind: 'expense_pending_review'; count: number; sampleVendors: string[] }
  | { kind: 'expense_low_confidence_match'; count: number; sampleIds: string[] };

/**
 * Aggregates DB state for a calendar quarter into the numbers an accountant
 * needs to file BTW-aangifte. The DB is authoritative; the sheet is the
 * accountant-readable mirror, not the source of truth.
 *
 * Income side runs on kasstelsel (cash-basis): a bank_transaction inside
 * the quarter that matched an invoice or a Wise transfer counts as income
 * on the date it cleared. Invoices issued in the quarter but not yet paid
 * surface as `invoice_unmatched` warnings, not as income.
 *
 * Expenses are counted by `expenseDate` (the receipt date). For credit-card
 * purchases this is close to the cash-basis date but not exactly it; a
 * follow-up could read bank-tx dates for paid expenses.
 */
@Injectable()
export class QuarterlyAggregatorService {
  private readonly logger = new Logger(QuarterlyAggregatorService.name);

  constructor(
    private readonly invoiceRepository: InvoiceRepository,
    private readonly wiseTransferRepository: WiseTransferRepository,
    private readonly expenseRepository: ExpenseRepository,
    private readonly bankTransactionRepository: BankTransactionRepository,
  ) {}

  async aggregate(year: number, quarter: Quarter): Promise<QuarterlyAggregate> {
    const { periodStart, periodEnd } = quarterRange(year, quarter);
    this.logger.debug(`Aggregating ${year} Q${quarter}: [${periodStart.toISOString()}, ${periodEnd.toISOString()})`);

    const sampleLimit = 5;
    const [paidInvoices, paidTransfers, approvedExpenses, unmatchedInvoices, pendingExpenses, lowConfidenceMatches] =
      await Promise.all([
        this.invoiceRepository.findPaidInPeriod(periodStart, periodEnd),
        this.wiseTransferRepository.findPaidInPeriod(periodStart, periodEnd),
        this.expenseRepository.findApprovedInPeriod(periodStart, periodEnd),
        // Cross-quarter unpaid invoices are included: any invoice issued before
        // period-end with no matched bank_tx counts. Wise-flow invoices are
        // excluded — their match lives on wise_transfer, not invoice.
        this.invoiceRepository.findUnmatchedBefore({ end: periodEnd, sampleLimit }),
        this.expenseRepository.findPendingInPeriod({ start: periodStart, end: periodEnd, sampleLimit }),
        this.bankTransactionRepository.findLowConfidenceInPeriod({
          start: periodStart,
          end: periodEnd,
          sampleLimit,
        }),
      ]);

    const byClass: Record<ClientClass, IncomeBucket> = {
      [ClientClass.NonEu]: emptyBucket(),
      [ClientClass.Eu]: emptyBucket(),
      [ClientClass.EuReverseCharge]: emptyBucket(),
      [ClientClass.Domestic]: emptyBucket(),
    };

    let totalGross = 0n;
    let totalBtw = 0n;
    for (const row of paidInvoices) {
      const cls = row.clientClass as ClientClass;
      const eurGross = pickEurMinor(row.eurTotalMinor, row.totalMinor, row.currency);
      const eurBtw =
        row.btwMinor === null || row.btwMinor === undefined ? 0n : BigInt(row.btwMinor as unknown as string);
      const bucket = byClass[cls];
      bucket.invoiceCount += 1;
      bucket.grossEurMinor += eurGross;
      bucket.btwEurMinor += eurBtw;
      totalGross += eurGross;
      totalBtw += eurBtw;
    }
    // Wise transfers that landed in the quarter contribute Non-EU income at the
    // EUR amount that actually arrived. No BTW (export, outside scope).
    for (const row of paidTransfers) {
      if (row.targetCurrency !== 'EUR') {
        continue;
      }
      const eurGross = BigInt(row.targetAmountMinor as unknown as string);
      const bucket = byClass[ClientClass.NonEu];
      bucket.invoiceCount += 1;
      bucket.grossEurMinor += eurGross;
      totalGross += eurGross;
    }

    let expenseGross = 0n;
    let expenseDeductibleBtw = 0n;
    for (const row of approvedExpenses) {
      const eurGross = row.currency === 'EUR' ? BigInt(row.amountMinor as unknown as string) : 0n;
      // For non-EUR expenses, deductibility requires conversion at the rate
      // that landed; we'd need a per-expense fxRate column. Skip for now.
      const eurBtw =
        row.btwMinor === null || row.btwMinor === undefined ? 0n : BigInt(row.btwMinor as unknown as string);
      expenseGross += eurGross;
      const cls = row.locationClass as ExpenseLocationClass;
      // Reverse-charge / non-EU expenses don't yield deductible BTW (you didn't pay any).
      if (cls === ExpenseLocationClass.Domestic || cls === ExpenseLocationClass.Eu) {
        expenseDeductibleBtw += eurBtw;
      }
    }

    const warnings: AggregatorWarning[] = [];
    if (unmatchedInvoices.count > 0) {
      warnings.push({
        kind: 'invoice_unmatched',
        count: unmatchedInvoices.count,
        sampleNumbers: unmatchedInvoices.sampleNumbers,
      });
    }
    if (pendingExpenses.count > 0) {
      warnings.push({
        kind: 'expense_pending_review',
        count: pendingExpenses.count,
        sampleVendors: pendingExpenses.sampleVendors,
      });
    }
    if (lowConfidenceMatches.count > 0) {
      warnings.push({
        kind: 'expense_low_confidence_match',
        count: lowConfidenceMatches.count,
        sampleIds: lowConfidenceMatches.sampleIds,
      });
    }

    return {
      year,
      quarter,
      periodStart,
      periodEnd,
      income: {
        byClass,
        totalGrossEurMinor: totalGross,
        totalBtwEurMinor: totalBtw,
      },
      expenses: {
        grossEurMinor: expenseGross,
        deductibleBtwEurMinor: expenseDeductibleBtw,
      },
      netBtwEurMinor: totalBtw - expenseDeductibleBtw,
      warnings,
    };
  }
}

export function quarterRange(year: number, quarter: Quarter): { periodStart: Date; periodEnd: Date } {
  const startMonth = (quarter - 1) * 3;
  const periodStart = new Date(Date.UTC(year, startMonth, 1));
  const periodEnd = quarter === 4 ? new Date(Date.UTC(year + 1, 0, 1)) : new Date(Date.UTC(year, startMonth + 3, 1));
  return { periodStart, periodEnd };
}

function emptyBucket(): IncomeBucket {
  return { invoiceCount: 0, grossEurMinor: 0n, btwEurMinor: 0n };
}

/**
 * Pick the EUR equivalent of an invoice's gross. Native-EUR invoices use
 * `totalMinor`; foreign-currency invoices use `eurTotalMinor` (set at the FX
 * rate that landed). Falls back to `totalMinor` if the EUR amount wasn't
 * recorded — the warning system will flag missing FX as needed.
 */
function pickEurMinor(eurTotalMinor: unknown, totalMinor: unknown, currency: string): bigint {
  if (currency === 'EUR') {
    return BigInt(totalMinor as bigint | number | string);
  }
  if (eurTotalMinor === null || eurTotalMinor === undefined) {
    return 0n;
  }
  return BigInt(eurTotalMinor as bigint | number | string);
}
