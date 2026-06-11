#!/usr/bin/env bash
# Thin shell wrapper: prints the deterministic WebGL content-hash to stdout.
#
# The real work is in scripts/webgl-attest-lib.ts (run via tsx) so BOTH the
# hash AND the §12 coverage guard share one resolver and can't drift. We avoid
# bash text-parsing the exported glob (adversarial-review fix V4) entirely — the
# .ts imports e2e/webgl-heavy-globs.ts directly and resolves with minimatch (the
# matcher Playwright uses).
#
# Usage:
#   HASH=$(bash scripts/webgl-attest-hash.sh)          # the hash
#   bash scripts/webgl-attest-hash.sh --list           # the basis file set
#
# See .myrobots/plans/webgl-attestation-semaphore.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

exec node --import tsx scripts/webgl-attest-hash.ts "$@"
