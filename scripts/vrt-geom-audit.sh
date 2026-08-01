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
#   scripts/vrt-geom-audit.sh <old-rev> <new-rev>
set -euo pipefail

OLD="${1:?old rev}"
NEW="${2:?new rev}"

dim() {
  python3 -c "
import sys,struct
d=sys.stdin.buffer.read()
if d[:8]!=b'\x89PNG\r\n\x1a\n':
    print('NOT-A-PNG'); sys.exit()
w,h=struct.unpack('>II',d[16:24])
print(f'{w}x{h}')
"
}

changed=0
git diff --name-only "$OLD" "$NEW" -- 'e2e/vrt/__screenshots__/**' | while read -r f; do
  a=$(git show "$OLD:$f" | git lfs smudge | dim)
  b=$(git show "$NEW:$f" | git lfs smudge | dim)
  if [ "$a" != "$b" ]; then
    echo "GEOMETRY-CHANGED  $f  $a -> $b"
    changed=$((changed + 1))
  else
    echo "same              $a  $f"
  fi
done
