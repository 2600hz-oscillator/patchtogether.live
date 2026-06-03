#!/usr/bin/env bash
# scripts/dsp-fetch-dist.sh — populate packages/dsp/dist from a PREBUILT copy
# instead of compiling Faust.
#
# Why: fresh `isolation: worktree` agent checkouts (and any env where the Faust
# toolchain or `@grame/faustwasm` isn't installed) can't run `task dsp:build`.
# But many local single-test runs (e2e/vrt/art) only NEED the compiled dist on
# disk — they don't care that it was produced here. So copy a known-good dist
# from the primary checkout (the main worktree) and stamp a fresh source hash so
# the `dsp:build` status-guard treats it as current and skips recompiling.
#
# This is a LOCAL DEV-LOOP convenience only. CI always compiles via the
# dedicated dsp-build job; this never runs there. The normal `task dsp:build`
# path is unchanged — `task dsp:ensure` only falls back to this when a real
# build isn't possible.
#
# Source resolution (first hit wins):
#   1. $DSP_DIST_SRC                       — explicit override (a dist/ dir)
#   2. <git-common-dir>/../packages/dsp/dist   — the primary worktree's dist
#   3. any sibling worktree with a populated packages/dsp/dist
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DEST="$ROOT/packages/dsp/dist"

dist_is_populated() {
  # A real dist has the source-hash sentinel plus at least one built artifact.
  [ -d "$1" ] && [ -n "$(ls -A "$1" 2>/dev/null || true)" ] \
    && ls "$1"/*.sha >/dev/null 2>&1
}

resolve_src() {
  # 1. explicit override
  if [ -n "${DSP_DIST_SRC:-}" ]; then
    if dist_is_populated "$DSP_DIST_SRC"; then echo "$DSP_DIST_SRC"; return 0; fi
    echo "[dsp:fetch-dist] DSP_DIST_SRC=$DSP_DIST_SRC is not a populated dist/" >&2
    return 1
  fi

  # 2. the primary checkout (parent of the shared .git common dir)
  local common primary
  common="$(git rev-parse --git-common-dir 2>/dev/null || true)"
  if [ -n "$common" ]; then
    # common is usually <main-checkout>/.git
    primary="$(cd "$(dirname "$common")" 2>/dev/null && pwd || true)"
    if [ -n "$primary" ] && [ "$primary" != "$ROOT" ]; then
      if dist_is_populated "$primary/packages/dsp/dist"; then
        echo "$primary/packages/dsp/dist"; return 0
      fi
    fi
  fi

  # 3. any sibling worktree with a populated dist
  while IFS= read -r wt; do
    [ "$wt" = "$ROOT" ] && continue
    if dist_is_populated "$wt/packages/dsp/dist"; then
      echo "$wt/packages/dsp/dist"; return 0
    fi
  done < <(git worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}')

  return 1
}

SRC="$(resolve_src || true)"
if [ -z "$SRC" ]; then
  cat >&2 <<EOF
[dsp:fetch-dist] No prebuilt packages/dsp/dist found to copy from.
  Tried: \$DSP_DIST_SRC, the primary worktree, and sibling worktrees.
  Either run a real build in an env with Faust:  flox activate -- task dsp:build
  or point at a known-good dist:                 DSP_DIST_SRC=/path/to/dist task dsp:fetch-dist
EOF
  exit 1
fi

echo "[dsp:fetch-dist] copying prebuilt dist:"
echo "  from: $SRC"
echo "  to:   $DEST"

# Staleness check: if the source dist carries its own .dsp-srchash and it does
# NOT match THIS worktree's current sources, the copied dist was built from
# different DSP sources — modules you added/changed here won't be in it. Warn
# loudly; re-stamping below would otherwise silently hide the mismatch behind a
# green status guard. (In a real Faust env, run `task dsp:build` instead.)
SRC_HASH=""
[ -f "$SRC/.dsp-srchash" ] && SRC_HASH="$(cat "$SRC/.dsp-srchash" 2>/dev/null)"
CUR_HASH="$(bash "$ROOT/scripts/dsp-src-hash.sh")"
if [ -n "$SRC_HASH" ] && [ "$SRC_HASH" != "$CUR_HASH" ]; then
  echo "[dsp:fetch-dist] WARNING: source dist was built from DIFFERENT DSP sources" >&2
  echo "[dsp:fetch-dist]   than this worktree has. Modules you added/changed here may" >&2
  echo "[dsp:fetch-dist]   be MISSING from the copied dist. For an exact build, run" >&2
  echo "[dsp:fetch-dist]   \`task dsp:build\` in a Faust-capable env." >&2
fi

mkdir -p "$DEST"
# Mirror the source dir (incl. the .dsp-srchash sentinel + dotfiles).
rm -rf "$DEST"
cp -R "$SRC" "$DEST"

# Re-stamp the sentinel to THIS worktree's sources so the dsp:build status guard
# reports "up to date" for the common case (source dist built from identical
# committed sources). When the warning above fired, this is a deliberate
# "good enough to run single tests" stamp — not a claim the dist is exact.
echo "$CUR_HASH" > "$DEST/.dsp-srchash"
echo "[dsp:fetch-dist] done — re-stamped .dsp-srchash for this worktree."
echo "[dsp:fetch-dist] \`task dsp:build\` will now skip recompiling (status guard satisfied)."
