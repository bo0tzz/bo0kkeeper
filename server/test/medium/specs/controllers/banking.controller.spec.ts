import { BadRequestException } from '@nestjs/common';
import type { Response } from 'express';
import { Kysely } from 'kysely';
import { BankingController } from 'src/controllers/banking.controller';
import { BankingSessionStatus, JobName } from 'src/enum';
import { BankingSessionRepository } from 'src/repositories/banking-session.repository';
import { JobRepository } from 'src/repositories/job.repository';
import { DB } from 'src/schema';
import { BankingSessionService } from 'src/services/banking-session.service';
import { getKyselyDB } from 'test/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  process.env.OIDC_ISSUER ??= 'http://idp.test';
  process.env.OIDC_CLIENT_ID ??= 'test';
  process.env.OIDC_REDIRECT_URI ??= 'http://localhost/callback';
  process.env.ENABLE_BANKING_REDIRECT_URI = 'http://localhost:3000/api/banking/auth/callback';
  process.env.ENABLE_BANKING_CONSENT_DAYS = '90';
});

function fakeRes(): Response & { redirected?: { status: number; url: string } } {
  const res: Partial<Response> & { redirected?: { status: number; url: string } } = {};
  res.redirect = vi.fn().mockImplementation((status: number, url: string) => {
    res.redirected = { status, url };
    return res as Response;
  }) as Response['redirect'];
  return res as Response & { redirected?: { status: number; url: string } };
}

describe('BankingController', () => {
  let db: Kysely<DB>;
  let repo: BankingSessionRepository;
  let service: BankingSessionService;
  let jobRepo: JobRepository & { queue: ReturnType<typeof vi.fn> };
  let controller: BankingController;

  beforeEach(async () => {
    db = await getKyselyDB();
    repo = new BankingSessionRepository(db);
    service = {
      startAuth: vi.fn(),
      completeCallback: vi.fn(),
      sweepStalePending: vi.fn(),
    } as unknown as BankingSessionService;
    jobRepo = {
      queue: vi.fn().mockResolvedValue('fake-job-id'),
    } as unknown as JobRepository & { queue: ReturnType<typeof vi.fn> };
    controller = new BankingController(service, repo, jobRepo);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('GET /session returns null when there is no session', async () => {
    expect(await controller.getLatestSession()).toBeNull();
  });

  it('GET /session returns a DTO mapping accountsJson into a typed accounts array', async () => {
    await repo.create({
      oauthState: '11111111-2222-4333-8444-555555555555',
      aspspName: 'Mock ASPSP',
      aspspCountry: 'NL',
      psuType: 'personal',
      status: BankingSessionStatus.Active,
      applicationSessionId: 'eb-1',
      expiresAt: new Date('2026-08-06T12:00:00Z'),
      accountsJson: [
        { uid: 'acct-1', currency: 'EUR', name: 'Business', iban: 'NL01TEST', product: 'Current' },
      ],
    });

    const dto = await controller.getLatestSession();
    expect(dto).not.toBeNull();
    expect(dto!.status).toBe(BankingSessionStatus.Active);
    expect(dto!.expiresAt).toBe('2026-08-06T12:00:00.000Z');
    expect(dto!.accounts).toEqual([
      { uid: 'acct-1', iban: 'NL01TEST', currency: 'EUR', name: 'Business', product: 'Current' },
    ]);
  });

  it('GET /auth/callback redirects to /banking on success after exchanging the code', async () => {
    const res = fakeRes();
    await controller.callback('cb-code', 'state-xyz', undefined, res);
    expect(service.completeCallback).toHaveBeenCalledWith({ code: 'cb-code', state: 'state-xyz' });
    expect(res.redirected).toEqual({ status: 302, url: '/banking' });
  });

  it('GET /auth/callback redirects to /banking with the error param if the bank returned one', async () => {
    const res = fakeRes();
    await controller.callback(undefined, undefined, 'access_denied', res);
    expect(service.completeCallback).not.toHaveBeenCalled();
    expect(res.redirected).toEqual({ status: 302, url: '/banking?error=access_denied' });
  });

  it('GET /auth/callback rejects when neither code+state nor error are present', async () => {
    const res = fakeRes();
    await expect(controller.callback(undefined, undefined, undefined, res)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('POST /sync enqueues BankingSyncAll with the caller IP for PSU-IP-Address', async () => {
    const result = await controller.sync('203.0.113.42');
    expect(result).toEqual({ enqueued: true });
    expect(jobRepo.queue).toHaveBeenCalledWith(JobName.BankingSyncAll, { psuIpAddress: '203.0.113.42' });
  });
});
