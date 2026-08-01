#!/usr/bin/env bash
# scripts/vrt-geom-audit.sh — decode two revisions of every changed VRT
# baseline and report the ones whose PIXEL GEOMETRY moved.
#
# WHY THIS EXISTS: `git diff --name-status` reports A/D/M. A same-name PNG that
# changed SIZE is an "M", identical in that report to a pure recolour. So
# "0 added / 0 deleted, therefore nothing structural" is the wrong instrument —
# it is invariant to exactly the thing it claims to rule out. Decoding the IHDR
# is the instrument that can see it.
#
# ─────────────────────────────────────────────────────────────────────────
# ⚠ THIS TOOL COULD NOT RUN ON ITS OWN COMMIT RANGE, AND THAT IS HOW THE BUG
# IT EXISTS TO CATCH GOT THROUGH.
#
# The first version ran `git show "$OLD:$f"` for every path in
# `git diff --name-only`, under `set -euo pipefail`. A baseline ADDED inside
# the range does not exist at OLD, so `git show` exits 128 —
#
#     fatal: path '…/vco-scope-audio-trace.png' exists on disk, but not in '<old>'
#
# — and `set -e` tore the scan down at the FIRST added file, silently skipping
# every path after it. The branch that shipped this script also added a
# baseline, so the audit aborted partway through its own range and a SECOND
# undocumented geometry change (warrenspectrum 526x527 → 527x527) sat
# unreported behind the abort. A gate that cannot run is decoration; a gate
# that runs halfway and exits 0 is worse, because it looks like it ran.
#
# Fixed here: A/D/M are handled explicitly, one missing blob can no longer
# abort the sweep, and the tally survives (the old `changed` counter lived
# inside a `while` on the right-hand side of a pipe — its own subshell — so it
# was always 0 by the time the script ended).
#
#   scripts/vrt-geom-audit.sh <old-rev> <new-rev> [--strict]
#
#     --strict   exit 1 when any geometry moved (for a CI/pre-push gate).
#                Default is report-only, exit 0.
set -uo pipefail

OLD="${1:?usage: vrt-geom-audit.sh <old-rev> <new-rev> [--strict]}"
NEW="${2:?usage: vrt-geom-audit.sh <old-rev> <new-rev> [--strict]}"
STRICT=0
[ "${3:-}" = "--strict" ] && STRICT=1

dim() {
  python3 -c "
import sys,struct
d=sys.stdin.buffer.read()
if len(d)<24 or d[:8]!=b'\x89PNG\r\n\x1a\n':
    print('NOT-A-PNG'); sys.exit()
w,h=struct.unpack('>II',d[16:24])
print(f'{w}x{h}')
"
}

# Decode one path at one rev. Prints the WxH, or ABSENT when the blob does not
# exist at that rev — NEVER fails the caller, which is the whole fix.
#
# Existence is probed with `git cat-file -e` rather than by capturing
# `git show` into a variable: command substitution is not binary-safe (it
# strips NULs and trailing newlines), and a baseline that is NOT LFS-tracked
# would come back as mangled bytes and decode as NOT-A-PNG — a false finding
# that looks exactly like a real one.
dim_at() {
  local rev="$1" path="$2"
  if ! git cat-file -e "$rev:$path" 2>/dev/null; then
    echo "ABSENT"
    return 0
  fi
  git show "$rev:$path" 2>/dev/null | git lfs smudge 2>/dev/null | dim
}

changed=0
added=0
deleted=0
same=0

# `--no-renames` so a rename is reported as its A + D halves: a renamed
# baseline IS a new snapshot name, and pairing it with its old name would hide
# that. Process substitution (not a pipe) so the counters live in THIS shell.
while IFS=$'\t' read -r status path rest; do
  [ -n "${path:-}" ] || continue
  case "$status" in
    A*)
      b="$(dim_at "$NEW" "$path")"
      echo "ADDED             $path  (new: $b)"
      added=$((added + 1))
      ;;
    D*)
      a="$(dim_at "$OLD" "$path")"
      echo "DELETED           $path  (was: $a)"
      deleted=$((deleted + 1))
      ;;
    *)
      a="$(dim_at "$OLD" "$path")"
      b="$(dim_at "$NEW" "$path")"
      if [ "$a" != "$b" ]; then
        echo "GEOMETRY-CHANGED  $path  $a -> $b"
        changed=$((changed + 1))
      else
        echo "same              $a  $path"
        same=$((same + 1))
      fi
      ;;
  esac
done < <(git diff --name-status --no-renames "$OLD" "$NEW" -- 'e2e/vrt/__screenshots__/**')

echo
echo "── vrt-geom-audit  $OLD..$NEW ────────────────────────────────"
echo "  geometry changed : $changed"
echo "  added            : $added"
echo "  deleted          : $deleted"
echo "  same geometry    : $same"

if [ "$STRICT" = "1" ] && [ "$changed" -gt 0 ]; then
  echo "  --strict: FAILING because $changed baseline(s) changed pixel geometry." >&2
  exit 1
fi
exit 0
