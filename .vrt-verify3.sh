#!/usr/bin/env bash
# 3x clean-verify of the full VRT lane against the freshly regenerated
# baselines. Fails loudly on the FIRST failing iteration so a flake can't hide
# behind a later green run (repo standard: flake-check new/changed tests 3x).
set -u
cd /Users/2600hz/Documents/workspace/inet.modular/.claude/worktrees/agent-a61db48c3132fd443
for i in 1 2 3; do
  echo "=== VERIFY RUN $i START ==="
  E2E_BASE_URL=http://localhost:5610 npx --workspace e2e playwright test \
    --config=vrt/vrt.config.ts --reporter=line 2>&1 | tail -30
  rc=${PIPESTATUS[0]}
  echo "=== VERIFY RUN $i EXIT=$rc ==="
  if [ "$rc" -ne 0 ]; then
    echo "!!! VERIFY RUN $i FAILED — stopping (do not re-run, root-cause it)"
    exit "$rc"
  fi
done
echo "=== ALL 3 VERIFY RUNS CLEAN ==="
