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
import { BankingSessionStatus } from 'src/enum';

/**
 * One row per Enable Banking PSD2 consent session. The lifecycle is:
 * pending (auth started) → active (callback completed) → expired / revoked.
 *
 * `oauthState` is the random token we send into Enable Banking's `/auth` and
 * receive back as a query string on the redirect; it ties an in-flight auth
 * to its caller so the callback handler can find the right pending row.
 *
 * `accountsJson` mirrors the `accounts[]` array Enable Banking returns from
 * `POST /sessions`: each entry has a stable `uid` we use for follow-up
 * `/accounts/{uid}/transactions` calls. We store the full payload for audit
 * and so the admin UI can show IBAN/owner without a re-fetch.
 *
 * `lastSyncedAt` is a session-wide watermark used as `date_from` on the next
 * cron pull. The over-pull is fine — `bank_transaction` has a unique
 * `(source, externalId)` index so re-fetched rows are no-ops.
 */
@Table('banking_session')
@Index({ name: 'banking_session_oauthState_uq', unique: true, columns: ['oauthState'] })
@Index({ name: 'banking_session_status_idx', columns: ['status'] })
export class BankingSessionTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @Column({ type: 'uuid' })
  oauthState!: string;

  @Column({ type: 'text' })
  aspspName!: string;

  @Column({ type: 'text' })
  aspspCountry!: string;

  @Column({ type: 'text' })
  psuType!: string;

  @Column({ type: 'character varying' })
  status!: BankingSessionStatus;

  /** Enable Banking's `session_id`. Null while `status = pending`. */
  @Column({ type: 'text', nullable: true })
  applicationSessionId!: string | null;

  /** Full accounts[] from POST /sessions. Null while `status = pending`. */
  @Column({ type: 'jsonb', nullable: true })
  accountsJson!: ColumnType<unknown[] | null>;

  /** PSU consent expiry (PSD2 caps at 90 days). Null while pending. */
  @Column({ type: 'timestamp with time zone', nullable: true })
  expiresAt!: Timestamp | null;

  /** Session-wide cursor for incremental tx pulls. Null until first sync. */
  @Column({ type: 'timestamp with time zone', nullable: true })
  lastSyncedAt!: Timestamp | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}
