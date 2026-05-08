import { Injectable } from '@nestjs/common';
import { Kysely, Selectable, Updateable } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DB } from 'src/schema';
import { AppSettingsTable } from 'src/schema/tables/app-settings.table';

export type AppSettings = Selectable<AppSettingsTable>;
export type AppSettingsUpdate = Updateable<AppSettingsTable>;

@Injectable()
export class AppSettingsRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /** Return the single row, or undefined if the table hasn't been seeded yet. */
  findOne(): Promise<AppSettings | undefined> {
    return this.db.selectFrom('app_settings').selectAll().limit(1).executeTakeFirst();
  }

  async create(values: Omit<AppSettings, 'id' | 'createdAt' | 'updatedAt'>): Promise<AppSettings> {
    return this.db.insertInto('app_settings').values(values).returningAll().executeTakeFirstOrThrow();
  }

  async update(id: string, patch: AppSettingsUpdate): Promise<AppSettings> {
    return this.db
      .updateTable('app_settings')
      .set({ ...patch, updatedAt: new Date() })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}
