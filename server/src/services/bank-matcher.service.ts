import { Injectable, Logger } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { ClientClass, MatchConfidence } from 'src/enum';
import { BankTransaction, BankTransactionRepository } from 'src/repositories/bank-transaction.repository';
import { ClientRepository } from 'src/repositories/client.repository';
import { DB } from 'src/schema';
import { SheetWriterService } from 'src/services/sheet-writer.service';

const TXN_REF_PATTERN = /\bTXN-\d{4,}\b/;
const INVOICE_NUMBER_PATTERN = /\b\d{4}\/\d{3}\b/;

export type MatchResult =
  | { matched: true; type: 'wise_transfer'; transferId: string; confidence: MatchConfidence }
  | { matched: true; type: 'invoice'; invoiceId: string; confidence: MatchConfidence }
  | { matched: false; reason: string };

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
 *
 * Lower-confidence heuristics (amount + counterparty + date proximity) are
 * future work — they map to MatchConfidence.AutoLow with a Manual override
 * path in the admin UI.
 */
@Injectable()
export class BankMatcherService {
  private readonly logger = new Logger(BankMatcherService.name);

  constructor(
    @InjectKysely() private readonly db: Kysely<DB>,
    private readonly bankTransactionRepository: BankTransactionRepository,
    private readonly clientRepository: ClientRepository,
    private readonly sheetWriter: SheetWriterService,
  ) {}

  async tryMatch(bankTx: BankTransaction): Promise<MatchResult> {
    if (bankTx.matchedAt) {
      return { matched: false, reason: 'already matched' };
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

    return { matched: false, reason: 'no high-confidence signal' };
  }

  /**
   * Append a sheet income row for the matched invoice. Best-effort: a sheets
   * outage or a missing service-account config must not block the match itself
   * (the row is still persisted and visible in the admin UI).
   *
   * Date convention: the bank tx date is the kasstelsel "payment received"
   * date, which is what the sheet is keyed on.
   */
  private async appendIncomeRow(bankTx: BankTransaction, invoice: { clientId: string; number: string }) {
    try {
      const client = await this.clientRepository.findById(invoice.clientId);
      if (!client) {
        this.logger.warn(`Skipping sheet write for invoice ${invoice.number}: client ${invoice.clientId} not found`);
        return;
      }
      const rawMinor = BigInt(bankTx.amountMinor as bigint | number | string);
      const eurAmountMinor = rawMinor < 0n ? -rawMinor : rawMinor;
      await this.sheetWriter.writeIncomeRow({
        date: bankTx.txDate instanceof Date ? bankTx.txDate : new Date(bankTx.txDate),
        invoiceNumber: invoice.number,
        eurAmountMinor,
        client: { name: client.name, class: client.class as ClientClass },
        from: bankTx.counterpartyName ?? client.name,
        source: `bank_tx/${bankTx.id}`,
      });
    } catch (error) {
      this.logger.error(`Sheet write failed for invoice ${invoice.number}: ${(error as Error).message}`);
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
        from: bankTx.counterpartyName ?? 'Wise',
        source: `wise_transfer/${transfer.id}`,
      });
    } catch (error) {
      this.logger.error(`Sheet write failed for wise_transfer ${transfer.id}: ${(error as Error).message}`);
    }
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
      .set({ matchedTransferId: transferId, matchedAt: new Date(), matchConfidence: confidence, updatedAt: new Date() })
      .where('id', '=', bankTxId)
      .execute();
  }

  private async persistInvoiceMatch(bankTxId: string, invoiceId: string, confidence: MatchConfidence) {
    await this.db
      .updateTable('bank_transaction')
      .set({ matchedInvoiceId: invoiceId, matchedAt: new Date(), matchConfidence: confidence, updatedAt: new Date() })
      .where('id', '=', bankTxId)
      .execute();
  }
}

// Reference sql to avoid unused-import warning if Kysely's strict-mode trips.
void sql;
