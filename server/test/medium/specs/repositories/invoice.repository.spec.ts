import { Kysely } from 'kysely';
import {
  BankSource,
  ClientClass,
  MatchConfidence,
  TradeName,
  WiseTransferDirection,
  WiseTransferState,
} from 'src/enum';
import { BankTransactionRepository } from 'src/repositories/bank-transaction.repository';
import { ClientRepository } from 'src/repositories/client.repository';
import { InvoiceRepository } from 'src/repositories/invoice.repository';
import { WiseTransferRepository } from 'src/repositories/wise-transfer.repository';
import { DB } from 'src/schema';
import { getKyselyDB } from 'test/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('InvoiceRepository', () => {
  let db: Kysely<DB>;
  let clientRepo: ClientRepository;
  let invoiceRepo: InvoiceRepository;
  let bankTxRepo: BankTransactionRepository;
  let wiseRepo: WiseTransferRepository;
  let clientId: string;

  beforeEach(async () => {
    db = await getKyselyDB();
    clientRepo = new ClientRepository(db);
    invoiceRepo = new InvoiceRepository(db);
    bankTxRepo = new BankTransactionRepository(db);
    wiseRepo = new WiseTransferRepository(db);
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

  /** Issue a no-line invoice on the given date — terse helper for filter tests. */
  async function issueOn(year: number, isoDate: string, totalMinor = 1n) {
    return invoiceRepo.issue({
      year,
      invoice: {
        clientId,
        issuedAt: new Date(isoDate),
        currency: 'EUR',
        totalMinor,
        sourceEventId: null,
      },
      lines: [],
    });
  }

  /** Create + match a bank_transaction row to mark the given invoice as paid. */
  async function markPaid(invoiceId: string, externalId: string) {
    const ingest = await bankTxRepo.ingest({
      source: BankSource.SnsCsv,
      externalId,
      txDate: new Date('2099-06-01'),
      amountMinor: 1n,
      currency: 'EUR',
      counterpartyName: null,
      counterpartyIban: null,
      description: '',
      rawPayload: {},
    });
    if (!ingest.ingested) {
      throw new Error('bank tx ingest precondition');
    }
    await db
      .updateTable('bank_transaction')
      .set({
        matchedInvoiceId: invoiceId,
        matchedAt: new Date(),
        matchConfidence: MatchConfidence.Manual,
      })
      .where('id', '=', ingest.row.id)
      .execute();
  }

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

  describe('findPaginated', () => {
    it('returns newest issuedAt first with total reflecting the unsliced count', async () => {
      await issueOn(2099, '2099-01-15');
      await issueOn(2099, '2099-03-15');
      await issueOn(2099, '2099-02-15');

      const page1 = await invoiceRepo.findPaginated({ offset: 0, limit: 2 });
      expect(page1.total).toBe(3);
      expect(page1.items.map((i) => i.number)).toEqual(['2099/002', '2099/003']);

      const page2 = await invoiceRepo.findPaginated({ offset: 2, limit: 2 });
      expect(page2.total).toBe(3);
      expect(page2.items.map((i) => i.number)).toEqual(['2099/001']);
    });

    it('year filter buckets on UTC year boundaries', async () => {
      // The Dec 31 row is the boundary case — invoice.issuedAt is a date column,
      // so any TZ slip in the slice query would either drop this row from 2099
      // or pull it into 2100.
      await issueOn(2099, '2099-12-31');
      await issueOn(2100, '2100-01-01');
      await issueOn(2100, '2100-06-15');

      const inA = await invoiceRepo.findPaginated({ year: 2099, offset: 0, limit: 50 });
      expect(inA.total).toBe(1);
      expect(inA.items[0].issuedAt).toEqual(new Date('2099-12-31'));

      const inB = await invoiceRepo.findPaginated({ year: 2100, offset: 0, limit: 50 });
      expect(inB.total).toBe(2);
      expect(inB.items.map((i) => i.number)).toEqual(['2100/002', '2100/001']);
    });

    it('status=paid / status=open partition by matched bank_transaction presence', async () => {
      const paidA = await issueOn(2099, '2099-02-01');
      const paidB = await issueOn(2099, '2099-03-01');
      await issueOn(2099, '2099-04-01'); // open
      await markPaid(paidA.id, 'paid-a');
      await markPaid(paidB.id, 'paid-b');

      const paid = await invoiceRepo.findPaginated({ status: 'paid', offset: 0, limit: 50 });
      expect(paid.total).toBe(2);
      expect(paid.items.every((i) => i.matchedBankTxId !== null)).toBe(true);

      const open = await invoiceRepo.findPaginated({ status: 'open', offset: 0, limit: 50 });
      expect(open.total).toBe(1);
      expect(open.items[0].matchedBankTxId).toBeNull();
    });

    it('treats an invoice as paid when its wise_transfer has a matched bank_tx (Wise route)', async () => {
      // Mirrors the FUTO field case: USD invoice paid via Wise USD→EUR
      // payout. bank_tx points at the wise_transfer (not at the invoice
      // directly), but the invoice is paid for accounting purposes.
      const transfer = await wiseRepo.create({
        wiseTransferId: 'WISE-PAID-VIA-WISE',
        direction: WiseTransferDirection.Out,
        sourceAmountMinor: 479_100n,
        sourceCurrency: 'USD',
        targetAmountMinor: 413_040n,
        targetCurrency: 'EUR',
        fxRate: '0.862',
        feeMinor: 1442n,
        feeCurrency: 'USD',
        state: WiseTransferState.OutgoingPaymentSent,
        stateUpdatedAt: new Date(),
        ourReference: 'TXN-9001',
        counterpartyName: null,
        correlationId: null,
      });
      const invoice = await invoiceRepo.issue({
        year: 2099,
        invoice: {
          clientId,
          issuedAt: new Date('2099-07-01'),
          currency: 'USD',
          totalMinor: 479_100n,
          sourceEventId: null,
          wiseTransferId: transfer.id,
        },
        lines: [],
      });
      const bankIngest = await bankTxRepo.ingest({
        source: BankSource.SnsCsv,
        externalId: 'wise-payout',
        txDate: new Date('2099-07-05'),
        amountMinor: 413_040n,
        currency: 'EUR',
        counterpartyName: null,
        counterpartyIban: null,
        description: 'TXN-9001',
        rawPayload: {},
      });
      if (!bankIngest.ingested) {
        throw new Error('precondition');
      }
      await db
        .updateTable('bank_transaction')
        .set({
          matchedTransferId: transfer.id,
          matchedAt: new Date(),
          matchConfidence: MatchConfidence.AutoHigh,
        })
        .where('id', '=', bankIngest.row.id)
        .execute();

      const paid = await invoiceRepo.findPaginated({ status: 'paid', offset: 0, limit: 50 });
      expect(paid.items.find((i) => i.id === invoice.id)?.matchedBankTxId).toBe(bankIngest.row.id);

      const open = await invoiceRepo.findPaginated({ status: 'open', offset: 0, limit: 50 });
      expect(open.items.find((i) => i.id === invoice.id)).toBeUndefined();
    });

    it('combines year + status filters', async () => {
      const paid2099 = await issueOn(2099, '2099-05-01');
      await issueOn(2099, '2099-06-01'); // open 2099
      const paid2100 = await issueOn(2100, '2100-05-01');
      await markPaid(paid2099.id, 'paid-2099');
      await markPaid(paid2100.id, 'paid-2100');

      const result = await invoiceRepo.findPaginated({
        year: 2099,
        status: 'paid',
        offset: 0,
        limit: 50,
      });
      expect(result.total).toBe(1);
      expect(result.items[0].id).toBe(paid2099.id);
    });
  });
});
