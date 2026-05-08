/**
 * Seed the dev DB with synthetic data so the UI has something to render.
 *
 * Idempotent on a fresh DB; re-run after `migrations:run` on a wiped volume.
 * Never run against production — the data here is fictional but the script
 * inserts directly without going through any of the normal validation paths.
 *
 * Usage:
 *   pnpm --filter bo0kkeeper exec tsx src/bin/seed-fake-data.ts
 */
import { Kysely } from 'kysely';
import { loadConfig } from 'src/config';
import {
  BankSource,
  ClientClass,
  EventSource,
  ExpenseLocationClass,
  MatchConfidence,
  TradeName,
  WiseTransferDirection,
  WiseTransferState,
} from 'src/enum';
import { BankTransactionRepository } from 'src/repositories/bank-transaction.repository';
import { ClientRepository } from 'src/repositories/client.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { ExpenseRepository } from 'src/repositories/expense.repository';
import { InvoiceRepository } from 'src/repositories/invoice.repository';
import { WiseTransferRepository } from 'src/repositories/wise-transfer.repository';
import { DB } from 'src/schema';
import { getKyselyConfig } from 'src/utils/database';

async function main() {
  const config = loadConfig();
  const db = new Kysely<DB>(getKyselyConfig(config.database));

  try {
    const clientRepo = new ClientRepository(db);
    const invoiceRepo = new InvoiceRepository(db);
    const transferRepo = new WiseTransferRepository(db);
    const bankRepo = new BankTransactionRepository(db);
    const expenseRepo = new ExpenseRepository(db);
    const eventRepo = new EventRepository(db);

    console.log('Seeding clients…');
    const acmeStudio = await clientRepo.create({
      name: 'F. Acme Studio (Otherville)',
      class: ClientClass.Domestic,
      tradeName: TradeName.ItServices,
      address: { line1: 'Example Street 99', city: '5678CD Otherville', countryCode: 'NL' },
      vatId: null,
      defaultDescription: 'Maatwerk',
    });
    const overseas = await clientRepo.create({
      name: 'OverseasClientCo',
      class: ClientClass.NonEu,
      tradeName: TradeName.ItServices,
      address: { line1: '1 Park Plaza', city: 'Anytown', countryCode: 'US' },
      vatId: null,
      wiseSenderPattern: 'OverseasClientCo',
      defaultDescription: 'Provided services',
    });
    const euClient = await clientRepo.create({
      name: 'EuroIndustrial BV',
      class: ClientClass.Eu,
      tradeName: TradeName.ItServices,
      address: { line1: 'Industrieweg 12', city: 'Eindhoven', countryCode: 'NL' },
      vatId: 'NL999999999B01',
      defaultDescription: 'Consulting',
    });

    console.log('Seeding invoices…');
    const inv2026001 = await invoiceRepo.issue({
      year: 2026,
      invoice: {
        clientId: acmeStudio.id,
        issuedAt: new Date('2026-01-15'),
        currency: 'EUR',
        totalMinor: 18_150n,
        btwRateBps: 2100,
        btwMinor: 3150n,
        sourceEventId: null,
      },
      lines: [
        {
          ordinal: 0,
          description: '3D printing time',
          unitLabel: '€15/hr',
          quantity: '10 hours',
          lineTotalMinor: 15_000n,
        },
      ],
    });
    const inv2026002 = await invoiceRepo.issue({
      year: 2026,
      invoice: {
        clientId: acmeStudio.id,
        issuedAt: new Date('2026-02-15'),
        currency: 'EUR',
        totalMinor: 24_200n,
        btwRateBps: 2100,
        btwMinor: 4200n,
        sourceEventId: null,
      },
      lines: [
        {
          ordinal: 0,
          description: 'Design + tuning',
          unitLabel: '€20/hr',
          quantity: '10 hours',
          lineTotalMinor: 20_000n,
        },
      ],
    });
    const inv2026003 = await invoiceRepo.issue({
      year: 2026,
      invoice: {
        clientId: overseas.id,
        issuedAt: new Date('2026-03-15'),
        currency: 'USD',
        totalMinor: 500_000n,
        eurTotalMinor: 452_000n,
        fxRate: '0.904',
        btwRateBps: null,
        btwMinor: null,
        sourceEventId: null,
      },
      lines: [
        {
          ordinal: 0,
          description: 'Provided services, March 1 – March 15',
          unitLabel: null,
          quantity: null,
          lineTotalMinor: 500_000n,
        },
      ],
    });
    const inv2026004 = await invoiceRepo.issue({
      year: 2026,
      invoice: {
        clientId: euClient.id,
        issuedAt: new Date('2026-04-01'),
        currency: 'EUR',
        totalMinor: 60_500n,
        btwRateBps: 2100,
        btwMinor: 10_500n,
        sourceEventId: null,
      },
      lines: [
        {
          ordinal: 0,
          description: 'Q1 consulting',
          unitLabel: '€100/hr',
          quantity: '5 hours',
          lineTotalMinor: 50_000n,
        },
      ],
    });

    console.log('Seeding wise transfers…');
    const wiseOverseasTransfer = await transferRepo.create({
      wiseTransferId: 'WISE-2026031501',
      direction: WiseTransferDirection.Out,
      sourceAmountMinor: 500_000n,
      sourceCurrency: 'USD',
      targetAmountMinor: 452_000n,
      targetCurrency: 'EUR',
      fxRate: '0.904',
      feeMinor: 1500n,
      feeCurrency: 'USD',
      state: WiseTransferState.OutgoingPaymentSent,
      stateUpdatedAt: new Date('2026-03-20'),
      ourReference: 'TXN-0050',
      counterpartyName: 'T. Holder',
      correlationId: null,
    });

    console.log('Seeding bank transactions (with matches)…');
    await bankRepo.ingest({
      source: BankSource.SnsCsv,
      externalId: '20:1',
      txDate: new Date('2026-01-20'),
      amountMinor: 18_150n,
      currency: 'EUR',
      counterpartyName: 'F. Acme Studio',
      counterpartyIban: 'NL12RABO0000000001',
      description: 'Betaling factuur 2026/001',
      rawPayload: {},
      matchedInvoiceId: inv2026001.id,
      matchConfidence: MatchConfidence.AutoHigh,
      matchedAt: new Date('2026-01-20'),
    });
    await bankRepo.ingest({
      source: BankSource.SnsCsv,
      externalId: '21:1',
      txDate: new Date('2026-02-08'),
      amountMinor: -1500n,
      currency: 'EUR',
      counterpartyName: 'Music Stream Co',
      counterpartyIban: null,
      description: 'Music subscription',
      rawPayload: {},
    });
    await bankRepo.ingest({
      source: BankSource.SnsCsv,
      externalId: '22:1',
      txDate: new Date('2026-03-20'),
      amountMinor: 452_000n,
      currency: 'EUR',
      counterpartyName: 'Wise Europe SA',
      counterpartyIban: 'BE03967415006984',
      description: 'TXN-0050',
      rawPayload: {},
      matchedTransferId: wiseOverseasTransfer.id,
      matchConfidence: MatchConfidence.AutoHigh,
      matchedAt: new Date('2026-03-20'),
    });
    await bankRepo.ingest({
      source: BankSource.SnsCsv,
      externalId: '23:1',
      txDate: new Date('2026-04-05'),
      amountMinor: 60_500n,
      currency: 'EUR',
      counterpartyName: 'EuroIndustrial BV',
      counterpartyIban: 'NL55INGB0000099999',
      description: 'Payment for invoice 2026/004',
      rawPayload: {},
      matchedInvoiceId: inv2026004.id,
      matchConfidence: MatchConfidence.AutoHigh,
      matchedAt: new Date('2026-04-05'),
    });
    void inv2026002;
    void inv2026003;

    console.log('Seeding expenses…');
    await expenseRepo.ingest({
      paperlessDocId: '4242',
      vendor: 'Acme Cables',
      expenseDate: new Date('2026-01-10'),
      amountMinor: 0n,
      currency: 'EUR',
      btwRateBps: null,
      btwMinor: null,
      locationClass: ExpenseLocationClass.Domestic,
      category: '',
      notes: null,
      sourceEventId: null,
    });
    await expenseRepo.ingest({
      paperlessDocId: '4243',
      vendor: 'Cloud Hosting GmbH',
      expenseDate: new Date('2026-02-01'),
      amountMinor: 0n,
      currency: 'EUR',
      btwRateBps: null,
      btwMinor: null,
      locationClass: ExpenseLocationClass.Domestic,
      category: '',
      notes: null,
      sourceEventId: null,
    });
    const grocer = await expenseRepo.ingest({
      paperlessDocId: '4244',
      vendor: 'Daily Groceries NL',
      expenseDate: new Date('2026-01-15'),
      amountMinor: 3450n,
      currency: 'EUR',
      btwRateBps: 900,
      btwMinor: 285n,
      locationClass: ExpenseLocationClass.Domestic,
      category: 'office',
      notes: 'Coffee + lunch for client visit.',
      sourceEventId: null,
    });
    if (grocer.ingested) {
      await expenseRepo.approve(grocer.row.id);
    }
    const creative = await expenseRepo.ingest({
      paperlessDocId: '4245',
      vendor: 'Creative Software Ltd',
      expenseDate: new Date('2026-02-10'),
      amountMinor: 3000n,
      currency: 'EUR',
      btwRateBps: 0,
      btwMinor: 0n,
      locationClass: ExpenseLocationClass.EuReverseCharge,
      category: 'software',
      notes: null,
      sourceEventId: null,
    });
    if (creative.ingested) {
      await expenseRepo.approve(creative.row.id);
    }

    console.log('Seeding events…');
    // Pending wise balance#credit — surfaces on the /wise queue with a "Draft transfer" button.
    await eventRepo.ingest({
      source: EventSource.Wise,
      eventType: 'balances#credit',
      externalId: 'seed:wise:credit:1',
      occurredAt: new Date('2026-04-15T10:00:00Z'),
      payload: {
        event_type: 'balances#credit',
        sent_at: '2026-04-15T10:00:00Z',
        data: {
          amount: 5000,
          currency: 'USD',
          resource: { id: 999_991, type: 'balance', profile_id: 12_345 },
          occurred_at: '2026-04-15T10:00:00Z',
        },
      },
    });
    // Already-processed wise event for context.
    const processedWise = await eventRepo.ingest({
      source: EventSource.Wise,
      eventType: 'transfers#state-change',
      externalId: 'seed:wise:state:1',
      occurredAt: new Date('2026-03-20T09:00:00Z'),
      payload: {
        event_type: 'transfers#state-change',
        data: { resource: { id: 'WISE-2026031501', type: 'transfer' }, current_state: 'outgoing_payment_sent' },
      },
    });
    if (processedWise.ingested) {
      await eventRepo.markProcessed(processedWise.event.id);
    }
    // Processed paperless event tied to one of the approved expenses.
    const processedPaperless = await eventRepo.ingest({
      source: EventSource.Paperless,
      eventType: 'document.consumed',
      externalId: 'seed:paperless:1',
      occurredAt: new Date('2026-01-15T12:00:00Z'),
      payload: { document_id: '4244', correspondent: 'Daily Groceries NL', created: '2026-01-15' },
    });
    if (processedPaperless.ingested) {
      await eventRepo.markProcessed(processedPaperless.event.id);
    }

    console.log('Done seeding.');
    console.log(`  clients:       ${[acmeStudio, overseas, euClient].length}`);
    console.log('  invoices:      4 (1 unpaid, 3 paid via bank match)');
    console.log('  bank tx:       4 (3 matched, 1 noise)');
    console.log('  wise transfer: 1 (matched to bank tx)');
    console.log('  expenses:      4 (2 pending review, 2 approved)');
    console.log('  events:        3 (1 pending wise credit, 2 processed)');
    console.log('Status filters set up so all surfaces have content.');
  } finally {
    await db.destroy();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
