import { Kysely } from 'kysely';
import { EventSource, EventStatus, ExpenseLocationClass, ExpenseStatus } from 'src/enum';
import { EventRepository } from 'src/repositories/event.repository';
import { ExpenseRepository } from 'src/repositories/expense.repository';
import { PaperlessRepository } from 'src/repositories/paperless.repository';
import { DB } from 'src/schema';
import { ExpensePipelineService } from 'src/services/expense-pipeline.service';
import { SettingsService } from 'src/services/settings.service';
import { getKyselyDB } from 'test/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  process.env.OIDC_ISSUER ??= 'http://idp.test';
  process.env.OIDC_CLIENT_ID ??= 'test';
  process.env.OIDC_REDIRECT_URI ??= 'http://localhost/callback';
  process.env.CUTOVER_DATE ??= '2000-01-01';
});

/**
 * Tag-gate config used to live in env (PAPERLESS_EXPENSE_TAGS); now it's on
 * SettingsService. A test-local fake lets each block opt into different
 * tag sets without touching DB state.
 */
function fakeSettings(expenseTags: string[] = []): SettingsService {
  return {
    getPaperlessExpenseTags: vi.fn().mockResolvedValue(expenseTags),
  } as unknown as SettingsService;
}

function fakePaperless(opts: { docTags?: number[]; tagIds?: Map<string, number> } = {}): PaperlessRepository {
  return {
    getDocument: vi.fn().mockResolvedValue({
      id: 0,
      tags: opts.docTags ?? [],
      correspondent: null,
      document_type: null,
      title: '',
      created: '',
      added: '',
    }),
    resolveTagIds: vi.fn().mockImplementation((names: string[]) => {
      const map = opts.tagIds ?? new Map<string, number>();
      return Promise.resolve(names.map((n) => map.get(n) ?? 0));
    }),
  } as unknown as PaperlessRepository;
}

