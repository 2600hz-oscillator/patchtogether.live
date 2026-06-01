#!/usr/bin/env bash
# scripts/live-smoke-alert.sh — checks dev.patchtogether.live + relay are
# healthy and the relay isn't sitting at a memory-crit threshold.
#
# Designed for two callers:
#   1. .github/workflows/live-smoke-alert.yml (every 10 min cron)
#   2. local devs running `bash scripts/live-smoke-alert.sh --dry-run`
#      to verify the curl logic without triggering BetterStack or GH
#      issue creation.
#
# Exit codes:
#   0 — everything healthy
#   1 — at least one probe failed (workflow opens an issue + emails)
#   2 — script invocation error (bad args, missing tools)
#
# Stdout contract: one machine-readable JSON object on the last line of
# normal output, surrounded by `<<SMOKE_RESULT>>` markers so the workflow
# can pluck it without parsing arbitrary log noise.

set -uo pipefail

WEB_URL="${WEB_URL:-https://dev.patchtogether.live}"
RELAY_URL="${RELAY_URL:-https://patchtogether-server-dev.fly.dev}"
MEM_CRIT_MB="${RELAY_MEM_CRIT_MB:-480}"
DRY_RUN=false
BETA_GATE_USER="${BETA_GATE_USER:-beta}"
BETA_GATE_PASS="${BETA_GATE_PASS:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --web-url) WEB_URL="$2"; shift 2 ;;
    --relay-url) RELAY_URL="$2"; shift 2 ;;
    --mem-crit-mb) MEM_CRIT_MB="$2"; shift 2 ;;
    -h|--help)
      cat <<EOF
Usage: $0 [--dry-run] [--web-url URL] [--relay-url URL] [--mem-crit-mb N]
EOF
      exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

for tool in curl jq; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "missing required tool: $tool" >&2
    exit 2
  fi
done

failures=()
reasons=()

# Build the auth header for the beta-gated dev site. If we don't have a
# password, fall through; the curl will return 401 and the failure will
# itself be the alert (a 401 from the public health endpoint is a regression
# in its own right — the beta-gate carve-out for /api/health may have been
# removed).
auth_args=()
if [[ -n "$BETA_GATE_PASS" ]]; then
  auth_args=(-u "${BETA_GATE_USER}:${BETA_GATE_PASS}")
fi

echo "[1/3] curl $WEB_URL/api/health"
# `${auth_args[@]+"${auth_args[@]}"}` is the empty-array-safe expansion;
# under `set -u`, a bare `${auth_args[@]}` errors when the array has no
# elements set (bash < 4.4 quirk that still bites macOS bash 3.2).
web_resp=$(curl -sS -m 10 -w '\n__HTTP_STATUS:%{http_code}' ${auth_args[@]+"${auth_args[@]}"} "$WEB_URL/api/health" || true)
web_status=$(echo "$web_resp" | awk -F: '/^__HTTP_STATUS:/ {print $2}' | tr -d ' \n')
web_body=$(echo "$web_resp" | sed '/^__HTTP_STATUS:/d')
if [[ "$web_status" != "200" ]]; then
  failures+=("web-health-status")
  reasons+=("web /api/health returned HTTP $web_status")
elif ! echo "$web_body" | jq -e '.ok == true' >/dev/null 2>&1; then
  failures+=("web-health-body")
  reasons+=("web /api/health body missing ok:true; got: $web_body")
fi

echo "[2/3] curl $RELAY_URL/health"
relay_resp=$(curl -sS -m 10 -w '\n__HTTP_STATUS:%{http_code}' "$RELAY_URL/health" || true)
relay_status=$(echo "$relay_resp" | awk -F: '/^__HTTP_STATUS:/ {print $2}' | tr -d ' \n')
relay_body=$(echo "$relay_resp" | sed '/^__HTTP_STATUS:/d')
if [[ "$relay_status" != "200" ]]; then
  failures+=("relay-health-status")
  reasons+=("relay /health returned HTTP $relay_status")
elif ! echo "$relay_body" | jq -e '.ok == true' >/dev/null 2>&1; then
  failures+=("relay-health-body")
  reasons+=("relay /health body missing ok:true; got: $relay_body")
fi

echo "[3/3] curl $RELAY_URL/metrics"
metrics_resp=$(curl -sS -m 10 -w '\n__HTTP_STATUS:%{http_code}' "$RELAY_URL/metrics" || true)
metrics_status=$(echo "$metrics_resp" | awk -F: '/^__HTTP_STATUS:/ {print $2}' | tr -d ' \n')
metrics_body=$(echo "$metrics_resp" | sed '/^__HTTP_STATUS:/d')
rss_mb="unknown"
if [[ "$metrics_status" != "200" ]]; then
  failures+=("relay-metrics-status")
  reasons+=("relay /metrics returned HTTP $metrics_status")
else
  rss_mb=$(echo "$metrics_body" | jq -r '.rss_mb // "unknown"' 2>/dev/null || echo "unknown")
  if [[ "$rss_mb" == "unknown" ]] || ! echo "$metrics_body" | jq -e '.rss_mb | type == "number"' >/dev/null 2>&1; then
    failures+=("relay-metrics-body")
    reasons+=("relay /metrics body missing numeric rss_mb")
  else
    # Use awk for portable float compare; bash test only handles ints.
    over_crit=$(awk -v r="$rss_mb" -v c="$MEM_CRIT_MB" 'BEGIN { print (r > c) ? 1 : 0 }')
    if [[ "$over_crit" == "1" ]]; then
      failures+=("relay-mem-crit")
      reasons+=("relay rss_mb=$rss_mb exceeds RELAY_MEM_CRIT_MB=$MEM_CRIT_MB")
    fi
  fi
fi

healthy=true
combined_reason="all probes healthy"
if [[ ${#failures[@]} -gt 0 ]]; then
  healthy=false
  combined_reason=$(IFS='; '; echo "${reasons[*]}")
fi

# Emit machine-readable summary for the workflow to pick up.
echo "<<SMOKE_RESULT>>"
jq -n \
  --argjson healthy "$healthy" \
  --arg reason "$combined_reason" \
  --arg web_status "$web_status" \
  --arg relay_status "$relay_status" \
  --arg metrics_status "$metrics_status" \
  --arg rss_mb "$rss_mb" \
  --arg crit_mb "$MEM_CRIT_MB" \
  '{
    healthy: $healthy,
    reason: $reason,
    probes: {
      web_status: $web_status,
      relay_status: $relay_status,
      metrics_status: $metrics_status,
      rss_mb: $rss_mb,
      crit_mb: $crit_mb
    }
  }'
echo "<<END_SMOKE_RESULT>>"

if $DRY_RUN; then
  echo "[dry-run] not opening issue / not paging — script complete"
  exit 0
fi

if [[ "$healthy" == "true" ]]; then
  exit 0
fi
exit 1
