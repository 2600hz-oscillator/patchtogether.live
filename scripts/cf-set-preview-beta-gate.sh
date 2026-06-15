#!/usr/bin/env bash
#
# scripts/cf-set-preview-beta-gate.sh
#
# Ensure the PR-preview beta gate is UP by setting BETA_GATE_PASS as a
# secret_text env var on the PREVIEW deployment-config scope of the
# `patchtogether-live-autotest` Cloudflare Pages project.
#
# WHY THIS EXISTS / THE SCOPE MODEL
#   PR previews deploy to branch `pr-<N>` on the autotest Pages project. A
#   non-production branch reads its RUNTIME env from the project's PREVIEW
#   deployment-config scope — NOT the Production scope (which serves
#   autotest.patchtogether.live). The runtime beta gate (hooks.server.ts)
#   serves HTTP 401 only while BETA_GATE_PASS is set; the Preview scope had
#   none, so previews came up publicly OPEN (HTTP 200). This sets it.
#
# WHY THE CF API (not `wrangler pages secret put`)
#   `wrangler pages secret put` has NO `--env preview` flag in wrangler 4.x —
#   it can only target a single (production) scope, so it CANNOT reliably set a
#   Preview-scope secret. The CF Pages "edit project" API
#   (PATCH .../pages/projects/<project>) takes
#   `deployment_configs.preview.env_vars.<NAME> = {type:"secret_text", value}`
#   which targets the Preview scope precisely and stores it ENCRYPTED
#   (secret_text) — so a subsequent `wrangler pages deploy` will NOT clear it
#   (plain_text vars get wiped on deploy; secret_text persists — the #742 bug).
#   This ONLY touches the Preview scope of the autotest project; the
#   Production scope (autotest.patchtogether.live) and prod/dev projects are
#   untouched.
#
# IDEMPOTENT + TOLERANT
#   Run before every preview deploy. PATCH is upsert — re-running is a no-op if
#   the value is unchanged. Missing creds / missing value → warn + exit 0 so a
#   preview deploy is never blocked by this (the post-deploy assert-beta-gate
#   step is the real enforcement gate).
#
# Required env:
#   CLOUDFLARE_API_TOKEN     — token with Pages:Edit on the account
#   CLOUDFLARE_ACCOUNT_ID    — CF account id
#   PREVIEW_BETA_GATE_PASS   — the preview gate password (e.g. `2600hz`, same as
#                              dev). If unset, this is a no-op (warn + exit 0).
# Optional env:
#   CF_PAGES_PROJECT         — project name (default: patchtogether-live-autotest)
#   CF_API_BASE              — API base (default: https://api.cloudflare.com/client/v4)
#
# Usage:
#   PREVIEW_BETA_GATE_PASS=2600hz bash scripts/cf-set-preview-beta-gate.sh

set -uo pipefail

PROJECT="${CF_PAGES_PROJECT:-patchtogether-live-autotest}"
API_BASE="${CF_API_BASE:-https://api.cloudflare.com/client/v4}"

if [[ -z "${PREVIEW_BETA_GATE_PASS:-}" ]]; then
  echo "::warning::cf-set-preview-beta-gate: PREVIEW_BETA_GATE_PASS not set — leaving preview gate UNCHANGED (no-op). Set the repo secret to enable the preview beta gate."
  exit 0
fi
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" || -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  echo "::warning::cf-set-preview-beta-gate: CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID not set — skipping (no-op)."
  exit 0
fi
for tool in curl jq; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "::warning::cf-set-preview-beta-gate: '$tool' not found — skipping (no-op)."
    exit 0
  fi
done

ACCT="$CLOUDFLARE_ACCOUNT_ID"
url="${API_BASE}/accounts/${ACCT}/pages/projects/${PROJECT}"

# Build the PATCH body with jq so the secret value is JSON-escaped safely and
# never expanded by the shell. We set ONLY deployment_configs.preview.env_vars
# — a partial PATCH merges, leaving the Production scope + other preview vars
# (INVITE_SECRET, CLERK_*, DATABASE_URL set by sync-secrets.sh) intact.
body=$(jq -n --arg v "$PREVIEW_BETA_GATE_PASS" \
  '{deployment_configs:{preview:{env_vars:{BETA_GATE_PASS:{type:"secret_text",value:$v}}}}}')

echo "cf-set-preview-beta-gate: PATCH preview-scope BETA_GATE_PASS (secret_text) on project=$PROJECT"

resp=$(curl -sS -m 30 -X PATCH \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data "$body" \
  "$url" 2>/dev/null || echo '')

ok=$(printf '%s' "$resp" | jq -r '.success // false' 2>/dev/null || echo "false")
if [[ "$ok" == "true" ]]; then
  echo "cf-set-preview-beta-gate: OK — preview-scope BETA_GATE_PASS is set (secret_text). The post-deploy assert will confirm HTTP 401."
  exit 0
fi

# Tolerant: surface the error but DON'T fail the deploy here. The post-deploy
# assert-beta-gate step is the enforcement point (it fails loudly if the gate
# is still down). This keeps a transient CF-API hiccup or a token missing
# Pages:Edit from blocking the actual preview deploy.
errs=$(printf '%s' "$resp" | jq -rc '.errors // []' 2>/dev/null || echo '[]')
echo "::warning::cf-set-preview-beta-gate: could not PATCH preview env (tolerant): ${errs}"
echo "::warning::If the token lacks Pages:Edit, set the preview BETA_GATE_PASS once via Dashboard → ${PROJECT} → Settings → Variables and Secrets → Preview scope → Encrypt. The post-deploy assert will then pass."
exit 0
