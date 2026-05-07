import { Kysely } from 'kysely';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { EventSource, JobName } from 'src/enum';
import { EventRepository } from 'src/repositories/event.repository';
import { JobRepository } from 'src/repositories/job.repository';
import { DB } from 'src/schema';
import { WebhookService } from 'src/services/webhook.service';
import { getKyselyDB } from 'test/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const WISE_FIXTURES = resolve(process.cwd(), 'test/fixtures/wise');
const PAPERLESS_FIXTURES = resolve(process.cwd(), 'test/fixtures/paperless');

async function loadFixture(name: string, dir = WISE_FIXTURES) {
  const raw = await readFile(resolve(dir, name), 'utf8');
  return { raw, parsed: JSON.parse(raw) };
}

/** Stand-in for JobRepository — only `queue` is exercised. pg-boss never starts. */
function fakeJobRepo() {
  const queue = vi.fn().mockResolvedValue('fake-job-id');
  return { queue, queueAll: vi.fn(), setup: vi.fn() } as unknown as JobRepository & { queue: ReturnType<typeof vi.fn> };
}

describe('WebhookService — Wise ingestion', () => {
  let db: Kysely<DB>;
  let eventRepository: EventRepository;
  let jobRepository: JobRepository & { queue: ReturnType<typeof vi.fn> };
  let service: WebhookService;

  beforeEach(async () => {
    process.env.WISE_WEBHOOK_VERIFY = 'false';
    process.env.OIDC_ISSUER ??= 'http://idp.test';
    process.env.OIDC_CLIENT_ID ??= 'test-client';
    process.env.OIDC_REDIRECT_URI ??= 'http://localhost/callback';
    db = await getKyselyDB();
    eventRepository = new EventRepository(db);
    jobRepository = fakeJobRepo();
    service = new WebhookService(eventRepository, jobRepository);
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
    // balance-credit does NOT auto-enqueue (review queue is user-initiated).
    expect(jobRepository.queue).not.toHaveBeenCalled();
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

  it('auto-enqueues WiseTransferStateChange for transfers#state-change events', async () => {
    const { parsed } = await loadFixture('transfer-state-change.example.json');

    const result = await service.ingestWiseEvent(parsed, 'state-change-1');
    expect(result.ingested).toBe(true);
    expect(jobRepository.queue).toHaveBeenCalledOnce();
    if (result.ingested) {
      expect(jobRepository.queue).toHaveBeenCalledWith(JobName.WiseTransferStateChange, {
        eventId: result.event.id,
      });
    }
  });

  it('does not re-enqueue on duplicate delivery', async () => {
    const { parsed } = await loadFixture('transfer-state-change.example.json');

    await service.ingestWiseEvent(parsed, 'state-change-2');
    expect(jobRepository.queue).toHaveBeenCalledOnce();

    await service.ingestWiseEvent(parsed, 'state-change-2');
    expect(jobRepository.queue).toHaveBeenCalledOnce();
  });
});

describe('WebhookService — Paperless ingestion', () => {
  let db: Kysely<DB>;
  let eventRepository: EventRepository;
  let jobRepository: JobRepository & { queue: ReturnType<typeof vi.fn> };
  let service: WebhookService;

  beforeEach(async () => {
    process.env.WISE_WEBHOOK_VERIFY = 'false';
    process.env.OIDC_ISSUER ??= 'http://idp.test';
    process.env.OIDC_CLIENT_ID ??= 'test-client';
    process.env.OIDC_REDIRECT_URI ??= 'http://localhost/callback';
    delete process.env.PAPERLESS_WEBHOOK_TOKEN;
    db = await getKyselyDB();
    eventRepository = new EventRepository(db);
    jobRepository = fakeJobRepo();
    service = new WebhookService(eventRepository, jobRepository);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('ingests a paperless workflow webhook and enqueues ProcessPaperlessDocument', async () => {
    const { parsed } = await loadFixture('document-consumed.example.json', PAPERLESS_FIXTURES);

    const result = await service.ingestPaperlessEvent(parsed, 'paperless-delivery-1');

    expect(result.ingested).toBe(true);
    if (result.ingested) {
      expect(result.event.source).toBe(EventSource.Paperless);
      expect(result.event.eventType).toBe('document.consumed');
      expect(result.event.externalId).toBe('paperless-delivery-1');
    }
    expect(jobRepository.queue).toHaveBeenCalledOnce();
    if (result.ingested) {
      expect(jobRepository.queue).toHaveBeenCalledWith(JobName.ProcessPaperlessDocument, {
        eventId: result.event.id,
      });
    }
  });

  it('falls back to a derived externalId keyed on document_id when no header is present', async () => {
    const { parsed } = await loadFixture('document-consumed.example.json', PAPERLESS_FIXTURES);

    const result = await service.ingestPaperlessEvent(parsed);
    expect(result.ingested).toBe(true);
    if (result.ingested) {
      expect(result.event.externalId).toBe('paperless:4242');
    }
  });

  it('is idempotent on retry of the same paperless delivery', async () => {
    const { parsed } = await loadFixture('document-consumed.example.json', PAPERLESS_FIXTURES);

    const first = await service.ingestPaperlessEvent(parsed, 'pdelivery-2');
    expect(first.ingested).toBe(true);
    expect(jobRepository.queue).toHaveBeenCalledOnce();

    const second = await service.ingestPaperlessEvent(parsed, 'pdelivery-2');
    expect(second.ingested).toBe(false);
    expect(jobRepository.queue).toHaveBeenCalledOnce();
  });

  it('skips authorization with a warning when no token is configured', () => {
    expect(() => service.verifyPaperlessAuthorization()).not.toThrow();
    expect(() => service.verifyPaperlessAuthorization('Bearer anything')).not.toThrow();
  });

  it('rejects mismatched bearer token when configured', () => {
    process.env.PAPERLESS_WEBHOOK_TOKEN = 'shared-secret';
    const guardedService = new WebhookService(eventRepository, jobRepository);
    expect(() => guardedService.verifyPaperlessAuthorization('Bearer wrong')).toThrow(/Invalid Paperless/);
    expect(() => guardedService.verifyPaperlessAuthorization()).toThrow(/Invalid Paperless/);
    expect(() => guardedService.verifyPaperlessAuthorization('Bearer shared-secret')).not.toThrow();
  });
});
