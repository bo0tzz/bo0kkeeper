import { Kysely } from 'kysely';
import { ClientClass, JobName, TradeName } from 'src/enum';
import { AppSettingsRepository } from 'src/repositories/app-settings.repository';
import { ClientRepository } from 'src/repositories/client.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { InvoiceRepository } from 'src/repositories/invoice.repository';
import { JobRepository } from 'src/repositories/job.repository';
import { PaperlessRepository } from 'src/repositories/paperless.repository';
import { TypstRepository } from 'src/repositories/typst.repository';
import { WiseTransferRepository } from 'src/repositories/wise-transfer.repository';
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

async function seedOutgoingTransfer(
  db: Kysely<DB>,
  overrides?: {
    state?:
      | 'incoming_payment_waiting'
      | 'processing'
      | 'funds_converted'
      | 'outgoing_payment_sent'
      | 'cancelled'
      | 'failed';
    direction?: 'in' | 'out';
  },
) {
  return await new WiseTransferRepository(db).create({
    wiseTransferId: `WISE-${Math.floor(Math.random() * 1e9)}`,
    direction: (overrides?.direction ?? 'out') as never,
    sourceAmountMinor: 479_100n,
    sourceCurrency: 'USD',
    targetAmountMinor: 404_572n,
    targetCurrency: 'EUR',
    fxRate: '0.846991',
    feeMinor: 1442n,
    feeCurrency: 'USD',
    state: (overrides?.state ?? 'outgoing_payment_sent') as never,
    stateUpdatedAt: new Date(),
    ourReference: 'TXN-0044',
  });
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
    // composer also resolves tag names → ids when tags are configured.
    // SettingsService defaults to `Business,Invoice,bo0kkeeper`, so this
    // path always runs and needs stubbing — otherwise the real call hits
    // the paperless REST API (works locally with PAPERLESS_BASE_URL set,
    // fails in CI without it).
    paperless.resolveTagIds = vi.fn().mockResolvedValue([1, 2, 3]);

    jobs = fakeJobRepo();
    const settingsService = new SettingsService(new AppSettingsRepository(db));
    await settingsService.onModuleInit();
    composer = new InvoiceComposerService(
      clientRepo,
      invoiceRepo,
      new WiseTransferRepository(db),
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

  it('charges BTW on top of the net line subtotal (Total = subtotal + BTW)', async () => {
    // Domestic client: line amounts are net (excl-BTW). They sum to the
    // subtotal; BTW = subtotal × rate is charged on top; the stored total is
    // the gross the client pays and the bank-matcher reconciles against.
    const domestic = await clientRepo.create({
      name: 'DUTCHCO',
      class: ClientClass.Domestic,
      tradeName: TradeName.ItServices,
      address: { line1: 'Dorpsstraat 1', city: 'Amsterdam' },
    });

    const result = await composer.composeAndIssue({
      clientId: domestic.id,
      issuedAt: new Date('2099-06-15T00:00:00Z'),
      currency: 'EUR',
      btwRateBps: 2100,
      lines: [{ description: 'Consulting', lineTotalMinor: 100_000n }],
    });

    // €1000,00 net @ 21% → BTW €210,00, total €1210,00.
    expect(Number(result.invoice.btwMinor)).toBe(21_000);
    expect(Number(result.invoice.totalMinor)).toBe(121_000);
  });

  describe('composeFromWise', () => {
    it('derives currency + amounts from the wise_transfer and persists the FK', async () => {
      const transfer = await seedOutgoingTransfer(db);
      const result = await composer.composeFromWise({
        wiseTransferId: transfer.id,
        clientId,
        issuedAt: new Date('2099-01-15T00:00:00Z'),
        lines: [{ description: 'Services Jan 1 – 15', lineTotalMinor: 479_100n }],
      });
      expect(result.invoice.currency).toBe('USD');
      expect(String(result.invoice.totalMinor)).toBe('479100');
      // Critical: eurTotalMinor = the ACTUAL EUR that landed at SNS
      // (targetAmountMinor), not source × fxRate. Net of Wise's fee/spread.
      expect(String(result.invoice.eurTotalMinor)).toBe('404572');
      expect(result.invoice.wiseTransferId).toBe(transfer.id);
    });

    it('prefillFromWise returns the suggested client when there is exactly one Non-EU client', async () => {
      const transfer = await seedOutgoingTransfer(db);
      const prefill = await composer.prefillFromWise(transfer.id);
      expect(prefill.currency).toBe('USD');
      expect(String(prefill.totalMinor)).toBe('479100');
      expect(String(prefill.eurTotalMinor)).toBe('404572');
      expect(prefill.ourReference).toBe('TXN-0044');
      expect(prefill.suggestedClientId).toBe(clientId);
    });

    it('rejects an inbound (direction=in) transfer', async () => {
      const transfer = await seedOutgoingTransfer(db, { direction: 'in' });
      await expect(composer.prefillFromWise(transfer.id)).rejects.toThrow(/direction=in/);
    });

    it('rejects a non-terminal state', async () => {
      const transfer = await seedOutgoingTransfer(db, { state: 'processing' });
      await expect(composer.prefillFromWise(transfer.id)).rejects.toThrow(/state=processing/);
    });

    it('rejects a transfer that already has an invoice (unique constraint)', async () => {
      const transfer = await seedOutgoingTransfer(db);
      await composer.composeFromWise({
        wiseTransferId: transfer.id,
        clientId,
        issuedAt: new Date('2099-01-15T00:00:00Z'),
        lines: [{ description: 'Services', lineTotalMinor: 479_100n }],
      });
      await expect(
        composer.composeFromWise({
          wiseTransferId: transfer.id,
          clientId,
          issuedAt: new Date('2099-01-16T00:00:00Z'),
          lines: [{ description: 'Services again', lineTotalMinor: 479_100n }],
        }),
      ).rejects.toThrow(/already has invoice/);
    });
  });

  it('never records BTW for a non-EU client even if a rate is passed', async () => {
    // The compose form's BTW field defaults to 21 and isn't class-aware. A
    // non-EU client is out of scope for BTW, so the composer must ignore the
    // rate: no btwMinor, no rate stored, total = subtotal (no BTW on top).
    // (The default `clientId` client is already class non_eu.)
    const result = await composer.composeAndIssue({
      clientId,
      issuedAt: new Date('2099-07-15T00:00:00Z'),
      currency: 'USD',
      btwRateBps: 2100,
      lines: [{ description: 'Services', lineTotalMinor: 100_000n }],
    });

    expect(result.invoice.btwMinor).toBeNull();
    expect(result.invoice.btwRateBps).toBeNull();
    expect(Number(result.invoice.totalMinor)).toBe(100_000);
  });
});
