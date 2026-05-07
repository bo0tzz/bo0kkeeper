import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, Selectable, sql, Updateable } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DB } from 'src/schema';
import { WiseTransferTable } from 'src/schema/tables/wise-transfer.table';

export type WiseTransferRow = Selectable<WiseTransferTable>;
export type NewWiseTransfer = Insertable<WiseTransferTable>;
export type WiseTransferUpdate = Updateable<WiseTransferTable>;

@Injectable()
export class WiseTransferRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  async create(data: NewWiseTransfer): Promise<WiseTransferRow> {
    const inserted = await this.db.insertInto('wise_transfer').values(data).returningAll().executeTakeFirstOrThrow();
    return inserted as WiseTransferRow;
  }

  findByWiseTransferId(wiseTransferId: string): Promise<WiseTransferRow | undefined> {
    return this.db
      .selectFrom('wise_transfer')
      .selectAll()
      .where('wiseTransferId', '=', wiseTransferId)
      .executeTakeFirst() as Promise<WiseTransferRow | undefined>;
  }

  async updateState(wiseTransferId: string, state: WiseTransferUpdate['state'], stateUpdatedAt: Date): Promise<void> {
    await this.db
      .updateTable('wise_transfer')
      .set({ state, stateUpdatedAt, updatedAt: new Date() })
      .where('wiseTransferId', '=', wiseTransferId)
      .execute();
  }

  /**
   * Allocate the next `TXN-NNNN` reference for an outbound transfer. Backed by
   * a Postgres SEQUENCE — atomic and gap-tolerant under concurrency.
   */
  async allocateTxnReference(): Promise<string> {
    const result = await sql<{ nextval: number | string }>`SELECT nextval('wise_txn_sequence')`.execute(this.db);
    const next = result.rows[0]?.nextval;
    if (next === undefined) {
      throw new Error('Failed to allocate TXN reference: nextval returned no row');
    }
    return `TXN-${String(next).padStart(4, '0')}`;
  }
}
