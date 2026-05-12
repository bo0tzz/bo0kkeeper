/**
 * Seeds demo data into the dev DB so every UI surface has something to look
 * at and the bank-matcher heuristics fire visibly. Wherever possible we
 * drive things through the same services the live system uses (webhook
 * service for paperless / Wise events, bank-matcher for tx ingestion) so
 * the data flows through real pipelines, not just direct row inserts.
 *
 * Run: pnpm tsx src/bin/seed-demo-data.ts
 *
 * Idempotent: re-running re-uses or skips rows it already inserted.
 */
import { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { loadConfig } from 'src/config';
import {
  BankingSessionStatus,
  BankSource,
  EventSource,
  ExpenseLocationClass,
  WiseTransferDirection,
  WiseTransferState,
} from 'src/enum';
import { BankTransactionRepository } from 'src/repositories/bank-transaction.repository';
import { ClientRepository } from 'src/repositories/client.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { ExpenseRepository } from 'src/repositories/expense.repository';
import { SheetsRepository } from 'src/repositories/sheets.repository';
import { WiseTransferRepository } from 'src/repositories/wise-transfer.repository';
import { DB } from 'src/schema';
import { BankMatcherService } from 'src/services/bank-matcher.service';
import { SheetWriterService } from 'src/services/sheet-writer.service';
import { getKyselyConfig } from 'src/utils/database';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const db = new Kysely<DB>(getKyselyConfig(cfg.database));
  try {
    const bankRepo = new BankTransactionRepository(db);
    const clientRepo = new ClientRepository(db);
    const eventRepo = new EventRepository(db);
    const expenseRepo = new ExpenseRepository(db);
    const transferRepo = new WiseTransferRepository(db);
    const sheetWriter = new SheetWriterService(new SheetsRepository());
    const matcher = new BankMatcherService(db, bankRepo, clientRepo, sheetWriter, eventRepo);

    console.log('=== Wise transfers (varied states) ===');
    await ensureWiseTransfer(transferRepo, {
      wiseTransferId: 'DEMO-IPW-1',
      ourReference: 'TXN-9001',
      state: WiseTransferState.IncomingPaymentWaiting,
      sourceAmountMinor: 500_000n,
      targetAmountMinor: 425_000n,
    });
    await ensureWiseTransfer(transferRepo, {
      wiseTransferId: 'DEMO-PROC-1',
      ourReference: 'TXN-9002',
      state: WiseTransferState.Processing,
      sourceAmountMinor: 480_000n,
      targetAmountMinor: 408_000n,
    });
    await ensureWiseTransfer(transferRepo, {
      wiseTransferId: 'DEMO-FC-1',
      ourReference: 'TXN-9003',
      state: WiseTransferState.FundsConverted,
      sourceAmountMinor: 320_000n,
      targetAmountMinor: 272_000n,
    });
    await ensureWiseTransfer(transferRepo, {
      wiseTransferId: 'DEMO-OPS-1',
      ourReference: 'TXN-9004',
      state: WiseTransferState.OutgoingPaymentSent,
      sourceAmountMinor: 600_000n,
      targetAmountMinor: 510_000n,
    });
    await ensureWiseTransfer(transferRepo, {
      wiseTransferId: 'DEMO-CANC-1',
      ourReference: 'TXN-9005',
      state: WiseTransferState.Cancelled,
      sourceAmountMinor: 250_000n,
      targetAmountMinor: 212_500n,
    });

    console.log('=== Pending banking_session (for the GC sweep) ===');
    await db
      .insertInto('banking_session')
      .values({
        oauthState: randomUUID(),
        aspspName: 'Mock ASPSP (abandoned)',
        aspspCountry: 'NL',
        psuType: 'personal',
        status: BankingSessionStatus.Pending,
        // createdAt is auto-set; we want it to be old enough that the
        // sweepStalePending will GC it on next run.
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
    // Backdate the most recent demo pending row so the sweep can see it as stale.
    await db
      .updateTable('banking_session')
      .set({ createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
      .where('aspspName', '=', 'Mock ASPSP (abandoned)')
      .execute();

    console.log('=== Demo expense (for auto_low heuristic) ===');
    await expenseRepo.ingest({
      paperlessDocId: 'demo-acme-cables-001',
      vendor: 'Acme Cables',
      expenseDate: new Date('2026-04-22'),
      amountMinor: 12_100n,
      currency: 'EUR',
      btwRateBps: 2100,
      btwMinor: 2100n,
      locationClass: ExpenseLocationClass.Domestic,
      category: '',
      notes: 'Demo HDMI cable purchase',
      sourceEventId: null,
    });
    // Auto-approve so it's not stuck in pending_review.
    const pendingExpenses = await expenseRepo.findPendingReview();
    const demoExpense = pendingExpenses.find((e) => e.vendor === 'Acme Cables');
    if (demoExpense) {
      await expenseRepo.approve(demoExpense.id);
      console.log(`  approved expense ${demoExpense.id} (Acme Cables, €121)`);
    }

    console.log('=== Bank transactions, run through matcher ===');

    // 1. Auto-high TXN-NNNN match — links to DEMO-OPS-1.
    await ingestAndMatch(bankRepo, matcher, {
      externalId: 'demo-bank-1',
      txDate: new Date('2026-04-20'),
      amountMinor: 510_000n,
      currency: 'EUR',
      counterpartyName: 'Test Account Holder',
      counterpartyIban: 'NL00BANK0000000000',
      description: '12345-NL00BANK0000000000-Test Account Holder-TXN-9004',
    });

    // 2. Auto-high invoice number — find an existing invoice and match its
    //    number into the description. Picks the most recent invoice.
    const recentInvoice = await db
      .selectFrom('invoice')
      .select(['number', 'currency', 'totalMinor'])
      .orderBy('issuedAt', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (recentInvoice) {
      await ingestAndMatch(bankRepo, matcher, {
        externalId: 'demo-bank-2',
        txDate: new Date('2026-04-22'),
        amountMinor: BigInt(recentInvoice.totalMinor),
        currency: recentInvoice.currency,
        counterpartyName: 'Some Client',
        counterpartyIban: 'NL00CLNT0000000000',
        description: `SEPA payment ref ${recentInvoice.number}`,
      });
    }

    // 3. Auto-low heuristic — same vendor + amount + close date as demo
    //    expense, but no TXN/invoice ref in the description.
    await ingestAndMatch(bankRepo, matcher, {
      externalId: 'demo-bank-3',
      txDate: new Date('2026-04-22'),
      amountMinor: -12_100n,
      currency: 'EUR',
      counterpartyName: 'Acme Cables via PSP',
      counterpartyIban: null,
      description: 'opaque-psp-id 1234567 ORD-987654 no-TXN-ref',
    });

    // 4. Unmatched — to exercise the manual Link UI.
    await ingestAndMatch(bankRepo, matcher, {
      externalId: 'demo-bank-4',
      txDate: new Date('2026-04-25'),
      amountMinor: -25_000n,
      currency: 'EUR',
      counterpartyName: 'BELASTINGDIENST',
      counterpartyIban: 'NL86INGB0002445588',
      description: 'BTW-aangifte',
    });

    // 5. Self-transfer (should remain unmatched too).
    await ingestAndMatch(bankRepo, matcher, {
      externalId: 'demo-bank-5',
      txDate: new Date('2026-04-26'),
      amountMinor: -100_000n,
      currency: 'EUR',
      counterpartyName: 'T.A. Holder',
      counterpartyIban: 'NL00OWNR0000000001',
      description: 'transfer to savings',
    });

    console.log('=== Demo manual events (for /events visibility) ===');
    await eventRepo.recordAction({
      source: EventSource.Manual,
      eventType: 'banking.tx.linked',
      payload: { bankTxId: 'demo-bank-1', targetType: 'wise_transfer', targetId: 'demo' },
    });
    await eventRepo.recordAction({
      source: EventSource.System,
      eventType: 'banking.sync.completed',
      payload: { sessions: 1, ingested: 5, matched: 3, psuOnline: false },
    });

    console.log('\nDone. Refresh /banking, /invoices, /wise/transfers, /events.');
  } finally {
    await db.destroy();
  }
}

async function ensureWiseTransfer(
  repo: WiseTransferRepository,
  opts: {
    wiseTransferId: string;
    ourReference: string;
    state: WiseTransferState;
    sourceAmountMinor: bigint;
    targetAmountMinor: bigint;
  },
): Promise<void> {
  const existing = await repo.findByWiseTransferId(opts.wiseTransferId);
  if (existing) {
    console.log(`  exists wise_transfer ${opts.wiseTransferId} (${opts.state})`);
    return;
  }
  await repo.create({
    wiseTransferId: opts.wiseTransferId,
    direction: WiseTransferDirection.Out,
    sourceAmountMinor: opts.sourceAmountMinor,
    sourceCurrency: 'USD',
    targetAmountMinor: opts.targetAmountMinor,
    targetCurrency: 'EUR',
    fxRate: '0.85',
    feeMinor: 1500n,
    feeCurrency: 'USD',
    state: opts.state,
    stateUpdatedAt: new Date(),
    ourReference: opts.ourReference,
    counterpartyName: null,
    correlationId: null,
  });
  console.log(`  created wise_transfer ${opts.wiseTransferId} (${opts.state})`);
}

async function ingestAndMatch(
  bankRepo: BankTransactionRepository,
  matcher: BankMatcherService,
  row: {
    externalId: string;
    txDate: Date;
    amountMinor: bigint;
    currency: string;
    counterpartyName: string | null;
    counterpartyIban: string | null;
    description: string;
  },
): Promise<void> {
  const result = await bankRepo.ingest({
    source: BankSource.SnsCsv,
    externalId: row.externalId,
    txDate: row.txDate,
    amountMinor: row.amountMinor,
    currency: row.currency,
    counterpartyName: row.counterpartyName,
    counterpartyIban: row.counterpartyIban,
    description: row.description,
    rawPayload: { synthetic: true, externalId: row.externalId },
  });
  if (!result.ingested) {
    console.log(`  skip ${row.externalId} (already exists)`);
    return;
  }
  const match = await matcher.tryMatch(result.row);
  if (match.matched) {
    console.log(`  ${row.externalId} → ${match.type} (${match.confidence})`);
  } else {
    console.log(`  ${row.externalId} → unmatched (${match.reason})`);
  }
}

void (async () => {
  try {
    await main();
  } catch (error) {
    console.error('FAIL:', (error as Error)?.message);
    console.error((error as Error)?.stack);
    process.exit(1);
  }
})();
