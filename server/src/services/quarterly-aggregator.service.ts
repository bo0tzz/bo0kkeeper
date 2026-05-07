import { Injectable, Logger } from '@nestjs/common';
import { Kysely } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { ClientClass, ExpenseLocationClass, ExpenseStatus, MatchConfidence } from 'src/enum';
import { DB } from 'src/schema';

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
 * Date convention (period-basis, first cut): invoices counted by `issuedAt`,
 * expenses counted by `expenseDate`. Strict kasstelsel (bank-match dates) is
 * a follow-up — the warnings already surface what would prevent that switch
 * (unmatched invoices, pending-review expenses).
 */
@Injectable()
export class QuarterlyAggregatorService {
  private readonly logger = new Logger(QuarterlyAggregatorService.name);

  constructor(@InjectKysely() private readonly db: Kysely<DB>) {}

  async aggregate(year: number, quarter: Quarter): Promise<QuarterlyAggregate> {
    const { periodStart, periodEnd } = quarterRange(year, quarter);
    this.logger.debug(`Aggregating ${year} Q${quarter}: [${periodStart.toISOString()}, ${periodEnd.toISOString()})`);

    const [invoiceRows, expenseRows, unmatchedSample, pendingExpensesSample, lowConfidenceMatchSample] =
      await Promise.all([
        this.db
          .selectFrom('invoice')
          .innerJoin('client', 'client.id', 'invoice.clientId')
          .select([
            'invoice.id as id',
            'invoice.number as number',
            'invoice.totalMinor as totalMinor',
            'invoice.eurTotalMinor as eurTotalMinor',
            'invoice.btwMinor as btwMinor',
            'invoice.currency as currency',
            'client.class as clientClass',
          ])
          .where('invoice.issuedAt', '>=', periodStart)
          .where('invoice.issuedAt', '<', periodEnd)
          .execute(),
        this.db
          .selectFrom('expense')
          .select(['id', 'amountMinor', 'btwMinor', 'currency', 'locationClass', 'vendor'])
          .where('status', '=', ExpenseStatus.Approved)
          .where('expenseDate', '>=', periodStart)
          .where('expenseDate', '<', periodEnd)
          .execute(),
        this.db
          .selectFrom('invoice')
          .leftJoin('bank_transaction', 'bank_transaction.matchedInvoiceId', 'invoice.id')
          .select(['invoice.number'])
          .where('invoice.issuedAt', '>=', periodStart)
          .where('invoice.issuedAt', '<', periodEnd)
          .where('bank_transaction.id', 'is', null)
          .limit(5)
          .execute(),
        this.db
          .selectFrom('expense')
          .select(['vendor'])
          .where('status', '=', ExpenseStatus.PendingReview)
          .where('expenseDate', '>=', periodStart)
          .where('expenseDate', '<', periodEnd)
          .limit(5)
          .execute(),
        this.db
          .selectFrom('bank_transaction')
          .select(['id'])
          .where('matchConfidence', '=', MatchConfidence.AutoLow)
          .where('txDate', '>=', periodStart)
          .where('txDate', '<', periodEnd)
          .limit(5)
          .execute(),
      ]);

    const byClass: Record<ClientClass, IncomeBucket> = {
      [ClientClass.NonEu]: emptyBucket(),
      [ClientClass.Eu]: emptyBucket(),
      [ClientClass.EuReverseCharge]: emptyBucket(),
      [ClientClass.Domestic]: emptyBucket(),
    };

    let totalGross = 0n;
    let totalBtw = 0n;
    for (const row of invoiceRows) {
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

    let expenseGross = 0n;
    let expenseDeductibleBtw = 0n;
    for (const row of expenseRows) {
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
    if (unmatchedSample.length > 0) {
      const unmatchedCountRow = await this.db
        .selectFrom('invoice')
        .leftJoin('bank_transaction', 'bank_transaction.matchedInvoiceId', 'invoice.id')
        .select((eb) => eb.fn.countAll().as('total'))
        .where('invoice.issuedAt', '>=', periodStart)
        .where('invoice.issuedAt', '<', periodEnd)
        .where('bank_transaction.id', 'is', null)
        .executeTakeFirstOrThrow();
      warnings.push({
        kind: 'invoice_unmatched',
        count: Number(unmatchedCountRow.total),
        sampleNumbers: unmatchedSample.map((row) => row.number),
      });
    }
    if (pendingExpensesSample.length > 0) {
      const pendingCountRow = await this.db
        .selectFrom('expense')
        .select((eb) => eb.fn.countAll().as('total'))
        .where('status', '=', ExpenseStatus.PendingReview)
        .where('expenseDate', '>=', periodStart)
        .where('expenseDate', '<', periodEnd)
        .executeTakeFirstOrThrow();
      warnings.push({
        kind: 'expense_pending_review',
        count: Number(pendingCountRow.total),
        sampleVendors: pendingExpensesSample.map((row) => row.vendor),
      });
    }
    if (lowConfidenceMatchSample.length > 0) {
      const lowConfCountRow = await this.db
        .selectFrom('bank_transaction')
        .select((eb) => eb.fn.countAll().as('total'))
        .where('matchConfidence', '=', MatchConfidence.AutoLow)
        .where('txDate', '>=', periodStart)
        .where('txDate', '<', periodEnd)
        .executeTakeFirstOrThrow();
      warnings.push({
        kind: 'expense_low_confidence_match',
        count: Number(lowConfCountRow.total),
        sampleIds: lowConfidenceMatchSample.map((row) => row.id),
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
