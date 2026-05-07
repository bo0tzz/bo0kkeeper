import { Column, PrimaryColumn, Table } from '@immich/sql-tools';

/**
 * Invoice numbers are year-restarted (`YYYY/NNN`) and gap-free across all
 * clients. One row per year. Allocation uses an upsert pattern so the first
 * invoice of a year auto-creates the row.
 */
@Table('invoice_number_sequence')
export class InvoiceNumberSequenceTable {
  @PrimaryColumn({ type: 'integer' })
  year!: number;

  @Column({ type: 'integer', default: 0 })
  lastNumber!: number;
}
