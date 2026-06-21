import { Injectable, Logger } from '@nestjs/common';
import { OnJob } from 'src/decorators';
import { BankingSessionStatus, BankSource, EventSource, JobName, QueueName } from 'src/enum';
import { BankTransactionRepository, NewBankTransaction } from 'src/repositories/bank-transaction.repository';
import { BankingSession, BankingSessionRepository } from 'src/repositories/banking-session.repository';
import {
  EnableBankingAccount,
  EnableBankingApiError,
  EnableBankingRepository,
  EnableBankingTransaction,
} from 'src/repositories/enable-banking.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { BankMatcherService } from 'src/services/bank-matcher.service';
import { JobOf } from 'src/types';
import { checkCutover } from 'src/utils/cutover';
import { majorToMinor } from 'src/utils/money';

/**
 * Account row as we stash it in `banking_session.accountsJson` — the API
 * shape (uid + iban + name + …) plus tracking fields for self-reconciliation:
 *
 * - `balance`: most-recently-fetched API balance.
 * - `baseline`: the first balance we fetched, frozen as a trust anchor. The
 *   "expected" balance is derived as baseline + sum(bank_tx since baselineDate);
 *   if it diverges from the live `balance`, something has drifted (missing
 *   ingest, hand-edited row, etc.) and the UI surfaces it.
 */
type AccountWithBalance = EnableBankingAccount & {
  balance?: {
    amountMinor: string;
    currency: string;
    asOf: string;
  };
  baseline?: {
    amountMinor: string;
    currency: string;
    asOf: string;
  };
};

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
    private readonly apiService: EnableBankingRepository,
    private readonly matcher: BankMatcherService,
    private readonly eventRepository: EventRepository,
  ) {}

  @OnJob({ name: JobName.BankingSyncAll, queue: QueueName.Default })
  async handleSyncAll(data: JobOf<JobName.BankingSyncAll>): Promise<void> {
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
    this.logger.log(`banking sync: ${sessions.length} session(s), ${ingested} new tx, ${matched} matched`);
    await this.eventRepository.recordAction({
      source: EventSource.System,
      eventType: 'banking.sync.completed',
      payload: { sessions: sessions.length, ingested, matched, psuOnline: !!opts.psuIpAddress },
    });
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
    const accounts = (session.accountsJson ?? []) as AccountWithBalance[];
    let ingested = 0;
    let matched = 0;
    let isRevoked = false;
    for (const account of accounts) {
      try {
        const r = await this.syncAccount(session, account, opts);
        ingested += r.ingested;
        matched += r.matched;
        const balance = await this.refreshBalance(account, opts);
        if (balance) {
          const next = {
            amountMinor: String(balance.amountMinor),
            currency: balance.currency,
            asOf: balance.asOf,
          };
          account.balance = next;
          // First successful balance fetch becomes the baseline — the trust
          // anchor we measure drift against. Never overwritten afterwards.
          account.baseline ??= next;
        }
      } catch (error) {
        if (error instanceof EnableBankingApiError && (error.status === 401 || error.status === 403)) {
          this.logger.warn(
            `Session ${session.id} returned ${error.status}; marking revoked. Body: ${JSON.stringify(error.body)}`,
          );
          await this.sessionRepository.update(session.id, { status: BankingSessionStatus.Revoked });
          isRevoked = true;
          // No point trying the remaining accounts on this revoked session.
          break;
        }
        // Per-account failures are logged and shrugged off — next cron tick retries.
        this.logger.error(`account ${account.uid} sync failed in session ${session.id}: ${(error as Error).message}`);
      }
    }
    if (!isRevoked) {
      // Persist the (possibly balance-updated) accounts array alongside the
      // watermark; one write per session.
      await this.sessionRepository.update(session.id, {
        lastSyncedAt: new Date(),
        accountsJson: accounts as unknown[],
      });
    }
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
    let droppedBefore = 0;
    let droppedNoCutover = 0;
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
        const decision = checkCutover(new Date(newRow.txDate as Date));
        if (!decision.allowed) {
          if (decision.reason === 'before_cutover') {
            droppedBefore += 1;
            await this.eventRepository.recordAction({
              source: EventSource.System,
              eventType: 'ingest.dropped_before_cutover',
              payload: {
                droppedSource: BankSource.EnableBanking,
                droppedExternalId: String(newRow.externalId),
                droppedOccurredAt: new Date(newRow.txDate as Date).toISOString(),
              },
            });
          } else {
            droppedNoCutover += 1;
          }
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
    if (droppedBefore > 0) {
      this.logger.log(`account ${account.uid}: dropped ${droppedBefore} tx with txDate before cutover`);
    }
    if (droppedNoCutover > 0) {
      this.logger.warn(
        `account ${account.uid}: dropped ${droppedNoCutover} tx because CUTOVER_DATE is unset — set it in env to enable ingestion`,
      );
    }
    return { ingested, matched };
  }

  /**
   * Pull and persist the current balance for one account. Best-effort: a 429
   * (rate cap) or a Mock ASPSP without seeded balances is shrugged off; we
   * just don't update the cached value. Called from syncSession after the
   * transaction pull so the displayed balance reflects the freshly-ingested
   * tx.
   */
  private async refreshBalance(
    account: EnableBankingAccount,
    opts: { psuIpAddress?: string },
  ): Promise<{ amountMinor: bigint; currency: string; asOf: string } | null> {
    try {
      const balance = await this.apiService.getCurrentBalance(account.uid, opts.psuIpAddress);
      if (!balance) {
        return null;
      }
      return {
        amountMinor: balance.amountMinor,
        currency: balance.currency,
        // Prefer the bank-side reference_date when present — that's when the
        // balance was actually true at the ASPSP. Falling back to call-time
        // when missing would mask EB freshness lag (a stale balance returned
        // with a fresh "now" timestamp), so the previous behaviour silently
        // defeated drift diagnostics. Fall back only when EB literally
        // didn't supply a reference_date (some balance types omit it).
        asOf: balance.referenceDate ?? new Date().toISOString(),
      };
    } catch (error) {
      this.logger.warn(`balance refresh skipped for ${account.uid}: ${(error as Error).message}`);
      return null;
    }
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
  const amountMinor = sign * majorToMinor(tx.transaction_amount.amount);

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
