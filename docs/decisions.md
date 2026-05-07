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
