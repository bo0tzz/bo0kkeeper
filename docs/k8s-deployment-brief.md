# bo0kkeeper — k8s deployment brief

Self-contained reference for whoever's writing the manifests. Pairs with the running Docker image; everything below is what the image already expects, nothing here is aspirational.

## What to deploy

**One Deployment.** Single image bundles the NestJS API + the SvelteKit static SPA — the server serves both. Single port, no sidecars, no separate web pod.

```
image:           ghcr.io/bo0tzz/bo0kkeeper:<tag>
port:            2283 (HTTP)
user:            node (uid 1000), set in image
replicas:        1
```

**Tags published by CI:**
- `latest` — head of main (rolling)
- `main` — same SHA as latest
- `sha-<short>` — commit-pinned, recommended for production manifests

Pin to `sha-<short>` so manifest changes are explicit. The image has no native arm support yet (amd64-only build); set `nodeSelector` / `runtimeClassName` accordingly if your cluster is mixed.

## Resources

No load testing has been done. Single-user steady state observed at ~140 MiB RSS / sub-1% CPU. Starting hint:

```yaml
resources:
  requests: { cpu: 50m,  memory: 256Mi }
  limits:   { cpu: 500m, memory: 512Mi }
```

Memory budget is generous because pg-boss runs in-process — a busy job period briefly inflates RSS.

## Dependencies the deploy needs to reach

| System | Direction | Required? | Notes |
|---|---|---|---|
| **Postgres 16+** | bo0kkeeper → DB | YES | All state. pg-boss queue lives here too. |
| **Authentik (OIDC IDP)** | bo0kkeeper → IDP, browser → IDP | YES | User auth; no OIDC = no app. |
| **paperless-ngx** | bo0kkeeper ↔ paperless | optional | Read receipts, upload invoice PDFs. Paperless webhook → bo0kkeeper at `/api/webhooks/paperless`. |
| **Wise API** | bo0kkeeper → api.transferwise.com | optional | Drafting transfers, reconciling state. Wise webhook → bo0kkeeper at `/api/webhooks/wise`. |
| **Google Sheets API** | bo0kkeeper → sheets.googleapis.com | optional | Writing income/expense rows. |
| **Enable Banking API** | bo0kkeeper → api.enablebanking.com, browser → IDP-style consent | optional | Bank tx sync via PSD2. |

"Optional" means the app boots fine without them, but the corresponding feature is dark. In practice for this user all six are required.

