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
      'incoming_payment_waiting' | 'processing' | 'funds_converted' | 'outgoing_payment_sent' | 'cancelled' | 'failed';
    direction?: 'in' | 'out';
    sourceAmountMinor?: bigint;
    targetAmountMinor?: bigint;
    originalCreditMinor?: bigint | null;
  },
) {
  return await new WiseTransferRepository(db).create({
    wiseTransferId: `WISE-${Math.floor(Math.random() * 1e9)}`,
    direction: (overrides?.direction ?? 'out') as never,
    sourceAmountMinor: overrides?.sourceAmountMinor ?? 479_100n,
    sourceCurrency: 'USD',
    // Default to the same as sourceAmountMinor so pre-existing tests that
    // assume "sweep amount == credit amount" keep passing.
    originalCreditMinor:
      overrides?.originalCreditMinor === undefined
        ? (overrides?.sourceAmountMinor ?? 479_100n)
        : overrides.originalCreditMinor,
    targetAmountMinor: overrides?.targetAmountMinor ?? 404_572n,
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
    // Inbox-tag strip path: default to "no inbox tags configured" so existing
    // tests don't accidentally exercise the patch. Tests that DO exercise it
    // override these mocks per-case.
    paperless.listInboxTagIds = vi.fn().mockResolvedValue([]);
    paperless.getDocument = vi.fn().mockResolvedValue({ id: 42, tags: [1, 2, 3] });
    paperless.setDocumentTags = vi.fn().mockResolvedValue(void 0);

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

  it('archive job strips any inbox tags Paperless auto-applied to our upload', async () => {
    // Pretend Paperless added inbox tag id 99 alongside our intended tags.
    paperless.listInboxTagIds = vi.fn().mockResolvedValue([99]);
    paperless.getDocument = vi.fn().mockResolvedValue({ id: 42, tags: [1, 2, 3, 99] });
    const setTagsMock = vi.fn().mockResolvedValue(void 0);
    paperless.setDocumentTags = setTagsMock;

    const composed = await composer.composeAndIssue({
      clientId,
      issuedAt: new Date('2099-03-15T00:00:00Z'),
      currency: 'USD',
      eurTotalMinor: 100_000n,
      fxRate: '0.85',
      lines: [{ description: 'X', lineTotalMinor: 100_000n }],
    });

    await composer.handleArchiveInvoiceToPaperless({ invoiceId: composed.invoice.id });

    expect(setTagsMock).toHaveBeenCalledOnce();
    // Final tag list: our three intended ones, inbox tag 99 dropped.
    expect(setTagsMock.mock.calls[0]).toEqual(['paperless-doc-42', [1, 2, 3]]);
  });

  it('archive job keeps the tags it asked for even when paperless counts them as inbox tags', async () => {
    paperless.listInboxTagIds = vi.fn().mockResolvedValue([1, 99]);
    paperless.getDocument = vi.fn().mockResolvedValue({ id: 42, tags: [1, 2, 3, 99] });
    const setTagsMock = vi.fn().mockResolvedValue(void 0);
    paperless.setDocumentTags = setTagsMock;

    const composed = await composer.composeAndIssue({
      clientId,
      issuedAt: new Date('2099-04-15T00:00:00Z'),
      currency: 'USD',
      eurTotalMinor: 100_000n,
      fxRate: '0.85',
      lines: [{ description: 'X', lineTotalMinor: 100_000n }],
    });

    await composer.handleArchiveInvoiceToPaperless({ invoiceId: composed.invoice.id });

    expect(setTagsMock).toHaveBeenCalledExactlyOnceWith('paperless-doc-42', [1, 2, 3]);
  });

  it('archive job skips the inbox-tag patch when no inbox tags are configured', async () => {
    paperless.listInboxTagIds = vi.fn().mockResolvedValue([]);
    const setTagsMock = vi.fn();
    paperless.setDocumentTags = setTagsMock;

    const composed = await composer.composeAndIssue({
      clientId,
      issuedAt: new Date('2099-06-15T00:00:00Z'),
      currency: 'USD',
      eurTotalMinor: 100_000n,
      fxRate: '0.85',
      lines: [{ description: 'X', lineTotalMinor: 100_000n }],
    });

    await composer.handleArchiveInvoiceToPaperless({ invoiceId: composed.invoice.id });

    expect(setTagsMock).not.toHaveBeenCalled();
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

    // v0.9.1 fix — when the sweep ran under-credit (because some was
    // spent Wise-side before drafting), invoice compose uses the
    // *original* credit amount, not the swept amount. EUR total is
    // proportional to the sweep rate on that full pool.
    it('uses originalCreditMinor as the invoice total when the sweep ran under-credit', async () => {
      // Client paid $5000; $150 was Wise-card-spent; sweep drafted for
      // $4850 → €4109 EUR. Invoice should reflect the $5000 payment.
      const transfer = await seedOutgoingTransfer(db, {
        sourceAmountMinor: 485_000n,
        originalCreditMinor: 500_000n,
        targetAmountMinor: 410_900n,
      });
      const prefill = await composer.prefillFromWise(transfer.id);
      // USD side: full credit, not sweep amount.
      expect(String(prefill.totalMinor)).toBe('500000');
      // EUR side: proportional — 500_000 * 410_900 / 485_000 = 423_608.
      expect(String(prefill.eurTotalMinor)).toBe('423608');

      const result = await composer.composeFromWise({
        wiseTransferId: transfer.id,
        clientId,
        issuedAt: new Date('2099-01-15T00:00:00Z'),
        lines: [{ description: 'Services', lineTotalMinor: 500_000n }],
      });
      expect(String(result.invoice.eurTotalMinor)).toBe('423608');
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

  async function setTemplateDescription(db: Kysely<DB>, clientId: string) {
    await db
      .updateTable('client')
      .set({ defaultDescription: 'Provided services, {period.start.day} {period.start.month_long}' })
      .where('id', '=', clientId)
      .execute();
  }

  async function seedPriorInvoice(
    composer: InvoiceComposerService,
    db: Kysely<DB>,
    clientId: string,
    lineTotal = 479_100n,
  ) {
    const priorTransfer = await seedOutgoingTransfer(db);
    await composer.composeFromWise({
      wiseTransferId: priorTransfer.id,
      clientId,
      issuedAt: new Date('2099-01-15T00:00:00Z'),
      periodStart: new Date('2099-01-01T00:00:00Z'),
      periodEnd: new Date('2099-01-15T00:00:00Z'),
      lines: [{ description: 'Services', lineTotalMinor: lineTotal }],
    });
  }

  describe('tryAutoComposeFromWise', () => {
    it('composes when every guard passes (steady-cadence template-driven client)', async () => {
      await setTemplateDescription(db, clientId);
      await seedPriorInvoice(composer, db, clientId);
      const settled = await seedOutgoingTransfer(db);

      const result = await composer.tryAutoComposeFromWise(settled.id);
      expect(result.outcome).toBe('composed');
      if (result.outcome !== 'composed') {
        return;
      }
      const invoice = await invoiceRepo.findById(result.invoiceId);
      expect(invoice?.wiseTransferId).toBe(settled.id);
      expect(invoice?.lines).toHaveLength(1);
    });

    it('is idempotent — a second attempt on the same transfer returns already_invoiced', async () => {
      await setTemplateDescription(db, clientId);
      await seedPriorInvoice(composer, db, clientId);
      const settled = await seedOutgoingTransfer(db);
      await composer.tryAutoComposeFromWise(settled.id);

      const second = await composer.tryAutoComposeFromWise(settled.id);
      expect(second.outcome).toBe('already_invoiced');
    });

    it('declines no_prior_invoice when the client has never been invoiced', async () => {
      await setTemplateDescription(db, clientId);
      const settled = await seedOutgoingTransfer(db);

      const result = await composer.tryAutoComposeFromWise(settled.id);
      expect(result).toMatchObject({ outcome: 'declined', reason: 'no_prior_invoice' });
    });

    it('declines rate_changed when the latest invoice total differs from the prefill', async () => {
      await setTemplateDescription(db, clientId);
      await seedPriorInvoice(composer, db, clientId, 500_000n);
      const settled = await seedOutgoingTransfer(db, { sourceAmountMinor: 479_100n, originalCreditMinor: 479_100n });

      const result = await composer.tryAutoComposeFromWise(settled.id);
      expect(result).toMatchObject({ outcome: 'declined', reason: 'rate_changed' });
    });

    it('declines client_not_template_driven when the client has a non-template description', async () => {
      // Non-empty but static — passes the "no description at all" guard but
      // fails the template-driven check. Caller probably writes line text per
      // invoice, so don't guess.
      await db.updateTable('client').set({ defaultDescription: 'Services' }).where('id', '=', clientId).execute();
      await seedPriorInvoice(composer, db, clientId);
      const settled = await seedOutgoingTransfer(db);

      const result = await composer.tryAutoComposeFromWise(settled.id);
      expect(result).toMatchObject({ outcome: 'declined', reason: 'client_not_template_driven' });
    });

    it('declines no_line_description when the client has no defaultDescription at all', async () => {
      await seedPriorInvoice(composer, db, clientId);
      const settled = await seedOutgoingTransfer(db);

      const result = await composer.tryAutoComposeFromWise(settled.id);
      expect(result).toMatchObject({ outcome: 'declined', reason: 'no_line_description' });
    });

    it('declines no_suggested_client when there are multiple Non-EU clients', async () => {
      await setTemplateDescription(db, clientId);
      await seedPriorInvoice(composer, db, clientId);
      await clientRepo.create({
        name: 'OTHERCO',
        class: ClientClass.NonEu,
        tradeName: TradeName.ItServices,
        address: { line1: 'other', city: 'elsewhere' },
      });
      const settled = await seedOutgoingTransfer(db);

      const result = await composer.tryAutoComposeFromWise(settled.id);
      expect(result).toMatchObject({ outcome: 'declined', reason: 'no_suggested_client' });
    });

    it('declines wrong_state for a non-settled transfer', async () => {
      await setTemplateDescription(db, clientId);
      await seedPriorInvoice(composer, db, clientId);
      const draft = await seedOutgoingTransfer(db, { state: 'processing' });

      const result = await composer.tryAutoComposeFromWise(draft.id);
      expect(result).toMatchObject({ outcome: 'declined', reason: 'wrong_state' });
    });

    it('declines wrong_direction for an inbound transfer', async () => {
      await setTemplateDescription(db, clientId);
      await seedPriorInvoice(composer, db, clientId);
      const inbound = await seedOutgoingTransfer(db, { direction: 'in' });

      const result = await composer.tryAutoComposeFromWise(inbound.id);
      expect(result).toMatchObject({ outcome: 'declined', reason: 'wrong_direction' });
    });

    it('declines invoice_dismissed when the operator marked the transfer not invoiceable', async () => {
      await setTemplateDescription(db, clientId);
      await seedPriorInvoice(composer, db, clientId);
      const settled = await seedOutgoingTransfer(db);
      await new WiseTransferRepository(db).markInvoiceDismissed(settled.id, new Date());

      const result = await composer.tryAutoComposeFromWise(settled.id);
      expect(result).toMatchObject({ outcome: 'declined', reason: 'invoice_dismissed' });
    });

    it('countOutgoingAwaitingInvoice excludes dismissed transfers', async () => {
      const repo = new WiseTransferRepository(db);
      const t1 = await seedOutgoingTransfer(db);
      const t2 = await seedOutgoingTransfer(db);
      expect(await repo.countOutgoingAwaitingInvoice()).toBe(2);
      await repo.markInvoiceDismissed(t1.id, new Date());
      expect(await repo.countOutgoingAwaitingInvoice()).toBe(1);
      await repo.markInvoiceDismissed(t2.id, new Date());
      expect(await repo.countOutgoingAwaitingInvoice()).toBe(0);
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
