import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DB } from 'src/schema';

@Injectable()
export class HealthRepository {
  constructor(@InjectKysely() private readonly db: Kysely<DB>) {}

  /** Cheapest possible round-trip — `SELECT 1`. Throws if the DB is unreachable. */
  async ping(): Promise<void> {
    await sql`SELECT 1`.execute(this.db);
  }
}
