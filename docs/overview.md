# System overview

bo0kkeeper observes financial events from Wise, the bank, and paperless-ngx; surfaces decisions for human confirmation in an admin UI; and writes canonical artifacts (invoice PDFs into paperless, rows into the accountant-facing Google Sheet) once the user approves.

## Three canonical stores

| Store | Role | Backed up |
|---|---|---|
| **Postgres** | Operational state: events log, idempotency, job queue, invoice number sequence, state tables | Yes (operational backup) |
| **Google Sheet** | Accountant-facing record, source of truth for transactions | Yes (gdrive-level) |
| **Paperless-ngx** | Document archive: invoices issued + receipts + bills | Yes (paperless's own backup story) |

The sheet + paperless together satisfy the 7-year *bewaarplicht*. Postgres is operational; in principle replayable from external sources, but operationally backed up directly.

## Components

```
                    ┌──────────────┐
                    │     IDP      │  OIDC
                    └──────┬───────┘
                           │
   ┌───────────────────────▼────────────────────────────┐
   │                  bo0kkeeper                         │
   │                                                     │
   │  ┌──────────┐  ┌──────────────┐  ┌──────────────┐ │
   │  │ Web (SK) │──│ Server (Nest)│──│ pg-boss jobs │ │
   │  └──────────┘  └──────┬───────┘  └──────┬───────┘ │
   │                       │                  │         │
   │                       ▼                  ▼         │
   │                  ┌────────────────────────────┐   │
   │                  │       Postgres             │   │
   │                  │  events + state tables     │   │
   │                  └────────────────────────────┘   │
   └────┬───────────────┬──────────────┬──────────────┬┘
        │               │              │              │
        ▼               ▼              ▼              ▼
    ┌───────┐    ┌──────────┐    ┌─────────┐    ┌──────────┐
    │ Wise  │    │  Bank    │    │paperless│    │  Google  │
    │webhook│    │(EnableB  │    │  -ngx   │    │  Sheets  │
    │       │    │ /CSV dev)│    │         │    │          │
    └───────┘    └──────────┘    └─────────┘    └──────────┘
```

The webhook receiver is the only public ingress; everything else stays cluster-internal.

## Event log + jobs pattern

**Append-then-side-effect**:

1. External event arrives (Wise webhook, paperless webhook, bank tx ingestion).
2. Server **verifies** + **idempotent INSERT** into `events` table (unique on `(source, external_id)`, `ON CONFLICT DO NOTHING`).
3. Server **enqueues a pg-boss job** to process the event.
4. Server returns 200 (within Wise's 5-second ack window).
5. pg-boss worker picks up the job, runs the handler in a single transaction:
   - Read the event row.
   - Apply state-table writes (transfers, invoices, bank_transactions, etc.).
   - Mark the event `processed`.
   - Possibly enqueue follow-up jobs.
6. State tables are written **only** by event handlers, never directly. They can in principle be rebuilt by replaying events — that's a property of the design, not an operational feature (we don't backfill).

This gives idempotency by construction, durable workflows, dry-runnable side effects, and an auditable history.

## Idempotency

Every external event is keyed on its source UUID:

- Wise: `data.delivery_id` (or transfer/balance UUID, depending on event type)
- Paperless: document ID
- Bank: tx UUID (from Enable Banking) or `(account, date, sequence)` (from CSV)

The unique index on `events(source, external_id)` is the deduplication mechanism. Replays are safe.

## Confirmation gates

Every payment goes through a human confirmation step in the admin UI before any external artifact is created or modified. Auto-finalize for "vanilla" cases is future scope (see `decisions.md`).

For a Wise income payment, there are two gates:
1. **SCA tap in the Wise app** to fund the drafted USD→EUR transfer (Wise's gate).
2. **Admin UI review** before invoice number is allocated, PDF rendered to paperless, sheet row written (our gate).

For an unknown inbound (some other USD lands), the admin UI review gate covers categorization with no invoice path.

## Auth

OIDC against the user's existing IDP. ID token in HttpOnly+Secure cookie, refresh token in second cookie. Server verifies JWT signature against IDP JWKS on every request. No DB session table. Logout = clear cookies + RP-Initiated Logout to IDP.

## Match decisions are themselves events

When the system links a bank tx to a Wise transfer or to an invoice (auto or manually), it appends a `match_decisions` row. This is the audit trail; spot-checks can query it.
