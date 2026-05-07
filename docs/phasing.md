# Phasing

Each phase ends in a deployable, useful state. Early phases don't touch external state.

## Phase 0 — Foundations

Workspace, Dockerfile, k8s manifests, mise tasks. Postgres + Kysely + `@immich/sql-tools` wired. OIDC working against the user's IDP. Empty admin shell with `@immich/ui`. Logging, errors, Zod, vitest + testcontainers all green. Event log table + repository + pg-boss worker plumbing. **No business logic yet.** Goal: deployable infra.

Sub-phases:

- **0a** workspace skeleton (root configs, mise, gitignore, README, docs)
- **0b** server NestJS scaffold
- **0c** web SvelteKit + `@immich/ui` scaffold
- **0d** DB layer (Kysely + sql-tools + events table + first migration)
- **0e** tests with testcontainers + Postgres template-DB pattern
- **0f** OIDC auth (server + frontend guard)
- **0g** pg-boss worker plumbing + `@OnJob` discovery + startup invariant
- **0h** fixture/scrub + replay tooling

## Phase 1 — Wise webhook ingestion (observe-only)

RSA-SHA256 verify, idempotent INSERT into `events`, return 200. Admin UI event log browser (filter, drill into payload, retry failed). **No drafts, no invoices, no sheet writes.**

**Test gate:** Phase 1 is fixture-replay-driven before pointing at the live Wise webhook. Build out the endpoint and verify against scrubbed historical payloads end-to-end *first*; then point production Wise at it for the next real paycheck. The next real webhook is the first end-to-end live check, not the first end-to-end check.

Goal: when the next paycheck hits, we see the credit event in our DB and confirm shapes match assumptions before any side effects.

## Phase 2 — Wise drafting + outgoing observation

Wise API client (create quote, draft USD→EUR transfer in one operation). Admin UI: pending-review queue for inbound credits → approve → system drafts transfer in Wise. User SCAs in Wise app. System observes outgoing webhooks, records `wise_transfers` state machine. **Still no invoices, no sheet writes.** Goal: full Wise round-trip is automated up to (but not including) external artifact creation.

## Phase 3 — Invoice generation + paperless

Typst templates per (trade name × client class). Admin UI prompts post-`outgoing_payment_sent` for invoice composition (description, period, line items). Render PDF, allocate next invoice number from `invoice_number_sequence`, push to paperless. Goal: invoices land in paperless automatically per Wise payment.

**Watch:** invoice numbering must be gap-free; allocation + paperless write happen together with the event marked processed.

## Phase 4 — Sheet writes

Google Sheets service-account auth. Append to current quarter tab. Auto-create new quarter tab when needed. Goal: full Wise income cycle ends with a sheet row.

## Phase 5 — Bank ingestion + matching

SNS CSV importer (dev/manual until Enable Banking is wired). `bank_transactions` event ingestion. Auto-match: `TXN-NNNN` reference in description → `wise_transfers`; invoice number in description → `invoices`. Unmatched-bank-tx review queue. Manual link + categorize-without-document path.

## Phase 6 — Expense pipeline

paperless 2.x webhook receiver. OCR-extracted data → admin UI review queue with editable fields. Approve → sheet row. Two-stage review enforced.

## Phase 7 — Quarterly aggregator

Filter sheet rows by quarter, map category → BTW rubriek, populate accountant's Excel template. Validation gates (refuses to produce until clean). Filled template + validation report + summary view.

## Phase 8 — Domestic invoice composer

Compose UI (line items, BTW rate, optional SNS betaalverzoek URL paste-in). Same render pipeline as Wise-flow invoices.

## Phase 9 — Enable Banking

Replace SNS CSV path with live AISP integration. 90/180-day session reauth handled in admin UI.

## Future / out-of-scope for v1

- Auto-finalize for vanilla Wise income (skip the admin UI confirmation when match is exact). Earned only when system has run cleanly for several cycles.
- Auto-emailing of domestic invoices.
- Yearly aggregator (accountant currently combines quarterlies manually).
- Authentik/Authelia user management (single user; OIDC at the IDP is enough).
