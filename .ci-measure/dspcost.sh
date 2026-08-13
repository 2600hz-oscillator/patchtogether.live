#!/usr/bin/env bash
# How long does the Faust compile take when the DSP dist cache MISSES?
set -euo pipefail
for run in $(gh api 'repos/:owner/:repo/actions/workflows/ci.yml/runs?per_page=40&status=completed' -q '.workflow_runs[].id'); do
  gh api "repos/:owner/:repo/actions/runs/$run/jobs" --paginate \
    -q '.jobs[] | select(.name|startswith("dsp-build")) | [.run_id, .head_branch, (.steps[] | select(.name|startswith("Build DSP worklets")) | ((.completed_at|fromdateiso8601)-(.started_at|fromdateiso8601))), ((.completed_at|fromdateiso8601)-(.started_at|fromdateiso8601))] | @tsv' 2>/dev/null || true
done
