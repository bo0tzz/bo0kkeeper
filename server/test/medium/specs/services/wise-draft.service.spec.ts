import { Kysely } from 'kysely';
import { EventSource, WiseTransferDirection } from 'src/enum';
import { EventRepository } from 'src/repositories/event.repository';
import { WiseTransferRepository } from 'src/repositories/wise-transfer.repository';
import { DB } from 'src/schema';
import { WiseApiRepository } from 'src/repositories/wise-api.repository';
import { WiseDraftService } from 'src/services/wise-draft.service';
import { getKyselyDB } from 'test/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const balanceCreditPayload = {
  event_type: 'balances#credit',
  data: {
    amount: 4791,
    currency: 'USD',
    occurred_at: '2099-01-15T13:26:00Z',
  },
};

beforeEach(() => {
  process.env.OIDC_ISSUER ??= 'http://idp.test';
  process.env.OIDC_CLIENT_ID ??= 'test';
  process.env.OIDC_REDIRECT_URI ??= 'http://localhost/callback';
  process.env.CUTOVER_DATE ??= '2000-01-01';
  process.env.WISE_API_BASE_URL = 'https://api.fake.wise';
  process.env.WISE_API_TOKEN = 'fake-token';
  process.env.WISE_PROFILE_ID = '12345';
  process.env.WISE_TARGET_RECIPIENT_ID = '67890';
});

describe('WiseDraftService', () => {
  let db: Kysely<DB>;
  let eventRepo: EventRepository;
  let transferRepo: WiseTransferRepository;
  let wiseApi: WiseApiRepository;
  let createQuoteMock: ReturnType<typeof vi.fn>;
  let createTransferMock: ReturnType<typeof vi.fn>;
  let service: WiseDraftService;

  beforeEach(async () => {
    db = await getKyselyDB();
    eventRepo = new EventRepository(db);
    transferRepo = new WiseTransferRepository(db);

    createQuoteMock = vi.fn().mockResolvedValue({
      id: 'quote-uuid-1',
      rate: '0.846991',
      feeMinor: 1442n,
      feeCurrency: 'USD',
      sourceAmountMinor: 479_100n,
      sourceCurrency: 'USD',
      targetAmountMinor: 404_572n,
      targetCurrency: 'EUR',
    });
    createTransferMock = vi.fn().mockResolvedValue({
      id: 9_999_999,
      state: 'incoming_payment_waiting',
      reference: 'TXN-0044',
      rate: '0.846991',
      sourceCurrency: 'USD',
      sourceValue: 4791,
      targetCurrency: 'EUR',
      targetValue: 4045.72,
    });

    wiseApi = new WiseApiRepository();
    wiseApi.createQuote = createQuoteMock;
    wiseApi.createTransfer = createTransferMock;

    service = new WiseDraftService(eventRepo, transferRepo, wiseApi);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('drafts a Wise transfer from an inbound credit event and persists wise_transfer', async () => {
    const ingest = await eventRepo.ingest({
      source: EventSource.Wise,
      eventType: 'balances#credit',
      externalId: 'delivery-1',
      occurredAt: new Date('2099-01-15T13:26:00Z'),
      payload: balanceCreditPayload,
    });
    if (!ingest.ingested) {
      throw new Error('precondition: expected ingest to succeed');
    }

    const row = await service.draftFromEvent({ eventId: ingest.event.id, ourReference: 'TXN-0044' });

    expect(createQuoteMock).toHaveBeenCalledWith({
      sourceCurrency: 'USD',
      targetCurrency: 'EUR',
      sourceAmountMinor: 479_100n,
    });
    expect(createTransferMock).toHaveBeenCalledWith({
      quoteId: 'quote-uuid-1',
      recipientId: 67_890,
      reference: 'TXN-0044',
    });

    expect(row.wiseTransferId).toBe('9999999');
    expect(row.direction).toBe(WiseTransferDirection.Out);
    expect(row.state).toBe('incoming_payment_waiting');
    expect(row.ourReference).toBe('TXN-0044');
    // Kysely + postgres-js return bigint columns as JS numbers when in safe range.
    expect(Number(row.sourceAmountMinor)).toBe(479_100);
    expect(Number(row.targetAmountMinor)).toBe(404_572);
    expect(row.sourceCurrency).toBe('USD');
    expect(row.targetCurrency).toBe('EUR');
    expect(row.fxRate).toBe('0.846991');
  });

  it('rejects events that are not Wise balance credits', async () => {
    const ingest = await eventRepo.ingest({
      source: EventSource.Bank,
      eventType: 'bank.transaction',
      externalId: 'bank-1',
      occurredAt: new Date(),
      payload: { foo: 'bar' },
    });
    if (!ingest.ingested) {
      throw new Error('precondition');
    }
    await expect(service.draftFromEvent({ eventId: ingest.event.id, ourReference: 'TXN-0044' })).rejects.toThrow(
      /not a Wise balance credit/,
    );
    expect(createQuoteMock).not.toHaveBeenCalled();
  });

  it('returns 404-style error for unknown eventId', async () => {
    await expect(
      service.draftFromEvent({
        eventId: '00000000-0000-0000-0000-000000000000',
        ourReference: 'TXN-0044',
      }),
    ).rejects.toThrow(/Event not found/);
  });

  it('auto-allocates a TXN reference from the sequence when omitted', async () => {
    const ingest = await eventRepo.ingest({
      source: EventSource.Wise,
      eventType: 'balances#credit',
      externalId: 'delivery-auto-ref',
      occurredAt: new Date('2099-01-15T13:26:00Z'),
      payload: balanceCreditPayload,
    });
    if (!ingest.ingested) {
      throw new Error('precondition');
    }

    const row = await service.draftFromEvent({ eventId: ingest.event.id });

    // Sequence starts at 44 in the seeded test DB.
    expect(row.ourReference).toBe('TXN-0044');
    expect(createTransferMock).toHaveBeenCalledWith(expect.objectContaining({ reference: 'TXN-0044' }));
  });
});
