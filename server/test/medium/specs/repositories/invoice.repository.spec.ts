import { Kysely } from 'kysely';
import { ClientClass, TradeName } from 'src/enum';
import { ClientRepository } from 'src/repositories/client.repository';
import { InvoiceRepository } from 'src/repositories/invoice.repository';
import { DB } from 'src/schema';
import { getKyselyDB } from 'test/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('InvoiceRepository', () => {
  let db: Kysely<DB>;
  let clientRepo: ClientRepository;
  let invoiceRepo: InvoiceRepository;
  let clientId: string;

  beforeEach(async () => {
    db = await getKyselyDB();
    clientRepo = new ClientRepository(db);
    invoiceRepo = new InvoiceRepository(db);
    const client = await clientRepo.create({
      name: 'Test Client',
      class: ClientClass.NonEu,
      tradeName: TradeName.ItServices,
      address: { line1: '1 Fake', countryCode: 'US' },
    });
    clientId = client.id;
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('issues invoices with year-restarted, gap-free numbering', async () => {
    const a = await invoiceRepo.issue({
      year: 2099,
      invoice: {
        clientId,
        issuedAt: new Date('2099-01-15'),
        currency: 'EUR',
        totalMinor: 19_750n,
        sourceEventId: null,
      },
      lines: [{ ordinal: 0, description: 'Services', lineTotalMinor: 19_750n, unitLabel: null, quantity: null }],
    });
    const b = await invoiceRepo.issue({
      year: 2099,
      invoice: {
        clientId,
        issuedAt: new Date('2099-02-15'),
        currency: 'EUR',
        totalMinor: 23_898n,
        sourceEventId: null,
      },
      lines: [],
    });
    const c = await invoiceRepo.issue({
      year: 2100,
      invoice: {
        clientId,
        issuedAt: new Date('2100-01-15'),
        currency: 'EUR',
        totalMinor: 1n,
        sourceEventId: null,
      },
      lines: [],
    });

    expect(a.number).toBe('2099/001');
    expect(b.number).toBe('2099/002');
    expect(c.number).toBe('2100/001');
  });

  it('persists multi-line invoices and returns them ordered', async () => {
    const issued = await invoiceRepo.issue({
      year: 2099,
      invoice: {
        clientId,
        issuedAt: new Date('2099-03-15'),
        currency: 'USD',
        totalMinor: 2_106_100n,
        eurTotalMinor: 1_923_492n,
        fxRate: '0.91289',
        sourceEventId: null,
      },
      lines: [
        { ordinal: 0, description: 'Services', lineTotalMinor: 185_900n, unitLabel: null, quantity: null },
        {
          ordinal: 1,
          description: 'Signing bonus',
          lineTotalMinor: 1_612_800n,
          unitLabel: null,
          quantity: null,
        },
        {
          ordinal: 2,
          description: 'Expenses reimbursement',
          lineTotalMinor: 307_400n,
          unitLabel: null,
          quantity: null,
        },
      ],
    });

    const fetched = await invoiceRepo.findById(issued.id);
    expect(fetched?.lines).toHaveLength(3);
    expect(fetched?.lines.map((l) => l.description)).toEqual(['Services', 'Signing bonus', 'Expenses reimbursement']);
  });

  it('updates the paperless doc id', async () => {
    const issued = await invoiceRepo.issue({
      year: 2099,
      invoice: {
        clientId,
        issuedAt: new Date('2099-04-01'),
        currency: 'EUR',
        totalMinor: 1n,
        sourceEventId: null,
      },
      lines: [],
    });

    await invoiceRepo.setPaperlessDocId(issued.id, 'paperless-doc-42');
    const fetched = await invoiceRepo.findByNumber(issued.number);
    expect(fetched?.paperlessDocId).toBe('paperless-doc-42');
  });
});
