import { Kysely, sql } from 'kysely';
import { AppSettingsRepository } from 'src/repositories/app-settings.repository';
import { DB } from 'src/schema';
import { down, up } from 'src/schema/migrations/1792844553197-AddExpenseExtractSettings';
import { SettingsService } from 'src/services/settings.service';
import { DEFAULT_EXPENSE_EXTRACT_FIELD_DESCRIPTIONS } from 'src/utils/expense-extraction';
import { getKyselyDB } from 'test/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('AddExpenseExtractSettings migration', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await getKyselyDB();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('backfills an existing settings row with JSON values, not JSON strings', async () => {
    await new SettingsService(new AppSettingsRepository(db)).get();
    await down(db);
    await up(db);

    const { rows } = await sql<{ namesType: string; descriptionsType: string }>`
      SELECT jsonb_typeof("extractOwnNames") AS "namesType", jsonb_typeof("extractFieldDescriptions") AS "descriptionsType"
      FROM "app_settings"`.execute(db);
    expect(rows).toEqual([{ namesType: 'array', descriptionsType: 'object' }]);

    const settings = await new SettingsService(new AppSettingsRepository(db)).getExpenseExtraction();
    expect(settings).toEqual({ ownNames: [], fieldDescriptions: DEFAULT_EXPENSE_EXTRACT_FIELD_DESCRIPTIONS });
  });
});
