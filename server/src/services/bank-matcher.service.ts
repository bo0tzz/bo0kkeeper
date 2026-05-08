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

  /**
   * Operator-driven match. Sets exactly one of the matched* FKs (clearing the
   * others), marks confidence=manual, and runs the same sheet-append we'd run
   * on an auto-match — manual matches earn the same sheet row treatment.
   *
   * Returns the updated row so the UI can refresh in place.
   */
  /**
   * Recent things the user might want to manually link a bank tx to. Each
   * group is filtered by an optional free-text query (case-insensitive
   * substring match against the most useful identifier of that type) and
   * capped to keep the response small. The UI groups them by type for the
   * link modal.
   */
  async findMatchCandidates(query: string | undefined, limit = 20): Promise<MatchCandidates> {
    const q = query?.trim().toLowerCase();
    const like = q ? `%${q}%` : null;

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
      return qb.execute();
    })();

    const expenses = await (() => {
      let qb = this.db
        .selectFrom('expense')
        .select(['id', 'vendor', 'amountMinor', 'currency', 'expenseDate', 'status'])
        .orderBy('expenseDate', 'desc')
        .limit(limit);
      if (like) {
        qb = qb.where(eb => eb(eb.fn<string>('lower', ['vendor']), 'like', like));
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
    }

    const refreshed = await this.bankTransactionRepository.findById(bankTxId);
    if (!refreshed) {
      throw new Error(`bank_transaction ${bankTxId} disappeared after match`);
    }
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
        updatedAt: new Date(),
      })
      .where('id', '=', bankTxId)
      .execute();
  }
}

// Reference sql to avoid unused-import warning if Kysely's strict-mode trips.
void sql;
