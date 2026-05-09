import { Kysely } from 'kysely';
import { WiseTransferDirection, WiseTransferState } from 'src/enum';
import { WiseTransferRepository } from 'src/repositories/wise-transfer.repository';
import { DB } from 'src/schema';
import { getKyselyDB } from 'test/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('WiseTransferRepository', () => {
  let db: Kysely<DB>;
  let repo: WiseTransferRepository;

  beforeEach(async () => {
    db = await getKyselyDB();
    repo = new WiseTransferRepository(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  /** Insert a transfer in the given state — terse helper for filter tests. */
  async function makeTransfer(
    wiseTransferId: string,
    state: WiseTransferState,
    overrides: Partial<Parameters<WiseTransferRepository['create']>[0]> = {},
  ) {
    return repo.create({
      wiseTransferId,
      direction: WiseTransferDirection.Out,
      sourceAmountMinor: 100n,
      sourceCurrency: 'USD',
      targetAmountMinor: 90n,
      targetCurrency: 'EUR',
      fxRate: '0.9',
      feeMinor: 0n,
      feeCurrency: 'USD',
      state,
      stateUpdatedAt: new Date(),
      ourReference: null,
      counterpartyName: null,
      correlationId: null,
      ...overrides,
    });
  }

  describe('findPaginated', () => {
    it('returns newest createdAt first with total reflecting the unsliced count', async () => {
      // Three rows created in succession; createdAt is set by Postgres so they
      // strictly increase by insertion order.
      await makeTransfer('a', WiseTransferState.Processing);
      await makeTransfer('b', WiseTransferState.Processing);
      await makeTransfer('c', WiseTransferState.Processing);

      const page1 = await repo.findPaginated({ offset: 0, limit: 2 });
      expect(page1.total).toBe(3);
      expect(page1.items.map((i) => i.wiseTransferId)).toEqual(['c', 'b']);

      const page2 = await repo.findPaginated({ offset: 2, limit: 2 });
      expect(page2.total).toBe(3);
      expect(page2.items.map((i) => i.wiseTransferId)).toEqual(['a']);
    });

    it('state filter narrows to that state only', async () => {
      await makeTransfer('sent-1', WiseTransferState.OutgoingPaymentSent);
      await makeTransfer('sent-2', WiseTransferState.OutgoingPaymentSent);
      await makeTransfer('processing-1', WiseTransferState.Processing);
      await makeTransfer('cancelled-1', WiseTransferState.Cancelled);

      const sent = await repo.findPaginated({
        state: WiseTransferState.OutgoingPaymentSent,
        offset: 0,
        limit: 50,
      });
      expect(sent.total).toBe(2);
      expect(sent.items.every((t) => t.state === WiseTransferState.OutgoingPaymentSent)).toBe(true);
    });
  });
});
