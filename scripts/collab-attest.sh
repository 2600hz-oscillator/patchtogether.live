#!/usr/bin/env bash
# Local @collab attestation runner + writer. Thin wrapper around
# scripts/collab-attest.ts (run via tsx). The collab analogue of
# scripts/webgl-attest.sh. See that .ts file's header for the design (fresh
# dedicated relay+DB, relay-vacuity-skip = hard failure) and
# .myrobots/plans/collab-attest-2026-06-15.md.
#
# Usage (normally via `task collab:attest`):
#   bash scripts/collab-attest.sh             # full run on a fresh relay+DB + write attestation
#   bash scripts/collab-attest.sh --dry-run   # verify the DB/relay/skip-classify/writer wiring
#   REPEAT=3 bash scripts/collab-attest.sh    # 3x flake-check (pre-MR standard)
#
# REQUIRES a real Postgres reachable via $DATABASE_URL — the @collab lane is
# VACUOUS without a DB. The runner asserts it (and applies the schema) before
# running, and REFUSES to write an attestation if any @collab spec skips for a
# relay/sync reason (a vacuous run proves nothing about multiplayer).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

exec node --import tsx scripts/collab-attest.ts "$@"
