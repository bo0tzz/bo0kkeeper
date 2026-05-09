# Design decisions

Append entries; don't rewrite history. When a decision is reversed, add a new entry that supersedes — link it.

Format: `## Date — short title`, then a brief context, decision, and rationale.

---

## 2026-05-07 — Architecture mirrors Immich

Use Immich's `project-template` as the starting layout: NestJS server, SvelteKit static SPA web, `@immich/sql-tools` over Kysely for schema + migrations, `nestjs-zod` for boundary validation, `@immich/ui` + Tailwind 4 for the admin UI.

Why: user is an Immich developer day-to-day; mirroring conventions keeps cognitive overhead low and lets `@immich/*` packages plug in naturally.

Watch-fors: skip the heavy `BaseService`-with-50-deps pattern — start with explicit per-service deps and graduate later if the constructor list hurts. Use NestJS `ConsoleLogger` + `nestjs-cls` (per main Immich), not pino. No husky/lint-staged; rely on `mise run checklist`.

## 2026-05-07 — Postgres + Kysely + @immich/sql-tools

Decision over Drizzle / Prisma / TypeORM. Why: matches Immich; keeps SQL legible; types flow without runtime overhead.

## 2026-05-07 — pg-boss for queues, not BullMQ

Why: pg-boss is Postgres-backed (no Redis to operate). Immich uses BullMQ but doesn't need to be mirrored on this point.

The `@OnJob({ name, queue })` decorator pattern + `JobRepository.setup(services)` discovery + startup invariant ("every JobName has exactly one handler") is mirrored from Immich; only the underlying queue impl differs.

## 2026-05-07 — No in-process event bus

Skipping the `EventRepository.emit/@OnEvent` pattern from Immich. Every cross-component reaction in this system has consistency requirements; pg-boss covers all of it. Adding an in-process bus on top would add a class of "events that may be lost" that we don't actually need.

The `events` *table* still exists as the durable audit/idempotency log of external events.

## 2026-05-07 — OIDC: ID token in cookie, no DB session table

Single-user admin app; we don't need API keys, shared links, multi-device session metadata, or server-side specific-session revocation. Use `openid-client@^6`. ID token + refresh token in HttpOnly + Secure + SameSite=Lax cookies. Server verifies JWT signature against IDP JWKS on every request.

Trade-off: can't revoke a specific browser session before token expiry. With short-lived ID tokens (5–15 min) this is rarely a real concern. Add a session table later if it becomes one.

## 2026-05-07 — Auth from v1, never deferred

Secure-by-default, even on cluster-internal services. Never propose "skip auth for v1, add later" — the IDP is already running.

## 2026-05-07 — Forward-only cutover; no historical backfill

Everything before go-live already happened and stays as-is in the existing sheet / paperless. The system starts empty. Existing sheet rows have no `source` audit tag and that's fine.

Dev-mode replay of historical data for *testing the matching logic* is fine and expected — but never feeds the live sheet or Postgres.

## 2026-05-07 — Test-first, fixture-replay-driven Phase 1

Phase 1 (Wise webhook ingestion) is fully fixture-replay-tested locally before pointing at the live Wise webhook. The next real webhook is the first end-to-end **live** check, not the first end-to-end check.

`bin/scrub` transforms the user's local raw data into committable fixtures (deterministic but anonymized: consistent fake names per real name so cross-row matching still works, dates shifted, amounts perturbed, fake-but-checksum-valid IBANs). `bin/replay` POSTs fixtures to the actual webhook endpoint with valid signing, exercising the whole verify+ingest path.

## 2026-05-07 — Repo may go public; no raw bookkeeping data committed

User wants the option of open-sourcing. Anything in repo history must not contain real bookkeeping data: no real names, KvK, BTW IDs, IBANs, amounts. `data/` is gitignored. Test fixtures under `test/fixtures/` are scrubbed/synthesized, structurally accurate but with synthesized values.

## 2026-05-07 — Confirmation gate mandatory in v1

Every payment goes through an admin UI confirmation step before invoice number is allocated, PDF rendered, sheet row written. Auto-finalize for vanilla cases is future scope; we earn it by running clean for a while.

## 2026-05-07 — Match decisions are events

Every link from a bank tx to a transfer/invoice/expense (auto or manual) appends a `match_decisions` row. Audit trail; spot-checks queryable.

## 2026-05-07 — Money as bigint minor units; never JS `number`

All money columns are `bigint` cents/öre with explicit `currency`. Never `numeric` or JS `number`. `Temporal` polyfill (or `date-fns`) for dates; never native `Date`.

## 2026-05-07 — kasstelsel: sheet date = payment received date

Cash-basis BTW. Sheet rows dated to the payment-received date, not invoice issue date. BTW reported in the quarter when payment was received. Verified by existing data: invoice `2025/025` appears in Q1 2026 with payment-received date `08/01/2026`.

## 2026-05-07 — Single image, server serves web statically

Multi-stage Dockerfile builds server + web from monorepo root context. Final stage serves `web/build` via `sirv` from the same Node process. One k8s pod. Mirrors Immich.

## 2026-05-07 — Typst for invoice PDFs

Single static binary, sub-second renders, repo-versioned `.typ` templates per (trade name × client class). Cleaner than HTML→Puppeteer for invoice-shaped output.

## 2026-05-07 — mise tasks, not Makefile

The Makefile is an Immich-legacy artifact. We use mise tasks (`mise.toml`) for orchestration and version pinning (Node, pnpm).

## 2026-05-07 — Migrations: generated files, applied via Kysely's Migrator

