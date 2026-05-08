import { Kysely } from 'kysely';
import { BankingSessionStatus, BankSource } from 'src/enum';
import { BankTransactionRepository } from 'src/repositories/bank-transaction.repository';
import { BankingSessionRepository } from 'src/repositories/banking-session.repository';
import { ClientRepository } from 'src/repositories/client.repository';
import { WiseTransferRepository } from 'src/repositories/wise-transfer.repository';
import { DB } from 'src/schema';
import { BankMatcherService } from 'src/services/bank-matcher.service';
import { BankingSyncService, mapTransaction } from 'src/services/banking-sync.service';
import {
  EnableBankingAccount,
  EnableBankingApiError,
  EnableBankingApiService,
  EnableBankingTransaction,
  ListTransactionsResult,
} from 'src/services/enable-banking-api.service';
import { SheetWriterService } from 'src/services/sheet-writer.service';
import { getKyselyDB } from 'test/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  process.env.OIDC_ISSUER ??= 'http://idp.test';
  process.env.OIDC_CLIENT_ID ??= 'test';
  process.env.OIDC_REDIRECT_URI ??= 'http://localhost/callback';
});

const ACC: EnableBankingAccount = { uid: 'acct-1', currency: 'EUR', name: 'Business' };

function tx(overrides: Partial<EnableBankingTransaction> = {}): EnableBankingTransaction {
  return {
    entryReference: 'tx-' + Math.random().toString(36).slice(2, 8),
    bookingDate: '2026-05-01',
    transactionAmount: { amount: '100.00', currency: 'EUR' },
    creditDebitIndicator: 'CRDT',
    debtorName: 'ACME B.V.',
    remittanceInformation: ['Invoice 2026/001'],
    ...overrides,
  };
}

function fakeApi(pages: ListTransactionsResult[]): EnableBankingApiService & {
  listTransactions: ReturnType<typeof vi.fn>;
} {
  let i = 0;
  const listTransactions = vi.fn().mockImplementation(() => {
    const page = pages[i] ?? { transactions: [], continuationKey: null };
    i += 1;
    return Promise.resolve(page);
  });
  return { listTransactions } as unknown as EnableBankingApiService & {
    listTransactions: ReturnType<typeof vi.fn>;
  };
}

describe('mapTransaction', () => {
  it('signs CRDT positive (money in) and pulls counterparty from debtor', () => {
    const row = mapTransaction(
      tx({
        entryReference: 'eb-1',
        creditDebitIndicator: 'CRDT',
        transactionAmount: { amount: '420.50', currency: 'EUR' },
        debtorName: 'Client X',
        debtorAccount: { iban: 'NL01CLNT' },
        creditorName: 'Should Not Use',
      }),
      ACC,
    );
    expect(row).not.toBeNull();
    expect(row!.source).toBe(BankSource.EnableBanking);
    expect(row!.externalId).toBe('eb-1');
    expect(row!.amountMinor).toBe(42_050n);
    expect(row!.counterpartyName).toBe('Client X');
    expect(row!.counterpartyIban).toBe('NL01CLNT');
    expect(row!.description).toBe('Invoice 2026/001');
  });

  it('signs DBIT negative (money out) and pulls counterparty from creditor', () => {
    const row = mapTransaction(
      tx({
        creditDebitIndicator: 'DBIT',
        transactionAmount: { amount: '50.25', currency: 'EUR' },
        creditorName: 'Vendor Y',
        creditorAccount: { iban: 'NL02VEND' },
      }),
      ACC,
    );
    expect(row!.amountMinor).toBe(-5025n);
    expect(row!.counterpartyName).toBe('Vendor Y');
    expect(row!.counterpartyIban).toBe('NL02VEND');
  });

  it('falls back to transactionId when entryReference is missing, drops if both absent', () => {
    expect(mapTransaction(tx({ entryReference: undefined, transactionId: 'tx-id-9' }), ACC)?.externalId).toBe(
      'tx-id-9',
    );
    expect(mapTransaction(tx({ entryReference: undefined }), ACC)).toBeNull();
  });
});

