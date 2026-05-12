import { Injectable, Logger } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { OnJob } from 'src/decorators';
import { BankTxCategory, ClientClass, EventSource, ExpenseStatus, JobName, MatchConfidence, QueueName } from 'src/enum';
import { BankTransaction, BankTransactionRepository } from 'src/repositories/bank-transaction.repository';
import { ClientRepository } from 'src/repositories/client.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { DB } from 'src/schema';
import { expenseToSheetRow, SheetWriterService } from 'src/services/sheet-writer.service';
import { JobOf } from 'src/types';

const TXN_REF_PATTERN = /\bTXN-\d{4,}\b/;
const INVOICE_NUMBER_PATTERN = /\b\d{4}\/\d{3}\b/;

/**
 * Description-substring rules for recurring rows that aren't a real
 * income/expense and should skip the matcher entirely. Fees here are SNS-
 * specific monthly charges (Klantonderzoek, account maintenance,
 * payment-request) — the user's bank, not Wise. Add patterns as new
 * recurring rows show up; deliberately a code constant rather than a DB
 * table because the set is small, stable, and reviewed in PR.
 */
type AutoCategoryRule = {
  /** Substring match against bank description, case-insensitive. */
  descriptionContains: string;
  category: BankTxCategory;
  /** Operator-readable explanation that lands in the audit event. */
  reason: string;
};

const AUTO_CATEGORY_RULES: readonly AutoCategoryRule[] = [
  {
    descriptionContains: 'klantonderzoek',
    category: BankTxCategory.Fee,
    reason: 'SNS Klantonderzoek monthly fee',
  },
  {
    descriptionContains: 'kosten rekening',
    category: BankTxCategory.Fee,
    reason: 'SNS account maintenance fee',
  },
  {
    descriptionContains: 'kosten betaalverzoek',
    category: BankTxCategory.Fee,
    reason: 'SNS payment-request fee',
  },
];

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

export type TransferCandidate = {
  id: string;
  wiseTransferId: string;
  ourReference: string | null;
  state: string;
  sourceCurrency: string;
  sourceAmountMinor: bigint;
  targetCurrency: string;
  targetAmountMinor: bigint;
  createdAt: Date;
};

export type InvoiceCandidate = {
  id: string;
  number: string;
  totalMinor: bigint;
  currency: string;
  issuedAt: Date;
  clientName: string | null;
};

export type ExpenseCandidate = {
  id: string;
  vendor: string;
  amountMinor: bigint;
  currency: string;
  expenseDate: Date;
  status: string;
};

