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
import { BankMatcherService } from 'src/services/bank-matcher.service';
import { SheetWriterService } from 'src/services/sheet-writer.service';
import { getKyselyDB } from 'test/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  process.env.OIDC_ISSUER ??= 'http://idp.test';
  process.env.OIDC_CLIENT_ID ??= 'test';
  process.env.OIDC_REDIRECT_URI ??= 'http://localhost/callback';
});

describe('BankMatcherService', () => {
  let db: Kysely<DB>;
  let bankRepo: BankTransactionRepository;
  let transferRepo: WiseTransferRepository;
  let invoiceRepo: InvoiceRepository;
  let clientRepo: ClientRepository;
  let sheetWriter: SheetWriterService & { writeIncomeRow: ReturnType<typeof vi.fn> };
  let matcher: BankMatcherService;

  beforeEach(async () => {
    db = await getKyselyDB();
    bankRepo = new BankTransactionRepository(db);
    transferRepo = new WiseTransferRepository(db);
    invoiceRepo = new InvoiceRepository(db);
    clientRepo = new ClientRepository(db);
    sheetWriter = {
      writeIncomeRow: vi.fn().mockResolvedValue(void 0),
    } as unknown as SheetWriterService & { writeIncomeRow: ReturnType<typeof vi.fn> };
    matcher = new BankMatcherService(db, bankRepo, clientRepo, sheetWriter);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('matches a bank tx to a wise_transfer via TXN-NNNN reference (auto_high)', async () => {
    const transfer = await transferRepo.create({
      wiseTransferId: 'WISE-1',
      direction: WiseTransferDirection.Out,
      sourceAmountMinor: 479_100n,
      sourceCurrency: 'USD',
      targetAmountMinor: 404_572n,
      targetCurrency: 'EUR',
      fxRate: '0.846991',
      feeMinor: 1442n,
      feeCurrency: 'USD',
      state: WiseTransferState.OutgoingPaymentSent,
      stateUpdatedAt: new Date(),
      ourReference: 'TXN-0044',
      counterpartyName: null,
      correlationId: null,
    });

    const ingest = await bankRepo.ingest({
      source: BankSource.SnsCsv,
      externalId: '50:1',
      txDate: new Date('2099-01-15'),
      amountMinor: 404_572n,
      currency: 'EUR',
      counterpartyName: 'Test Account Holder',
      counterpartyIban: 'BE03967415006984',
      description: '1234567-BE03967415006984-Test Account Holder-TXN-0044',
      rawPayload: {},
    });
    expect(ingest.ingested).toBe(true);
    if (!ingest.ingested) {
      throw new Error('precondition');
    }

    const result = await matcher.tryMatch(ingest.row);
    expect(result.matched).toBe(true);
    if (result.matched && result.type === 'wise_transfer') {
      expect(result.transferId).toBe(transfer.id);
      expect(result.confidence).toBe(MatchConfidence.AutoHigh);
    }

    const refetched = await bankRepo.findById(ingest.row.id);
    expect(refetched?.matchedTransferId).toBe(transfer.id);
    expect(refetched?.matchConfidence).toBe(MatchConfidence.AutoHigh);
    expect(refetched?.matchedAt).toBeInstanceOf(Date);
  });

  it('matches a bank tx to an invoice via YYYY/NNN reference', async () => {
    const client = await clientRepo.create({
      name: 'Acme Studio',
      class: ClientClass.Domestic,
      tradeName: TradeName.ItServices,
      address: { line1: 'X', city: 'Y' },
    });
    const invoice = await invoiceRepo.issue({
      year: 2099,
      invoice: {
        clientId: client.id,
        issuedAt: new Date('2099-03-05'),
        currency: 'EUR',
        totalMinor: 23_898n,
        sourceEventId: null,
      },
      lines: [{ ordinal: 0, description: 'Services', lineTotalMinor: 23_898n, unitLabel: null, quantity: null }],
    });

    const ingest = await bankRepo.ingest({
      source: BankSource.SnsCsv,
      externalId: '60:2',
      txDate: new Date('2099-03-05'),
      amountMinor: 23_898n,
      currency: 'EUR',
      counterpartyName: 'F. Acme Studio',
      counterpartyIban: 'NL00BANK0000000000',
      description: '3D print services (2099/001)',
      rawPayload: {},
    });
    if (!ingest.ingested) {
      throw new Error('precondition');
    }

    const result = await matcher.tryMatch(ingest.row);
    expect(result.matched).toBe(true);
    if (result.matched && result.type === 'invoice') {
      expect(result.invoiceId).toBe(invoice.id);
    }

    const refetched = await bankRepo.findById(ingest.row.id);
    expect(refetched?.matchedInvoiceId).toBe(invoice.id);

    // Sheet income row appended (kasstelsel — payment received in NL bank).
    expect(sheetWriter.writeIncomeRow).toHaveBeenCalledOnce();
    const args = sheetWriter.writeIncomeRow.mock.calls[0][0] as {
      invoiceNumber: string;
      eurAmountMinor: bigint;
      client: { name: string; class: ClientClass };
      from: string;
      source: string;
    };
    expect(args.invoiceNumber).toBe(invoice.number);
    expect(args.eurAmountMinor).toBe(23_898n);
    expect(args.client.name).toBe('Acme Studio');
    expect(args.client.class).toBe(ClientClass.Domestic);
    expect(args.from).toBe('F. Acme Studio');
    expect(args.source).toBe(`bank_tx/${ingest.row.id}`);
  });

  it('absorbs sheet write failures so the match still persists', async () => {
    sheetWriter.writeIncomeRow.mockRejectedValueOnce(new Error('sheets api down'));

    const client = await clientRepo.create({
      name: 'Sheet-Failing Client',
      class: ClientClass.Domestic,
      tradeName: TradeName.ItServices,
      address: { line1: 'X', city: 'Y' },
    });
    const invoice = await invoiceRepo.issue({
      year: 2099,
      invoice: {
        clientId: client.id,
        issuedAt: new Date('2099-04-01'),
        currency: 'EUR',
        totalMinor: 12_100n,
        sourceEventId: null,
      },
      lines: [{ ordinal: 0, description: 'Services', lineTotalMinor: 12_100n, unitLabel: null, quantity: null }],
    });
    const ingest = await bankRepo.ingest({
      source: BankSource.SnsCsv,
      externalId: '60:fail',
      txDate: new Date('2099-04-01'),
      amountMinor: 12_100n,
      currency: 'EUR',
      counterpartyName: 'Sheet-Failing Client',
      counterpartyIban: null,
      description: `Payment for ${invoice.number}`,
      rawPayload: {},
    });
    if (!ingest.ingested) {
      throw new Error('precondition');
    }

    const result = await matcher.tryMatch(ingest.row);
    expect(result.matched).toBe(true);

    const refetched = await bankRepo.findById(ingest.row.id);
    expect(refetched?.matchedInvoiceId).toBe(invoice.id);
  });

  it('returns matched:false when no signal is present', async () => {
    const ingest = await bankRepo.ingest({
      source: BankSource.SnsCsv,
      externalId: '70:3',
      txDate: new Date('2099-04-01'),
      amountMinor: -1000n,
      currency: 'EUR',
      counterpartyName: 'Random Vendor',
      counterpartyIban: null,
      description: 'no recognizable references in this text',
      rawPayload: {},
    });
    if (!ingest.ingested) {
      throw new Error('precondition');
    }

    const result = await matcher.tryMatch(ingest.row);
    expect(result.matched).toBe(false);
  });

  it('does not re-match an already-matched row', async () => {
    const ingest = await bankRepo.ingest({
      source: BankSource.SnsCsv,
      externalId: '80:4',
      txDate: new Date(),
      amountMinor: 1n,
      currency: 'EUR',
      counterpartyName: 'X',
      counterpartyIban: null,
      description: 'no signal',
      rawPayload: {},
      matchedAt: new Date(),
      matchConfidence: MatchConfidence.Manual,
    });
    if (!ingest.ingested) {
      throw new Error('precondition');
    }

    const result = await matcher.tryMatch(ingest.row);
    expect(result.matched).toBe(false);
    if (!result.matched) {
      expect(result.reason).toContain('already matched');
    }
  });

  it('matchAllUnmatched processes the queue and reports counts', async () => {
    await transferRepo.create({
      wiseTransferId: 'WISE-2',
      direction: WiseTransferDirection.Out,
      sourceAmountMinor: 1n,
      sourceCurrency: 'USD',
      targetAmountMinor: 1n,
      targetCurrency: 'EUR',
      feeMinor: 0n,
      feeCurrency: 'USD',
      state: WiseTransferState.OutgoingPaymentSent,
      stateUpdatedAt: new Date(),
      ourReference: 'TXN-0099',
      counterpartyName: null,
      correlationId: null,
      fxRate: null,
    });
    await bankRepo.ingest({
      source: BankSource.SnsCsv,
      externalId: '90:1',
      txDate: new Date(),
      amountMinor: 1n,
      currency: 'EUR',
      counterpartyName: 'X',
      counterpartyIban: null,
      description: 'reference TXN-0099',
      rawPayload: {},
    });
    await bankRepo.ingest({
      source: BankSource.SnsCsv,
      externalId: '90:2',
      txDate: new Date(),
      amountMinor: 1n,
      currency: 'EUR',
      counterpartyName: 'X',
      counterpartyIban: null,
      description: 'no signal here',
      rawPayload: {},
    });

    const summary = await matcher.matchAllUnmatched();
    expect(summary.matched).toBe(1);
    expect(summary.unmatched).toBe(1);
  });
});
