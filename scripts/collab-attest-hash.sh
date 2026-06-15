#!/usr/bin/env bash
# Thin shell wrapper: prints the deterministic @collab content-hash to stdout.
#
# The real work is in scripts/collab-attest-lib.ts (run via tsx) so the hash,
# the runner, and the basis guard share one resolver and can't drift. Mirrors
# scripts/webgl-attest-hash.sh.
#
# Usage:
#   HASH=$(bash scripts/collab-attest-hash.sh)          # the hash
#   bash scripts/collab-attest-hash.sh --list           # the basis file set
#
# See .myrobots/plans/collab-attest-2026-06-15.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

exec node --import tsx scripts/collab-attest-hash.ts "$@"