export type MatchCandidates = {
  transfers: TransferCandidate[];
  invoices: InvoiceCandidate[];
  expenses: ExpenseCandidate[];
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
    @InjectKysely() private readonly db: Kysely<DB>,
    private readonly bankTransactionRepository: BankTransactionRepository,
    private readonly clientRepository: ClientRepository,
    private readonly sheetWriter: SheetWriterService,
    private readonly eventRepository: EventRepository,
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

    // Recognized recurring fees / known-pattern rows are auto-categorized
    // and bypass the matcher entirely — they have no counterpart to link to.
    const autocat = await this.tryAutoCategorize(bankTx);
    if (autocat.categorized) {
      return { matched: false, reason: `auto-categorized as ${autocat.category}` };
    }

    const description = bankTx.description ?? '';

    const txnRef = TXN_REF_PATTERN.exec(description)?.[0];
    if (txnRef) {
      const transfer = await this.db
        .selectFrom('wise_transfer')
        .selectAll()
        .where('ourReference', '=', txnRef)
        .executeTakeFirst();
      if (transfer) {
        await this.persistTransferMatch(bankTx.id, transfer.id, MatchConfidence.AutoHigh);
        this.logger.log(`bank_tx ${bankTx.id} → wise_transfer ${transfer.id} via ${txnRef}`);
        await this.appendWiseIncomeRow(bankTx, transfer);
        return { matched: true, type: 'wise_transfer', transferId: transfer.id, confidence: MatchConfidence.AutoHigh };
      }
    }

    const invoiceNumber = INVOICE_NUMBER_PATTERN.exec(description)?.[0];
    if (invoiceNumber) {
      const invoice = await this.db
        .selectFrom('invoice')
        .selectAll()
        .where('number', '=', invoiceNumber)
        .executeTakeFirst();
      if (invoice) {
        await this.persistInvoiceMatch(bankTx.id, invoice.id, MatchConfidence.AutoHigh);
        this.logger.log(`bank_tx ${bankTx.id} → invoice ${invoice.id} via ${invoiceNumber}`);
        await this.appendIncomeRow(bankTx, invoice);
        return { matched: true, type: 'invoice', invoiceId: invoice.id, confidence: MatchConfidence.AutoHigh };
      }
    }

    // No high-confidence signal — fall through to heuristics. Outflows look
    // for an expense, inflows look for an invoice. Sheet-write deliberately
    // skipped on auto_low; promotion to manual via the link UI handles that.
    const isOutflow = BigInt(bankTx.amountMinor as bigint | number | string) < 0n;
    const heuristic = isOutflow
      ? await this.tryExpenseHeuristic(bankTx)
      : await this.tryInvoiceHeuristic(bankTx);
    if (heuristic) {
      return heuristic;
    }

    return { matched: false, reason: 'no high-confidence signal' };
  }

  /**
   * Set the category on rows whose description matches a known recurring-fee
   * pattern. Audit-trails as a `banking.tx.auto_categorized` system event.
   * Returns whether anything was applied.
   */
  async tryAutoCategorize(
    bankTx: BankTransaction,
  ): Promise<{ categorized: true; category: BankTxCategory; reason: string } | { categorized: false }> {
    if (bankTx.matchedAt || bankTx.category) {
      return { categorized: false };
    }
    const description = (bankTx.description ?? '').toLowerCase();
    const rule = AUTO_CATEGORY_RULES.find((r) => description.includes(r.descriptionContains));
    if (!rule) {
      return { categorized: false };
    }
    await this.bankTransactionRepository.setCategory(bankTx.id, rule.category);
    await this.eventRepository.recordAction({
      source: EventSource.System,
      eventType: 'banking.tx.auto_categorized',
      payload: { bankTxId: bankTx.id, category: rule.category, reason: rule.reason },
    });
    this.logger.log(`bank_tx ${bankTx.id} auto-categorized as ${rule.category} (${rule.reason})`);
    return { categorized: true, category: rule.category, reason: rule.reason };
  }

  private async tryExpenseHeuristic(bankTx: BankTransaction): Promise<MatchResult | null> {
    const counterparty = bankTx.counterpartyName?.trim();
    if (!counterparty || counterparty.length < FUZZY_MIN_LENGTH) {
      return null;
    }
    const absMinor = absBigInt(BigInt(bankTx.amountMinor as bigint | number | string));
    const txDate = toDate(bankTx.txDate);
    const dateLow = addDays(txDate, -EXPENSE_DATE_TOLERANCE_DAYS);
    const dateHigh = addDays(txDate, EXPENSE_DATE_TOLERANCE_DAYS);

    const candidates = await this.db
      .selectFrom('expense')
      .selectAll()
      .where('amountMinor', '=', absMinor)
      .where('currency', '=', bankTx.currency)
      .where('expenseDate', '>=', dateLow)
      .where('expenseDate', '<=', dateHigh)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('bank_transaction')
              .select('id')
              .whereRef('bank_transaction.matchedExpenseId', '=', 'expense.id'),
          ),
        ),
      )
      .execute();

    const matches = candidates.filter((e) => fuzzyContains(counterparty, e.vendor));
    if (matches.length !== 1) {
      return null;
    }
    const expense = matches[0];
    await this.persistExpenseMatch(bankTx.id, expense.id, MatchConfidence.AutoLow);
    this.logger.log(
      `bank_tx ${bankTx.id} → expense ${expense.id} via heuristic (vendor "${expense.vendor}", amount ${absMinor})`,
    );
    return { matched: true, type: 'expense', expenseId: expense.id, confidence: MatchConfidence.AutoLow };
  }

  private async tryInvoiceHeuristic(bankTx: BankTransaction): Promise<MatchResult | null> {
    const counterparty = bankTx.counterpartyName?.trim();
    if (!counterparty || counterparty.length < FUZZY_MIN_LENGTH) {
      return null;
    }
    const absMinor = absBigInt(BigInt(bankTx.amountMinor as bigint | number | string));
    const txDate = toDate(bankTx.txDate);
    const issuedAfter = addDays(txDate, -INVOICE_PAYMENT_WINDOW_DAYS);
    const issuedBefore = addDays(txDate, 1);

    // For non-EUR invoices we'd need a currency conversion to compare against
    // the EUR-denominated bank row; that's a meaningful slice of false-negatives
    // for the non-EU/USD flow, but those are already TXN-NNNN-matched (auto_high)
    // so the heuristic skipping them is fine.
    const candidates = await this.db
      .selectFrom('invoice')
      .innerJoin('client', 'client.id', 'invoice.clientId')
      .select([
        'invoice.id as invoiceId',
        'invoice.number',
        'invoice.totalMinor',
        'invoice.currency',
        'invoice.issuedAt',
        'client.name as clientName',
      ])
      .where('invoice.totalMinor', '=', absMinor)
      .where('invoice.currency', '=', bankTx.currency)
      .where('invoice.issuedAt', '>=', issuedAfter)
      .where('invoice.issuedAt', '<', issuedBefore)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('bank_transaction')
              .select('id')
              .whereRef('bank_transaction.matchedInvoiceId', '=', 'invoice.id'),
          ),
        ),
      )
      .execute();

    const matches = candidates.filter((i) => i.clientName && fuzzyContains(counterparty, i.clientName));
    if (matches.length !== 1) {
      return null;
    }
    const invoice = matches[0];
    await this.persistInvoiceMatch(bankTx.id, invoice.invoiceId, MatchConfidence.AutoLow);
    this.logger.log(
      `bank_tx ${bankTx.id} → invoice ${invoice.number} via heuristic (client "${invoice.clientName}", amount ${absMinor})`,
    );
    return { matched: true, type: 'invoice', invoiceId: invoice.invoiceId, confidence: MatchConfidence.AutoLow };
  }

  /**
   * Append a sheet income row for the matched invoice. Best-effort: a sheets
   * outage or a missing service-account config must not block the match itself
   * (the row is still persisted and visible in the admin UI).
   *
   * Date convention: the bank tx date is the kasstelsel "payment received"
   * date, which is what the sheet is keyed on.
   */
  private async appendIncomeRow(
    bankTx: BankTransaction,
    invoice: {
      clientId: string;
      number: string;
      btwRateBps: number | null;
      btwMinor: bigint | string | null;
    },
  ) {
    try {
      const client = await this.clientRepository.findById(invoice.clientId);
      if (!client) {
        this.logger.warn(`Skipping sheet write for invoice ${invoice.number}: client ${invoice.clientId} not found`);
        return;
      }
      const rawMinor = BigInt(bankTx.amountMinor as bigint | number | string);
      const eurAmountMinor = rawMinor < 0n ? -rawMinor : rawMinor;
      const vatPercent = invoice.btwRateBps == null ? undefined : `${invoice.btwRateBps / 100}%`;
      const vatMinor = invoice.btwMinor == null ? undefined : BigInt(invoice.btwMinor);
      await this.sheetWriter.writeIncomeRow({
        date: bankTx.txDate instanceof Date ? bankTx.txDate : new Date(bankTx.txDate),
        invoiceNumber: invoice.number,
        eurAmountMinor,
        client: { name: client.name, class: client.class as ClientClass },
        from: bankTx.counterpartyName ?? client.name,
        vatPercent,
        vatMinor,
        source: `bank_tx/${bankTx.id}`,
      });
      await this.markBankTxSheetRowAt(bankTx.id);
    } catch (error) {
      const message = (error as Error).message;
      this.logger.error(`Sheet write failed for invoice ${invoice.number}: ${message}`);
      await this.recordSheetWriteFailure({
        kind: 'invoice',
        bankTxId: bankTx.id,
        identifier: invoice.number,
        message,
      });
    }
  }

  /**
   * Append a sheet income row for a Wise-routed inbound payment (Non-EU). The
   * Wise transfer doesn't carry the originating client directly, so we look
   * up the unique Non-EU client; when there's exactly one we use it. Otherwise
   * the row is written with a placeholder name ("Wise") and the user fills in
   * the client manually in the sheet.
   */
  private async appendWiseIncomeRow(
    bankTx: BankTransaction,
    transfer: { id: string; ourReference: string | null; targetCurrency: string },
  ) {
    try {
      const reference = transfer.ourReference ?? '(no ref)';
      const rawMinor = BigInt(bankTx.amountMinor as bigint | number | string);
      const eurAmountMinor = rawMinor < 0n ? -rawMinor : rawMinor;
      const allClients = await this.clientRepository.findAll();
      const nonEuClients = allClients.filter((c) => c.class === ClientClass.NonEu);
      const nonEuClient = nonEuClients.length === 1 ? nonEuClients[0] : null;
      await this.sheetWriter.writeIncomeRow({
        date: bankTx.txDate instanceof Date ? bankTx.txDate : new Date(bankTx.txDate),
        invoiceNumber: reference,
        eurAmountMinor,
        client: { name: nonEuClient?.name ?? 'Wise', class: ClientClass.NonEu },
        // Omit `from` — writeIncomeRow falls back to client.name, which is the
        // originating Non-EU client. The bank-tx counterparty on the SNS side
        // is always "Wise" (the routing service), which is the wrong
        // bookkeeping party.
        source: `wise_transfer/${transfer.id}`,
      });
      await this.markBankTxSheetRowAt(bankTx.id);
    } catch (error) {
      const message = (error as Error).message;
      this.logger.error(`Sheet write failed for wise_transfer ${transfer.id}: ${message}`);
      await this.recordSheetWriteFailure({
        kind: 'wise_transfer',
        bankTxId: bankTx.id,
        identifier: transfer.ourReference ?? transfer.id,
        message,
      });
    }
  }

  /**
   * Retry any sheet writes that failed earlier. Identifies missing rows by
   * scanning entities that should have a sheet row (matched bank_tx,
   * approved + bank-tx-matched expense) but whose `sheetRowAt` is still null.
   *
   * Cron-scheduled hourly and on-demand-triggerable from /banking. The
   * existing append paths set `sheetRowAt` on success and write a
   * `sheet.write_failed` audit event on failure, so this is genuinely
   * idempotent — a retry that succeeds closes the loop; a retry that fails
   * just records another audit event without double-writing.
   */
  @OnJob({ name: JobName.SheetWriteRetry, queue: QueueName.Default })
  async retryFailedSheetWrites(_data: JobOf<JobName.SheetWriteRetry>): Promise<{
    attempted: number;
    succeeded: number;
  }> {
    let attempted = 0;
    let succeeded = 0;

    // Income side: matched bank_txs (auto_high or manual) missing their row.
    const incomeRows = await this.db
      .selectFrom('bank_transaction')
      .selectAll()
      .where('matchedAt', 'is not', null)
      .where('matchConfidence', 'in', [MatchConfidence.AutoHigh, MatchConfidence.Manual])
      .where('sheetRowAt', 'is', null)
      .where((eb) =>
        eb.or([eb('matchedInvoiceId', 'is not', null), eb('matchedTransferId', 'is not', null)]),
      )
      .execute();

    for (const bankTx of incomeRows as BankTransaction[]) {
      attempted += 1;
      const before = bankTx.sheetRowAt;
      if (bankTx.matchedInvoiceId) {
        const invoice = await this.db
          .selectFrom('invoice')
          .selectAll()
          .where('id', '=', bankTx.matchedInvoiceId)
          .executeTakeFirst();
        if (invoice) {
          await this.appendIncomeRow(bankTx, invoice);
        }
      } else if (bankTx.matchedTransferId) {
        const transfer = await this.db
          .selectFrom('wise_transfer')
          .selectAll()
          .where('id', '=', bankTx.matchedTransferId)
          .executeTakeFirst();
        if (transfer) {
          await this.appendWiseIncomeRow(bankTx, transfer);
        }
      }
      const after = await this.db
        .selectFrom('bank_transaction')
        .select('sheetRowAt')
        .where('id', '=', bankTx.id)
        .executeTakeFirst();
      if (after?.sheetRowAt && !before) {
        succeeded += 1;
      }
    }

    // Expense side: approved expenses with a manual-confidence bank_tx link,
    // missing their sheet row.
    const expenseRows = await this.db
      .selectFrom('expense')
      .innerJoin('bank_transaction', 'bank_transaction.matchedExpenseId', 'expense.id')
      .where('expense.status', '=', ExpenseStatus.Approved)
      .where('expense.sheetRowAt', 'is', null)
      .where('bank_transaction.matchConfidence', '=', MatchConfidence.Manual)
      .selectAll('expense')
      .select(['bank_transaction.id as bankTxId', 'bank_transaction.txDate as bankTxDate'])
      .execute();

    for (const row of expenseRows) {
      attempted += 1;
      const txDate = row.bankTxDate instanceof Date ? row.bankTxDate : new Date(row.bankTxDate);
      try {
        await this.sheetWriter.writeExpenseRow(expenseToSheetRow(row, txDate));
        await this.markExpenseSheetRowAt(row.id);
        succeeded += 1;
      } catch (error) {
        const message = (error as Error).message;
        this.logger.error(`Sheet write retry failed for expense ${row.id}: ${message}`);
        await this.recordSheetWriteFailure({
          kind: 'expense',
          bankTxId: row.bankTxId,
          identifier: row.paperlessDocId,
          message,
        });
      }
    }

    if (attempted > 0) {
      this.logger.log(`Sheet write retry: ${succeeded}/${attempted} succeeded`);
    }
    return { attempted, succeeded };
  }

  /**
   * Mark a bank_tx as having its sheet income row successfully written.
   * The retry job uses `sheetRowAt IS NULL` to find writes to retry; setting
   * it here closes the loop.
   */
  private async markBankTxSheetRowAt(bankTxId: string): Promise<void> {
    await this.db
      .updateTable('bank_transaction')
      .set({ sheetRowAt: new Date(), updatedAt: new Date() })
      .where('id', '=', bankTxId)
      .execute();
  }

  /** Same as markBankTxSheetRowAt but for the expense row. */
  private async markExpenseSheetRowAt(expenseId: string): Promise<void> {
    await this.db
      .updateTable('expense')
      .set({ sheetRowAt: new Date(), updatedAt: new Date() })
      .where('id', '=', expenseId)
      .execute();
  }

  /**
   * Append a `sheet.write_failed` audit event so the operator can see and
   * resolve sheet outages from the Events page. Best-effort itself — if the
   * event write fails, we don't recurse (we'd just have logged the message).
   */
  private async recordSheetWriteFailure(input: {
    kind: 'invoice' | 'wise_transfer' | 'expense';
    bankTxId: string;
    identifier: string;
    message: string;
  }): Promise<void> {
    try {
      await this.eventRepository.recordAction({
        source: EventSource.System,
        eventType: 'sheet.write_failed',
        payload: input,
      });
    } catch (error) {
      this.logger.error(`Failed to record sheet.write_failed event: ${(error as Error).message}`);
    }
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
    const like = q ? `%${q}%` : null;
    const excludeAlreadyMatched = !like;

    const transfers = await (() => {
      let qb = this.db
        .selectFrom('wise_transfer')
        .select([
          'id',
          'wiseTransferId',
          'ourReference',
          'state',
          'sourceCurrency',
          'sourceAmountMinor',
          'targetCurrency',
          'targetAmountMinor',
          'createdAt',
        ])
        .orderBy('createdAt', 'desc')
        .limit(limit);
      if (like) {
        qb = qb.where((eb) =>
          eb.or([
            eb(eb.fn<string>('lower', ['ourReference']), 'like', like),
            eb(eb.fn<string>('lower', ['wiseTransferId']), 'like', like),
          ]),
        );
      }
      if (excludeAlreadyMatched) {
        qb = qb.where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom('bank_transaction')
                .select('id')
                .whereRef('bank_transaction.matchedTransferId', '=', 'wise_transfer.id'),
            ),
          ),
        );
      }
      return qb.execute();
    })();

    const invoices = await (() => {
      let qb = this.db
        .selectFrom('invoice')
        .leftJoin('client', 'client.id', 'invoice.clientId')
        .select([
          'invoice.id',
          'invoice.number',
          'invoice.totalMinor',
          'invoice.currency',
          'invoice.issuedAt',
          'client.name as clientName',
        ])
        .orderBy('invoice.issuedAt', 'desc')
        .limit(limit);
      if (like) {
        qb = qb.where((eb) =>
          eb.or([
            eb(eb.fn<string>('lower', ['invoice.number']), 'like', like),
            eb(eb.fn<string>('lower', ['client.name']), 'like', like),
          ]),
        );
      }
      if (excludeAlreadyMatched) {
        qb = qb.where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom('bank_transaction')
                .select('id')
                .whereRef('bank_transaction.matchedInvoiceId', '=', 'invoice.id'),
            ),
          ),
        );
      }
      return qb.execute();
    })();

    const expenses = await (() => {
      let qb = this.db
        .selectFrom('expense')
        .select(['id', 'vendor', 'amountMinor', 'currency', 'expenseDate', 'status'])
        .orderBy('expenseDate', 'desc')
        .limit(limit);
      if (like) {
        qb = qb.where((eb) => eb(eb.fn<string>('lower', ['vendor']), 'like', like));
      }
      if (excludeAlreadyMatched) {
        qb = qb.where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom('bank_transaction')
                .select('id')
                .whereRef('bank_transaction.matchedExpenseId', '=', 'expense.id'),
            ),
          ),
        );
      }
      return qb.execute();
    })();

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
      const transfer = await this.db
        .selectFrom('wise_transfer')
        .selectAll()
        .where('id', '=', target.targetId)
        .executeTakeFirst();
      if (!transfer) {
        throw new Error(`wise_transfer ${target.targetId} not found`);
      }
      await this.persistTransferMatch(bankTxId, transfer.id, MatchConfidence.Manual);
      this.logger.log(`bank_tx ${bankTxId} → wise_transfer ${transfer.id} (manual)`);
      await this.appendWiseIncomeRow(bankTx, transfer);
    } else if (target.type === 'invoice') {
      const invoice = await this.db
        .selectFrom('invoice')
        .selectAll()
        .where('id', '=', target.targetId)
        .executeTakeFirst();
      if (!invoice) {
        throw new Error(`invoice ${target.targetId} not found`);
      }
      await this.persistInvoiceMatch(bankTxId, invoice.id, MatchConfidence.Manual);
      this.logger.log(`bank_tx ${bankTxId} → invoice ${invoice.id} (manual)`);
      await this.appendIncomeRow(bankTx, invoice);
    } else {
      const expense = await this.db
        .selectFrom('expense')
        .selectAll()
        .where('id', '=', target.targetId)
        .executeTakeFirst();
      if (!expense) {
        throw new Error(`expense ${target.targetId} not found`);
      }
      await this.persistExpenseMatch(bankTxId, expense.id, MatchConfidence.Manual);
      this.logger.log(`bank_tx ${bankTxId} → expense ${expense.id} (manual)`);
      // Bank-tx match is the canonical kasstelsel money-out signal — this
      // is where the sheet row fires for expenses. Approval (in the admin
      // UI) intentionally does NOT write a sheet row anymore. If the
      // expense was still pending_review, the match implicitly approves
      // it. Rejected expenses are skipped (a tombstone shouldn't end up
      // on the books).
      if (expense.status !== ExpenseStatus.Rejected) {
        if (expense.status === ExpenseStatus.PendingReview) {
          const now = new Date();
          await this.db
            .updateTable('expense')
            .set({ status: ExpenseStatus.Approved, reviewedAt: now, updatedAt: now })
            .where('id', '=', expense.id)
            .execute();
        }
        const txDate = bankTx.txDate instanceof Date ? bankTx.txDate : new Date(bankTx.txDate);
        try {
          await this.sheetWriter.writeExpenseRow(expenseToSheetRow(expense, txDate));
          await this.markExpenseSheetRowAt(expense.id);
        } catch (error) {
          const message = (error as Error).message;
          this.logger.error(`Sheet write failed for expense ${expense.id}: ${message}`);
          await this.recordSheetWriteFailure({
            kind: 'expense',
            bankTxId: bankTx.id,
            identifier: expense.paperlessDocId,
            message,
          });
        }
      }
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

  /** Operator unlink: clears all match fields. Sheet rows aren't rewound. */
  async clearMatch(bankTxId: string): Promise<BankTransaction> {
    await this.db
      .updateTable('bank_transaction')
      .set({
        matchedInvoiceId: null,
        matchedTransferId: null,
        matchedExpenseId: null,
        matchedAt: null,
        matchConfidence: null,
        updatedAt: new Date(),
      })
      .where('id', '=', bankTxId)
      .execute();
    const refreshed = await this.bankTransactionRepository.findById(bankTxId);
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

  private async persistTransferMatch(bankTxId: string, transferId: string, confidence: MatchConfidence) {
    await this.db
      .updateTable('bank_transaction')
      .set({
        matchedInvoiceId: null,
        matchedExpenseId: null,
        matchedTransferId: transferId,
        matchedAt: new Date(),
        matchConfidence: confidence,
        category: null,
        updatedAt: new Date(),
      })
      .where('id', '=', bankTxId)
      .execute();
  }

  private async persistInvoiceMatch(bankTxId: string, invoiceId: string, confidence: MatchConfidence) {
    await this.db
      .updateTable('bank_transaction')
      .set({
        matchedTransferId: null,
        matchedExpenseId: null,
        matchedInvoiceId: invoiceId,
        matchedAt: new Date(),
        matchConfidence: confidence,
        category: null,
        updatedAt: new Date(),
      })
      .where('id', '=', bankTxId)
      .execute();
  }

  private async persistExpenseMatch(bankTxId: string, expenseId: string, confidence: MatchConfidence) {
    await this.db
      .updateTable('bank_transaction')
      .set({
        matchedTransferId: null,
        matchedInvoiceId: null,
        matchedExpenseId: expenseId,
        matchedAt: new Date(),
        matchConfidence: confidence,
        category: null,
        updatedAt: new Date(),
      })
      .where('id', '=', bankTxId)
      .execute();
  }
}

// Reference sql to avoid unused-import warning if Kysely's strict-mode trips.
void sql;

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

function absBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function toDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value);
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 24 * 60 * 60 * 1000);
}

