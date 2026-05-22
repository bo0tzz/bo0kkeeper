import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Config, loadConfig } from 'src/config';
import { OnJob } from 'src/decorators';
import { BankingSessionStatus, EventSource, JobName, QueueName } from 'src/enum';
import { BankingSession, BankingSessionRepository } from 'src/repositories/banking-session.repository';
import { EnableBankingAccount, EnableBankingRepository } from 'src/repositories/enable-banking.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { JobRepository } from 'src/repositories/job.repository';

/**
 * Drives the PSD2 consent flow against Enable Banking. Two entry points:
 *
 * - `startAuth` — admin clicks "Connect bank". We mint an `oauthState` UUID,
 *   persist a pending row, and call `/auth` to get the bank's SCA redirect.
 * - `completeCallback` — bank redirects back with `code` + `state`. We match
 *   the pending row by state, exchange the code for a session, and persist
 *   the resulting session id + accounts list.
 *
 * Pending rows older than 1h get garbage-collected to expired by a periodic
 * sweep; abandoned auths shouldn't accumulate in the table forever.
 */

export type StartAuthInput = {
  /** ASPSP name from `/aspsps`, e.g. `"Mock ASPSP"` (dev) or `"SNS Bank"` (prod). */
  aspspName: string;
  aspspCountry: string;
  psuType?: 'personal' | 'business';
};

export type StartAuthResult = {
  sessionId: string;
  /** URL to redirect the user to. UI does `window.location = redirectUrl`. */
  redirectUrl: string;
};

export type CompleteCallbackInput = {
  code: string;
  state: string;
};

@Injectable()
export class BankingSessionService {
  private readonly logger = new Logger(BankingSessionService.name);
  private readonly config: Config['enableBanking'];

  constructor(
    private readonly sessionRepository: BankingSessionRepository,
    private readonly apiService: EnableBankingRepository,
    private readonly jobRepository: JobRepository,
    private readonly eventRepository: EventRepository,
  ) {
    this.config = loadConfig().enableBanking;
  }

  async startAuth(input: StartAuthInput): Promise<StartAuthResult> {
    const redirectUri = this.requireRedirectUri();
    const psuType = input.psuType ?? 'personal';
    const oauthState = randomUUID();
    // PSD2 caps consent at 90 days; we always ask for the full window. The
    // bank may grant less and we trust whatever it returns in `valid_until`.
    const PSD2_MAX_CONSENT_DAYS = 90;
    const validUntil = new Date(Date.now() + PSD2_MAX_CONSENT_DAYS * 24 * 60 * 60 * 1000);

    // We only support one live bank at a time. Anything currently active or
    // pending gets marked expired before we mint the new pending row — that
    // way stale or stuck sessions don't pile up alongside the real one and
    // confuse the /banking UI's "latest session" view.
    const expired = await this.sessionRepository.expireAllLive();
    if (expired > 0) {
      this.logger.log(`Expired ${expired} prior live session(s) before starting new auth`);
    }

    const session = await this.sessionRepository.create({
      oauthState,
      aspspName: input.aspspName,
      aspspCountry: input.aspspCountry,
      psuType,
      status: BankingSessionStatus.Pending,
    });

    try {
      const auth = await this.apiService.startAuth({
        aspspName: input.aspspName,
        aspspCountry: input.aspspCountry,
        redirectUrl: redirectUri,
        state: oauthState,
        psuType,
        validUntil,
      });
      this.logger.log(`Started Enable Banking auth for ${input.aspspName} (session=${session.id})`);
      await this.eventRepository.recordAction({
        source: EventSource.Manual,
        eventType: 'banking.auth.started',
        payload: {
          sessionId: session.id,
          aspspName: input.aspspName,
          aspspCountry: input.aspspCountry,
          psuType,
          validUntil: validUntil.toISOString(),
        },
      });
      return { sessionId: session.id, redirectUrl: auth.url };
    } catch (error) {
      // Roll the pending row to expired so a retry mints a fresh state.
      await this.sessionRepository.update(session.id, { status: BankingSessionStatus.Expired });
      throw error;
    }
  }

  async completeCallback(input: CompleteCallbackInput): Promise<BankingSession> {
    const pending = await this.sessionRepository.findByOauthState(input.state);
    if (!pending) {
      throw new NotFoundException('No pending banking session for that state');
    }
    if (pending.status !== BankingSessionStatus.Pending) {
      throw new NotFoundException(`Session ${pending.id} is in state ${pending.status}, not pending`);
    }

    const session = await this.apiService.createSession(input.code);
    const updated = await this.sessionRepository.update(pending.id, {
      status: BankingSessionStatus.Active,
      applicationSessionId: session.sessionId,
      accountsJson: session.accounts as unknown as EnableBankingAccount[],
      expiresAt: new Date(session.validUntil),
    });
    this.logger.log(
      `Active banking session ${updated.id} (${updated.aspspName}) — ${session.accounts.length} account(s) shared, expires ${session.validUntil}`,
    );
    await this.eventRepository.recordAction({
      source: EventSource.Manual,
      eventType: 'banking.connected',
      payload: {
        sessionId: updated.id,
        aspspName: updated.aspspName,
        aspspCountry: updated.aspspCountry,
        applicationSessionId: updated.applicationSessionId,
        accountsCount: session.accounts.length,
        validUntil: session.validUntil,
      },
    });
    // Kick off an immediate sync so the user sees data on the /banking page
    // without having to click "Sync now". The cron picks up from there.
    await this.jobRepository.queue(JobName.BankingSyncAll, {});
    return updated;
  }

  /** Periodic GC: mark pending rows older than `cutoff` as expired. */
  async sweepStalePending(cutoff: Date = new Date(Date.now() - 60 * 60 * 1000)): Promise<number> {
    const n = await this.sessionRepository.expirePendingBefore(cutoff);
    if (n > 0) {
      this.logger.log(`Swept ${n} stale pending banking session(s)`);
    }
    return n;
  }

  @OnJob({ name: JobName.BankingSweepStalePending, queue: QueueName.Default })
  async handleSweepStalePending(): Promise<void> {
    await this.sweepStalePending();
  }

  private requireRedirectUri(): string {
    if (!this.config.redirectUri) {
      throw new Error('ENABLE_BANKING_REDIRECT_URI is not configured');
    }
    return this.config.redirectUri;
  }
}
