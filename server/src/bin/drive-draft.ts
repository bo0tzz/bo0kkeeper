import { Kysely } from 'kysely';
import { loadConfig } from 'src/config';
import { EventRepository } from 'src/repositories/event.repository';
import { WiseTransferRepository } from 'src/repositories/wise-transfer.repository';
import { DB } from 'src/schema';
import { WiseApiService } from 'src/services/wise-api.service';
import { WiseDraftService } from 'src/services/wise-draft.service';
import { getKyselyConfig } from 'src/utils/database';

async function main() {
  const cfg = loadConfig();
  const db = new Kysely<DB>(getKyselyConfig(cfg.database));
  try {
    const eventRepo = new EventRepository(db);
    const transferRepo = new WiseTransferRepository(db);
    const wiseApi = new WiseApiService();
    const draft = new WiseDraftService(eventRepo, transferRepo, wiseApi);
    const eventId = process.argv[2];
    if (!eventId) throw new Error('usage: drive-draft <eventId>');
    console.log('drafting from event', eventId);
    const row = await draft.draftFromEvent({ eventId });
    console.log('drafted:', JSON.stringify(row, null, 2));
  } finally {
    await db.destroy();
  }
}

void main().catch((e) => { console.error('FAIL:', e?.message); console.error(e?.stack); process.exit(1); });
