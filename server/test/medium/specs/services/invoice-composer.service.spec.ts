import { Kysely } from 'kysely';
import { ClientClass, JobName, TradeName } from 'src/enum';
import { AppSettingsRepository } from 'src/repositories/app-settings.repository';
import { ClientRepository } from 'src/repositories/client.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { InvoiceRepository } from 'src/repositories/invoice.repository';
import { JobRepository } from 'src/repositories/job.repository';
import { PaperlessRepository } from 'src/repositories/paperless.repository';
import { TypstRepository } from 'src/repositories/typst.repository';
import { DB } from 'src/schema';
import { InvoiceComposerService } from 'src/services/invoice-composer.service';
import { SettingsService } from 'src/services/settings.service';
import { getKyselyDB } from 'test/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  process.env.OIDC_ISSUER ??= 'http://idp.test';
  process.env.OIDC_CLIENT_ID ??= 'test';
  process.env.OIDC_REDIRECT_URI ??= 'http://localhost/callback';
  process.env.CUTOVER_DATE ??= '2000-01-01';
});

function fakeJobRepo() {
  const queue = vi.fn().mockResolvedValue('fake-job-id');
  return { queue, queueAll: vi.fn(), setup: vi.fn() } as unknown as JobRepository & { queue: ReturnType<typeof vi.fn> };
}

describe('InvoiceComposerService', () => {
  let db: Kysely<DB>;
  let clientRepo: ClientRepository;
  let invoiceRepo: InvoiceRepository;
  let render: TypstRepository;
  let paperless: PaperlessRepository;
  let jobs: JobRepository & { queue: ReturnType<typeof vi.fn> };
  let composer: InvoiceComposerService;
  let clientId: string;

  beforeEach(async () => {
    db = await getKyselyDB();
    clientRepo = new ClientRepository(db);
    invoiceRepo = new InvoiceRepository(db);
    render = new TypstRepository();

    paperless = new PaperlessRepository();
    paperless.uploadDocument = vi.fn().mockResolvedValue({ taskId: 'task-uuid-1' });
    paperless.waitForDocumentId = vi.fn().mockResolvedValue('paperless-doc-42');

    jobs = fakeJobRepo();
    const settingsService = new SettingsService(new AppSettingsRepository(db));
    await settingsService.onModuleInit();
    composer = new InvoiceComposerService(
      clientRepo,
      invoiceRepo,
      render,
      paperless,
      jobs,
      new EventRepository(db),
      settingsService,
    );

    const client = await clientRepo.create({
      name: 'FAKECO',
      class: ClientClass.NonEu,
      tradeName: TradeName.ItServices,
      address: { line1: '1 Fake Park Dr', city: 'Nowhere, Nullstate, USA' },
    });
    clientId = client.id;
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('issues + renders + enqueues an archive job (no inline paperless call)', async () => {
    const result = await composer.composeAndIssue({
      clientId,
      issuedAt: new Date('2099-01-15T00:00:00Z'),
      periodStart: new Date('2099-01-01T00:00:00Z'),
      periodEnd: new Date('2099-01-15T00:00:00Z'),
      currency: 'USD',
      eurTotalMinor: 404_572n,
      fxRate: '0.846991',
      lines: [{ description: 'Services Jan 1 – 15', lineTotalMinor: 479_100n }],
    });

    expect(result.invoice.number).toBe('2099/001');
    expect(result.pdf.subarray(0, 5).toString('utf8')).toBe('%PDF-');
    // paperless is NOT called inline — that happens in the queued job.
    expect(paperless.uploadDocument).not.toHaveBeenCalled();
    expect(jobs.queue).toHaveBeenCalledWith(JobName.ArchiveInvoiceToPaperless, { invoiceId: result.invoice.id });
  });

  it('archive job uploads to paperless and persists the doc id', async () => {
    const composed = await composer.composeAndIssue({
      clientId,
      issuedAt: new Date('2099-02-15T00:00:00Z'),
      currency: 'USD',
      eurTotalMinor: 100_000n,
      fxRate: '0.85',
      lines: [{ description: 'X', lineTotalMinor: 100_000n }],
    });

    await composer.handleArchiveInvoiceToPaperless({ invoiceId: composed.invoice.id });

    expect(paperless.uploadDocument).toHaveBeenCalledOnce();
    const refetched = await invoiceRepo.findByNumber('2099/001');
    expect(refetched?.paperlessDocId).toBe('paperless-doc-42');
  });

  it('archive job is idempotent — already-archived invoices are a no-op', async () => {
    const composed = await composer.composeAndIssue({
      clientId,
      issuedAt: new Date('2099-03-15T00:00:00Z'),
      currency: 'USD',
      eurTotalMinor: 100_000n,
      fxRate: '0.85',
      lines: [{ description: 'X', lineTotalMinor: 100_000n }],
    });

    await composer.handleArchiveInvoiceToPaperless({ invoiceId: composed.invoice.id });
    await composer.handleArchiveInvoiceToPaperless({ invoiceId: composed.invoice.id });

    expect(paperless.uploadDocument).toHaveBeenCalledOnce();
  });

  it('archive job propagates paperless errors so pg-boss can retry', async () => {
    paperless.uploadDocument = vi.fn().mockRejectedValue(new Error('paperless down'));

    const composed = await composer.composeAndIssue({
      clientId,
      issuedAt: new Date('2099-04-15T00:00:00Z'),
      currency: 'USD',
      eurTotalMinor: 100_000n,
      fxRate: '0.85',
      lines: [{ description: 'X', lineTotalMinor: 100_000n }],
    });

    await expect(composer.handleArchiveInvoiceToPaperless({ invoiceId: composed.invoice.id })).rejects.toThrow(
      /paperless down/,
    );
    const refetched = await invoiceRepo.findByNumber('2099/001');
    expect(refetched?.paperlessDocId).toBeNull();
  });

  it('persists multi-line invoices with summed total', async () => {
    const result = await composer.composeAndIssue({
      clientId,
      issuedAt: new Date('2099-05-15T00:00:00Z'),
      currency: 'USD',
      eurTotalMinor: 1_923_492n,
      fxRate: '0.91289',
      lines: [
        { description: 'Services', lineTotalMinor: 185_900n },
        { description: 'Signing bonus', lineTotalMinor: 1_612_800n },
        { description: 'Expenses reimbursement', lineTotalMinor: 307_400n },
      ],
    });

    expect(Number(result.invoice.totalMinor)).toBe(2_106_100);
    expect(result.invoice.lines).toHaveLength(3);
  });
});
