import { Kysely } from 'kysely';
import { BankingSessionStatus, JobName } from 'src/enum';
import { BankingSessionRepository } from 'src/repositories/banking-session.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { JobRepository } from 'src/repositories/job.repository';
import { DB } from 'src/schema';
import { BankingSessionService } from 'src/services/banking-session.service';
import {
  CreateSessionResult,
  EnableBankingApiService,
  StartAuthInput,
  StartAuthResult,
} from 'src/services/enable-banking-api.service';
import { getKyselyDB } from 'test/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  process.env.OIDC_ISSUER ??= 'http://idp.test';
  process.env.OIDC_CLIENT_ID ??= 'test';
  process.env.OIDC_REDIRECT_URI ??= 'http://localhost/callback';
  process.env.CUTOVER_DATE ??= '2000-01-01';
  process.env.ENABLE_BANKING_REDIRECT_URI = 'http://localhost:3000/api/banking/auth/callback';
  process.env.ENABLE_BANKING_CONSENT_DAYS = '90';
});

function fakeApi(): EnableBankingApiService & {
  startAuth: ReturnType<typeof vi.fn>;
  createSession: ReturnType<typeof vi.fn>;
} {
  return {
    startAuth: vi.fn(),
    createSession: vi.fn(),
  } as unknown as EnableBankingApiService & {
    startAuth: ReturnType<typeof vi.fn>;
    createSession: ReturnType<typeof vi.fn>;
  };
}

describe('BankingSessionService', () => {
  let db: Kysely<DB>;
  let repo: BankingSessionRepository;
  let api: ReturnType<typeof fakeApi>;
  let jobRepo: JobRepository & { queue: ReturnType<typeof vi.fn> };
  let service: BankingSessionService;

  beforeEach(async () => {
    db = await getKyselyDB();
    repo = new BankingSessionRepository(db);
    api = fakeApi();
    jobRepo = {
      queue: vi.fn().mockResolvedValue('fake-job-id'),
    } as unknown as JobRepository & { queue: ReturnType<typeof vi.fn> };
    service = new BankingSessionService(repo, api, jobRepo, new EventRepository(db));
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('startAuth creates a pending row, calls /auth with the right params, and returns the redirect URL', async () => {
    api.startAuth.mockResolvedValue({
      url: 'https://bank.test/sca?token=abc',
      authorizationId: 'auth-1',
    } satisfies StartAuthResult);

    const result = await service.startAuth({ aspspName: 'Mock ASPSP', aspspCountry: 'NL' });

    expect(result.redirectUrl).toBe('https://bank.test/sca?token=abc');
    const persisted = await repo.findById(result.sessionId);
    expect(persisted).toBeDefined();
    expect(persisted!.status).toBe(BankingSessionStatus.Pending);
    expect(persisted!.aspspName).toBe('Mock ASPSP');
    expect(persisted!.psuType).toBe('personal');
    expect(persisted!.applicationSessionId).toBeNull();

    expect(api.startAuth).toHaveBeenCalledOnce();
    const call = api.startAuth.mock.calls[0][0] as StartAuthInput;
    expect(call.aspspName).toBe('Mock ASPSP');
    expect(call.redirectUrl).toBe('http://localhost:3000/api/banking/auth/callback');
    expect(call.state).toBe(persisted!.oauthState);
    // 90-day window from CONSENT_DAYS=90.
    const days = (call.validUntil.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThan(91);
  });

  it('startAuth rolls the pending row to expired if the API call fails (no orphans)', async () => {
    api.startAuth.mockRejectedValue(new Error('upstream down'));

    await expect(service.startAuth({ aspspName: 'Mock ASPSP', aspspCountry: 'NL' })).rejects.toThrow(
      /upstream down/,
    );

    // No active sessions; the row landed in expired.
    expect(await repo.findActive()).toHaveLength(0);
    const latest = await repo.findLatest();
    expect(latest!.status).toBe(BankingSessionStatus.Expired);
  });

  it('completeCallback exchanges code for session, persists session id + accounts + expiry', async () => {
    api.startAuth.mockResolvedValue({
      url: 'https://bank.test/sca',
      authorizationId: 'auth-1',
    });
    const { sessionId } = await service.startAuth({ aspspName: 'Mock ASPSP', aspspCountry: 'NL' });
    const pending = await repo.findById(sessionId);

    api.createSession.mockResolvedValue({
      sessionId: 'eb-session-99',
      accounts: [
        { uid: 'acct-1', currency: 'EUR', name: 'Business' },
        { uid: 'acct-2', currency: 'EUR', name: 'Savings' },
      ],
      validUntil: '2026-08-06T12:00:00.000Z',
    } satisfies CreateSessionResult);

    const updated = await service.completeCallback({ code: 'cb-code', state: pending!.oauthState });

    expect(updated.status).toBe(BankingSessionStatus.Active);
    expect(updated.applicationSessionId).toBe('eb-session-99');
    expect(updated.expiresAt!.toISOString()).toBe('2026-08-06T12:00:00.000Z');
    expect(updated.accountsJson).toHaveLength(2);
    expect(api.createSession).toHaveBeenCalledWith('cb-code');
    expect(jobRepo.queue).toHaveBeenCalledWith(JobName.BankingSyncAll, {});
  });

  it('completeCallback rejects an unknown state', async () => {
    api.createSession.mockResolvedValue({
      sessionId: 'eb-session-x',
      accounts: [],
      validUntil: '2026-08-06T12:00:00.000Z',
    });

    await expect(
      service.completeCallback({ code: 'c', state: '00000000-0000-0000-0000-000000000000' }),
    ).rejects.toThrow(/No pending banking session/);
    expect(api.createSession).not.toHaveBeenCalled();
  });

  it('completeCallback refuses to re-use a non-pending row', async () => {
    api.startAuth.mockResolvedValue({ url: 'https://bank.test/sca', authorizationId: 'auth-1' });
    api.createSession.mockResolvedValue({
      sessionId: 'eb-1',
      accounts: [],
      validUntil: '2026-08-06T12:00:00.000Z',
    });
    const { sessionId } = await service.startAuth({ aspspName: 'Mock ASPSP', aspspCountry: 'NL' });
    const pending = await repo.findById(sessionId);
    await service.completeCallback({ code: 'c1', state: pending!.oauthState });

    // Replay attempt on the same state — already active.
    await expect(service.completeCallback({ code: 'c1', state: pending!.oauthState })).rejects.toThrow(
      /not pending/,
    );
    expect(api.createSession).toHaveBeenCalledOnce();
  });

  it('sweepStalePending expires pending rows older than the cutoff', async () => {
    api.startAuth.mockResolvedValue({ url: 'https://bank.test/sca', authorizationId: 'auth-1' });
    await service.startAuth({ aspspName: 'Mock ASPSP', aspspCountry: 'NL' });
    // Choose a future cutoff so the just-created pending row is "old".
    const future = new Date(Date.now() + 10_000);
    const swept = await service.sweepStalePending(future);
    expect(swept).toBe(1);
    const latest = await repo.findLatest();
    expect(latest!.status).toBe(BankingSessionStatus.Expired);
  });
});
