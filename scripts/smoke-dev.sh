#!/usr/bin/env bash
# Smoke-test the local dev stack: db, backend, vite proxy, key endpoints.
#
# Assumes services are already running:
#   - bo0kkeeper_postgres on :5432
#   - server on :2283
#   - web (vite dev) on :3000
#
# Run from repo root:
#   mise run smoke
# or directly:
#   bash scripts/smoke-dev.sh
#
# Exits non-zero on the first failure with a description of what went wrong.
# Designed to catch the wire-up bugs that don't show up in unit/medium tests.
set -euo pipefail

SERVER_PORT=${SERVER_PORT:-2283}
WEB_PORT=${WEB_PORT:-3000}
SERVER_URL="http://localhost:${SERVER_PORT}"
WEB_URL="http://localhost:${WEB_PORT}"

red() { printf '\033[31m%s\033[0m\n' "$1"; }
green() { printf '\033[32m%s\033[0m\n' "$1"; }
yellow() { printf '\033[33m%s\033[0m\n' "$1"; }

fail() {
  red "FAIL: $1"
  exit 1
}

pass() {
  green "PASS: $1"
}

# --- Postgres ---
if ! docker exec bo0kkeeper_postgres pg_isready -U postgres > /dev/null 2>&1; then
  fail "postgres not ready (expected container 'bo0kkeeper_postgres'). Run 'mise run dev' first."
fi
pass "postgres up"

# --- Backend health ---
status=$(curl -sS -o /dev/null -w '%{http_code}' "${SERVER_URL}/api/health")
if [[ "${status}" != "200" ]]; then
  fail "backend /api/health returned ${status}, expected 200. Is the server running on :${SERVER_PORT}?"
fi
pass "backend /api/health -> 200"

# --- Web shell loads ---
status=$(curl -sS -o /dev/null -w '%{http_code}' "${WEB_URL}/")
if [[ "${status}" != "200" ]]; then
  fail "web /  returned ${status}, expected 200. Is vite running on :${WEB_PORT}?"
fi
pass "web / -> 200"

# --- Vite proxy reaches backend (the bug we just hit) ---
status=$(curl -sS -o /dev/null -w '%{http_code}' "${WEB_URL}/api/health")
if [[ "${status}" != "200" ]]; then
  fail "web /api/health (proxied) returned ${status}, expected 200. Vite proxy is misconfigured (check SERVER_URL env / vite.config.ts target)."
fi
pass "vite proxy carries /api/* -> backend"

# --- Auth endpoints behave as expected (without a session) ---
status=$(curl -sS -o /dev/null -w '%{http_code}' "${WEB_URL}/api/auth/me")
if [[ "${status}" != "401" ]]; then
  fail "auth/me without cookie returned ${status}, expected 401. AuthGuard or the cookie middleware is misconfigured."
fi
pass "auth/me without cookie -> 401"

# --- /api/auth/login redirects to the IDP ---
location=$(curl -sS -o /dev/null -w '%{redirect_url}' "${WEB_URL}/api/auth/login?return_to=/")
if [[ -z "${location}" ]]; then
  fail "auth/login did not redirect. OIDC discovery may have failed (check OIDC_ISSUER reachability)."
fi
if ! [[ "${location}" =~ ^https?:// ]]; then
  fail "auth/login redirected to '${location}', expected an absolute IDP URL."
fi
pass "auth/login -> 302 to IDP (${location:0:60}...)"

# --- The redirect_uri sent to the IDP points at the FRONTEND port ---
# Vite's `changeOrigin: true` rewrites Host to the backend, which makes
# openid-client derive a redirect_uri pointing at :2283 — the IDP then rejects
# the token exchange because that doesn't match what /authorize received.
redirect_uri=$(echo "${location}" | python3 -c '
import sys, urllib.parse
url = sys.stdin.read().strip()
qs = urllib.parse.urlparse(url).query
params = urllib.parse.parse_qs(qs)
print(params.get("redirect_uri", [""])[0])
' 2>/dev/null)
if [[ -z "${redirect_uri}" ]]; then
  fail "auth/login redirect didn't include redirect_uri in the query — broken OIDC config."
fi
if [[ "${redirect_uri}" == *":${SERVER_PORT}/"* ]]; then
  fail "redirect_uri sent to IDP is '${redirect_uri}' (backend port). Vite proxy must NOT rewrite Host (changeOrigin: false), and OIDC_REDIRECT_URI in .env must point at :${WEB_PORT}."
fi
pass "redirect_uri sent to IDP uses the frontend port"

# --- IDP JWKS is populated (catches the empty-JWKS Authentik misconfig) ---
issuer=$(grep -E '^OIDC_ISSUER=' .env 2>/dev/null | cut -d= -f2- | tr -d "'\"")
if [[ -z "${issuer}" ]]; then
  yellow "SKIP: OIDC_ISSUER not in .env, can't probe JWKS"
else
  jwks_uri=$(curl -sS "${issuer%/}/.well-known/openid-configuration" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("jwks_uri",""))' 2>/dev/null || echo '')
  if [[ -z "${jwks_uri}" ]]; then
    fail "could not read jwks_uri from ${issuer}.well-known/openid-configuration. IDP unreachable?"
  fi
  jwks_body=$(curl -sS "${jwks_uri}")
  key_count=$(echo "${jwks_body}" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d.get("keys",[])))' 2>/dev/null || echo '0')
  if [[ "${key_count}" -lt 1 ]]; then
    fail "IDP JWKS at ${jwks_uri} has 0 keys. Set a Signing Key on the OIDC provider in your IDP."
  fi
  pass "IDP JWKS has ${key_count} key(s)"
fi

# --- Redirect URI matches the frontend port (catches the bug we hit today) ---
if grep -qE '^OIDC_REDIRECT_URI=.*:'"${SERVER_PORT}"'/' .env 2>/dev/null; then
  fail "OIDC_REDIRECT_URI in .env points at the BACKEND port (:${SERVER_PORT}). Set it to :${WEB_PORT}/api/auth/callback so the callback runs through the vite proxy and stays on the frontend origin."
fi
pass "OIDC_REDIRECT_URI not pointing at backend port"

green "ALL SMOKE CHECKS PASSED"
