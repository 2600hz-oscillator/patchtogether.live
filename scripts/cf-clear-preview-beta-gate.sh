#!/usr/bin/env bash
#
# scripts/cf-clear-preview-beta-gate.sh
#
# Ensure the PR-preview beta gate is OFF by REMOVING BETA_GATE_PASS from the
# PREVIEW deployment-config scope of the `patchtogether-live-autotest`
# Cloudflare Pages project.
#
# WHY THIS EXISTS / THE SCOPE MODEL
#   PR previews deploy to branch `pr-<N>` on the autotest Pages project. A
#   non-production branch reads its RUNTIME env from the project's PREVIEW
#   deployment-config scope — NOT the Production scope (which serves
#   autotest.patchtogether.live). The runtime beta gate (hooks.server.ts)
#   serves HTTP 401 ONLY while BETA_GATE_PASS is set; with the Preview scope
#   var removed, previews come up publicly OPEN (HTTP 200) — no basic-auth
#   prompt on the short-lived per-PR subdomain (owner request: the browser
#   can't remember creds across a new PR subdomain each time). This REMOVES it.
#
#   This is the deliberate inverse of the old cf-set-preview-beta-gate.sh,
#   which used to SET the preview gate. Previews are now intentionally ungated.
#
# WHY IT ONLY TOUCHES THE PREVIEW SCOPE (dev / autotest / prod stay gated)
#   CF Pages keeps Production and Preview env vars in SEPARATE scopes; Preview
#   does NOT inherit Production vars. autotest.patchtogether.live reads the
#   Production scope of THIS SAME project; dev/prod are entirely separate
#   projects. Clearing `deployment_configs.preview.env_vars.BETA_GATE_PASS`
#   removes ONLY the preview-scope var — the autotest Production-scope gate and
#   the dev/prod project gates are untouched and stay UP (their post-deploy
#   assert-beta-gate steps still require HTTP 401).
#
# WHY THE CF API (not `wrangler pages secret delete`)
#   `wrangler pages secret <put|delete>` has NO `--env preview` flag in
#   wrangler 4.x — it can only target the (production) scope, so it CANNOT
#   remove a Preview-scope secret. The CF Pages "edit project" API
#   (PATCH .../pages/projects/<project>) accepts
#   `deployment_configs.preview.env_vars.<NAME> = null` to DELETE that key
#   precisely on the Preview scope. A partial PATCH merges, so the other
#   preview vars (INVITE_SECRET, CLERK_*, DATABASE_URL from sync-secrets.sh)
#   are left intact.
#
# IDEMPOTENT + TOLERANT (safe-by-default)
#   Run before every preview deploy. PATCH-with-null is a no-op once the var is
#   already gone. Missing creds / a token without Pages:Edit / a CF-API hiccup
#   → warn + exit 0 so a preview deploy is NEVER blocked by this. Note the
#   failure mode is SAFE: if the clear can't run, the OLD secret persists and
#   the preview simply stays GATED (no accidental exposure) — it never opens a
#   tier that was meant to be closed.
#
# Required env:
#   CLOUDFLARE_API_TOKEN     — token with Pages:Edit on the account
#   CLOUDFLARE_ACCOUNT_ID    — CF account id
# Optional env:
#   CF_PAGES_PROJECT         — project name (default: patchtogether-live-autotest)
#   CF_API_BASE              — API base (default: https://api.cloudflare.com/client/v4)
#
# Usage:
#   bash scripts/cf-clear-preview-beta-gate.sh

set -uo pipefail

PROJECT="${CF_PAGES_PROJECT:-patchtogether-live-autotest}"
API_BASE="${CF_API_BASE:-https://api.cloudflare.com/client/v4}"

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" || -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  echo "::warning::cf-clear-preview-beta-gate: CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID not set — skipping (no-op). Preview gate left as-is."
  exit 0
fi
for tool in curl jq; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "::warning::cf-clear-preview-beta-gate: '$tool' not found — skipping (no-op)."
    exit 0
  fi
done

ACCT="$CLOUDFLARE_ACCOUNT_ID"
url="${API_BASE}/accounts/${ACCT}/pages/projects/${PROJECT}"

# Partial PATCH: set ONLY deployment_configs.preview.env_vars.BETA_GATE_PASS to
# null, which DELETES that key on the Preview scope. Other preview vars and the
# whole Production scope merge through untouched.
body='{"deployment_configs":{"preview":{"env_vars":{"BETA_GATE_PASS":null}}}}'

echo "cf-clear-preview-beta-gate: PATCH remove preview-scope BETA_GATE_PASS on project=$PROJECT (previews are intentionally OPEN)"

resp=$(curl -sS -m 30 -X PATCH \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data "$body" \
  "$url" 2>/dev/null || echo '')

ok=$(printf '%s' "$resp" | jq -r '.success // false' 2>/dev/null || echo "false")
if [[ "$ok" == "true" ]]; then
  echo "cf-clear-preview-beta-gate: OK — preview-scope BETA_GATE_PASS removed. Previews serve HTTP 200 (no gate)."
  exit 0
fi

# Tolerant: surface the error but DON'T fail the deploy. Worst case the old
# secret persists and the preview stays GATED — a safe default, never an
# accidental exposure.
errs=$(printf '%s' "$resp" | jq -rc '.errors // []' 2>/dev/null || echo '[]')
echo "::warning::cf-clear-preview-beta-gate: could not PATCH preview env (tolerant): ${errs}"
echo "::warning::If the token lacks Pages:Edit, remove the preview BETA_GATE_PASS once via Dashboard → ${PROJECT} → Settings → Variables and Secrets → Preview scope → delete BETA_GATE_PASS. Until then previews stay gated (safe)."
exit 0
