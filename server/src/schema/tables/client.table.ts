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
import { ColumnType } from 'kysely';
import { ClientClass, TradeName } from 'src/enum';

/**
 * One row per billed-or-billing party. Holds presentation defaults (trade name,
 * description, template) plus the matching hook for inbound payments
 * (`wiseSenderPattern`).
 */
@Table('client')
@Index({ name: 'client_wiseSenderPattern_idx', columns: ['wiseSenderPattern'] })
export class ClientTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @Column({ type: 'text' })
  name!: string;

  /** Tax/billing classification — drives BTW treatment and invoice template. */
  @Column({ type: 'character varying' })
  class!: ClientClass;

  /** Which trade-name issues invoices to this client. */
  @Column({ type: 'character varying' })
  tradeName!: TradeName;

  /** Structured address for the invoice header. */
  @Column({ type: 'jsonb' })
  address!: ColumnType<Record<string, unknown>>;

  /** Counterparty VAT ID for B2B EU; null otherwise. */
  @Column({ type: 'text', nullable: true })
  vatId!: string | null;

  /**
   * Substring match against Wise inbound `data.resource` / sender fields. Lets the
   * system route an inbound credit to the right client (e.g. payroll-provider name
   * for the regular US client). Null = manual matching only.
   */
  @Column({ type: 'text', nullable: true })
  wiseSenderPattern!: string | null;

  /** Default description for invoices to this client (e.g. "Provided services"). */
  @Column({ type: 'text', default: '' })
  defaultDescription!: Generated<string>;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}
