#!/usr/bin/env bash
# Thin shell wrapper: prints the deterministic WebGL content-hash to stdout.
#
# The real work is in scripts/webgl-attest-lib.ts (run via tsx) so BOTH the
# hash AND the §12 coverage guard share one resolver and can't drift. We avoid
# bash text-parsing the exported glob (adversarial-review fix V4) entirely — the
# .ts imports e2e/webgl-heavy-globs.ts directly and resolves with minimatch (the
# matcher Playwright uses).
#
#
# ⚠ PREDICTING WHETHER YOUR CHANGE MOVES THIS HASH — READ THE FIELD LIST, NOT
# YOUR INTENT.
#
#   The normalizer strips `docs`, `controlFamilies`, `face` and `noUserControl`
#   — and NOTHING ELSE. So "it's only a doc change" is a claim about the FIELD,
#   not about the FILE. A commit that edits prose AND a def field is not a prose
#   commit.
#
# This has been got wrong twice, in opposite directions, and both times by
# reasoning from what the change was ABOUT instead of from what is kept:
#   * "deleting the 194 legacy cards will move it — the basis includes each
#     rendersWebGL module's card source". It did not: `--list` is 220 files with
#     ZERO *Card.svelte, because cube/wavesculpt enter through their extracted
#     *VizSurface.svelte.
#   * "the legacy-prose sweep will not move it — docs props are transparent".
#     It did: the same commit retired the `card:` DEF FIELD, six declarations of
#     which live in lib/video/modules/ — 96 of the 220 basis files.
#
# Do not trust a hash written down anywhere, including in .myrobots notes. Run
# `flox activate -- task webgl:attest:check`.
#
# Usage:
#   HASH=$(bash scripts/webgl-attest-hash.sh)          # the hash
#   bash scripts/webgl-attest-hash.sh --list           # the basis file set
#
# See .claude/skills/renderer-tests/SKILL.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

exec node --import tsx scripts/webgl-attest-hash.ts "$@"
