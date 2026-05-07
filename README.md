# bo0kkeeper

Bookkeeping automation for a Dutch zzp. Replaces a manual workflow around Wise (USD income), a Dutch bank, paperless-ngx (receipts), a Google Sheets spine, and a quarterly Excel template for the accountant's BTW-aangifte.

## Stack

- **Server**: NestJS, Kysely + `@immich/sql-tools`, Postgres, pg-boss, Zod, OIDC.
- **Web**: SvelteKit (static SPA), `@immich/ui`, Tailwind 4, OpenAPI-generated SDK.
- **PDF**: Typst as a subprocess.
- **Deployment**: homelab Kubernetes.

## Quick start

```bash
mise install                  # install Node + pnpm at the pinned versions
mise run install              # pnpm install across the workspace
mise run dev                  # bring up Postgres locally
pnpm --filter bo0kkeeper start:dev   # run the server in watch mode
pnpm --filter web dev                # run the SvelteKit dev server
```

## Layout

```
server/    NestJS REST API
web/       SvelteKit static SPA
docker/    Docker Compose for local Postgres + dev services
docs/      Architecture, schema, phasing, decisions
data/      (gitignored) raw real bookkeeping inputs — input to the scrubber, never committed
```

## Documentation

See `docs/README.md` for the index. Key reads:

- `docs/overview.md` — system architecture
- `docs/domain.md` — bookkeeping conventions
- `docs/schema.md` — DB tables
- `docs/phasing.md` — rollout plan
- `docs/decisions.md` — design decisions
