import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, Selectable } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DB } from 'src/schema';
import { PeriodCloseTable } from 'src/schema/tables/period-close.table';

export type PeriodClose = Selectable<PeriodCloseTable>;
export type NewPeriodClose = Insertable<PeriodCloseTable>;

@Injectable()
export class PeriodCloseRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  findByQuarter(year: number, quarter: number): Promise<PeriodClose | undefined> {
    return this.db
      .selectFrom('period_close')
      .selectAll()
      .where('year', '=', year)
      .where('quarter', '=', quarter)
      .executeTakeFirst();
  }

  findAll(): Promise<PeriodClose[]> {
    return this.db.selectFrom('period_close').selectAll().orderBy('year', 'desc').orderBy('quarter', 'desc').execute();
  }

  /** Mark a quarter as filed. Idempotent — re-closing updates `closedAt`. */
  async close(input: { year: number; quarter: number; notes?: string | null }): Promise<PeriodClose> {
    return this.db
      .insertInto('period_close')
      .values({ year: input.year, quarter: input.quarter, closedAt: new Date(), notes: input.notes ?? null })
      .onConflict((oc) =>
        oc.columns(['year', 'quarter']).doUpdateSet({
          closedAt: new Date(),
          notes: input.notes ?? null,
          updatedAt: new Date(),
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async reopen(year: number, quarter: number): Promise<void> {
    await this.db.deleteFrom('period_close').where('year', '=', year).where('quarter', '=', quarter).execute();
  }
}