**Inbound reach:**
- `/api/webhooks/wise` — needs to be reachable from the public internet (Wise's servers POST here).
- `/api/webhooks/paperless` — only needs to be reachable from paperless. If paperless runs in the same cluster, internal Service routing is fine; doesn't have to be exposed publicly.

## Health probes

Both endpoints are public (no auth).

```yaml
livenessProbe:
  httpGet:  { path: /api/health,       port: 2283 }
  initialDelaySeconds: 10
  periodSeconds: 30
readinessProbe:
  httpGet:  { path: /api/health/ready, port: 2283 }
  initialDelaySeconds: 5
  periodSeconds: 10
```

- `/api/health` — process is up. Always 200 unless event-loop wedged. Liveness fail → restart.
- `/api/health/ready` — pings the DB (`SELECT 1`). Returns 503 with `{status: not_ready, reason}` if DB unreachable. Readiness fail → depool from Service, no restart.

## Migrations

Built-in. The server runs pending migrations at boot, before Nest's module init or HTTP listen — no init container, no pre-deploy Job. On a fresh DB the server creates all tables and starts; on an up-to-date DB it's a no-op. If migrations fail, boot fails, the readiness probe stays 503, and k8s leaves the pod un-routed.

Concurrent pods are safe (`kysely_migrations_lock` table serializes them) but you should still keep `replicas: 1` for the reasons in the section below.

## Env vars — non-secret (ConfigMap)

| Variable | Required | Default | Description |
|---|---|---|---|
| `NODE_ENV` | — | image sets `production` | Already defaulted in the Dockerfile runtime stage. Only override for non-prod variants. `production` triggers fail-closed refinements: WISE_WEBHOOK_VERIFY=true + WISE_WEBHOOK_PUBLIC_KEY set, PAPERLESS_WEBHOOK_TOKEN set, refuse-to-boot otherwise. |
| `HOST` | no | `0.0.0.0` | Bind address. Leave at default. |
| `PORT` | no | `2283` | Listening port. Match the Service. |
| `WEB_DIST_DIR` | YES | (image sets `/app/web`) | Where the static SPA lives. The image's ENV already sets this; don't override unless you're doing something exotic. |
| `CUTOVER_DATE` | YES | (unset = ingestion disabled) | `YYYY-MM-DD`. Forward-only floor for all ingest paths. Unset is a deliberate safety net — set it to your go-live date. |
| `COOKIE_SECURE` | YES | `true` | Must stay `true` in prod (HTTPS-only auth cookies). |
| `OIDC_ISSUER` | YES | — | Full Authentik application issuer URL, e.g. `https://auth.example.com/application/o/bo0kkeeper/`. |
| `OIDC_CLIENT_ID` | YES | — | OIDC client id registered in Authentik. |
| `OIDC_REDIRECT_URI` | YES | — | `https://<public-hostname>/api/auth/callback`. Must match what's registered in the IDP. |
| `OIDC_SCOPES` | no | `openid email profile offline_access` | Leave default. `offline_access` is required for refresh tokens. |
| `OIDC_POST_LOGIN_PATH` | no | `/` | Where to land users after a successful login. |
| `WISE_WEBHOOK_VERIFY` | YES | `true` | Production requires this to be `true`. Refuses to boot otherwise. |
| `WISE_API_BASE_URL` | no | `https://api.transferwise.com` | Production Wise. Override to `https://api.sandbox.transferwise.tech` only for sandbox testing. |
| `WISE_PROFILE_ID` | optional | — | Numeric Wise business profile id. Needed for drafting transfers. |
| `WISE_TARGET_RECIPIENT_ID` | optional | — | Wise recipient id of the user's Dutch bank account. Needed for drafting transfers. |
| `WISE_TXN_REFERENCE_START` | no | `0` | Starting offset for system-issued `TXN-NNNN` references. Leave at 0 unless re-deploying onto an existing reference space. |
| `PAPERLESS_BASE_URL` | optional | — | Paperless instance URL, no trailing slash. E.g. `https://paperless.example.com`. |
| `ENABLE_BANKING_API_BASE_URL` | no | `https://api.enablebanking.com` | Leave default. |
| `ENABLE_BANKING_REDIRECT_URI` | optional | — | `https://<public-hostname>/api/banking/auth/callback`. Required if using Enable Banking. |

Invoice-issuer info (KvK, VAT id, address, IBAN) and paperless tag-gates live in the `app_settings` DB row and are edited via `/settings` in the UI — not env vars. First boot seeds the row with `'CONFIGURE'` placeholders; configure those values via the UI before issuing invoices or ingesting expenses.

## Env vars — secrets (Secret, SOPS-managed)

Group these into a single `bo0kkeeper-secrets` Secret unless your tooling prefers otherwise.

| Variable | Required | Notes |
|---|---|---|
| `DB_URL` | YES (or split fields) | Full `postgres://user:pass@host:5432/dbname` URL. Either set this, or set the individual `DB_*` fields below. |
| `DB_HOST` | (alt to DB_URL) | |
| `DB_PORT` | (alt to DB_URL, default 5432) | |
| `DB_USERNAME` | (alt to DB_URL) | |
| `DB_PASSWORD` | (alt to DB_URL) | |
| `DB_DATABASE_NAME` | (alt to DB_URL, default `bo0kkeeper`) | |
| `OIDC_CLIENT_SECRET` | YES | Confidential-client secret from Authentik. Required for token exchange. |
| `WISE_WEBHOOK_PUBLIC_KEY` | YES | RSA public key (PEM, multi-line) for verifying Wise webhook signatures. The **production** Wise public key — different from sandbox. Get from Wise dashboard after registering the live webhook subscription. |
| `WISE_API_TOKEN` | optional | Personal API token. Needed for drafting transfers and the reconcile cron. |
| `PAPERLESS_TOKEN` | optional | API token from paperless's user admin → API auth. |
| `PAPERLESS_WEBHOOK_TOKEN` | YES (prod refinement) | Shared secret. Paperless workflow must include `Authorization: Bearer <this>` header on webhook posts. |
| `ENABLE_BANKING_APP_ID` | optional | UUID from Enable Banking dashboard. |
| `ENABLE_BANKING_PRIVATE_KEY` | optional | RSA private key (PEM) for signing Enable Banking JWTs. |
| `SHEETS_SERVICE_ACCOUNT_EMAIL` | optional | `<account>@<project>.iam.gserviceaccount.com`. |
| `SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY` | optional | RSA private key (PEM, multi-line) from the GCP service account JSON. |
| `SHEETS_SPREADSHEET_ID` | optional | Sheet id from the gdrive URL. |

**Multi-line PEM values**: in k8s Secrets, store as a literal block with real newlines. The app reads them verbatim from `process.env`, so they have to be parseable by `jose.importPKCS8` / `importSPKI` as-written. (For SOPS, encrypt the PEM with newlines intact; don't `\n`-escape.)

## Networking

- **Service**: ClusterIP on 2283.
- **Ingress**: terminate TLS, route `/` to the Service. No path-based split needed — the server handles both API (`/api/*`) and SPA fallback for everything else.
- **Webhook reachability**: the public hostname must accept POST at `/api/webhooks/wise` (Wise's servers POST here). `/api/webhooks/paperless` only needs to be reachable from paperless — internal-cluster routing is enough if paperless lives in the same cluster. Both endpoints verify signatures/tokens; the Wise one is safe to expose without IP allowlisting.
- **Outbound**: needs egress to all listed external dependencies. No DNS-pin / proxy gymnastics required.

## What NOT to do

- **Don't mount a PVC.** The server is stateless. Persistent state lives in Postgres only. Logs to stdout; let the cluster's log shipper handle them.
- **Don't add an HPA.** Solo-user workload — no scaling pressure has been observed. pg-boss + cookie-based auth state mean multi-replica would technically work, but at this scale it's noise. Stay at `replicas: 1`.
- **Don't set `CUTOVER_DATE` to a date earlier than your actual cutover.** Every ingest path drops events with `occurredAt < CUTOVER_DATE` and records `ingest.dropped_before_cutover` audit events. Setting it permissively (e.g. `2000-01-01`) re-enables ingest for arbitrarily-old data — only do that in dev.

## First-deploy checklist

1. Seed the Postgres database (cluster + DB + user). Note credentials.
2. Register an OIDC client in Authentik with redirect URI `https://<host>/api/auth/callback`. Note client id + secret.
3. Register Wise webhook subscription pointing at `https://<host>/api/webhooks/wise`. Capture the production public key.
4. Configure paperless workflow with webhook target `https://<host>/api/webhooks/paperless` and `Authorization: Bearer <shared-secret>` header. Note the shared secret.
5. (If using Sheets) Create GCP service account, share the target spreadsheet with its email, download the JSON key. Extract the PEM private key.
6. (If using Enable Banking) Register application, generate keypair, configure redirect URI `https://<host>/api/banking/auth/callback`.
7. (If issuing invoices via bo0kkeeper) Seed the invoice number sequence so the first system-issued invoice continues from your last manually-issued one — see `docs/cutover.md` or the project memory.
8. Apply manifests. Migrations run as init container. Server boots, healthcheck flips green, /system page shows integration status.
