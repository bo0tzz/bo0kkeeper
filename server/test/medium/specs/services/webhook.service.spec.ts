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
    process.env.CUTOVER_DATE ??= '2000-01-01';
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

  // Reference body + signature from
  // https://github.com/transferwise/digital-signatures-examples/blob/main/verify-webhook-signature/verify-signature.js
  // — public test vector; lets us assert the verifier wires up the well-known
  // sandbox public key correctly without holding a private key.
  describe('with verification enabled (sandbox public key)', () => {
    const SANDBOX_PUB_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwpb91cEYuyJNQepZAVfP
ZIlPZfNUefH+n6w9SW3fykqKu938cR7WadQv87oF2VuT+fDt7kqeRziTmPSUhqPU
ys/V2Q1rlfJuXbE+Gga37t7zwd0egQ+KyOEHQOpcTwKmtZ81ieGHynAQzsn1We3j
wt760MsCPJ7GMT141ByQM+yW1Bx+4SG3IGjXWyqOWrcXsxAvIXkpUD/jK/L958Cg
nZEgz0BSEh0QxYLITnW1lLokSx/dTianWPFEhMC9BgijempgNXHNfcVirg1lPSyg
z7KqoKUN0oHqWLr2U1A+7kqrl6O2nx3CKs1bj1hToT1+p4kcMoHXA7kA+VBLUpEs
VwIDAQAB
-----END PUBLIC KEY-----`;
    const REF_BODY =
      '{"data":{"resource":{"id":49983981,"profile_id":16055450,"account_id":14124090,"type":"transfer"},"current_state":"incoming_payment_waiting","previous_state":null,"occurred_at":"2021-08-23T10:12:50Z"},"subscription_id":"90aa8e14-4ef1-4a56-861c-f3c9cde097ea","event_type":"transfers#state-change","schema_version":"2.0.0","sent_at":"2021-08-23T10:12:50Z"}';
    const REF_SIG =
      'wKcKCYXAzxNgiu7xmoDm943NUni7Rz33QN8JkEA9dWSGebgndonabgSj18Y4C08OrwVmueGsED2s00M7DtJVcYKOS1i3G4TMVx+mgM3aL9djMBkQtiYNBFUd6wrPI7ZUNHv/TrlKSjTMc+6JFvUvJ7owY3z85e3I4jLRLJowMFvO8kvCJ60+1pY9wDwZvtZ//WS93LrwGjk9Dvwzpmu0w+P4J75tETT5qC3Uv0y5G2yO8SEoO3yNP/tg/BOli02niHb53vEOUWUb9bly6thnfMoXoiV/osoGxgF20R58RlvkAmezyyl1Sv542TfS2DpiwVnmjjjkCyXeSUcKookYLQ==';

    let verifying: WebhookService;
    beforeEach(() => {
      process.env.WISE_WEBHOOK_VERIFY = 'true';
      process.env.WISE_WEBHOOK_PUBLIC_KEY = SANDBOX_PUB_KEY;
      verifying = new WebhookService(eventRepository, jobRepository);
    });

    it('accepts a valid signature for the reference body', () => {
      expect(() => verifying.verifyWiseSignature(REF_BODY, REF_SIG)).not.toThrow();
    });

    it('rejects when the body has been tampered with', () => {
      const tampered = REF_BODY.replace('"id":49983981', '"id":99999999');
      expect(() => verifying.verifyWiseSignature(tampered, REF_SIG)).toThrow(/Invalid Wise/);
    });

    it('rejects a corrupted signature', () => {
      const bad = `${REF_SIG.slice(0, -4)}AAA=`;
      expect(() => verifying.verifyWiseSignature(REF_BODY, bad)).toThrow(/Invalid Wise/);
    });

    it('rejects when the signature header is missing', () => {
      expect(() => verifying.verifyWiseSignature(REF_BODY)).toThrow(/Missing X-Signature/);
    });

    it('throws when verification is enabled but no key is configured', () => {
      process.env.WISE_WEBHOOK_PUBLIC_KEY = '';
      const unconfigured = new WebhookService(eventRepository, jobRepository);
      expect(() => unconfigured.verifyWiseSignature(REF_BODY, REF_SIG)).toThrow(/WISE_WEBHOOK_PUBLIC_KEY is not set/);
    });
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

  describe('cutover gate', () => {
    it('drops Wise events whose occurred_at is before CUTOVER_DATE', async () => {
      const { parsed } = await loadFixture('balance-credit.example.json');
      const oldEvent = { ...parsed, data: { ...parsed.data, occurred_at: '1999-12-31T00:00:00Z' } };
      process.env.CUTOVER_DATE = '2026-05-01';

      const result = await service.ingestWiseEvent(oldEvent, 'pre-cutover-1');
      expect(result.ingested).toBe(false);
      if (!result.ingested) {
        expect(result.reason).toBe('before_cutover');
      }
      expect(jobRepository.queue).not.toHaveBeenCalled();

      // The drop is audit-trailed as a system event so the dashboard counter
      // can surface it.
      const drops = await eventRepository.findMany({
        eventType: 'ingest.dropped_before_cutover',
        limit: 10,
        offset: 0,
      });
      expect(drops.total).toBe(1);
      expect(drops.items[0].source).toBe(EventSource.System);
      expect(drops.items[0].payload).toMatchObject({
        droppedSource: EventSource.Wise,
        droppedExternalId: 'pre-cutover-1',
      });

      // No row was inserted — the same delivery id ingested with a fresh
      // (post-cutover) date should succeed rather than 'duplicate'.
      const fresh = { ...parsed, data: { ...parsed.data, occurred_at: '2026-06-01T00:00:00Z' } };
      const second = await service.ingestWiseEvent(fresh, 'pre-cutover-1');
      expect(second.ingested).toBe(true);

      // Reset for the next test.
      process.env.CUTOVER_DATE = '2000-01-01';
    });

    it('refuses every Wise event when CUTOVER_DATE is unset, without audit-trailing it', async () => {
      const { parsed } = await loadFixture('balance-credit.example.json');
      const original = process.env.CUTOVER_DATE;
      delete process.env.CUTOVER_DATE;
      try {
        const result = await service.ingestWiseEvent(parsed, 'no-cutover-1');
        expect(result.ingested).toBe(false);
        if (!result.ingested) {
          expect(result.reason).toBe('no_cutover_configured');
        }
        // no_cutover_configured is shouted via the dashboard banner; no need
        // to bloat the events table with a drop event per webhook while in
        // setup mode.
        const drops = await eventRepository.findMany({
          eventType: 'ingest.dropped_before_cutover',
          limit: 10,
          offset: 0,
        });
        expect(drops.total).toBe(0);
      } finally {
        if (original !== undefined) {
          process.env.CUTOVER_DATE = original;
        }
      }
    });
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
    process.env.CUTOVER_DATE ??= '2000-01-01';
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

  // paperless v2.20.x exposes no id-shaped placeholder — the workflow can
  // only supply `{{doc_url}}`. The service peels the id off the URL tail
  // so the ingest path stays identical to the id-provided case.
  it('extracts the document id from document_url when no direct id field is present', async () => {
    const { parsed } = await loadFixture('document-consumed.example.json', PAPERLESS_FIXTURES);
    const { document_id: _omit, ...withoutId } = parsed;
    const urlOnly = { ...withoutId, document_url: 'https://paperless.test/documents/7777/' };

    const result = await service.ingestPaperlessEvent(urlOnly);
    expect(result.ingested).toBe(true);
    if (result.ingested) {
      expect(result.event.externalId).toBe('paperless:7777');
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

  describe('cutover gate', () => {
    it('drops paperless events whose created date is before CUTOVER_DATE', async () => {
      const { parsed } = await loadFixture('document-consumed.example.json', PAPERLESS_FIXTURES);
      const oldEvent = { ...parsed, created: '1999-06-15T00:00:00Z' };
      process.env.CUTOVER_DATE = '2026-05-01';

      const result = await service.ingestPaperlessEvent(oldEvent, 'pre-cutover-paperless-1');
      expect(result.ingested).toBe(false);
      if (!result.ingested) {
        expect(result.reason).toBe('before_cutover');
      }
      expect(jobRepository.queue).not.toHaveBeenCalled();

      process.env.CUTOVER_DATE = '2000-01-01';
    });
  });
});
