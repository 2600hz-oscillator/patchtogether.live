#!/usr/bin/env bash
# Thin shell wrapper: prints the deterministic GRAND-INTEGRATION content-hash to
# stdout. The real work is in scripts/grand-attest-lib.ts (run via tsx) so the
# hash, the runner, and the basis guard share one resolver and can't drift.
# Mirrors scripts/webgl-attest-hash.sh + scripts/collab-attest-hash.sh.
#
# Usage:
#   HASH=$(bash scripts/grand-attest-hash.sh)          # the hash
#   bash scripts/grand-attest-hash.sh --list           # the basis file set
#
# See .myrobots/plans/grand-integration-e2e-art-2026-07-19.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

exec node --import tsx scripts/grand-attest-hash.ts "$@"
