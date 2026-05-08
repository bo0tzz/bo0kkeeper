import { Injectable, Logger } from '@nestjs/common';
import { OnJob } from 'src/decorators';
import { BankingSessionStatus, BankSource, JobName, QueueName } from 'src/enum';
import {
  BankTransactionRepository,
  NewBankTransaction,
} from 'src/repositories/bank-transaction.repository';
import {
  BankingSession,
  BankingSessionRepository,
} from 'src/repositories/banking-session.repository';
import { BankMatcherService } from 'src/services/bank-matcher.service';
import { BankingSessionService } from 'src/services/banking-session.service';
import {
  EnableBankingAccount,
  EnableBankingApiError,
  EnableBankingApiService,
  EnableBankingTransaction,
} from 'src/services/enable-banking-api.service';
import { JobOf } from 'src/types';

/**
 * Pulls Enable Banking transactions for every active session, ingests them
 * into `bank_transaction`, then runs the existing matcher to link rows to
 * `wise_transfer` / `invoice`. Called by:
 *
 * - The pg-boss cron `banking.sync_all` (registered in AppModule, every 6h
 *   to stay under the PSD2 background-access cap of ~4 calls/day/account).
 * - The admin "Sync now" button, which passes the user's IP as
 *   `PSU-IP-Address`. That flags the call as user-online → exempt from the
 *   background cap.
 *
 * Per-account watermark: we use `session.lastSyncedAt` minus a 3-day cushion
 * as `date_from`. Late-arriving postings (banks back-date settlement) come
 * back on the next pull; the (source, externalId) unique index dedupes.
 */
@Injectable()
export class BankingSyncService {
  private readonly logger = new Logger(BankingSyncService.name);
  /** Days of overlap on each pull to catch back-dated postings. */
  private static readonly LOOKBACK_DAYS = 3;

  constructor(
    private readonly sessionRepository: BankingSessionRepository,
    private readonly bankTransactionRepository: BankTransactionRepository,
    private readonly apiService: EnableBankingApiService,
    private readonly matcher: BankMatcherService,
    private readonly sessionService: BankingSessionService,
  ) {}

  @OnJob({ name: JobName.BankingSyncAll, queue: QueueName.Default })
  async handleSyncAll(data: JobOf<JobName.BankingSyncAll>): Promise<void> {
    // GC abandoned-auth pendings (>1h old) before syncing. Cheap call; piggybacks
    // on the same cron tick so we don't need a separate scheduled job.
    await this.sessionService.sweepStalePending();
    await this.syncAllActive({ psuIpAddress: data?.psuIpAddress });
  }

  async syncAllActive(opts: { psuIpAddress?: string } = {}): Promise<{
    sessions: number;
    ingested: number;
    matched: number;
  }> {
    const sessions = await this.sessionRepository.findActive();
    let ingested = 0;
    let matched = 0;
    for (const session of sessions) {
      const result = await this.syncSession(session, opts);
      ingested += result.ingested;
      matched += result.matched;
    }
    this.logger.log(
      `banking sync: ${sessions.length} session(s), ${ingested} new tx, ${matched} matched`,
    );
    return { sessions: sessions.length, ingested, matched };
  }

  /**
   * Sync a single session. Returns counters; throws only on programming
   * errors (one bad account doesn't take down a sibling's sync).
   */
  async syncSession(
    session: BankingSession,
    opts: { psuIpAddress?: string },
  ): Promise<{ ingested: number; matched: number }> {
    if (session.status !== BankingSessionStatus.Active) {
      this.logger.warn(`Skipping non-active session ${session.id} (status=${session.status})`);
      return { ingested: 0, matched: 0 };
    }
    const accounts = (session.accountsJson ?? []) as EnableBankingAccount[];
    let ingested = 0;
    let matched = 0;
    for (const account of accounts) {
      try {
        const r = await this.syncAccount(session, account, opts);
        ingested += r.ingested;
        matched += r.matched;
      } catch (error) {
        if (error instanceof EnableBankingApiError && (error.status === 401 || error.status === 403)) {
          this.logger.warn(
            `Session ${session.id} returned ${error.status}; marking revoked. Body: ${JSON.stringify(error.body)}`,
          );
          await this.sessionRepository.update(session.id, { status: BankingSessionStatus.Revoked });
          // No point trying the remaining accounts on this revoked session.
          break;
        }
        // Per-account failures are logged and shrugged off — next cron tick retries.
        this.logger.error(
          `account ${account.uid} sync failed in session ${session.id}: ${(error as Error).message}`,
        );
      }
    }
    await this.sessionRepository.update(session.id, { lastSyncedAt: new Date() });
    return { ingested, matched };
  }

  private async syncAccount(
    session: BankingSession,
    account: EnableBankingAccount,
    opts: { psuIpAddress?: string },
  ): Promise<{ ingested: number; matched: number }> {
    const dateFrom = this.computeDateFrom(session);
    let cursor: string | undefined;
    let ingested = 0;
    let matched = 0;
    do {
      const page = await this.apiService.listTransactions({
        accountUid: account.uid,
        dateFrom,
        continuationKey: cursor,
        psuIpAddress: opts.psuIpAddress,
      });
      for (const tx of page.transactions) {
        const newRow = mapTransaction(tx, account);
        if (!newRow) {
          continue;
        }
        const result = await this.bankTransactionRepository.ingest(newRow);
        if (result.ingested) {
          ingested += 1;
          const match = await this.matcher.tryMatch(result.row);
          if (match.matched) {
            matched += 1;
          }
        }
      }
      cursor = page.continuationKey ?? undefined;
    } while (cursor);
    return { ingested, matched };
  }

  private computeDateFrom(session: BankingSession): string | undefined {
    if (!session.lastSyncedAt) {
      return undefined;
    }
    const watermark = new Date(session.lastSyncedAt);
    watermark.setUTCDate(watermark.getUTCDate() - BankingSyncService.LOOKBACK_DAYS);
    return formatYmd(watermark);
  }
}

function formatYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Map an Enable Banking transaction → `bank_transaction` insert. Returns
 * null when the API row lacks a stable id (defensive — Enable Banking
 * normalizes this already, but we'd rather drop than mint a fake id).
 *
 * Wire shape is snake_case with nested `creditor` / `debtor` objects; our
 * row shape is flat. We keep the raw payload around in `rawPayload` so any
 * fields we don't pull out are still available for audit.
 */
export function mapTransaction(
  tx: EnableBankingTransaction,
  _account: EnableBankingAccount,
): NewBankTransaction | null {
  const externalId = tx.entry_reference ?? tx.transaction_id;
  if (!externalId) {
    return null;
  }
  const sign = tx.credit_debit_indicator === 'CRDT' ? 1n : -1n;
  const amountMinor = sign * BigInt(Math.round(Number.parseFloat(tx.transaction_amount.amount) * 100));

  // CRDT (money in)  → counterparty is the *debtor* (the payer).
  // DBIT (money out) → counterparty is the *creditor* (the payee).
  const isIncoming = tx.credit_debit_indicator === 'CRDT';
  const counterpartyName = (isIncoming ? tx.debtor?.name : tx.creditor?.name) ?? null;
  const counterpartyIban = (isIncoming ? tx.debtor_account?.iban : tx.creditor_account?.iban) ?? null;

  return {
    source: BankSource.EnableBanking,
    externalId,
    txDate: new Date(tx.booking_date),
    amountMinor,
    currency: tx.transaction_amount.currency,
    counterpartyName,
    counterpartyIban,
    description: (tx.remittance_information ?? []).join(' ').trim(),
    rawPayload: tx as unknown as Record<string, unknown>,
  };
}
