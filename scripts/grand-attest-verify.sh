#!/usr/bin/env bash
# CI-side GRAND-INTEGRATION attestation verify (the `grand-attest` job runs this).
# The grand analogue of scripts/webgl-attest-verify.sh + collab-attest-verify.sh.
#
# Recomputes the deterministic grand content-hash and checks that a matching
# attestation file exists under ci-grand-attest/. The attestation was produced by
# a local heavy `task grand:attest` run on a TRUSTED GPU machine (real GPU
# synesthesia + real H.264 recorderbox + the real clip scheduler + real
# automation) and committed WITH the PR, so it travels through squash-merge (the
# hash is content-keyed, not git-HEAD-keyed).
#
#   match  → the grand-integration scenario substance (the four instrument DSP
#            cores, the pure clip step math, the shared clip fixture, the offline
#            ART + the driver, the toolchain pins) is unchanged-or-attested → CI
#            trusts the local heavy run. EXIT 0.
#   miss   → someone changed the scenario substance without re-attesting on a real
#            GPU → EXIT 1 with `run: flox activate -- task grand:attest`.
#
# HONEST FRAMING (read the README): the ONE robust property is "editing a hashed
# substance file forces a re-attest or CI notices." Every JSON field is
# hand-writable; this catches the lazy/accidental stale case, NOT a deliberate
# forger. The repo is contribution-locked to the owner (owner-only merge +
# fork-PR approval), so this is an owner self-attestation = single-trusted-actor.
#
# NO GPU / DB / LFS / bundle here — cheap (< 2-5 min: checkout + flox + one hash).
# The heavy scenario NEVER runs on CI (SwiftShader can't fairly render synesthesia
# and CI has no OS H.264 encoder — the exact classes the local-attest exists for).
#
# INFORMATIONAL for now: this job is NOT in the required `ci` umbrella's
# failing-condition set — exactly how webgl-attest + collab-attest started. The
# owner flips it required later (add `$GRAND_ATTEST` to the umbrella's failing
# `if`) once the pin has proven stable. See ci-grand-attest/README.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

HASH="$(bash scripts/grand-attest-hash.sh)"
ATTEST_FILE="ci-grand-attest/${HASH}.json"

echo "grand-integration content hash: ${HASH}"

if [[ ! -f "$ATTEST_FILE" ]]; then
  cat >&2 <<EOF
::error::No local grand-integration attestation for the current scenario content (hash ${HASH}).
You changed the grand-integration scenario substance (one of the four instrument
DSP cores under packages/dsp/src/lib, the pure clip step math clip-types.ts/
clip-clock.ts, the shared clip fixture e2e/fixtures/grand-integration/clips.ts, the
offline ART art/scenarios/grand-integration/combined-master.test.ts, the clip
driver art/setup/clip-driver.ts, or a toolchain pin). Run, on a TRUSTED GPU
machine (real H.264 encoder + real GPU):

    flox activate -- task grand:attest

then commit ${ATTEST_FILE} with your PR. (To check whether a re-attest is
required: flox activate -- task grand:attest:check)
EOF
  exit 1
fi

# The match key is the JSON's grandContentHash field (the filename is a
# convenience). Verify it agrees with the recomputed hash.
RECORDED="$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('${ATTEST_FILE}','utf8')).grandContentHash||''))")"
if [[ "$RECORDED" != "$HASH" ]]; then
  echo "::error::${ATTEST_FILE} records grandContentHash=${RECORDED} but the current content hashes to ${HASH}. Re-attest: flox activate -- task grand:attest" >&2
  exit 1
fi

# --- Sanity hints (NOT security — every field is hand-writable) ---------------
ATTESTED_AT="$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('${ATTEST_FILE}','utf8')).attestedAt||'?'))")"
ATTESTED_BY="$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('${ATTEST_FILE}','utf8')).attestedBy||'?'))")"
PW_VER="$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('${ATTEST_FILE}','utf8')).playwrightVersion||'?'))")"
GPU="$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('${ATTEST_FILE}','utf8')).gpu||'?'))")"
PASSED="$(node -e "process.stdout.write(String((JSON.parse(require('fs').readFileSync('${ATTEST_FILE}','utf8')).run||{}).passed||0))")"
ARTSHA="$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('${ATTEST_FILE}','utf8')).combinedMasterSha||''))")"

# An attestation that records zero passes is self-inconsistent (the runner
# refuses to write such a file) — flag it.
if [[ "$PASSED" == "0" ]]; then
  echo "::error::Attestation ${ATTEST_FILE} records 0 passed grand-integration tests — vacuous. Re-attest." >&2
  exit 1
fi

# Cross-check: the attestation records the offline-ART combined-master .sha it
# validated. If the committed baseline .sha has since moved but the attestation
# was not re-run, the recorded art SHA won't match — a cheap staleness sniff (the
# baseline .sha is NOT in the content hash, so this is the belt to that suspenders).
BASELINE_SHA_FILE="art/baselines/grand-integration/combined-master.sha"
if [[ -n "$ARTSHA" && -f "$BASELINE_SHA_FILE" ]]; then
  LIVE_ARTSHA="$(tr -d '[:space:]' < "$BASELINE_SHA_FILE")"
  if [[ "$ARTSHA" != "$LIVE_ARTSHA" ]]; then
    echo "::error::Attestation ${ATTEST_FILE} recorded combinedMasterSha=${ARTSHA} but the committed baseline is ${LIVE_ARTSHA}. The offline ART changed without a re-attest. Re-attest: flox activate -- task grand:attest" >&2
    exit 1
  fi
fi

echo "grand-integration attested locally on a real GPU at ${ATTESTED_AT} by ${ATTESTED_BY} (Playwright ${PW_VER}, GPU ${GPU}, ${PASSED} passed). The heavy scenario stays LOCAL-only (CI trusts the trusted-machine run); the offline combined-master ART also runs deterministically on the normal ART lane."
exit 0
