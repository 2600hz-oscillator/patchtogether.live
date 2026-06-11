#!/usr/bin/env bash
# CI-side WebGL attestation verify (the `webgl-attest` job runs this).
#
# Recomputes the deterministic WebGL content-hash and checks that a matching
# attestation file exists under ci-webgl-attest/. The attestation was produced
# by a real-GPU `task webgl:attest` run locally and committed WITH the PR, so it
# travels through squash-merge (the hash is content-keyed, not git-HEAD-keyed).
#
#   match  → the WebGL surface is unchanged-or-attested → the heavy WebGL lane
#            stays skipped (CI trusts the local real-GPU run). EXIT 0.
#   miss   → someone changed a WebGL/video path without re-attesting → EXIT 1
#            with `run: flox activate -- task webgl:attest`.
#
# HONEST FRAMING (read the README): the ONE robust property is "editing a hashed
# WebGL file forces a re-attest or CI fails" (accidental staleness, in-basis).
# Every JSON field is hand-writable; the sanity hints below catch the lazy /
# accidental SwiftShader-or-stale case, NOT a deliberate forger. The repo is
# contribution-locked to the owner (owner-only merge + fork-PR approval), so this
# is an owner-self-attestation = single-trusted-actor model, which is the basis
# on which the honor-system is acceptable. See
# .myrobots/plans/webgl-attestation-semaphore.md (§-2, §7).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

HASH="$(bash scripts/webgl-attest-hash.sh)"
ATTEST_FILE="ci-webgl-attest/${HASH}.json"

echo "WebGL content hash: ${HASH}"

if [[ ! -f "$ATTEST_FILE" ]]; then
  cat >&2 <<EOF
::error::No real-GPU WebGL attestation for the current WebGL content (hash ${HASH}).
You changed a WebGL/video path (a video module/engine/GL lib, a WebGL card —
CUBE/HYPERCUBE/WAVESCULPT —, a heavy WebGL spec, or a toolchain pin). Run, on a
machine with a REAL GPU:

    flox activate -- task webgl:attest

then commit ${ATTEST_FILE} with your PR. (If you only need to check whether a
re-attest is required: flox activate -- task webgl:attest:check)
EOF
  exit 1
fi

# The match key is the JSON's webglContentHash field (the filename is a
# convenience). Verify it agrees with the recomputed hash.
RECORDED="$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('${ATTEST_FILE}','utf8')).webglContentHash||''))")"
if [[ "$RECORDED" != "$HASH" ]]; then
  echo "::error::${ATTEST_FILE} records webglContentHash=${RECORDED} but the current content hashes to ${HASH}. Re-attest: flox activate -- task webgl:attest" >&2
  exit 1
fi

# --- Sanity hints (NOT security — every field is hand-writable; §7.4) ---------
# These catch the accidental SwiftShader-or-stale-Playwright case, not a forger.
ATTESTED_AT="$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('${ATTEST_FILE}','utf8')).attestedAt||'?'))")"
ATTESTED_BY="$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('${ATTEST_FILE}','utf8')).attestedBy||'?'))")"
PW_VER_ATTEST="$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('${ATTEST_FILE}','utf8')).playwrightVersion||'?'))")"
RENDERER="$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('${ATTEST_FILE}','utf8')).gpu||'?'))")"

# Reject an attestation that claims SwiftShader — the whole point is a real GPU.
if printf '%s' "$RENDERER" | grep -qiE 'swiftshader|software'; then
  echo "::error::Attestation ${ATTEST_FILE} reports a SwiftShader/software renderer ('${RENDERER}'). A real-GPU run is required; re-attest on real hardware." >&2
  exit 1
fi

echo "WebGL attested locally on real GPU at ${ATTESTED_AT} by ${ATTESTED_BY} (Playwright ${PW_VER_ATTEST}, ${RENDERER}). Heavy WebGL lane skipped (trusting the local run)."
exit 0
