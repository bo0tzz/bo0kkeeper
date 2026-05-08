import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, Selectable, Updateable } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { BankingSessionStatus } from 'src/enum';
import { DB } from 'src/schema';
import { BankingSessionTable } from 'src/schema/tables/banking-session.table';

export type BankingSession = Selectable<BankingSessionTable>;
export type NewBankingSession = Insertable<BankingSessionTable>;
export type BankingSessionUpdate = Updateable<BankingSessionTable>;

@Injectable()
export class BankingSessionRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  create(session: NewBankingSession): Promise<BankingSession> {
    return this.db.insertInto('banking_session').values(session).returningAll().executeTakeFirstOrThrow();
  }

  findById(id: string): Promise<BankingSession | undefined> {
    return this.db.selectFrom('banking_session').selectAll().where('id', '=', id).executeTakeFirst();
  }

  findByOauthState(state: string): Promise<BankingSession | undefined> {
    return this.db.selectFrom('banking_session').selectAll().where('oauthState', '=', state).executeTakeFirst();
  }

  /** Active sessions, newest first. Sync job iterates this list. */
  findActive(): Promise<BankingSession[]> {
    return this.db
      .selectFrom('banking_session')
      .selectAll()
      .where('status', '=', BankingSessionStatus.Active)
      .orderBy('createdAt', 'desc')
      .execute();
  }

  /** Most recent session of any status. UI uses this to render the connection card. */
  findLatest(): Promise<BankingSession | undefined> {
    return this.db
      .selectFrom('banking_session')
      .selectAll()
      .orderBy('createdAt', 'desc')
      .limit(1)
      .executeTakeFirst();
  }

  update(id: string, patch: BankingSessionUpdate): Promise<BankingSession> {
    return this.db
      .updateTable('banking_session')
      .set({ ...patch, updatedAt: new Date() })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * Garbage-collect pending sessions older than `cutoff` (auth started, never
   * came back). Returns the number of rows updated.
   */
  async expirePendingBefore(cutoff: Date): Promise<number> {
    const result = await this.db
      .updateTable('banking_session')
      .set({ status: BankingSessionStatus.Expired, updatedAt: new Date() })
      .where('status', '=', BankingSessionStatus.Pending)
      .where('createdAt', '<', cutoff)
      .executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0);
  }
}
