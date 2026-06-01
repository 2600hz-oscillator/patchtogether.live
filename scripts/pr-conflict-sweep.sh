#!/usr/bin/env bash
#
# scripts/pr-conflict-sweep.sh — after a merge to main, find the open PRs the
# merge just turned CONFLICTING, so they get rebased before they rot.
#
# REPOSITORY STANDARD (see CLAUDE.md "Post-merge conflict sweep"): whenever a PR
# merges, run this. GitHub recomputes every open PR's mergeability against the
# new main ASYNCHRONOUSLY, so we poll until the UNKNOWNs settle, then list the
# conflicting ones. Rebasing is a separate, careful step — merge origin/main in
# and DIFF; never blind `gh pr update-branch`, which silently drops additions on
# shared registry files (modules/index.ts, Canvas.svelte, …).
#
# Usage:
#   bash scripts/pr-conflict-sweep.sh           # all open PRs
#   bash scripts/pr-conflict-sweep.sh --mine    # only PRs you authored
# Always exits 0 (report-only). Run through flox.
set -uo pipefail

MINE=0
[ "${1:-}" = "--mine" ] && MINE=1
me=""
if [ "$MINE" = "1" ]; then me="$(gh api user --jq .login 2>/dev/null || true)"; fi

echo "Polling open-PR mergeability (GitHub recomputes async after a merge)…"
json='[]'
for attempt in 1 2 3 4 5 6; do
  json="$(gh pr list --state open --limit 200 \
            --json number,title,mergeable,headRefName,author 2>/dev/null || echo '[]')"
  unknown="$(printf '%s' "$json" | node -e 'const p=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(String(p.filter(x=>x.mergeable==="UNKNOWN").length))' 2>/dev/null || echo 0)"
  [ "$unknown" = "0" ] && break
  echo "  attempt $attempt/6: $unknown PR(s) still UNKNOWN; waiting…"
  sleep 5
done

printf '%s' "$json" | node -e '
const me = process.argv[1] || "";
const all = JSON.parse(require("fs").readFileSync(0, "utf8"));
const prs = me ? all.filter((p) => p.author && p.author.login === me) : all;
const bad = prs.filter((p) => p.mergeable === "CONFLICTING");
const unknown = prs.filter((p) => p.mergeable === "UNKNOWN");
if (unknown.length) console.log(`(note: ${unknown.length} PR(s) still UNKNOWN — re-run shortly)`);
if (!bad.length) {
  console.log("\n✓ No open PRs conflict with main. Nothing to rebase.");
  process.exit(0);
}
console.log(`\n⚠ ${bad.length} open PR(s) now CONFLICT with main — rebase each:`);
for (const p of bad) console.log(`  #${p.number}  ${p.headRefName}  — ${p.title}`);
console.log("\nRebase recipe (do NOT `gh pr update-branch` — it silent-drops on shared files):");
console.log("  flox activate -- git fetch origin");
console.log("  flox activate -- git checkout <branch> && flox activate -- git merge origin/main");
console.log("  # resolve, then VERIFY your additions survived (e.g. git grep <your-symbol>)");
console.log("  flox activate -- git push");
' "$me"
