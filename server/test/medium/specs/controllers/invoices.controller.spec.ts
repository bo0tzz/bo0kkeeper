import { NotFoundException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { InvoicesController } from 'src/controllers/invoices.controller';
import { InvoiceComposeDto } from 'src/dtos/invoice.dto';
import { ClientClass, TradeName } from 'src/enum';
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

describe('InvoicesController', () => {
  let db: Kysely<DB>;
  let clientRepo: ClientRepository;
  let invoiceRepo: InvoiceRepository;
  let render: TypstRepository;
  let paperless: PaperlessRepository;
  let composer: InvoiceComposerService;
  let controller: InvoicesController;
  let clientId: string;

  beforeEach(async () => {
    db = await getKyselyDB();
    clientRepo = new ClientRepository(db);
    invoiceRepo = new InvoiceRepository(db);
    render = new TypstRepository();

    paperless = new PaperlessRepository();
    paperless.uploadDocument = vi.fn().mockRejectedValue(new Error('paperless not configured in tests'));
    paperless.waitForDocumentId = vi.fn();

    const jobs = {
      queue: vi.fn().mockResolvedValue('fake-job-id'),
      queueAll: vi.fn(),
      setup: vi.fn(),
    } as unknown as JobRepository;
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
    controller = new InvoicesController(composer, invoiceRepo);

    const client = await clientRepo.create({
      name: 'Acme Studio',
      class: ClientClass.Domestic,
      tradeName: TradeName.ItServices,
      address: { line1: 'Example Street 99', city: '5678CD Otherville' },
    });
    clientId = client.id;
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('composes an invoice and returns the persisted row', async () => {
    const result = await controller.composeInvoice({
      clientId,
      issuedAt: new Date('2099-03-05'),
      currency: 'EUR',
      btwRateBps: 2100,
      lines: [
        { description: 'Services', lineTotalMinor: 19_750n },
        { description: '3D printing', lineTotalMinor: 3250n },
      ],
    } as unknown as InvoiceComposeDto);

    expect(result.invoice.number).toBe('2099/001');
    expect(result.invoice.lines).toHaveLength(2);
    expect(result.invoice.totalMinor).toBe('23000');
    expect(result.invoice.btwRateBps).toBe(2100);
  });

  it('getInvoice returns the persisted invoice with lines', async () => {
    const composeResult = await controller.composeInvoice({
      clientId,
      issuedAt: new Date('2099-04-01'),
      currency: 'EUR',
      btwRateBps: 2100,
      lines: [{ description: 'Services', lineTotalMinor: 1000n }],
    } as unknown as InvoiceComposeDto);

    const fetched = await controller.getInvoice(composeResult.invoice.id);
    expect(fetched.id).toBe(composeResult.invoice.id);
    expect(fetched.lines).toHaveLength(1);
  });

  it('getInvoice 404s for missing ids', async () => {
    await expect(controller.getInvoice('00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('getInvoicePdf streams a PDF for the issued invoice', async () => {
    const composed = await controller.composeInvoice({
      clientId,
      issuedAt: new Date('2099-05-01'),
      currency: 'EUR',
      btwRateBps: 2100,
      lines: [{ description: 'Services', lineTotalMinor: 12_100n }],
    } as unknown as InvoiceComposeDto);

    const headers: Record<string, string> = {};
    let body: Buffer | undefined;
    const res = {
      setHeader(name: string, value: string) {
        headers[name] = value;
      },
      end(payload: Buffer) {
        body = payload;
      },
    } as unknown as import('express').Response;

    await controller.getInvoicePdf(composed.invoice.id, res);

    expect(headers['content-type']).toBe('application/pdf');
    expect(headers['content-disposition']).toContain('2099-001.pdf');
    expect(body).toBeInstanceOf(Buffer);
    expect(body!.subarray(0, 5).toString('utf8')).toBe('%PDF-');
  });

  it('getInvoicePdf 404s for missing invoices', async () => {
    const res = {
      setHeader: vi.fn(),
      end: vi.fn(),
    } as unknown as import('express').Response;
    await expect(controller.getInvoicePdf('00000000-0000-0000-0000-000000000000', res)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
