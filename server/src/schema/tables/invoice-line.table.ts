import { Column, ForeignKeyColumn, Generated, Index, PrimaryGeneratedColumn, Table } from '@immich/sql-tools';
import { ColumnType } from 'kysely';
import { InvoiceTable } from 'src/schema/tables/invoice.table';

/**
 * Per-line breakdown of an invoice. For single-item invoices (e.g. regular
 * non-EU paychecks) a single row carries the whole amount. For multi-line
 * invoices (paycheck + bonus + reimbursement; design + 3D printing) each
 * line gets its own row.
 *
 * `unitLabel` and `quantity` are display strings — they vary in shape
 * (`€15/hr`, `€25/kg`, `x3`, `1.3kg`, `11 hours`) so there's no value in
 * structuring them numerically.
 */
@Table('invoice_line')
@Index({ name: 'invoice_line_invoiceId_idx', columns: ['invoiceId'] })
export class InvoiceLineTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => InvoiceTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  invoiceId!: string;

  @Column({ type: 'integer' })
  ordinal!: number;

  @Column({ type: 'text' })
  description!: string;

  @Column({ type: 'text', nullable: true })
  unitLabel!: string | null;

  @Column({ type: 'text', nullable: true })
  quantity!: string | null;

  @Column({ type: 'bigint' })
  lineTotalMinor!: ColumnType<bigint>;
}
