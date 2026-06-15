#!/usr/bin/env bash
#
# scripts/cf-preview-cleanup.sh <pr-branch>
#
# Delete a closed PR's Cloudflare Pages preview deployment(s) so the
# `patchtogether-live-autotest` project doesn't accumulate one dead
# `pr-<N>` deployment per PR forever (the project had grown to ~2,400 of
# them — a separate one-off bulk prune handles the historical backlog;
# THIS script keeps it from growing again, one PR at a time on close).
#
# WHAT IT DOES
#   1. Lists the autotest project's PREVIEW deployments (env=preview), paging
#      a few times to be safe.
#   2. Filters to deployments whose git branch == the passed <pr-branch>
#      (deployment_trigger.metadata.branch), i.e. `pr-<N>`.
#   3. DELETEs each with ?force=true (force allows deleting aliased /
#      non-production deployments that a plain delete would reject).
#
# TOLERANT BY DESIGN — a cleanup must NEVER fail the PR-close event:
#   - Missing creds → warn + exit 0 (nothing to do, don't go red).
#   - A 404 / "already gone" / per-deployment API error → logged, skipped,
#     does not fail the run.
#   - "No matching deployments" is a normal outcome (already pruned, or the
#     preview never deployed) → exit 0.
#   The CALLER additionally sets continue-on-error so even an unexpected
#   non-zero here can't block a merge; this script's own exit is 0 in all the
#   expected paths anyway.
#
# Required env (the same secrets deploy.yml already uses):
#   CLOUDFLARE_API_TOKEN   — Pages-scoped token (needs Pages:Edit to delete)
#   CLOUDFLARE_ACCOUNT_ID  — CF account id
# Optional env:
#   CF_PAGES_PROJECT       — project name (default: patchtogether-live-autotest)
#   CF_API_BASE            — API base (default: https://api.cloudflare.com/client/v4)
#   MAX_PAGES              — how many pages of 25 deployments to scan (default 8)
#
# Usage:
#   bash scripts/cf-preview-cleanup.sh pr-786

set -uo pipefail

BRANCH="${1:-}"
if [[ -z "$BRANCH" ]]; then
  echo "usage: $0 <pr-branch e.g. pr-786>" >&2
  exit 2
fi

PROJECT="${CF_PAGES_PROJECT:-patchtogether-live-autotest}"
API_BASE="${CF_API_BASE:-https://api.cloudflare.com/client/v4}"
MAX_PAGES="${MAX_PAGES:-8}"
PER_PAGE=25

# Tolerant: no creds → nothing to do, stay green.
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" || -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  echo "::warning::cf-preview-cleanup: CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID not set — skipping cleanup for $BRANCH (no-op)."
  exit 0
fi
for tool in curl jq; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "::warning::cf-preview-cleanup: '$tool' not found — skipping cleanup for $BRANCH (no-op)."
    exit 0
  fi
done

AUTH=(-H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")
ACCT="$CLOUDFLARE_ACCOUNT_ID"

echo "cf-preview-cleanup: project=$PROJECT branch=$BRANCH (scanning up to ${MAX_PAGES}×${PER_PAGE} preview deployments)"

# ── Collect matching deployment ids ──────────────────────────────────────────
ids=()
for ((page = 1; page <= MAX_PAGES; page++)); do
  url="${API_BASE}/accounts/${ACCT}/pages/projects/${PROJECT}/deployments?env=preview&page=${page}&per_page=${PER_PAGE}"
  resp=$(curl -sS -m 30 "${AUTH[@]}" "$url" 2>/dev/null || echo '')
  if [[ -z "$resp" ]]; then
    echo "  [page $page] no response from CF API — stopping scan (tolerant)."
    break
  fi
  ok=$(printf '%s' "$resp" | jq -r '.success // false' 2>/dev/null || echo "false")
  if [[ "$ok" != "true" ]]; then
    # Surface the API error but don't fail the cleanup.
    errs=$(printf '%s' "$resp" | jq -rc '.errors // []' 2>/dev/null || echo '[]')
    echo "::warning::cf-preview-cleanup: list deployments failed (page $page): ${errs} — stopping scan (tolerant)."
    break
  fi

  count=$(printf '%s' "$resp" | jq -r '.result | length' 2>/dev/null || echo 0)
  # Match on the git branch the deployment was triggered for.
  page_ids=$(printf '%s' "$resp" \
    | jq -r --arg b "$BRANCH" \
      '.result[] | select(.deployment_trigger.metadata.branch == $b) | .id' 2>/dev/null || true)
  if [[ -n "$page_ids" ]]; then
    while IFS= read -r id; do
      [[ -n "$id" ]] && ids+=("$id")
    done <<<"$page_ids"
  fi

  # Stop early once a page returns fewer than a full page (end of list).
  if [[ "$count" -lt "$PER_PAGE" ]]; then
    break
  fi
done

if [[ "${#ids[@]}" -eq 0 ]]; then
  echo "cf-preview-cleanup: no preview deployments found for branch $BRANCH — nothing to delete (already pruned or never deployed). Done."
  exit 0
fi

echo "cf-preview-cleanup: found ${#ids[@]} deployment(s) for $BRANCH; deleting (force=true)…"

# ── Delete each (tolerant per-deployment) ─────────────────────────────────────
deleted=0
failed=0
for id in "${ids[@]}"; do
  del_url="${API_BASE}/accounts/${ACCT}/pages/projects/${PROJECT}/deployments/${id}?force=true"
  body=$(curl -sS -m 30 -X DELETE "${AUTH[@]}" "$del_url" 2>/dev/null || echo '')
  ok=$(printf '%s' "$body" | jq -r '.success // false' 2>/dev/null || echo "false")
  if [[ "$ok" == "true" ]]; then
    echo "  deleted $id"
    deleted=$((deleted + 1))
  else
    # Tolerate "already gone" / aliased / transient errors — log, don't fail.
    errs=$(printf '%s' "$body" | jq -rc '.errors // []' 2>/dev/null || echo '[]')
    echo "  ::warning::could not delete $id (already gone / aliased / transient): ${errs}"
    failed=$((failed + 1))
  fi
done

echo "cf-preview-cleanup: done — deleted=${deleted} skipped/failed=${failed} for $BRANCH."
# Always succeed: a cleanup hiccup must never block a merge.
exit 0
