#!/usr/bin/env bash
#
# scripts/ci-health.sh — one-glance CI/PR health dashboard for every OPEN PR.
#
# The maintainer enables auto-merge and walks away; when CI goes red nobody
# notices. `task pr:conflict-sweep` only checks mergeability — it says nothing
# about CHECK status. This fills that gap: for every open PR it shows the exact
# CI state (❌ FAILING / ⏳ PENDING / ✅ GREEN), the mergeable + review state,
# and — for failing PRs — the failing job(s) plus a best-effort extract of the
# failing test lines pulled straight from the job log.
#
# Usage (always through flox so gh/LFS don't hang):
#   flox activate -- bash scripts/ci-health.sh            # report: all open PRs
#   flox activate -- bash scripts/ci-health.sh --watch 625  # block on #625's
#                                                           # checks, then detail
#
# CRITICAL: never `gh run view --log-failed` — it wedges the shell. We fetch
# logs via `gh api .../actions/jobs/<id>/logs` instead.
#
# Best-effort: log extraction can fail (expired logs, perms, non-Actions checks)
# — in that case we just print the failing job name + URL and move on. The
# script never crashes on a PR with no checks and never hangs.
set -euo pipefail

REPO="2600hz-oscillator/patchtogether.live"

# ---- terminal styling (disabled when not a TTY) -----------------------------
if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'
  YEL=$'\033[33m'; CYN=$'\033[36m'; RST=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GRN=""; YEL=""; CYN=""; RST=""
fi

# Markers that flag a failing-test line in a CI log.
MARKERS='✘|✗| failed|Error:|expect\(|Timed out|TimeoutError'

# Strip leading ISO-8601 timestamp + ANSI escapes from a CI log line so the
# extract is readable in a terminal report.
clean_log() {
  sed -E 's/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z[[:space:]]?//' \
    | sed -E 's/\x1b\[[0-9;]*m//g'
}

# Best-effort: given a job id, print up to 15 deduped failing-test lines, each
# indented. Never fails the script (logs may be gone / forbidden).
print_failing_lines() {
  local job_id="$1" indent="$2" log lines
  if [ -z "$job_id" ]; then return 0; fi
  log="$(gh api "/repos/${REPO}/actions/jobs/${job_id}/logs" 2>/dev/null || true)"
  if [ -z "$log" ]; then
    echo "${indent}${DIM}(log unavailable — open the URL above)${RST}"
    return 0
  fi
  lines="$(printf '%s\n' "$log" \
            | grep -E "$MARKERS" 2>/dev/null \
            | clean_log \
            | sed -E 's/[[:space:]]+$//' \
            | awk 'NF' \
            | awk '!seen[$0]++' \
            | head -n 15 || true)"
  if [ -z "$lines" ]; then
    echo "${indent}${DIM}(no test-failure lines matched in log)${RST}"
    return 0
  fi
  while IFS= read -r l; do
    echo "${indent}${RED}│${RST} ${l}"
  done <<< "$lines"
}

# Extract the trailing numeric job id from a check detailsUrl (…/job/<id>).
job_id_from_url() {
  printf '%s' "$1" | sed -nE 's#.*/job/([0-9]+).*#\1#p'
}

