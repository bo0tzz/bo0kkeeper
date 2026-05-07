import { Kysely } from 'kysely';
import { EventSource, EventStatus, WiseTransferDirection, WiseTransferState } from 'src/enum';
import { EventRepository } from 'src/repositories/event.repository';
import { WiseTransferRepository } from 'src/repositories/wise-transfer.repository';
import { DB } from 'src/schema';
import { WiseEventService } from 'src/services/wise-event.service';
import { getKyselyDB } from 'test/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

beforeEach(() => {
  process.env.OIDC_ISSUER ??= 'http://idp.test';
  process.env.OIDC_CLIENT_ID ??= 'test';
  process.env.OIDC_REDIRECT_URI ??= 'http://localhost/callback';
});

const stateChangePayload = (transferId: string | number, currentState: string) => ({
  event_type: 'transfers#state-change',
  data: {
    resource: { id: transferId, type: 'transfer' },
    current_state: currentState,
    occurred_at: '2099-01-15T14:45:35Z',
  },
});

const seedTransfer = async (transferRepo: WiseTransferRepository, wiseTransferId: string) => {
  return transferRepo.create({
    wiseTransferId,
    direction: WiseTransferDirection.Out,
    sourceAmountMinor: 479_100n,
    sourceCurrency: 'USD',
    targetAmountMinor: 404_572n,
    targetCurrency: 'EUR',
    fxRate: '0.846991',
    feeMinor: 1442n,
    feeCurrency: 'USD',
    state: WiseTransferState.IncomingPaymentWaiting,
    stateUpdatedAt: new Date('2099-01-15T13:30:00Z'),
    ourReference: 'TXN-0044',
    counterpartyName: null,
    correlationId: null,
  });
};

describe('WiseEventService', () => {
  let db: Kysely<DB>;
  let eventRepo: EventRepository;
  let transferRepo: WiseTransferRepository;
  let service: WiseEventService;

  beforeEach(async () => {
    db = await getKyselyDB();
    eventRepo = new EventRepository(db);
    transferRepo = new WiseTransferRepository(db);
    service = new WiseEventService(eventRepo, transferRepo);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('applies transfers#state-change to the matching wise_transfer row', async () => {
    await seedTransfer(transferRepo, '9999999');
    const ingest = await eventRepo.ingest({
      source: EventSource.Wise,
      eventType: 'transfers#state-change',
      externalId: 'delivery-1',
      occurredAt: new Date('2099-01-15T14:45:35Z'),
      payload: stateChangePayload(9_999_999, 'outgoing_payment_sent'),
    });
    if (!ingest.ingested) {
      throw new Error('precondition');
    }

    await service.handleWiseTransferStateChange({ eventId: ingest.event.id });

    const updated = await transferRepo.findByWiseTransferId('9999999');
    expect(updated?.state).toBe('outgoing_payment_sent');

    const eventAfter = await eventRepo.findById(ingest.event.id);
    expect(eventAfter?.status).toBe(EventStatus.Processed);
  });

  it('skips events that are not transfers#state-change but still marks processed', async () => {
    const ingest = await eventRepo.ingest({
      source: EventSource.Wise,
      eventType: 'balances#credit',
      externalId: 'delivery-2',
      occurredAt: new Date(),
      payload: { foo: 'bar' },
    });
    if (!ingest.ingested) {
      throw new Error('precondition');
    }

    await service.handleWiseTransferStateChange({ eventId: ingest.event.id });

    const eventAfter = await eventRepo.findById(ingest.event.id);
    expect(eventAfter?.status).toBe(EventStatus.Processed);
  });

  it('logs and skips when no matching wise_transfer row exists', async () => {
    const ingest = await eventRepo.ingest({
      source: EventSource.Wise,
      eventType: 'transfers#state-change',
      externalId: 'delivery-3',
      occurredAt: new Date(),
      payload: stateChangePayload(7_777_777, 'processing'),
    });
    if (!ingest.ingested) {
      throw new Error('precondition');
    }

    await expect(service.handleWiseTransferStateChange({ eventId: ingest.event.id })).resolves.toBeUndefined();

    const eventAfter = await eventRepo.findById(ingest.event.id);
    expect(eventAfter?.status).toBe(EventStatus.Processed);
  });

  it('throws when the event id does not exist', async () => {
    await expect(
      service.handleWiseTransferStateChange({ eventId: '00000000-0000-0000-0000-000000000000' }),
    ).rejects.toThrow(/Event not found/);
  });
});
