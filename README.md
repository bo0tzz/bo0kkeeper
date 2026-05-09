# bo0kkeeper

Bookkeeping automation for a Dutch zzp. Replaces a manual workflow around Wise (USD income), a Dutch bank, paperless-ngx (receipts), a Google Sheets spine, and a quarterly Excel template for the accountant's BTW-aangifte.

## Stack

- **Server**: NestJS, Kysely + `@immich/sql-tools`, Postgres, pg-boss, Zod, OIDC.
- **Web**: SvelteKit (static SPA), `@immich/ui`, Tailwind 4, OpenAPI-generated SDK.
- **PDF**: Typst as a subprocess.
- **Deployment**: homelab Kubernetes.

## Quick start

```bash
mise install                              # install Node + pnpm at the pinned versions
mise run install                          # pnpm install across the workspace
mise run dev                              # bring up Postgres (docker-compose, foreground)
pnpm --filter bo0kkeeper migrations:run   # apply schema migrations
mise run seed                             # OPTIONAL: synthetic clients/invoices/expenses for the UI
pnpm --filter bo0kkeeper start:dev        # run the server in watch mode (port 2283)
pnpm --filter web dev                     # run the SvelteKit dev server (port 3000)
mise run smoke                            # verify the wire-up — db, backend, vite proxy, auth
```

Open http://localhost:3000. The vite dev server proxies `/api/*` to the backend, so everything stays on a single origin.

### IDP configuration (Authentik or other OIDC provider)

The OIDC client must allow **`http://localhost:3000/api/auth/callback`** as a redirect URI — the callback runs through the vite proxy so cookies stay on the frontend origin. The provider also needs a **Signing Key** configured on the OIDC provider; without it `/jwks` returns `{}` and JWT verification fails (the smoke-test script catches this).

The default `OIDC_SCOPES` includes **`offline_access`** so the IDP issues a refresh token (the silent-refresh path on the API client uses it to swap in a fresh ID token without bouncing the user through the login flow). The OIDC client at the IDP must allow that scope; otherwise refresh fails and the client falls through to the existing login redirect on each cookie expiry.

### Ingestion floor — `CUTOVER_DATE`

Every live ingestion path (Wise webhooks, paperless webhooks, Enable-Banking sync) drops events whose own date is before `CUTOVER_DATE` (`YYYY-MM-DD`). When the env var is **unset, ingestion is disabled entirely** — a fresh deployment can't start eating pre-go-live data before the operator's set things up. Set it to your go-live date in prod; set it permissively (`2000-01-01`) in dev so synthetic fixtures and replay flows just work.

### Google Sheets configuration

The accountant-facing sheet uses service-account JWT auth — no OAuth flow. One-time setup:

1. **GCP project**: at [console.cloud.google.com](https://console.cloud.google.com), create or pick a project (e.g. `bo0kkeeper-dev`).
2. **Enable the Sheets API**: APIs & Services → Library → Google Sheets API → Enable.
3. **Service account**: IAM & Admin → Service Accounts → Create. Name it (e.g. `bo0kkeeper-sheets`); skip the "grant access" step. Note the email (`<name>@<project>.iam.gserviceaccount.com`).
4. **Key**: open the new account → Keys → Add Key → Create new key → JSON → download. The JSON contains a `client_email` and `private_key`.
5. **Spreadsheet**: create a fresh Google Sheet for dev (e.g. `bo0kkeeper-dev-sheet`). Copy the long id from the URL (`docs.google.com/spreadsheets/d/<this part>/edit`).
6. **Share**: in the spreadsheet's Share dialog, paste the service-account email and give it **Editor** access. (Without this, every API call returns 403 — the service account is just another user that needs access.)
7. **Env**: in `.env`, paste the three values from the JSON + the id:
   ```
   SHEETS_SERVICE_ACCOUNT_EMAIL=<client_email from JSON>
   SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
   SHEETS_SPREADSHEET_ID=<id from the URL>
   ```
   The private key needs literal `\n` for newlines inside the quoted string (or use `$'…'` in zsh to embed real newlines). The shape from the JSON file works as-is if you escape its newlines.
8. **Restart the server** so it re-reads `.env`.
9. **Verify** with the smoke command:
   ```
   pnpm --filter bo0kkeeper exec tsx src/bin/sheets-smoke.ts          # read-only — lists tabs
   pnpm --filter bo0kkeeper exec tsx src/bin/sheets-smoke.ts --write  # also appends to a "smoke-test" tab
   ```
   Read-only first to confirm auth + share. Then `--write` to confirm append works.

Once configured, the `/system` page will switch Google Sheets from `not_configured` to `healthy`, and live invoice / bank-match flows will append rows.

### Resetting state

```bash
mise run dev-down && mise run dev         # nuke + relaunch postgres
pnpm --filter bo0kkeeper migrations:run   # re-apply migrations
mise run seed                             # re-seed the demo data
```

## Layout

```
server/    NestJS REST API
web/       SvelteKit static SPA
docker/    Docker Compose for local Postgres + dev services
docs/      Architecture, schema, phasing, decisions
data/      (gitignored) raw real bookkeeping inputs — input to the scrubber, never committed
```

## Testing

Five layers, increasing in scope:

| Layer | Command | What it covers |
|---|---|---|
| Unit | `mise run test-server` | Pure function tests (parsers, formatters, adapters with mocks). Fast, no I/O. |
| Medium | `mise run test-medium` | Repositories + services against a real Postgres (testcontainers, per-test cloned DB). Mocks Wise/paperless/sheets HTTP. |
| E2E auth | `mise run test-e2e` | Boots a real Nest app + an in-process fake OIDC IDP, walks login → callback → `/api/auth/me` with a cookie jar. Catches JWKS, cookie scoping, OIDC discovery, and AuthGuard regressions. |
| Smoke | `mise run smoke` | Hits the **running** dev stack and asserts wire-up: db reachable, vite proxy targets backend, `/api/auth/login` redirects to the configured IDP, IDP JWKS is non-empty, redirect URI is on the frontend port. Run after any infra/env change. |
| Web | `mise run test-web` | SvelteKit unit tests (vitest, jsdom). |
| Browser e2e | `pnpm --filter web test:browser` | Playwright against the **running** dev stack (server + web + IDP). Smokes every nav route and exercises the higher-leverage flows (settings tag-check, system health refresh, compose-form validation). Auth state is reused from `tools/browser-harness/state.json`; bootstrap with `node tools/browser-harness/refresh-state.mjs` if your IDP session has expired. |

`mise run test` runs everything except smoke + browser e2e (both assume a running stack).
`mise run checklist` adds format + lint + typecheck.

## Documentation

See `docs/README.md` for the index. Key reads:

- `docs/overview.md` — system architecture
- `docs/domain.md` — bookkeeping conventions
- `docs/schema.md` — DB tables
- `docs/phasing.md` — rollout plan
- `docs/decisions.md` — design decisions
