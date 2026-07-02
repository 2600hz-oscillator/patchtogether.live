#!/usr/bin/env bash
# scripts/assert-beta-gate.sh <url>
#
# Post-deploy guard: assert the beta gate is UP on a deployed web tier.
#
# WHY THIS EXISTS — the silent-open-prod incident:
#   The web beta gate (packages/web/src/hooks.server.ts → betaGate) is active
#   ONLY while the BETA_GATE_PASS env var is set on the Cloudflare Pages project
#   (read at runtime via $env/dynamic/private). Per-project CF Pages env vars
#   MUST be `secret_text`, NOT `plain_text`: `wrangler pages deploy` (used by
#   .github/workflows/deploy.yml) CLEARS plain-text project vars on every
#   deploy, while secret_text vars persist. A plain_text BETA_GATE_PASS once got
#   wiped by a prod deploy → the gate turned itself off → prod served HTTP 200
#   to the world with NO auth, silently. dev was unaffected (its secret is
#   secret_text). This script makes that failure LOUD: it fails the deploy.
#
# WHAT IT CHECKS:
#   curls a known-GATED app path (default /rack; override GATE_PROBE_PATH)
#   WITHOUT credentials and asserts the gate answers HTTP 401. We must probe a
#   GATED path — NOT `/` (the PUBLIC landing since the landing overhaul), NOT
#   /api/health, NOT /docs/*: all three are gate-EXEMPT (isBetaGatePublic) and
#   would 200 even with the gate fully down, so they can't witness the
#   regression. A fully-wiped BETA_GATE_PASS still serves /rack as 200, so this
#   guard still fires. Callers pass the tier ORIGIN (…/); the script appends the
#   gated path.
#
# Only call this for tiers that ARE gated (prod / dev / autotest / PR-preview).
# Do NOT call it on a tier where the gate is legitimately off, or it will
# (correctly) fail.
#
# Retries to ride out CF deploy + DNS propagation: ~10 attempts, 6s apart
# (~60s window). It fails ONLY after the full window with a CONFIRMED non-401
# response (and treats a confirmed 200 as the smoking gun = gate is DOWN). A
# transient curl error (timeout / DNS not-yet-resolving / 5xx) does NOT
# immediately fail — it just retries — so a slow propagation can't false-fail
# and break every deploy. After the window is exhausted we report the last
# observed status and exit 1.
#
# Exit codes:
#   0 — saw HTTP 401 within the retry window (gate is UP)
#   1 — never saw 401 (gate down, or origin unreachable for the whole window)
#   2 — invocation error (missing url / missing curl)
#
# Usage:
#   bash scripts/assert-beta-gate.sh https://www.patchtogether.live/
#   ATTEMPTS=10 SLEEP_SECS=6 bash scripts/assert-beta-gate.sh <url>

set -uo pipefail

URL="${1:-}"
if [[ -z "$URL" ]]; then
  echo "usage: $0 <url>" >&2
  exit 2
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "missing required tool: curl" >&2
  exit 2
fi

# Probe a GATED path, not the origin root: `/` is the PUBLIC landing
# (isBetaGatePublic) as of the landing overhaul, so it 200s by design and can no
# longer witness the gate. /rack is a gated app route; a wiped BETA_GATE_PASS
# still serves it 200, so the guard still fires. Override via GATE_PROBE_PATH.
GATE_PROBE_PATH="${GATE_PROBE_PATH:-/rack}"
PROBE_URL="${URL%/}${GATE_PROBE_PATH}"

# Tunable for tests; defaults give a ~60s window (10 × 6s).
ATTEMPTS="${ATTEMPTS:-10}"
SLEEP_SECS="${SLEEP_SECS:-6}"
# Per-request timeout. Kept well under SLEEP_SECS * ATTEMPTS so a hung origin
# can't blow past a job timeout.
CURL_MAX_TIME="${CURL_MAX_TIME:-10}"

echo "assert-beta-gate: expecting HTTP 401 (gate UP) at $PROBE_URL"
echo "  window: ${ATTEMPTS} attempts × ${SLEEP_SECS}s sleep (per-request timeout ${CURL_MAX_TIME}s)"

last_status=""
for ((i = 1; i <= ATTEMPTS; i++)); do
  # -s silent, -o /dev/null drop the body, -w prints just the numeric status.
  # NO credentials are sent — we WANT the gate to reject us. On a curl-level
  # failure (DNS, connect, timeout) curl exits non-zero and %{http_code} is
  # "000"; we treat that as "not yet reachable" and keep retrying.
  status=$(curl -s -o /dev/null -m "$CURL_MAX_TIME" -w '%{http_code}' "$PROBE_URL" || echo "000")
  last_status="$status"

  if [[ "$status" == "401" ]]; then
    echo "  [$i/$ATTEMPTS] HTTP $status — gate is UP. PASS"
    exit 0
  fi

  if [[ "$status" == "200" ]]; then
    # The exact regression we're guarding against: root served with no auth.
    echo "  [$i/$ATTEMPTS] HTTP 200 — gate is DOWN (gated path served WITHOUT auth!). retrying to rule out propagation…"
  elif [[ "$status" == "000" ]]; then
    echo "  [$i/$ATTEMPTS] origin not reachable yet (curl error). retrying…"
  else
    echo "  [$i/$ATTEMPTS] HTTP $status (not 401). retrying…"
  fi

  if [[ "$i" -lt "$ATTEMPTS" ]]; then
    sleep "$SLEEP_SECS"
  fi
done

echo "::error::assert-beta-gate FAILED for $PROBE_URL — never observed HTTP 401 within the retry window (last status: HTTP ${last_status})."
if [[ "$last_status" == "200" ]]; then
  echo "::error::HTTP 200 means the beta gate is DOWN — the tier is serving the app to the public with no auth."
  echo "::error::Most likely cause: BETA_GATE_PASS on this CF Pages project is plain_text and was cleared by 'wrangler pages deploy'. Re-add it as secret_text (Dashboard → project → Settings → Variables and Secrets → Encrypt), then redeploy. See packages/web/wrangler.toml + scripts/sync-secrets.sh."
fi
exit 1
