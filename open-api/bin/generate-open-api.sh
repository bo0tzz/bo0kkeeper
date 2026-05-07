#!/usr/bin/env bash
# Regenerate the OpenAPI spec from the server and (re)build the typed SDK.
#
# Run from repo root: `mise run open-api`.
# Requires the server to compile cleanly (it's bootstrapped headless to walk
# its routes); does not need a running database.

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
ROOT_DIR=$(cd "$SCRIPT_DIR/../.." && pwd)
SDK_DIR="$ROOT_DIR/open-api/typescript-sdk"

cd "$ROOT_DIR"

pnpm --filter bo0kkeeper build
pnpm --filter bo0kkeeper sync:open-api

cp "$ROOT_DIR/server/server-openapi-specs.json" "$SDK_DIR/../server-openapi-specs.json"

cd "$SDK_DIR/.."
pnpm dlx oazapfts \
  --optimistic \
  --argumentStyle=object \
  --useEnumType \
  --allSchemas \
  server-openapi-specs.json \
  typescript-sdk/src/fetch-client.ts

pnpm --filter @bo0kkeeper/sdk build
