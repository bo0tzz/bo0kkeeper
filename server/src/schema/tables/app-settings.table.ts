import {
  Column,
  CreateDateColumn,
  Generated,
  PrimaryGeneratedColumn,
  Table,
  Timestamp,
  UpdateDateColumn,
} from '@immich/sql-tools';
import { ColumnType } from 'kysely';

/**
 * Single-row table for operator-editable application settings. Things that
 * aren't secrets and aren't infra (deployment-specific URLs etc.) live here
 * so they can be edited from the /settings page without an env edit and a
 * redeploy.
 *
 * Initial values are seeded from environment variables in the migration that
 * creates this table — existing dev installs come up with their familiar
 * config; after that, env is no longer consulted for these fields.
 *
 * What lives here:
 * - Issuer info (KvK, VAT id, full address, IBAN) — printed on every invoice
 * - Paperless tag names — used by the ingest webhook + invoice archive
 *
 * What does NOT live here:
 * - Secrets (API tokens, RSA keys, OIDC client secret) — env only
 * - Infra (DB URL, OIDC issuer, base URLs) — deployment-specific, env only
 * - One-time init values (cutover date, TXN reference start) — env only
 */
@Table('app_settings')
export class AppSettingsTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  // ─── Issuer (printed on invoices) ───────────────────────────────────────
  @Column({ type: 'text' })
  issuerKvk!: string;

  @Column({ type: 'text' })
  issuerVatId!: string;

  @Column({ type: 'text' })
  issuerAddressLine1!: string;

  @Column({ type: 'text' })
  issuerPostalCode!: string;

  @Column({ type: 'text' })
  issuerCity!: string;

  @Column({ type: 'text' })
  issuerCountry!: string;

  @Column({ type: 'text' })
  issuerIban!: string;

  // ─── Paperless tags ─────────────────────────────────────────────────────
  /** Tag NAMES required on a paperless doc for it to register as an expense. */
  @Column({ type: 'jsonb' })
  paperlessExpenseTags!: ColumnType<string[]>;

  /** Tag NAMES applied to invoices uploaded to paperless. Auto-created if missing. */
  @Column({ type: 'jsonb' })
  paperlessOutgoingInvoiceTags!: ColumnType<string[]>;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}