describe('BankingSyncService', () => {
  let db: Kysely<DB>;
  let sessionRepo: BankingSessionRepository;
  let bankRepo: BankTransactionRepository;
  let matcher: BankMatcherService;
  let api: ReturnType<typeof fakeApi>;
  let service: BankingSyncService;

  beforeEach(async () => {
    db = await getKyselyDB();
    sessionRepo = new BankingSessionRepository(db);
    bankRepo = new BankTransactionRepository(db);
    const clientRepo = new ClientRepository(db);
    const sheetWriter = { append: vi.fn().mockResolvedValue() } as unknown as SheetWriterService;
    matcher = new BankMatcherService(db, bankRepo, clientRepo, sheetWriter);
    api = fakeApi([]);
    service = new BankingSyncService(sessionRepo, bankRepo, api, matcher);
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function makeActiveSession(accounts: EnableBankingAccount[]): Promise<string> {
    const row = await sessionRepo.create({
      oauthState: '11111111-2222-4333-8444-' + Math.random().toString(16).slice(2, 14).padEnd(12, '0'),
      aspspName: 'Mock ASPSP',
      aspspCountry: 'NL',
      psuType: 'personal',
      status: BankingSessionStatus.Active,
      applicationSessionId: 'eb-' + Math.random().toString(36).slice(2, 8),
      accountsJson: accounts,
      expiresAt: new Date('2099-12-31'),
    });
    return row.id;
  }

  it('ingests new transactions across pagination and bumps lastSyncedAt', async () => {
    api.listTransactions.mockReset();
    api.listTransactions
      .mockResolvedValueOnce({
        transactions: [tx({ entryReference: 'p1-a' }), tx({ entryReference: 'p1-b' })],
        continuationKey: 'cursor-2',
      })
      .mockResolvedValueOnce({
        transactions: [tx({ entryReference: 'p2-a' })],
        continuationKey: null,
      });

    const sessionId = await makeActiveSession([ACC]);
    const session = (await sessionRepo.findById(sessionId))!;

    const result = await service.syncSession(session, {});

    expect(result.ingested).toBe(3);
    expect(api.listTransactions).toHaveBeenCalledTimes(2);
    const second = api.listTransactions.mock.calls[1][0] as { continuationKey?: string };
    expect(second.continuationKey).toBe('cursor-2');
    const refreshed = await sessionRepo.findById(sessionId);
    expect(refreshed!.lastSyncedAt).not.toBeNull();
  });

  it('deduplicates rows on retry — same externalId ingested twice → one row', async () => {
    const same = tx({ entryReference: 'dup-1' });
    api.listTransactions.mockResolvedValue({ transactions: [same], continuationKey: null });

    const sessionId = await makeActiveSession([ACC]);
    let session = (await sessionRepo.findById(sessionId))!;

    const first = await service.syncSession(session, {});
    expect(first.ingested).toBe(1);

    session = (await sessionRepo.findById(sessionId))!;
    const second = await service.syncSession(session, {});
    expect(second.ingested).toBe(0);
  });

  it('passes PSU-IP-Address through for online refreshes', async () => {
    api.listTransactions.mockResolvedValue({ transactions: [], continuationKey: null });
    const sessionId = await makeActiveSession([ACC]);
    const session = (await sessionRepo.findById(sessionId))!;

    await service.syncSession(session, { psuIpAddress: '203.0.113.7' });

    const call = api.listTransactions.mock.calls[0][0] as { psuIpAddress?: string };
    expect(call.psuIpAddress).toBe('203.0.113.7');
  });

  it('on a 401 marks the session revoked and stops syncing further accounts', async () => {
    api.listTransactions.mockReset();
    api.listTransactions.mockRejectedValueOnce(
      new EnableBankingApiError(401, { error: 'AUTHORIZATION_FAILED' }, 'forbidden'),
    );
    const sessionId = await makeActiveSession([ACC, { ...ACC, uid: 'acct-2' }]);
    const session = (await sessionRepo.findById(sessionId))!;

    await service.syncSession(session, {});

    expect(api.listTransactions).toHaveBeenCalledOnce();
    const refreshed = await sessionRepo.findById(sessionId);
    expect(refreshed!.status).toBe(BankingSessionStatus.Revoked);
  });

  it('matches new tx against an existing wise_transfer via TXN-NNNN reference', async () => {
    // Stage a wise_transfer the matcher can latch onto.
    const wiseRepo = new WiseTransferRepository(db);
    await wiseRepo.create({
      wiseTransferId: 'WISE-TEST-1',
      direction: 'out',
      sourceAmountMinor: 500_000n,
      sourceCurrency: 'USD',
      targetAmountMinor: 423_132n,
      targetCurrency: 'EUR',
      feeMinor: 0n,
      feeCurrency: 'USD',
      state: 'outgoing_payment_sent',
      stateUpdatedAt: new Date(),
      ourReference: 'TXN-0046',
    });

    api.listTransactions.mockResolvedValue({
      transactions: [
        tx({
          entryReference: 'eb-match',
          remittanceInformation: ['Wise transfer TXN-0046 from Acme'],
        }),
      ],
      continuationKey: null,
    });

    const sessionId = await makeActiveSession([ACC]);
    const session = (await sessionRepo.findById(sessionId))!;
    const result = await service.syncSession(session, {});

    expect(result.ingested).toBe(1);
    expect(result.matched).toBe(1);
  });
});
