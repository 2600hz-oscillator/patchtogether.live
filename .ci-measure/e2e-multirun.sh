#!/usr/bin/env bash
# Is "shard 4 is the slow one" a STABLE property of the partition (→ the cost
# model is wrong) or a different shard each run (→ runner variance)? One run
# cannot tell those apart, and they need opposite fixes.
set -euo pipefail
for run in $(gh api 'repos/:owner/:repo/actions/workflows/ci.yml/runs?per_page=25&status=success' -q '.workflow_runs[].id' | head -8); do
  echo "== run $run =="
  gh api "repos/:owner/:repo/actions/runs/$run/jobs" --paginate --jq \
    '[.jobs[] | select(.name|startswith("e2e (shard")) | {n: .name, s: (.steps[]|select(.name|startswith("Run E2E"))|((.completed_at|fromdateiso8601)-(.started_at|fromdateiso8601)))}] | sort_by(.n) | map("\(.n|capture("shard (?<k>[0-9]+)").k):\(.s)") | join("  ")'
done
