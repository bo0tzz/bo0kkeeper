import { Kysely } from 'kysely';
import { SettingsController } from 'src/controllers/settings.controller';
import { AppSettingsRepository } from 'src/repositories/app-settings.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { PaperlessRepository } from 'src/repositories/paperless.repository';
import { DB } from 'src/schema';
import { SettingsService } from 'src/services/settings.service';
import { DEFAULT_EXPENSE_EXTRACT_FIELD_DESCRIPTIONS } from 'src/utils/expense-extraction';
import { getKyselyDB } from 'test/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('SettingsController', () => {
  let db: Kysely<DB>;
  let settingsService: SettingsService;
  let controller: SettingsController;

  beforeEach(async () => {
    db = await getKyselyDB();
    settingsService = new SettingsService(new AppSettingsRepository(db));
    controller = new SettingsController(settingsService, new EventRepository(db), {} as PaperlessRepository);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('seeds extraction settings with no own names and the evaluated descriptions', async () => {
    const settings = await controller.get();
    expect(settings.extraction).toEqual({
      ownNames: [],
      fieldDescriptions: DEFAULT_EXPENSE_EXTRACT_FIELD_DESCRIPTIONS,
    });
  });

  it('updates extraction settings without touching the rest', async () => {
    const before = await controller.get();
    const fieldDescriptions = { ...DEFAULT_EXPENSE_EXTRACT_FIELD_DESCRIPTIONS, currency: 'always EUR' };

    const updated = await controller.update({ extraction: { ownNames: ['Jansen'], fieldDescriptions } });

    expect(updated.extraction).toEqual({ ownNames: ['Jansen'], fieldDescriptions });
    expect(updated.paperless).toEqual(before.paperless);
    await expect(settingsService.getExpenseExtraction()).resolves.toEqual({ ownNames: ['Jansen'], fieldDescriptions });
  });
});
