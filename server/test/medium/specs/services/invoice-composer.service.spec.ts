import { Kysely } from 'kysely';
import { resolve } from 'node:path';
import { ClientClass, TradeName } from 'src/enum';
import { ClientRepository } from 'src/repositories/client.repository';
import { InvoiceRepository } from 'src/repositories/invoice.repository';
import { DB } from 'src/schema';
import { InvoiceComposerService } from 'src/services/invoice-composer.service';
import { PaperlessService } from 'src/services/paperless.service';
import { RenderService } from 'src/services/render.service';
import { getKyselyDB } from 'test/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEMPLATES_DIR = resolve(process.cwd(), 'src/templates');

beforeEach(() => {
  process.env.OIDC_ISSUER ??= 'http://idp.test';
  process.env.OIDC_CLIENT_ID ??= 'test';
  process.env.OIDC_REDIRECT_URI ??= 'http://localhost/callback';
});

describe('InvoiceComposerService', () => {
  let db: Kysely<DB>;
  let clientRepo: ClientRepository;
  let invoiceRepo: InvoiceRepository;
  let render: RenderService;
  let paperless: PaperlessService;
  let composer: InvoiceComposerService;
  let clientId: string;

  beforeEach(async () => {
    db = await getKyselyDB();
    clientRepo = new ClientRepository(db);
    invoiceRepo = new InvoiceRepository(db);
    render = new RenderService(TEMPLATES_DIR);

    paperless = new PaperlessService();
    paperless.uploadDocument = vi.fn().mockResolvedValue({ taskId: 'task-uuid-1' });
    paperless.waitForDocumentId = vi.fn().mockResolvedValue('paperless-doc-42');

    composer = new InvoiceComposerService(clientRepo, invoiceRepo, render, paperless);

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

  it('issues, renders, and archives an invoice end-to-end', async () => {
    const result = await composer.composeAndIssue({
      clientId,
      issuedAt: new Date('2099-01-15T00:00:00Z'),
      periodStart: new Date('2099-01-01T00:00:00Z'),
      periodEnd: new Date('2099-01-15T00:00:00Z'),
      currency: 'USD',
      eurTotalMinor: 404_572n,
      fxRate: '0.846991',
      lines: [
        {
          description: 'Provided services, January 1 - January 15',
          lineTotalMinor: 479_100n,
        },
      ],
    });

    expect(result.invoice.number).toBe('2099/001');
    expect(result.invoice.lines).toHaveLength(1);
    expect(result.pdf.subarray(0, 5).toString('utf8')).toBe('%PDF-');
    expect(result.paperlessTaskId).toBe('task-uuid-1');
    expect(result.paperlessDocId).toBe('paperless-doc-42');

    // setPaperlessDocId persisted on the row.
    const refetched = await invoiceRepo.findByNumber('2099/001');
    expect(refetched?.paperlessDocId).toBe('paperless-doc-42');
  });

  it('survives paperless failure: invoice + PDF still produced, doc id null', async () => {
    paperless.uploadDocument = vi.fn().mockRejectedValue(new Error('paperless down'));

    const result = await composer.composeAndIssue({
      clientId,
      issuedAt: new Date('2099-02-15T00:00:00Z'),
      currency: 'USD',
      eurTotalMinor: 100_000n,
      fxRate: '0.85',
      lines: [{ description: 'X', lineTotalMinor: 100_000n }],
    });

    expect(result.invoice.number).toBe('2099/001'); // first invoice of year
    expect(result.pdf.byteLength).toBeGreaterThan(1000);
    expect(result.paperlessDocId).toBeUndefined();

    const refetched = await invoiceRepo.findByNumber('2099/001');
    expect(refetched?.paperlessDocId).toBeNull();
  });

  it('persists multi-line invoices with summed total', async () => {
    const result = await composer.composeAndIssue({
      clientId,
      issuedAt: new Date('2099-03-15T00:00:00Z'),
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
