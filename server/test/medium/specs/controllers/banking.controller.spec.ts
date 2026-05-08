import { BadRequestException } from '@nestjs/common';
import type { Response } from 'express';
import { Kysely } from 'kysely';
import { BankingController } from 'src/controllers/banking.controller';
import { BankingSessionStatus, BankSource, JobName, MatchConfidence, WiseTransferDirection, WiseTransferState } from 'src/enum';
import { BankTransactionRepository } from 'src/repositories/bank-transaction.repository';
import { BankingSessionRepository } from 'src/repositories/banking-session.repository';
import { ClientRepository } from 'src/repositories/client.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { JobRepository } from 'src/repositories/job.repository';
import { DB } from 'src/schema';
import { BankMatcherService } from 'src/services/bank-matcher.service';
import { BankingSessionService } from 'src/services/banking-session.service';
import { SheetWriterService } from 'src/services/sheet-writer.service';
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
  let bankTxRepo: BankTransactionRepository;
  let service: BankingSessionService;
  let jobRepo: JobRepository & { queue: ReturnType<typeof vi.fn> };
  let controller: BankingController;

  beforeEach(async () => {
    db = await getKyselyDB();
    repo = new BankingSessionRepository(db);
    bankTxRepo = new BankTransactionRepository(db);
    service = {
      startAuth: vi.fn(),
      completeCallback: vi.fn(),
      sweepStalePending: vi.fn(),
    } as unknown as BankingSessionService;
    jobRepo = {
      queue: vi.fn().mockResolvedValue('fake-job-id'),
    } as unknown as JobRepository & { queue: ReturnType<typeof vi.fn> };
    const clientRepo = new ClientRepository(db);
    const sheetWriter = { writeIncomeRow: vi.fn().mockResolvedValue(void 0) } as unknown as SheetWriterService;
    const matcher = new BankMatcherService(db, bankTxRepo, clientRepo, sheetWriter, new EventRepository(db));
    controller = new BankingController(service, repo, jobRepo, bankTxRepo, matcher, new EventRepository(db));
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
      {
        uid: 'acct-1',
        iban: 'NL01TEST',
        currency: 'EUR',
        name: 'Business',
        product: 'Current',
        balance: null,
        expectedBalanceMinor: null,
        balanceDiscrepancyMinor: null,
      },
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

  it('GET /match-candidates without a query returns recent items of each type', async () => {
    const result = await controller.matchCandidates();
    expect(result).toEqual({ transfers: [], invoices: [], expenses: [] });
  });

  it('PUT /transactions/:id/match links a wise_transfer with confidence=manual', async () => {
    const tx = await db
      .insertInto('bank_transaction')
      .values({
        source: BankSource.EnableBanking,
        externalId: 'ctrl-link-1',
        txDate: new Date('2026-05-07'),
        amountMinor: 50_000n,
        currency: 'EUR',
        description: 'no reference here',
        rawPayload: {},
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const transfer = await db
      .insertInto('wise_transfer')
      .values({
        wiseTransferId: 'WISE-MANUAL-1',
        direction: WiseTransferDirection.Out,
        sourceAmountMinor: 60_000n,
        sourceCurrency: 'USD',
        targetAmountMinor: 50_000n,
        targetCurrency: 'EUR',
        feeMinor: 0n,
        feeCurrency: 'USD',
        state: WiseTransferState.OutgoingPaymentSent,
        stateUpdatedAt: new Date(),
        ourReference: 'TXN-9999',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const result = await controller.setMatch(tx.id, { type: 'wise_transfer', targetId: transfer.id });
    expect(result.matchedTransferId).toBe(transfer.id);
    expect(result.matchConfidence).toBe('manual');
  });

  it('DELETE /transactions/:id/match clears all match fields', async () => {
    const tx = await db
      .insertInto('bank_transaction')
      .values({
        source: BankSource.EnableBanking,
        externalId: 'ctrl-link-2',
        txDate: new Date('2026-05-07'),
        amountMinor: 50_000n,
        currency: 'EUR',
        description: '',
        rawPayload: {},
        matchedTransferId: null,
        matchedAt: new Date(),
        matchConfidence: MatchConfidence.AutoHigh,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const result = await controller.clearMatch(tx.id);
    expect(result.matchedAt).toBeNull();
    expect(result.matchConfidence).toBeNull();
  });

  it('GET /transactions returns recent rows mapped into a serializable DTO', async () => {
    await bankTxRepo.ingest({
      source: BankSource.EnableBanking,
      externalId: 'ctrl-tx-1',
      txDate: new Date('2026-05-07'),
      amountMinor: 12_345n,
      currency: 'EUR',
      counterpartyName: 'ACME B.V.',
      counterpartyIban: 'NL01TEST',
      description: 'Test row',
      rawPayload: {},
    });
    const result = await controller.listTransactions();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      externalId: 'ctrl-tx-1',
      amountMinor: '12345',
      currency: 'EUR',
      counterpartyName: 'ACME B.V.',
      txDate: '2026-05-07',
      matchedTransferId: null,
    });
  });
});
