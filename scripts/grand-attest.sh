#!/usr/bin/env bash
# Local heavy GRAND-INTEGRATION attestation runner + writer. Thin wrapper around
# scripts/grand-attest.ts (run via tsx). The grand analogue of
# scripts/webgl-attest.sh + scripts/collab-attest.sh. See that .ts file's header
# for the design (real GPU synesthesia + real H.264 recorderbox + real clip
# scheduler + real automation; refuses SwiftShader / a busy machine) and
# .myrobots/plans/grand-integration-e2e-art-2026-07-19.md.
#
# Usage (normally via `task grand:attest`):
#   bash scripts/grand-attest.sh             # full real-GPU run + write attestation
#   bash scripts/grand-attest.sh --dry-run   # verify preflight/probe/run/writer wiring
#   REPEAT=3 bash scripts/grand-attest.sh    # 3× flake-check (pre-MR standard)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Hard refuse SwiftShader at the shell level too (belt-and-suspenders; the .ts
# also checks + probes the real renderer).
if [[ "${E2E_SWIFTSHADER:-}" == "1" ]]; then
  echo "E2E_SWIFTSHADER=1 — a SwiftShader grand attestation would be a lie. Unset it." >&2
  exit 2
fi

# Keep the machine fully awake for the whole run (macOS): a mid-run display sleep
# / app nap throttles the GPU → stalled synesthesia frames → false refusals.
if [[ "$(uname)" == "Darwin" ]] && command -v caffeinate >/dev/null 2>&1; then
  exec caffeinate -dimsu node --import tsx scripts/grand-attest.ts "$@"
fi
exec node --import tsx scripts/grand-attest.ts "$@"
