import { Kysely } from 'kysely';
import { ClientClass, TradeName } from 'src/enum';
import { ClientRepository, NewClient } from 'src/repositories/client.repository';
import { DB } from 'src/schema';
import { getKyselyDB } from 'test/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const fakeClient = (overrides: Partial<NewClient> = {}): NewClient => ({
  name: 'Test Client',
  class: ClientClass.NonEu,
  tradeName: TradeName.ItServices,
  address: { line1: '1 Fake St', city: 'Nowhere', countryCode: 'US' },
  ...overrides,
});

describe('ClientRepository', () => {
  let db: Kysely<DB>;
  let repo: ClientRepository;

  beforeEach(async () => {
    db = await getKyselyDB();
    repo = new ClientRepository(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('creates and retrieves a client', async () => {
    const created = await repo.create(fakeClient({ name: 'OverseasClientCo-ish' }));
    expect(created.id).toBeTruthy();
    expect(created.name).toBe('OverseasClientCo-ish');
    expect(created.class).toBe(ClientClass.NonEu);

    const fetched = await repo.findById(created.id);
    expect(fetched?.id).toBe(created.id);
  });

  it('lists clients alphabetically', async () => {
    await repo.create(fakeClient({ name: 'Zebra Inc' }));
    await repo.create(fakeClient({ name: 'Alpha Co' }));
    await repo.create(fakeClient({ name: 'Mid LLC' }));

    const list = await repo.findAll();
    expect(list.map((c) => c.name)).toEqual(['Alpha Co', 'Mid LLC', 'Zebra Inc']);
  });

  it('matches by Wise sender pattern (substring)', async () => {
    await repo.create(fakeClient({ name: 'Other', wiseSenderPattern: null }));
    const target = await repo.create(fakeClient({ name: 'Match Me', wiseSenderPattern: 'PAYROLL_INC' }));

    const found = await repo.findByWiseSender('Payment from PAYROLL_INC, Inc.');
    expect(found?.id).toBe(target.id);
  });

  it('returns undefined for an unmatched Wise sender', async () => {
    await repo.create(fakeClient({ wiseSenderPattern: 'KNOWN' }));
    const found = await repo.findByWiseSender('totally different sender');
    expect(found).toBeUndefined();
  });

  it('updates fields and bumps updatedAt', async () => {
    const created = await repo.create(fakeClient({ name: 'Old Name' }));
    const before = created.updatedAt;
    await new Promise((r) => setTimeout(r, 5));

    const updated = await repo.update(created.id, { name: 'New Name' });
    expect(updated?.name).toBe('New Name');
    expect(new Date(updated!.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
  });

  it('deletes a client', async () => {
    const created = await repo.create(fakeClient());
    await repo.delete(created.id);
    expect(await repo.findById(created.id)).toBeUndefined();
  });
});
