#!/usr/bin/env bash
# Deterministic content hash of every input that feeds `task dsp:build`.
#
# Inputs hashed (in a stable, sorted order):
#   - packages/dsp/src/**      — the .dsp / .ts worklet sources + lib
#   - packages/dsp/scripts/**  — the build pipeline (build.mjs / build-worklet.mjs)
#   - packages/dsp/package.json — pins @grame/faustwasm + esbuild versions
#   - .flox/env/manifest.toml  — pins the Faust + Node toolchain versions
#
# Why this exists: the DSP worklets are slow to compile (Faust) and were being
# rebuilt ~16× per CI run (once per e2e shard, vrt, vrt-strict, art, …). We now
# build them ONCE in the `dsp-build` CI job and restore packages/dsp/dist/**
# everywhere else. This script produces the fingerprint that:
#   1. the `dsp:build` Taskfile task writes into dist/.dsp-srchash, and
#   2. the same task's `status:` guard compares against — so a job that calls
#      `task art|vrt|build` (which list dsp:build as a dep) REUSES the restored
#      dist instead of recompiling, as long as the sources are unchanged.
#
# It is the source-of-truth-on-disk equivalent of the CI cache key
# (which uses GitHub's hashFiles() over the same paths). The two algorithms
# differ but serve the same set of inputs; correctness only requires that the
# sentinel reflect the sources that actually produced the restored dist.
set -euo pipefail

# Resolve repo root from this script's location so it works from any cwd.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Collect the input files in a stable order. `find | sort` is deterministic
# across machines; we hash both the path and the content of each file so a
# rename also invalidates.
{
  find packages/dsp/src packages/dsp/scripts -type f -print0 \
    | LC_ALL=C sort -z \
    | while IFS= read -r -d '' f; do
        printf '%s\0' "$f"
        cat "$f"
      done
  cat packages/dsp/package.json
  cat .flox/env/manifest.toml
} | {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum
  else
    # macOS / BSD fallback
    shasum -a 256
  fi
} | cut -d' ' -f1
