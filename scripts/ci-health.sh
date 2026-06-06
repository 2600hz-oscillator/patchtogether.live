#!/usr/bin/env bash
#
# scripts/ci-health.sh — a CI/PR health dashboard for the repo.
#
# DEFAULT (report) mode: list every open PR, classify its CI checks
#   ❌ FAILING (any check FAILURE/TIMED_OUT/CANCELLED), ⏳ PENDING (still
#   running, none failed), ✅ GREEN (all done, none failed), and ❔ NO CHECKS.
#   Print mergeable + reviewDecision per PR. For each FAILING check, print the
#   job name + workflow, then a BEST-EFFORT extract of the failing test lines
#   pulled straight from that job's raw log (jobs/<id>/logs api). FAILING PRs
#   sort first, then PENDING, then GREEN, then NO CHECKS.
#
#   CRITICAL: we NEVER call `gh run view --log-failed` — it wedges the shell.
#   We fetch logs via the `actions/jobs/<id>/logs` REST endpoint instead, and
#   the whole log step is best-effort: a failed fetch never aborts the report.
#
# --watch <pr#> mode: block on `gh pr checks <pr#> --watch` until that PR's
#   checks resolve, then print the per-PR failing detail for it.
#
# Every command runs inside flox already (you invoke this via
# `flox activate -- task ci:health`); this script only touches gh/git metadata,
# no LFS, so it is safe.
#
# Usage:
#   bash scripts/ci-health.sh              # report on all open PRs
#   bash scripts/ci-health.sh --watch 624  # block on #624, then show its detail
set -euo pipefail

REPO="2600hz-oscillator/patchtogether.live"

# detailsUrl → job id (the /job/<digits> segment), or empty if absent.
job_id_from_url() {
  printf '%s' "$1" | sed -nE 's#.*/job/([0-9]+).*#\1#p'
}

# ---- best-effort failing-test extraction from a single job log -------------
# Args: <job_id> <job_name> <details_url> <workflow>
# Prints the job header, then up to 15 deduped failing lines. Never aborts the
# script: any fetch/parse failure just yields the header + a hint line.
print_failing_detail_for_job() {
  local job_id="$1" job_name="$2" details_url="$3" workflow="${4:-}"
  if [ -n "$workflow" ]; then
    printf '      ✘ %s  [%s]\n' "$job_name" "$workflow"
  else
    printf '      ✘ %s\n' "$job_name"
  fi
  printf '        %s\n' "$details_url"

  if [ -z "$job_id" ]; then
    printf '        (no job id in detailsUrl — open the link above)\n'
    return 0
  fi

  local log lines
  # `|| true` everywhere so a non-zero gh/api never trips set -e.
  log="$(gh api "/repos/${REPO}/actions/jobs/${job_id}/logs" 2>/dev/null || true)"
  if [ -z "$log" ]; then
    printf '        (could not fetch job log — open the link above)\n'
    return 0
  fi

  # Strip leading ISO timestamps + ANSI escapes, grep failure signatures,
  # dedup, cap at 15 lines.
  lines="$(
    printf '%s\n' "$log" \
      | sed -E 's/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z //' \
      | sed -E 's/\x1b\[[0-9;]*[a-zA-Z]//g' \
      | grep -aE '✘|✗| failed|Error:|expect\(|Timed out|TimeoutError' \
      | awk '!seen[$0]++' \
      | head -15 || true
  )"

  if [ -z "$lines" ]; then
    printf '        (job failed but no test-line signature matched — open the link)\n'
    return 0
  fi

  printf '%s\n' "$lines" | while IFS= read -r ln; do
    printf '          %s\n' "$ln"
  done
  return 0
}

# Print the FAILING-check detail block for one PR. Args: <pr#>.
# Re-fetches the rollup. Best-effort; never aborts. Prints nothing if no fails.
print_pr_failing_detail() {
  local pr="$1"
  local rollup fails
  rollup="$(gh pr view "$pr" --json statusCheckRollup 2>/dev/null || echo '{}')"

  # One TSV line per failing check: name<TAB>workflow<TAB>detailsUrl
  fails="$(
    printf '%s' "$rollup" | node -e '
      let d = {};
      try { d = JSON.parse(require("fs").readFileSync(0, "utf8")); } catch {}
      const r = d.statusCheckRollup || [];
      const FAIL = new Set(["FAILURE","TIMED_OUT","CANCELLED","STARTUP_FAILURE","ACTION_REQUIRED"]);
      for (const c of r) {
        const concl = c.conclusion || c.state || "";   // CheckRun=conclusion, StatusContext=state
        if (!FAIL.has(concl)) continue;
        const name = c.name || c.context || "(unnamed check)";
        const wf = c.workflowName || "";
        const url = c.detailsUrl || c.targetUrl || "";
        process.stdout.write([name, wf, url].join("\t") + "\n");
      }
    ' 2>/dev/null || true
  )"

  [ -z "$fails" ] && return 0

  printf '%s\n' "$fails" | while IFS=$'\t' read -r name workflow url; do
    [ -z "$name" ] && continue
    local jid
    jid="$(job_id_from_url "$url")"
    print_failing_detail_for_job "$jid" "$name" "$url" "$workflow"
  done
  return 0
}

