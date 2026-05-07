import { Injectable, Logger } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { MatchConfidence } from 'src/enum';
import { BankTransaction, BankTransactionRepository } from 'src/repositories/bank-transaction.repository';
import { DB } from 'src/schema';

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
        .select('id')
        .where('ourReference', '=', txnRef)
        .executeTakeFirst();
      if (transfer) {
        await this.persistTransferMatch(bankTx.id, transfer.id, MatchConfidence.AutoHigh);
        this.logger.log(`bank_tx ${bankTx.id} → wise_transfer ${transfer.id} via ${txnRef}`);
        return { matched: true, type: 'wise_transfer', transferId: transfer.id, confidence: MatchConfidence.AutoHigh };
      }
    }

    const invoiceNumber = INVOICE_NUMBER_PATTERN.exec(description)?.[0];
    if (invoiceNumber) {
      const invoice = await this.db
        .selectFrom('invoice')
        .select('id')
        .where('number', '=', invoiceNumber)
        .executeTakeFirst();
      if (invoice) {
        await this.persistInvoiceMatch(bankTx.id, invoice.id, MatchConfidence.AutoHigh);
        this.logger.log(`bank_tx ${bankTx.id} → invoice ${invoice.id} via ${invoiceNumber}`);
        return { matched: true, type: 'invoice', invoiceId: invoice.id, confidence: MatchConfidence.AutoHigh };
      }
    }

    return { matched: false, reason: 'no high-confidence signal' };
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
