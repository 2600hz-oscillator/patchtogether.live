#!/usr/bin/env bash
set -euo pipefail
ROOT=/Users/2600hz/Documents/workspace/inet.modular/.claude/worktrees/wf_f09a5e8e-581-1
cd "$ROOT/e2e"
VRT_STRICT=1 npx playwright test --config=vrt/vrt.config.ts --list --reporter=json 2>/dev/null > "$ROOT/.ci-measure/vrt-list.json"
echo "wrote $(wc -c < "$ROOT/.ci-measure/vrt-list.json") bytes"