# ---------------------------------------------------------------------------
# --watch <pr#> mode
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--watch" ]; then
  pr="${2:-}"
  if [ -z "$pr" ]; then
    echo "usage: bash scripts/ci-health.sh --watch <pr#>" >&2
    exit 2
  fi
  echo "Watching checks for PR #${pr} (gh pr checks --watch --interval 30)…"
  # gh exits non-zero if any check fails — that's expected, don't abort here.
  gh pr checks "$pr" --watch --interval 30 || true
  echo
  echo "── Failing detail for PR #${pr} ──────────────────────────────────────"
  detail="$(print_pr_failing_detail "$pr")"
  if [ -z "$detail" ]; then
    echo "  ✅ No failing checks for PR #${pr}."
  else
    printf '%s\n' "$detail"
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# Default report mode
# ---------------------------------------------------------------------------
echo "CI/PR health — ${REPO}"
echo "Fetching open PRs…"

prs_json="$(
  gh pr list --state open \
    --json number,title,headRefName,mergeable,reviewDecision,isDraft,author \
    --limit 50 2>/dev/null || echo '[]'
)"

count="$(printf '%s' "$prs_json" | node -e 'let p=[];try{p=JSON.parse(require("fs").readFileSync(0,"utf8"))}catch{};process.stdout.write(String(p.length))' 2>/dev/null || echo 0)"
if [ "$count" = "0" ]; then
  echo "No open PRs."
  exit 0
fi
echo "Found ${count} open PR(s). Classifying checks…"

# Render each PR block to a temp file keyed by sort rank, so multi-line blocks
# survive sorting cleanly (no fragile in-band TAB/newline juggling).
# rank: 0 FAILING · 1 PENDING · 2 GREEN · 3 NO CHECKS
workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

while IFS= read -r pr; do
  [ -z "$pr" ] && continue

  meta="$(
    printf '%s' "$prs_json" | node -e '
      const pr = Number(process.argv[1]);
      const all = JSON.parse(require("fs").readFileSync(0, "utf8"));
      const p = all.find((x) => x.number === pr) || {};
      const draft = p.isDraft ? " (draft)" : "";
      const author = (p.author && p.author.login) || "?";
      const rd = p.reviewDecision || "—";
      process.stdout.write([p.mergeable || "?", rd, author + draft, (p.title || "")].join("\t"));
    ' "$pr" 2>/dev/null || printf '?\t—\t?\t'
  )"
  mergeable="$(printf '%s' "$meta" | cut -f1)"
  reviewdec="$(printf '%s' "$meta" | cut -f2)"
  authordft="$(printf '%s' "$meta" | cut -f3)"
  title="$(printf '%s' "$meta" | cut -f4)"

  rollup="$(gh pr view "$pr" --json statusCheckRollup 2>/dev/null || echo '{}')"

  # Classify → "<rank>\t<icon>\t<counts>"
  cls="$(
    printf '%s' "$rollup" | node -e '
      let d = {};
      try { d = JSON.parse(require("fs").readFileSync(0, "utf8")); } catch {}
      const r = d.statusCheckRollup || [];
      const FAIL = new Set(["FAILURE","TIMED_OUT","CANCELLED","STARTUP_FAILURE","ACTION_REQUIRED"]);
      if (r.length === 0) { process.stdout.write("3\t❔ NO CHECKS\t(no checks reported)"); process.exit(0); }
      let failed = 0, pending = 0, ok = 0, skipped = 0;
      for (const c of r) {
        const concl = c.conclusion || c.state || "";
        const status = c.status || "";
        if (FAIL.has(concl)) { failed++; continue; }
        if (!concl || concl === "PENDING" || status === "IN_PROGRESS" || status === "QUEUED" || status === "PENDING" || status === "WAITING") { pending++; continue; }
        if (concl === "SKIPPED" || concl === "NEUTRAL") { skipped++; continue; }
        ok++;
      }
      const counts = `${failed} fail · ${pending} pending · ${ok} ok · ${skipped} skip`;
      if (failed > 0) process.stdout.write(`0\t❌ FAILING\t${counts}`);
      else if (pending > 0) process.stdout.write(`1\t⏳ PENDING\t${counts}`);
      else process.stdout.write(`2\t✅ GREEN\t${counts}`);
    ' 2>/dev/null || printf '3\t❔ NO CHECKS\t(classify failed)'
  )"
  rank="$(printf '%s' "$cls" | cut -f1)"
  icon="$(printf '%s' "$cls" | cut -f2)"
  counts="$(printf '%s' "$cls" | cut -f3)"
  [ -z "$rank" ] && { rank=3; icon="❔ NO CHECKS"; counts="(classify failed)"; }

  # Filename = <rank>.<zero-padded-pr> so sort is purely lexical on the name.
  out="$(printf '%s/%s.%010d' "$workdir" "$rank" "$pr")"
  {
    echo "──────────────────────────────────────────────────────────────────────"
    printf '%s  #%s — %s\n' "$icon" "$pr" "$title"
    printf '    %s\n' "$counts"
    printf '    mergeable=%s   review=%s   by=%s\n' "$mergeable" "$reviewdec" "$authordft"
    if [ "$rank" = "0" ]; then
      print_pr_failing_detail "$pr"
    fi
  } > "$out"
done < <(printf '%s' "$prs_json" | node -e 'const p=JSON.parse(require("fs").readFileSync(0,"utf8"));for(const x of p)console.log(x.number)' 2>/dev/null)

echo
# Concatenate blocks in rank order (FAILING first). LC_ALL=C for stable lexical sort.
for f in $(printf '%s\n' "$workdir"/* | LC_ALL=C sort); do
  [ -f "$f" ] && cat "$f"
done

echo "──────────────────────────────────────────────────────────────────────"
echo "Legend: ❌ FAILING  ⏳ PENDING  ✅ GREEN  ❔ NO CHECKS"
echo "Watch one PR: flox activate -- task pr:watch -- <pr#>"
