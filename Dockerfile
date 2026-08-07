# syntax=docker/dockerfile:1.25@sha256:0adf442eae370b6087e08edc7c50b552d80ddf261576f4ebd6421006b2461f12

# ---- Stage: typst --------------------------------------------------------
# Pulls the typst CLI binary by version. We use it to compile invoice
# templates to PDFs at runtime, so the runtime image needs `typst` on PATH.
FROM debian:13-slim@sha256:020c0d20b9880058cbe785a9db107156c3c75c2ac944a6aa7ab59f2add76a7bd AS typst
ARG TYPST_VERSION=0.13.1
ARG TARGETARCH
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl xz-utils; \
    case "$TARGETARCH" in \
      amd64) typst_arch="x86_64-unknown-linux-musl";; \
      arm64) typst_arch="aarch64-unknown-linux-musl";; \
      *) echo "unsupported arch: $TARGETARCH"; exit 1;; \
    esac; \
    curl -fsSL "https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/typst-${typst_arch}.tar.xz" \
      | tar -xJf - -C /tmp; \
    mv "/tmp/typst-${typst_arch}/typst" /usr/local/bin/typst; \
    chmod +x /usr/local/bin/typst; \
    typst --version

# ---- Stage: deps ---------------------------------------------------------
# Install ALL workspace dependencies (server + web + open-api sdk). Cached
# on the lockfile alone — code edits don't bust this layer.
FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS deps
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
COPY open-api/typescript-sdk/package.json ./open-api/typescript-sdk/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ---- Stage: build --------------------------------------------------------
# Compile the SvelteKit static site + nest build the server. Output:
#   /app/web/build/        — static SPA bundle (precompressed)
#   /app/server/dist/      — compiled server JS
FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS build
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY --from=deps /app/web/node_modules ./web/node_modules
COPY --from=deps /app/open-api/typescript-sdk/node_modules ./open-api/typescript-sdk/node_modules
COPY . .
RUN pnpm --filter web build \
 && pnpm --filter bo0kkeeper build

# ---- Stage: prod-deps ----------------------------------------------------
# Re-resolve a production-only node_modules graph for the server. Drops
# devDependencies (vitest, eslint, prettier, etc.) so the runtime image
# stays smaller.
FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS prod-deps
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
COPY open-api/typescript-sdk/package.json ./open-api/typescript-sdk/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter bo0kkeeper

# ---- Stage: runtime ------------------------------------------------------
FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS runtime
# Build identifier — CI passes the release tag (e.g. `0.4.3`) or short SHA.
# Surfaced in startup logs + `/api/system/info` so the running build
# uniquely identifies a commit. `dev` is the fallback when this image is
# built locally without CI passing a value.
ARG APP_VERSION=dev
ENV NODE_ENV=production \
    APP_VERSION=$APP_VERSION \
    WEB_DIST_DIR=/app/web \
    PORT=2283 \
    HOST=0.0.0.0
WORKDIR /app/server

# Typst is invoked via PATH from RenderService. Install runtime libs the
# typst static binary needs (libc + fontconfig for system font discovery).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*
COPY --from=typst /usr/local/bin/typst /usr/local/bin/typst

# Server dist + production node_modules (server-scoped).
COPY --from=build     /app/server/dist          /app/server/dist
COPY --from=build     /app/server/src/templates /app/server/src/templates
COPY --from=prod-deps /app/server/node_modules  /app/server/node_modules
COPY --from=prod-deps /app/node_modules         /app/node_modules
COPY                   server/package.json       /app/server/package.json

# Built SvelteKit static SPA bundle. Served by NestJS at /.
COPY --from=build /app/web/build /app/web

EXPOSE 2283

# Drop to a non-root user. Node's default `node` user (uid 1000) already
# exists in node:bookworm-slim.
USER node

# Container HEALTHCHECK hits the readiness probe so docker/k8s see "healthy"
# only when the process is up AND the DB ping succeeds. K8s deployments
# should also wire a separate liveness probe at /api/health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||2283)+'/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "/app/server/dist/main.js"]
