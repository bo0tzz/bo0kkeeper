import { Kysely } from 'kysely';
import { BankingSessionStatus } from 'src/enum';
import { BankingSessionRepository } from 'src/repositories/banking-session.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { DB } from 'src/schema';
import { PaperlessService } from 'src/services/paperless.service';
import { SettingsService } from 'src/services/settings.service';
import { SystemHealthService } from 'src/services/system-health.service';
import { WiseApiService } from 'src/services/wise-api.service';
import { getKyselyDB } from 'test/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('SystemHealthService', () => {
  let db: Kysely<DB>;
  let eventRepo: EventRepository;
  let sessionRepo: BankingSessionRepository;

  beforeEach(async () => {
    process.env.OIDC_ISSUER ??= 'http://idp.test';
    process.env.OIDC_CLIENT_ID ??= 'test';
    process.env.OIDC_REDIRECT_URI ??= 'http://localhost/callback';
    db = await getKyselyDB();
    eventRepo = new EventRepository(db);
    sessionRepo = new BankingSessionRepository(db);
  });

  afterEach(async () => {
    delete process.env.CUTOVER_DATE;
    delete process.env.WISE_API_TOKEN;
    delete process.env.WISE_PROFILE_ID;
    delete process.env.PAPERLESS_BASE_URL;
    delete process.env.PAPERLESS_TOKEN;
    delete process.env.ENABLE_BANKING_APP_ID;
    delete process.env.ENABLE_BANKING_PRIVATE_KEY;
    delete process.env.ENABLE_BANKING_REDIRECT_URI;
    delete process.env.SHEETS_SERVICE_ACCOUNT_EMAIL;
    delete process.env.SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY;
    delete process.env.SHEETS_SPREADSHEET_ID;
    await db.destroy();
  });

  function makeService(overrides: {
    paperlessTags?: string[];
    paperlessTagsExist?: { name: string; exists: boolean; id: number | null }[];
    wisePingFails?: boolean;
  } = {}): SystemHealthService {
    const paperless = {
      checkTagsExist: vi.fn().mockResolvedValue(overrides.paperlessTagsExist ?? []),
    } as unknown as PaperlessService;
    const settings = {
      getPaperlessExpenseTags: vi.fn().mockResolvedValue(overrides.paperlessTags ?? []),
    } as unknown as SettingsService;
    const wise = {
      ping: vi.fn().mockImplementation(() => {
        if (overrides.wisePingFails) {
          return Promise.reject(new Error('forbidden'));
        }
        return Promise.resolve();
      }),
    } as unknown as WiseApiService;
    return new SystemHealthService(eventRepo, sessionRepo, paperless, settings, wise);
  }

  it('reports cutover not_configured when CUTOVER_DATE unset', async () => {
    delete process.env.CUTOVER_DATE;
    const service = makeService();
    const checks = await service.checkAll();
    const cutover = checks.find((c) => c.id === 'cutover')!;
    expect(cutover.status).toBe('not_configured');
    expect(cutover.configured).toBe(false);
  });

  it('reports cutover healthy with the floor value when set', async () => {
    process.env.CUTOVER_DATE = '2026-05-01';
    const service = makeService();
    const checks = await service.checkAll();
    const cutover = checks.find((c) => c.id === 'cutover')!;
    expect(cutover.status).toBe('healthy');
    expect(cutover.message).toContain('2026-05-01');
  });

  it('reports wise not_configured without API token', async () => {
    delete process.env.WISE_API_TOKEN;
    const service = makeService();
    const checks = await service.checkAll();
    const wise = checks.find((c) => c.id === 'wise')!;
    expect(wise.status).toBe('not_configured');
  });

  it('reports wise broken when ping fails', async () => {
    process.env.WISE_API_TOKEN = 'fake';
    process.env.WISE_PROFILE_ID = '123';
    const service = makeService({ wisePingFails: true });
    const checks = await service.checkAll();
    const wise = checks.find((c) => c.id === 'wise')!;
    expect(wise.status).toBe('broken');
    expect(wise.message).toContain('forbidden');
  });

  it('reports paperless degraded when tag-gate is empty', async () => {
    process.env.PAPERLESS_BASE_URL = 'https://paperless.test';
    process.env.PAPERLESS_TOKEN = 'fake';
    const service = makeService({ paperlessTags: [] });
    const checks = await service.checkAll();
    const paperless = checks.find((c) => c.id === 'paperless')!;
    expect(paperless.status).toBe('degraded');
    expect(paperless.message).toContain('no expense tag-gate');
  });

  it('reports paperless degraded when configured tags are missing in paperless', async () => {
    process.env.PAPERLESS_BASE_URL = 'https://paperless.test';
    process.env.PAPERLESS_TOKEN = 'fake';
    const service = makeService({
      paperlessTags: ['Business', 'Buisness'],
      paperlessTagsExist: [
        { name: 'Business', exists: true, id: 1 },
        { name: 'Buisness', exists: false, id: null },
      ],
    });
    const checks = await service.checkAll();
    const paperless = checks.find((c) => c.id === 'paperless')!;
    expect(paperless.status).toBe('degraded');
    expect(paperless.message).toContain('Buisness');
  });

  it('reports enable_banking degraded when configured but no session', async () => {
    process.env.ENABLE_BANKING_APP_ID = '01999999-9999-7999-9999-999999999999';
    process.env.ENABLE_BANKING_PRIVATE_KEY = 'fake-key';
    process.env.ENABLE_BANKING_REDIRECT_URI = 'http://localhost/callback';
    const service = makeService();
    const checks = await service.checkAll();
    const eb = checks.find((c) => c.id === 'enable_banking')!;
    expect(eb.status).toBe('degraded');
    expect(eb.message).toContain('no consent session');
  });

  it('reports enable_banking broken when consent is revoked', async () => {
    process.env.ENABLE_BANKING_APP_ID = '01999999-9999-7999-9999-999999999999';
    process.env.ENABLE_BANKING_PRIVATE_KEY = 'fake-key';
    process.env.ENABLE_BANKING_REDIRECT_URI = 'http://localhost/callback';
    await sessionRepo.create({
      oauthState: '11111111-2222-4333-8444-555555555555',
      aspspName: 'Mock ASPSP',
      aspspCountry: 'NL',
      psuType: 'personal',
      status: BankingSessionStatus.Revoked,
      applicationSessionId: 'eb-1',
      expiresAt: new Date('2099-12-31'),
    });
    const service = makeService();
    const checks = await service.checkAll();
    const eb = checks.find((c) => c.id === 'enable_banking')!;
    expect(eb.status).toBe('broken');
    expect(eb.message).toContain('reconnect');
  });
});
