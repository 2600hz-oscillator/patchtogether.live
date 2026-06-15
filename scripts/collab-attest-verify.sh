#!/usr/bin/env bash
# CI-side @collab attestation verify (the `collab-attest` job runs this).
# The collab analogue of scripts/webgl-attest-verify.sh.
#
# Recomputes the deterministic @collab content-hash and checks that a matching
# attestation file exists under ci-collab-attest/. The attestation was produced
# by a local FRESH-dedicated-relay+DB `task collab:attest` run and committed WITH
# the PR, so it travels through squash-merge (the hash is content-keyed, not
# git-HEAD-keyed).
#
#   match  → the collab surface is unchanged-or-attested → the ~6.5-8 min @collab
#            lane stays per-PR-informational; CI trusts the local calm-relay run.
#            EXIT 0.
#   miss   → someone changed a collab/sync/relay path without re-attesting →
#            EXIT 1 with `run: flox activate -- task collab:attest`.
#
# HONEST FRAMING (read the README): the ONE robust property is "editing a hashed
# collab file forces a re-attest or CI fails" (accidental staleness, in-basis).
# Every JSON field is hand-writable; this catches the lazy/accidental stale case,
# NOT a deliberate forger. The repo is contribution-locked to the owner
# (owner-only merge + fork-PR approval), so this is an owner-self-attestation =
# single-trusted-actor model.
#
# CAVEAT (differs from webgl-attest): a calm LOCAL relay is merely LESS
# CONTENDED than CI's, not strictly superior — a calm local pass can mask an
# under-load multiplayer race. The NIGHTLY backstop (collab-nightly.yml) runs the
# FULL real @collab lane on CI to surface contention regressions daily. See
# .myrobots/plans/collab-attest-2026-06-15.md §caveat.
#
# INFORMATIONAL for now: this job is NOT in the required `ci` umbrella's
# failing-condition set — exactly how webgl-attest started. The owner flips it
# required later via the ruleset (see the plan doc + README).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

HASH="$(bash scripts/collab-attest-hash.sh)"
ATTEST_FILE="ci-collab-attest/${HASH}.json"

echo "@collab content hash: ${HASH}"

if [[ ! -f "$ATTEST_FILE" ]]; then
  cat >&2 <<EOF
::error::No local @collab attestation for the current collab content (hash ${HASH}).
You changed a collab/sync/relay path (the Hocuspocus relay under packages/server,
the client sync/presence/roster layer under lib/multiplayer, the syncedStore glue,
the DOOM multiplayer netcode/roster/lockstep, a @collab spec, the DB schema, or a
toolchain pin). Run, with a local Postgres up + DATABASE_URL set:

    flox activate -- task collab:attest

then commit ${ATTEST_FILE} with your PR. (To check whether a re-attest is
required: flox activate -- task collab:attest:check)
EOF
  exit 1
fi

# The match key is the JSON's collabContentHash field (the filename is a
# convenience). Verify it agrees with the recomputed hash.
RECORDED="$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('${ATTEST_FILE}','utf8')).collabContentHash||''))")"
if [[ "$RECORDED" != "$HASH" ]]; then
  echo "::error::${ATTEST_FILE} records collabContentHash=${RECORDED} but the current content hashes to ${HASH}. Re-attest: flox activate -- task collab:attest" >&2
  exit 1
fi

# --- Sanity hints (NOT security — every field is hand-writable) ---------------
ATTESTED_AT="$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('${ATTEST_FILE}','utf8')).attestedAt||'?'))")"
ATTESTED_BY="$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('${ATTEST_FILE}','utf8')).attestedBy||'?'))")"
PW_VER="$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('${ATTEST_FILE}','utf8')).playwrightVersion||'?'))")"
PASSED="$(node -e "process.stdout.write(String((JSON.parse(require('fs').readFileSync('${ATTEST_FILE}','utf8')).run||{}).passed||0))")"
VAC="$(node -e "process.stdout.write(String((JSON.parse(require('fs').readFileSync('${ATTEST_FILE}','utf8')).run||{}).relayVacuitySkips||0))")"
DB_OK="$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('${ATTEST_FILE}','utf8')).databaseConfirmed||false))")"

# An attestation that records a relay-vacuity skip, an unconfirmed DB, or zero
# passes is self-inconsistent (the runner refuses to write such a file) — flag it.
if [[ "$VAC" != "0" ]]; then
  echo "::error::Attestation ${ATTEST_FILE} records relayVacuitySkips=${VAC} (>0). A genuine attest run refuses to write with any relay-vacuity skip. Re-attest." >&2
  exit 1
fi
if [[ "$DB_OK" != "true" ]]; then
  echo "::error::Attestation ${ATTEST_FILE} does not record databaseConfirmed=true. The @collab lane is vacuous without a DB. Re-attest." >&2
  exit 1
fi
if [[ "$PASSED" == "0" ]]; then
  echo "::error::Attestation ${ATTEST_FILE} records 0 passed @collab tests — vacuous. Re-attest." >&2
  exit 1
fi

echo "@collab attested locally on a fresh dedicated relay+DB at ${ATTESTED_AT} by ${ATTESTED_BY} (Playwright ${PW_VER}, ${PASSED} passed, 0 relay-vacuity skips). The ~6.5-8 min @collab lane stays per-PR-informational (trusting the local calm-relay run; nightly backstop covers under-load)."
exit 0