Every schema change is captured as a numbered migration file under `server/src/schema/migrations/`. Files are *generated* by `pnpm migrations:generate <path>` (which calls `sql-tools migrations generate` against a live DB) — we never hand-edit them. The decorated table classes in `server/src/schema/tables/*.table.ts` are the source of truth; sql-tools diffs them against the running DB and emits the file.

Migrations are *applied* via Kysely's `Migrator` + `FileMigrationProvider`:
- In tests: `test/medium/globalSetup.ts` runs migrations against the testcontainers Postgres template DB.
- In prod: `pnpm migrations:run` (sql-tools CLI, reads from the built `dist/schema/migrations/`).

**Why generated files (not direct schema-from-code apply):** sql-tools is designed around versioned migration files. The direct-apply path through `schemaFromCode + schemaDiff(...).asSql()` produced incorrect SQL (it emitted DROP for declared extensions). The CLI path is the canonical and supported workflow.

**Watch-for:** sql-tools reads compiled JS from `dist/schema/`, which depends on `tsconfig.build.json` having `rootDir: "./src"` — without that, output lands in `dist/src/schema/` and the CLI can't find it. `tsconfig.json` keeps `rootDir: "."` so `tsc --noEmit` covers both `src/` and `test/`.

## 2026-05-08 — DB-backed `app_settings`, env seeds at boot then drops out

Operator-editable values that used to live as env vars (issuer KvK / VAT id / address / IBAN, paperless tag-gate names) move into a single-row `app_settings` table. `SettingsService.ensureInitialized` seeds the row from `process.env.*` on first boot; subsequent boots read from the DB and ignore env entirely.

**Why:** redeploying the pod every time the issuer's address changes was the wrong workflow — these are settings, not infra. A single-row table keeps the code simple (no per-key API), and seeding-once-from-env gives a clean migration without forcing a manual setup step on first boot. Secrets (Wise key, IDP client secret, Enable Banking creds) and infra config (DB URL, base URLs) explicitly stay in env — never displayed in the UI, never hot-editable.

**Watch-for:** the seed migration originally tried to populate the row via raw SQL with `${JSON.stringify(...)}::jsonb` in the migration template — Kysely/sql parameter-bound it and the array landed double-stringified. Fix was to do the seed via `SettingsService` using Kysely's typed query builder (which knows how to serialize jsonb). Same shape for any future single-row config tables.

## 2026-05-08 — Period close model: soft warning, not a hard block

`period_close` row per `(year, quarter)` marks a quarter as filed-with-the-accountant. Editing rows that fall inside a closed period surfaces a badge + warning on the aggregator page; nothing actually blocks the edit.

**Why:** corrections happen — mis-categorized rows surface weeks later, an expense gets re-OCR'd. A hard block would force the user to either reopen the period or work around the system; both are worse than a deliberate soft warning that says "the accountant has already used these numbers, are you sure?" The reopen path exists explicitly so the operator can take the action when needed.

**How to apply:** any new write surface (sheet writes, invoice edits, expense approval) that targets a row inside a closed period should at least *log* the event (audit), and the UI should warn. Don't add hard guards.

## 2026-05-09 — k8s deploy strategy: `Recreate`, not `RollingUpdate`

Single-replica homelab deploy. Default `RollingUpdate` (with `maxSurge=1`) creates a brief overlap window where old + new pods coexist; both run pg-boss workers pulling from the same queue. pg-boss claims via `FOR UPDATE SKIP LOCKED` so any individual job is processed exactly once, but two separately-queued jobs (cron + manual fire) can run concurrently across the two pods during the rollout window.

In practice the race is benign for our flows — bank-tx ingest is uniquely-keyed and only the winning insert proceeds to the matcher, and session metadata writes are last-writer-wins — but keeping it that way relies on every future writer thinking about it. Cleaner to avoid the overlap entirely.

**Decision:** k8s `Deployment.spec.strategy.type: Recreate`. Old pod stops cleanly before new pod starts. Trades a few seconds of API downtime, which is irrelevant for a bookkeeping app, in exchange for never having two pg-boss workers live at once.

**Watch-for:** if/when the deployment scales to multiple replicas (not planned), revisit. At that point pg-boss workers across pods are an intentional design property and the in-process invariants need a second look.

## 2026-05-09 — Native `Date` + ISO strings; pull in `luxon` only on demand

Supersedes the date half of the 2026-05-07 money-and-dates entry ("`Temporal` polyfill or `date-fns`; never native `Date`"). That was aspirational; through Phase 1–9 we never hit a need that justified it, and the codebase ended up using native `Date` everywhere. Settling on what's there.

**Decision:** native JS `Date` for in-memory values, ISO 8601 strings on the wire (DTOs and HTTP), `YYYY-MM-DD` slices for date-only fields. No date library imported by default.

**Why:** our date handling is shallow — parse-from-ISO, take `Date.now()`, compare, format. No multi-timezone display, no calendar arithmetic past `Date.UTC(year, 0, 1)` for year-bucketing. Adding luxon/date-fns/Temporal up front would buy nothing and add a dependency surface.

**When to revisit:** if and when we need real timezone-aware ops (e.g. surfacing rows in the user's local tz, or computing quarters on a non-UTC fiscal calendar), reach for **`luxon`** — that's what Immich uses, our reference architecture. Don't reach for `Temporal` (still stage-3, polyfill churn) or `date-fns` (function-per-import shape; awkward for a few helpers). The migration would be selective: keep native `Date` for storage/marshalling, use `DateTime` from luxon at the points that actually need arithmetic — same shape Immich runs.
