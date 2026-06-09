import { Injectable, Logger } from '@nestjs/common';
import { Kysely } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { OnJob } from 'src/decorators';
import { ClientClass, EventSource, ExpenseStatus, JobName, MatchConfidence, QueueName } from 'src/enum';
import { BankTransaction } from 'src/repositories/bank-transaction.repository';
import { ClientRepository } from 'src/repositories/client.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { Expense } from 'src/repositories/expense.repository';
import { InvoiceRepository } from 'src/repositories/invoice.repository';
import { DB } from 'src/schema';
import { expenseToSheetRow, SheetWriterService } from 'src/services/sheet-writer.service';
import { JobOf } from 'src/types';
import { toDate } from 'src/utils/date';
import { absMinor } from 'src/utils/money';

/**
 * Owns the accountant-sheet side of bank matching: composing + appending the
 * income/expense rows once a bank_transaction has been linked, and the hourly
 * retry that closes the loop after a sheet outage.
 *
 * Split out of BankMatcherService so the matcher concerns itself only with
 * *deciding* a match; this service handles the (best-effort, never-blocking)
 * write of that decision to the sheet. Every append is best-effort: a sheets
 * outage or missing service-account config must not block the match itself —
 * the row is still persisted and visible in the admin UI, and `sheetRowAt`
 * stays null so the retry job picks it up.
 */
@Injectable()
export class SheetSyncService {
  private readonly logger = new Logger(SheetSyncService.name);

  constructor(
    @InjectKysely() private readonly db: Kysely<DB>,
    private readonly clientRepository: ClientRepository,
    private readonly invoiceRepository: InvoiceRepository,
    private readonly sheetWriter: SheetWriterService,
    private readonly eventRepository: EventRepository,
  ) {}

  /**
   * Append a sheet income row for the matched invoice. Best-effort.
   *
   * Date convention: the bank tx date is the kasstelsel "payment received"
   * date, which is what the sheet is keyed on.
   */
  async appendInvoiceIncomeRow(
    bankTx: BankTransaction,
    invoice: {
      clientId: string;
      number: string;
      btwRateBps: number | null;
      btwMinor: bigint | string | null;
    },
  ): Promise<void> {
    try {
      const client = await this.clientRepository.findById(invoice.clientId);
      if (!client) {
        this.logger.warn(`Skipping sheet write for invoice ${invoice.number}: client ${invoice.clientId} not found`);
        return;
      }
      const eurAmountMinor = absMinor(BigInt(bankTx.amountMinor as bigint | number | string));
      const vatPercent = invoice.btwRateBps == null ? undefined : `${invoice.btwRateBps / 100}%`;
      const vatMinor = invoice.btwMinor == null ? undefined : BigInt(invoice.btwMinor);
      await this.sheetWriter.writeIncomeRow({
        date: toDate(bankTx.txDate),
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
   * Append a sheet income row for a Wise-routed inbound payment (Non-EU).
   *
   * If the wise_transfer already has a composed invoice linked, use the
   * invoice number + that invoice's client — the proper bookkeeping path.
   * Otherwise fall back to TXN-NNNN as the row id + the unique Non-EU
   * client (or "Wise" placeholder), which keeps the kasstelsel row landing
   * on time even when the operator hasn't composed the invoice yet.
   */
  async appendWiseIncomeRow(
    bankTx: BankTransaction,
    transfer: { id: string; ourReference: string | null; targetCurrency: string },
  ): Promise<void> {
    try {
      const eurAmountMinor = absMinor(BigInt(bankTx.amountMinor as bigint | number | string));
      const invoice = await this.invoiceRepository.findByWiseTransferId(transfer.id);
      let invoiceNumber: string;
      let client: { name: string; class: ClientClass };
      if (invoice) {
        const invoiceClient = await this.clientRepository.findById(invoice.clientId);
        invoiceNumber = invoice.number;
        client = { name: invoiceClient?.name ?? 'Wise', class: ClientClass.NonEu };
      } else {
        const allClients = await this.clientRepository.findAll();
        const nonEuClients = allClients.filter((c) => c.class === ClientClass.NonEu);
        const nonEuClient = nonEuClients.length === 1 ? nonEuClients[0] : null;
        invoiceNumber = transfer.ourReference ?? '(no ref)';
        client = { name: nonEuClient?.name ?? 'Wise', class: ClientClass.NonEu };
      }
      await this.sheetWriter.writeIncomeRow({
        date: toDate(bankTx.txDate),
        invoiceNumber,
        eurAmountMinor,
        client,
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
   * Append the sheet expense row for a matched expense, marking `sheetRowAt`
   * on success and recording a `sheet.write_failed` audit event on failure.
   * Best-effort; returns whether the write succeeded (the retry job counts on
   * it). Consolidates the append/mark/catch sequence shared by the auto-fee,
   * manual-match, and retry paths.
   */
  async writeExpenseRowSafely(expense: Expense, date: Date, bankTxId: string): Promise<boolean> {
    try {
      await this.sheetWriter.writeExpenseRow(expenseToSheetRow(expense, date));
      await this.markExpenseSheetRowAt(expense.id);
      return true;
    } catch (error) {
      const message = (error as Error).message;
      this.logger.error(`Sheet write failed for expense ${expense.id}: ${message}`);
      await this.recordSheetWriteFailure({
        kind: 'expense',
        bankTxId,
        identifier: expense.paperlessDocId ?? expense.id,
        message,
      });
      return false;
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
      .where((eb) => eb.or([eb('matchedInvoiceId', 'is not', null), eb('matchedTransferId', 'is not', null)]))
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
          await this.appendInvoiceIncomeRow(bankTx, invoice);
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
      const txDate = toDate(row.bankTxDate);
      if (await this.writeExpenseRowSafely(row, txDate, row.bankTxId)) {
        succeeded += 1;
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
}
