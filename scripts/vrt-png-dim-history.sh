#!/usr/bin/env bash
# scripts/vrt-png-dim-history.sh <path> — print the decoded WxH of an
# LFS-tracked baseline at every commit that touched it.
set -euo pipefail
F="${1:?path}"
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
git log --format='%h %ad %s' --date=short -- "$F" | while read -r sha rest; do
  d=$(git show "$sha:$F" 2>/dev/null | git lfs smudge | dim || echo "MISSING")
  echo "$d  $sha  $rest"
done
