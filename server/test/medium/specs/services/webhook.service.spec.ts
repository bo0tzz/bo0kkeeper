import { Kysely } from 'kysely';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { EventSource } from 'src/enum';
import { EventRepository } from 'src/repositories/event.repository';
import { DB } from 'src/schema';
import { WebhookService } from 'src/services/webhook.service';
import { getKyselyDB } from 'test/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const FIXTURES = resolve(process.cwd(), 'test/fixtures/wise');

async function loadFixture(name: string) {
  const raw = await readFile(resolve(FIXTURES, name), 'utf8');
  return { raw, parsed: JSON.parse(raw) };
}

describe('WebhookService — Wise ingestion', () => {
  let db: Kysely<DB>;
  let eventRepository: EventRepository;
  let service: WebhookService;

  beforeEach(async () => {
    process.env.WISE_WEBHOOK_VERIFY = 'false';
    process.env.OIDC_ISSUER ??= 'http://idp.test';
    process.env.OIDC_CLIENT_ID ??= 'test-client';
    process.env.OIDC_REDIRECT_URI ??= 'http://localhost/callback';
    db = await getKyselyDB();
    eventRepository = new EventRepository(db);
    service = new WebhookService(eventRepository);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('ingests a Wise balance-credit fixture as an events row', async () => {
    const { parsed } = await loadFixture('balance-credit.example.json');

    const result = await service.ingestWiseEvent(parsed, 'delivery-test-1');
    expect(result.ingested).toBe(true);
    if (result.ingested) {
      expect(result.event.source).toBe(EventSource.Wise);
      expect(result.event.eventType).toBe('balances#credit');
      expect(result.event.externalId).toBe('delivery-test-1');
      expect(result.event.payload).toMatchObject({ event_type: 'balances#credit' });
    }
  });

  it('is idempotent on retry of the same delivery id', async () => {
    const { parsed } = await loadFixture('balance-credit.example.json');

    const first = await service.ingestWiseEvent(parsed, 'delivery-test-2');
    expect(first.ingested).toBe(true);

    const second = await service.ingestWiseEvent(parsed, 'delivery-test-2');
    expect(second.ingested).toBe(false);
  });

  it('falls back to a derived externalId when no delivery header is present', async () => {
    const { parsed } = await loadFixture('balance-credit.example.json');

    const result = await service.ingestWiseEvent(parsed);
    expect(result.ingested).toBe(true);
    if (result.ingested) {
      // Derived id has the form `subscription:event_type:sent_at:resource_id`
      expect(result.event.externalId).toContain('balances#credit');
    }
  });

  it('skipping signature verification logs a warning and returns void', () => {
    expect(() => service.verifyWiseSignature('any body')).not.toThrow();
  });
});