# Print the failing-detail block for ONE pr number (used by report + watch).
# Fetches the rollup, lists each failing check + its extracted log lines.
print_pr_failing_detail() {
  local num="$1" rollup
  rollup="$(gh pr view "$num" --repo "$REPO" --json statusCheckRollup \
              --jq '.statusCheckRollup' 2>/dev/null || echo '[]')"
  [ -z "$rollup" ] && rollup='[]'

  # name<TAB>workflow<TAB>detailsUrl for every FAILURE/TIMED_OUT/CANCELLED check.
  local failing
  failing="$(printf '%s' "$rollup" | jq -r '
    .[]
    | select(.__typename=="CheckRun")
    | select(.conclusion=="FAILURE" or .conclusion=="TIMED_OUT" or .conclusion=="CANCELLED")
    | [ (.name // "?"), (.workflowName // "?"), (.detailsUrl // "") ]
    | @tsv' 2>/dev/null || true)"

  if [ -z "$failing" ]; then
    echo "    ${DIM}(no failing checks found)${RST}"
    return 0
  fi

  while IFS=$'\t' read -r name wf url; do
    [ -z "$name" ] && continue
    echo "    ${RED}✘${RST} ${BOLD}${name}${RST} ${DIM}[${wf}]${RST}"
    [ -n "$url" ] && echo "      ${DIM}${url}${RST}"
    print_failing_lines "$(job_id_from_url "$url")" "        "
  done <<< "$failing"
}

# ---------------------------------------------------------------------------
# --watch <pr#>: block until the PR's checks resolve, then print its detail.
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--watch" ]; then
  num="${2:-}"
  if [ -z "$num" ]; then
    echo "usage: bash scripts/ci-health.sh --watch <pr#>" >&2
    exit 2
  fi
  echo "${BOLD}Watching checks for PR #${num} (interval 30s; blocks until resolved)…${RST}"
  # gh pr checks --watch exits non-zero when a check fails — that's expected,
  # we still want to print the detail afterwards.
  gh pr checks "$num" --repo "$REPO" --watch --interval 30 || true
  echo
  echo "${BOLD}── PR #${num} failing detail ──${RST}"
  print_pr_failing_detail "$num"
  exit 0
fi

# ---------------------------------------------------------------------------
# report mode (default): every open PR, classified, FAILING first.
# ---------------------------------------------------------------------------
prs_json="$(gh pr list --repo "$REPO" --state open \
  --json number,title,headRefName,mergeable,reviewDecision,isDraft,author \
  --limit 50 2>/dev/null || echo '[]')"
[ -z "$prs_json" ] && prs_json='[]'

count="$(printf '%s' "$prs_json" | jq 'length' 2>/dev/null || echo 0)"
if [ "$count" = "0" ]; then
  echo "${GRN}No open PRs.${RST}"
  exit 0
fi

echo "${BOLD}CI/PR health — ${count} open PR(s) in ${REPO}${RST}"
echo "${DIM}❌ FAILING first, then ⏳ PENDING, then ✅ GREEN. Run --watch <pr#> to block on one.${RST}"
echo

# Build, per PR, a line:  <rank>\t<num>\t<state>\t<oneliner>
# rank: 0=FAILING 1=PENDING 2=GREEN  (so a numeric sort puts failures first).
# We also stash the per-PR detail to print under FAILING PRs.
tmp_rows="$(mktemp)"
trap 'rm -f "$tmp_rows"' EXIT

# Iterate PR numbers.
for num in $(printf '%s' "$prs_json" | jq -r '.[].number'); do
  meta="$(printf '%s' "$prs_json" | jq -r --argjson n "$num" '
    .[] | select(.number==$n)
    | [ (.title // ""), (.headRefName // ""), (.mergeable // "?"),
        (.reviewDecision // ""), (.isDraft // false), (.author.login // "?") ]
    | @tsv')"
  IFS=$'\t' read -r title branch mergeable review draft author <<< "$meta"

  rollup="$(gh pr view "$num" --repo "$REPO" --json statusCheckRollup \
              --jq '.statusCheckRollup' 2>/dev/null || echo '[]')"
  [ -z "$rollup" ] && rollup='[]'

  # Classify from CheckRun + StatusContext entries.
  read -r n_fail n_pending n_total <<< "$(printf '%s' "$rollup" | jq -r '
    [ .[] | select(.__typename=="CheckRun" or .__typename=="StatusContext") ] as $c
    | ($c | map(select(
        (.conclusion // "") as $x
        | $x=="FAILURE" or $x=="TIMED_OUT" or $x=="CANCELLED"
        or (.state=="FAILURE" or .state=="ERROR")
      )) | length) as $fail
    | ($c | map(select(
        ((.status // "") as $s | $s=="QUEUED" or $s=="IN_PROGRESS" or $s=="PENDING" or $s=="WAITING")
        or (.state=="PENDING")
      )) | length) as $pend
    | "\($fail) \($pend) \($c | length)"' 2>/dev/null || echo "0 0 0")"
  n_fail="${n_fail:-0}"; n_pending="${n_pending:-0}"; n_total="${n_total:-0}"

  if [ "$n_total" = "0" ]; then
    rank=1; icon="⏳"; statelbl="${YEL}NO CHECKS YET${RST}"
  elif [ "$n_fail" -gt 0 ]; then
    rank=0; icon="❌"; statelbl="${RED}FAILING${RST} (${n_fail} check(s))"
  elif [ "$n_pending" -gt 0 ]; then
    rank=1; icon="⏳"; statelbl="${YEL}PENDING${RST} (${n_pending} running)"
  else
    rank=2; icon="✅"; statelbl="${GRN}GREEN${RST}"
  fi

  # Mergeable / review badges.
  case "$mergeable" in
    MERGEABLE)   mlabel="${GRN}mergeable${RST}";;
    CONFLICTING) mlabel="${RED}CONFLICTING${RST}";;
    *)           mlabel="${DIM}mergeable:${mergeable}${RST}";;
  esac
  case "$review" in
    APPROVED)          rlabel="${GRN}approved${RST}";;
    CHANGES_REQUESTED) rlabel="${RED}changes-requested${RST}";;
    REVIEW_REQUIRED)   rlabel="${YEL}review-required${RST}";;
    "")                rlabel="${DIM}no-review${RST}";;
    *)                 rlabel="${DIM}${review}${RST}";;
  esac
  draftlabel=""
  [ "$draft" = "true" ] && draftlabel=" ${DIM}[draft]${RST}"

  header="${icon} ${BOLD}#${num}${RST} ${statelbl}  ${DIM}·${RST} ${mlabel}  ${DIM}·${RST} ${rlabel}${draftlabel}"
  subline="    ${CYN}${branch}${RST} ${DIM}— ${title}${RST}"

  # Encode the row; use a unit-separator so titles with tabs don't break it.
  printf '%s\t%s\t%s\x1f%s\n' "$rank" "$num" "$header" "$subline" >> "$tmp_rows"
done

# Emit sorted: FAILING (0) → PENDING (1) → GREEN (2), then by PR number desc.
sort -t$'\t' -k1,1n -k2,2nr "$tmp_rows" | while IFS=$'\t' read -r rank num rest; do
  header="${rest%%$'\x1f'*}"
  subline="${rest#*$'\x1f'}"
  echo "$header"
  echo "$subline"
  if [ "$rank" = "0" ]; then
    print_pr_failing_detail "$num"
  fi
  echo
done
