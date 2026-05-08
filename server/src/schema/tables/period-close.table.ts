import {
  Column,
  CreateDateColumn,
  Generated,
  Index,
  PrimaryGeneratedColumn,
  Table,
  Timestamp,
  UpdateDateColumn,
} from '@immich/sql-tools';

/**
 * One row per filed-with-the-accountant quarter. Existence of a row marks
 * the period as "closed": the user shouldn't be editing rows that fall
 * inside it because the accountant has already used those numbers. The
 * application surfaces this via a badge + warning rather than a hard
 * block — corrections happen, but they need to be deliberate.
 */
@Table('period_close')
@Index({ name: 'period_close_year_quarter_uq', unique: true, columns: ['year', 'quarter'] })
export class PeriodCloseTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @Column({ type: 'integer' })
  year!: number;

  /** 1..4. Yearly aggregation is out of scope (the accountant handles it). */
  @Column({ type: 'integer' })
  quarter!: number;

  /** When the user marked this period as filed. Distinct from updatedAt. */
  @Column({ type: 'timestamp with time zone' })
  closedAt!: Timestamp;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}
