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

`mise run test` runs everything except the smoke test (which assumes a running stack).
`mise run checklist` adds format + lint + typecheck.

Browser-level e2e is intentionally not in the suite yet — Playwright is the right tool when the UI surface stabilises.

## Documentation

See `docs/README.md` for the index. Key reads:

- `docs/overview.md` — system architecture
- `docs/domain.md` — bookkeeping conventions
- `docs/schema.md` — DB tables
- `docs/phasing.md` — rollout plan
- `docs/decisions.md` — design decisions