describe('ExpensePipelineService', () => {
  let db: Kysely<DB>;
  let eventRepo: EventRepository;
  let expenseRepo: ExpenseRepository;
  let paperless: PaperlessRepository;
  let service: ExpensePipelineService;

  beforeEach(async () => {
    db = await getKyselyDB();
    eventRepo = new EventRepository(db);
    expenseRepo = new ExpenseRepository(db);
    paperless = fakePaperless();
    service = new ExpensePipelineService(eventRepo, expenseRepo, paperless, fakeSettings([]));
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('creates a pending_review expense from a paperless event', async () => {
    const ingest = await eventRepo.ingest({
      source: EventSource.Paperless,
      eventType: 'document.consumed',
      externalId: 'paperless-1',
      occurredAt: new Date('2099-04-05'),
      payload: {
        document_id: 4242,
        correspondent: 'Acme Cables',
        created: '2099-04-05',
      },
    });
    if (!ingest.ingested) {
      throw new Error('precondition');
    }

    await service.handleProcessPaperlessDocument({ eventId: ingest.event.id });

    const pending = await expenseRepo.findPendingReview();
    expect(pending).toHaveLength(1);
    expect(pending[0].vendor).toBe('Acme Cables');
    expect(pending[0].paperlessDocId).toBe('4242');
    expect(pending[0].status).toBe(ExpenseStatus.PendingReview);
    expect(pending[0].locationClass).toBe(ExpenseLocationClass.Domestic);

    const eventAfter = await eventRepo.findById(ingest.event.id);
    expect(eventAfter?.status).toBe(EventStatus.Processed);
  });

  it('idempotent on duplicate paperless documents', async () => {
    const first = await eventRepo.ingest({
      source: EventSource.Paperless,
      eventType: 'document.consumed',
      externalId: 'paperless-2',
      occurredAt: new Date(),
      payload: { document_id: 'doc-99', correspondent: 'Vendor', created: '2099-01-01' },
    });
    if (!first.ingested) {
      throw new Error('precondition');
    }
    await service.handleProcessPaperlessDocument({ eventId: first.event.id });

    // Second event for the same paperless doc id arrives (e.g. reprocess) — same expense row.
    const second = await eventRepo.ingest({
      source: EventSource.Paperless,
      eventType: 'document.consumed',
      externalId: 'paperless-2-retry',
      occurredAt: new Date(),
      payload: { document_id: 'doc-99', correspondent: 'Vendor 2.0', created: '2099-01-02' },
    });
    if (!second.ingested) {
      throw new Error('precondition');
    }
    await service.handleProcessPaperlessDocument({ eventId: second.event.id });

    const pending = await expenseRepo.findPendingReview();
    expect(pending).toHaveLength(1);
    // First write wins — no clobbering.
    expect(pending[0].vendor).toBe('Vendor');
  });

  it('skips and marks-processed events from non-paperless sources', async () => {
    const ingest = await eventRepo.ingest({
      source: EventSource.Wise,
      eventType: 'balances#credit',
      externalId: 'wise-stray',
      occurredAt: new Date(),
      payload: { foo: 'bar' },
    });
    if (!ingest.ingested) {
      throw new Error('precondition');
    }

    await service.handleProcessPaperlessDocument({ eventId: ingest.event.id });

    const pending = await expenseRepo.findPendingReview();
    expect(pending).toHaveLength(0);

    const eventAfter = await eventRepo.findById(ingest.event.id);
    expect(eventAfter?.status).toBe(EventStatus.Processed);
  });

  describe('tag gate', () => {
    beforeEach(async () => {
      // Settings configured to require Business + Bills, wired to a fake
      // paperless where Business=1 and Bills=4.
      await db.destroy();
      db = await getKyselyDB();
      eventRepo = new EventRepository(db);
      expenseRepo = new ExpenseRepository(db);
    });

    it('ingests a doc that has all required tags', async () => {
      paperless = fakePaperless({
        docTags: [1, 4, 5],
        tagIds: new Map([
          ['Business', 1],
          ['Bills', 4],
        ]),
      });
      service = new ExpensePipelineService(eventRepo, expenseRepo, paperless, fakeSettings(['Business', 'Bills']));
      const ingest = await eventRepo.ingest({
        source: EventSource.Paperless,
        eventType: 'document.consumed',
        externalId: 'paperless-tagged-yes',
        occurredAt: new Date('2099-04-05'),
        payload: { document_id: 4242, correspondent: 'Acme Cables', created: '2099-04-05' },
      });
      if (!ingest.ingested) {
        throw new Error('precondition');
      }
      await service.handleProcessPaperlessDocument({ eventId: ingest.event.id });
      const pending = await expenseRepo.findPendingReview();
      expect(pending).toHaveLength(1);
    });

    it('skips a doc missing one of the required tags', async () => {
      paperless = fakePaperless({
        docTags: [1], // has Business but not Bills
        tagIds: new Map([
          ['Business', 1],
          ['Bills', 4],
        ]),
      });
      service = new ExpensePipelineService(eventRepo, expenseRepo, paperless, fakeSettings(['Business', 'Bills']));
      const ingest = await eventRepo.ingest({
        source: EventSource.Paperless,
        eventType: 'document.consumed',
        externalId: 'paperless-tagged-partial',
        occurredAt: new Date('2099-04-05'),
        payload: { document_id: 4243, correspondent: 'Random', created: '2099-04-05' },
      });
      if (!ingest.ingested) {
        throw new Error('precondition');
      }
      await service.handleProcessPaperlessDocument({ eventId: ingest.event.id });
      const pending = await expenseRepo.findPendingReview();
      expect(pending).toHaveLength(0);
      const eventAfter = await eventRepo.findById(ingest.event.id);
      expect(eventAfter?.status).toBe(EventStatus.Processed);
    });

    it('falls through to ingest when tag resolution errors (over-ingest > silent drop)', async () => {
      paperless = {
        getDocument: vi.fn().mockRejectedValue(new Error('paperless down')),
        resolveTagIds: vi.fn().mockRejectedValue(new Error('paperless down')),
      } as unknown as PaperlessRepository;
      service = new ExpensePipelineService(eventRepo, expenseRepo, paperless, fakeSettings(['Business', 'Bills']));
      const ingest = await eventRepo.ingest({
        source: EventSource.Paperless,
        eventType: 'document.consumed',
        externalId: 'paperless-tag-error',
        occurredAt: new Date('2099-04-05'),
        payload: { document_id: 4244, correspondent: 'Vendor', created: '2099-04-05' },
      });
      if (!ingest.ingested) {
        throw new Error('precondition');
      }
      await service.handleProcessPaperlessDocument({ eventId: ingest.event.id });
      const pending = await expenseRepo.findPendingReview();
      expect(pending).toHaveLength(1);
    });
  });

  it('throws when the event id does not exist', async () => {
    await expect(
      service.handleProcessPaperlessDocument({ eventId: '00000000-0000-0000-0000-000000000000' }),
    ).rejects.toThrow(/Event not found/);
  });
});
