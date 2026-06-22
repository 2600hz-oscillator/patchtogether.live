#!/usr/bin/env bash
# Real-GPU WebGL attestation runner + writer. Thin wrapper around
# scripts/webgl-attest.ts (run via tsx). See that file's header for the
# multi-pass design (fix V5), and .myrobots/plans/webgl-attestation-semaphore.md.
#
# Usage (normally via `task webgl:attest`):
#   bash scripts/webgl-attest.sh             # full real-GPU run + write attestation
#   bash scripts/webgl-attest.sh --dry-run   # verify pass-selection/count-gating/writer wiring
#   REPEAT=3 bash scripts/webgl-attest.sh    # 3× flake-check (pre-MR standard)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Hard refuse SwiftShader at the shell level too (belt-and-suspenders; the .ts
# also checks + probes the real renderer).
if [[ "${E2E_SWIFTSHADER:-}" == "1" ]]; then
  echo "E2E_SWIFTSHADER=1 — a SwiftShader attestation would be a lie. Unset it." >&2
  exit 2
fi

# Keep the machine fully awake for the whole run. A mid-run display sleep / app
# nap / system idle-suspend on macOS pauses or throttles the GPU mid-pass →
# stalled frames → false refusals. caffeinate -dimsu holds display+system+disk
# awake and prevents idle sleep for the duration of the child.
if [[ "$(uname)" == "Darwin" ]] && command -v caffeinate >/dev/null 2>&1; then
  exec caffeinate -dimsu node --import tsx scripts/webgl-attest.ts "$@"
fi
exec node --import tsx scripts/webgl-attest.ts "$@"
