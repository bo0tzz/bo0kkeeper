import { Kysely } from 'kysely';
import { EventSource, EventStatus } from 'src/enum';
import { EventRepository, NewEvent } from 'src/repositories/event.repository';
import { DB } from 'src/schema';
import { getKyselyDB } from 'test/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const fakeEvent = (overrides: Partial<NewEvent> = {}): NewEvent => ({
  source: EventSource.Wise,
  eventType: 'wise.balances.credit',
  externalId: 'wise-delivery-test-123',
  occurredAt: new Date('2026-04-14T13:26:00.000Z'),
  payload: { foo: 'bar' },
  ...overrides,
});

describe('EventRepository', () => {
  let db: Kysely<DB>;
  let repo: EventRepository;

  beforeEach(async () => {
    db = await getKyselyDB();
    repo = new EventRepository(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('ingests a new event and reports ingested:true', async () => {
    const result = await repo.ingest(fakeEvent());
    expect(result.ingested).toBe(true);
    if (result.ingested) {
      expect(result.event.source).toBe(EventSource.Wise);
      expect(result.event.externalId).toBe('wise-delivery-test-123');
      expect(result.event.status).toBe(EventStatus.Pending);
    }
  });

  it('returns ingested:false on duplicate (source + externalId)', async () => {
    const first = await repo.ingest(fakeEvent());
    expect(first.ingested).toBe(true);

    const second = await repo.ingest(fakeEvent());
    expect(second.ingested).toBe(false);
    if (!second.ingested && first.ingested) {
      expect(second.existingId).toBe(first.event.id);
    }
  });

  it('different externalId is not a duplicate', async () => {
    await repo.ingest(fakeEvent({ externalId: 'a' }));
    const second = await repo.ingest(fakeEvent({ externalId: 'b' }));
    expect(second.ingested).toBe(true);
  });

  it('different source is not a duplicate', async () => {
    await repo.ingest(fakeEvent());
    const second = await repo.ingest(fakeEvent({ source: EventSource.Bank }));
    expect(second.ingested).toBe(true);
  });

  it('findPending returns pending rows oldest-first', async () => {
    await repo.ingest(fakeEvent({ externalId: 'old', occurredAt: new Date('2026-04-13T00:00:00.000Z') }));
    await repo.ingest(fakeEvent({ externalId: 'new', occurredAt: new Date('2026-04-14T00:00:00.000Z') }));

    const pending = await repo.findPending();
    expect(pending).toHaveLength(2);
    expect(pending[0].externalId).toBe('old');
    expect(pending[1].externalId).toBe('new');
  });

  it('markProcessed flips status and stamps processedAt', async () => {
    const ingested = await repo.ingest(fakeEvent());
    if (!ingested.ingested) {
      throw new Error('precondition: expected ingest to succeed');
    }

    await repo.markProcessed(ingested.event.id);
    const after = await repo.findById(ingested.event.id);
    expect(after?.status).toBe(EventStatus.Processed);
    expect(after?.processedAt).toBeInstanceOf(Date);
  });

  it('markFailed increments attempts and records error', async () => {
    const ingested = await repo.ingest(fakeEvent());
    if (!ingested.ingested) {
      throw new Error('precondition: expected ingest to succeed');
    }

    await repo.markFailed(ingested.event.id, { message: 'boom' });
    const after = await repo.findById(ingested.event.id);
    expect(after?.status).toBe(EventStatus.Failed);
    expect(after?.attempts).toBe(1);
    expect(after?.lastError).toMatchObject({ message: 'boom' });
  });
});
