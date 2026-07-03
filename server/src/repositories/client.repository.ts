import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, Selectable, Updateable } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DB } from 'src/schema';
import { ClientTable } from 'src/schema/tables/client.table';

export type Client = Selectable<ClientTable>;
export type NewClient = Insertable<ClientTable>;
export type ClientUpdate = Updateable<ClientTable>;

@Injectable()
export class ClientRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  findAll(): Promise<Client[]> {
    return this.db.selectFrom('client').selectAll().orderBy('name', 'asc').execute() as Promise<Client[]>;
  }

  findById(id: string): Promise<Client | undefined> {
    return this.db.selectFrom('client').selectAll().where('id', '=', id).executeTakeFirst() as Promise<
      Client | undefined
    >;
  }

  /**
   * Find the client whose `wiseSenderPattern` is contained in `senderText`.
   * Used to route inbound Wise credits to the right client (e.g. payroll-provider
   * name embedded in the resource → known client).
   */
  async findByWiseSender(senderText: string): Promise<Client | undefined> {
    const candidates = await this.db
      .selectFrom('client')
      .selectAll()
      .where('wiseSenderPattern', 'is not', null)
      .execute();
    return candidates.find((c) => c.wiseSenderPattern && senderText.includes(c.wiseSenderPattern)) as
      Client | undefined;
  }

  async create(data: NewClient): Promise<Client> {
    const inserted = await this.db.insertInto('client').values(data).returningAll().executeTakeFirstOrThrow();
    return inserted as Client;
  }

  async update(id: string, data: ClientUpdate): Promise<Client | undefined> {
    const updated = await this.db
      .updateTable('client')
      .set({ ...data, updatedAt: new Date() })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    return updated as Client | undefined;
  }

  async delete(id: string): Promise<void> {
    await this.db.deleteFrom('client').where('id', '=', id).execute();
  }
}
