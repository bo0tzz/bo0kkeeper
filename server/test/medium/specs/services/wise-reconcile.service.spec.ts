import { Kysely } from 'kysely';
import { WiseTransferDirection, WiseTransferState } from 'src/enum';
import { EventRepository } from 'src/repositories/event.repository';
import { WiseApiError, WiseApiRepository, WiseTransfer } from 'src/repositories/wise-api.repository';
import { WiseTransferRepository } from 'src/repositories/wise-transfer.repository';
import { DB } from 'src/schema';
import { WiseReconcileService } from 'src/services/wise-reconcile.service';
import { getKyselyDB } from 'test/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  process.env.OIDC_ISSUER ??= 'http://idp.test';
  process.env.OIDC_CLIENT_ID ??= 'test';
  process.env.OIDC_REDIRECT_URI ??= 'http://localhost/callback';
  process.env.CUTOVER_DATE ??= '2000-01-01';
});

function makeWiseTransfer(id: number, state: WiseTransfer['state'], rate: WiseTransfer['rate'] = '0.85'): WiseTransfer {
  return {
    id,
    state,
    reference: `TXN-${id}`,
    rate,
    sourceCurrency: 'USD',
    sourceValue: 1000,
    targetCurrency: 'EUR',
    targetValue: 850,
    created: '2099-01-01T00:00:00Z',
  };
}

describe('WiseReconcileService', () => {
  let db: Kysely<DB>;
  let repo: WiseTransferRepository;
  let api: WiseApiRepository & {
    getTransfer: ReturnType<typeof vi.fn<WiseApiRepository['getTransfer']>>;
  };
  let service: WiseReconcileService;

  beforeEach(async () => {
    db = await getKyselyDB();
    repo = new WiseTransferRepository(db);
    api = { getTransfer: vi.fn<WiseApiRepository['getTransfer']>() } as unknown as WiseApiRepository & {
      getTransfer: ReturnType<typeof vi.fn<WiseApiRepository['getTransfer']>>;
    };
    service = new WiseReconcileService(repo, api, new EventRepository(db));
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function seedTransfer(state: WiseTransferState, wiseId = '99999999') {
    return await repo.create({
      wiseTransferId: wiseId,
      direction: WiseTransferDirection.Out,
      sourceAmountMinor: 100_000n,
      sourceCurrency: 'USD',
      targetAmountMinor: 85_000n,
      targetCurrency: 'EUR',
      fxRate: '0.85',
      feeMinor: 0n,
      feeCurrency: 'USD',
      state,
      stateUpdatedAt: new Date('2026-05-01'),
      ourReference: 'TXN-9999',
    });
  }

  it('updates a transfer whose upstream state has advanced past ours', async () => {
    const seeded = await seedTransfer(WiseTransferState.Processing);
    api.getTransfer.mockResolvedValue(makeWiseTransfer(99_999_999, 'outgoing_payment_sent'));

    const result = await service.reconcileAll();
    expect(result).toMatchObject({ checked: 1, updated: 1, missing: 0 });
    const refreshed = await repo.findByWiseTransferId(seeded.wiseTransferId);
    expect(refreshed!.state).toBe('outgoing_payment_sent');
    expect(api.getTransfer).toHaveBeenCalledWith(99_999_999);
  });

  it('leaves a transfer unchanged when upstream agrees', async () => {
    await seedTransfer(WiseTransferState.Processing);
    api.getTransfer.mockResolvedValue(makeWiseTransfer(99_999_999, 'processing'));
    const result = await service.reconcileAll();
    expect(result).toEqual({ checked: 1, updated: 0, missing: 0 });
  });

  it('skips terminal-state transfers (no API call)', async () => {
    await seedTransfer(WiseTransferState.OutgoingPaymentSent, '88888888');
    await seedTransfer(WiseTransferState.Cancelled, '77777777');
    await seedTransfer(WiseTransferState.Failed, '66666666');
    const result = await service.reconcileAll();
    expect(result.checked).toBe(0);
    expect(api.getTransfer).not.toHaveBeenCalled();
  });

  it('handles a 404 by counting it as missing without bombing the rest', async () => {
    await seedTransfer(WiseTransferState.Processing, '11111111');
    await seedTransfer(WiseTransferState.Processing, '22222222');
    api.getTransfer.mockImplementation((id: number) => {
      if (id === 11_111_111) {
        return Promise.reject(new WiseApiError(404, { error: 'not found' }, 'Wise API GET failed: 404'));
      }
      return Promise.resolve(makeWiseTransfer(id, 'outgoing_payment_sent'));
    });
    const result = await service.reconcileAll();
    expect(result).toEqual({ checked: 2, updated: 1, missing: 1 });
  });

  it('skips non-numeric wiseTransferId without calling the API', async () => {
    await seedTransfer(WiseTransferState.Processing, 'WISE-MANUAL-FIXTURE');
    const result = await service.reconcileAll();
    expect(api.getTransfer).not.toHaveBeenCalled();
    expect(result).toEqual({ checked: 1, updated: 0, missing: 0 });
  });

  it('detects amount drift (user bumped source at SCA time) even when state matches', async () => {
    // Scenario: 0.41 USD cashback drafted, user bumped to 10.41 at Wise SCA
    // screen. State stays `processing`, but sourceValue/targetValue changed.
    const seeded = await repo.create({
      wiseTransferId: '55555555',
      direction: WiseTransferDirection.Out,
      sourceAmountMinor: 41n,
      sourceCurrency: 'USD',
      targetAmountMinor: 35n,
      targetCurrency: 'EUR',
      fxRate: '0.85',
      feeMinor: 0n,
      feeCurrency: 'USD',
      state: WiseTransferState.Processing,
      stateUpdatedAt: new Date('2026-05-01'),
      ourReference: 'TXN-BUMPED',
    });
    api.getTransfer.mockResolvedValue({
      id: 55_555_555,
      state: 'processing',
      reference: 'TXN-BUMPED',
      rate: '0.86',
      sourceCurrency: 'USD',
      sourceValue: 10.41,
      targetCurrency: 'EUR',
      targetValue: 8.95,
      created: '2099-01-01T00:00:00Z',
    });
    const result = await service.reconcileAll();
    expect(result).toEqual({ checked: 1, updated: 1, missing: 0 });
    const refreshed = await repo.findByWiseTransferId(seeded.wiseTransferId);
    // Amounts + rate should reflect the bumped values from upstream.
    expect(String(refreshed!.sourceAmountMinor)).toBe('1041');
    expect(String(refreshed!.targetAmountMinor)).toBe('895');
    expect(refreshed!.fxRate).toBe('0.86');
    expect(refreshed!.state).toBe('processing');
  });
});
