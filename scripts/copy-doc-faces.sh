#!/usr/bin/env bash
# scripts/copy-doc-faces.sh
#
# Copy the numbered card-FACE PNGs from the VRT-generated source tree into the
# web package's static assets so the prerendered doc page (/docs/modules/[id])
# can serve them as <img src>.
#
#   source: e2e/vrt/__annotated__/{type}.png   (LFS, committed)
#   dest:   packages/web/static/docs/module-faces/{type}.png
#
# There is ONE face set, not one per platform. This used to read
# `__annotated__/darwin/` because vrt-annotated.config.ts wrote a {platform}
# subdir; both dropped it when the VRT baseline tree collapsed to a single
# linux-authored set. The legend JSON has always lived flat in __annotated__/ —
# the doc loader globs it to render the numbered KEY (resolved to authored
# docs.controls).
#
# Idempotent + safe on a fresh checkout: if no card faces exist yet it prints a
# notice and exits 0 (the doc page falls back to the IoDiagram).
#
# Wired into `task build` / `task build:web` (via docs:faces) so a production
# build always has fresh faces, and into `task vrt:annotated` after generation.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/e2e/vrt/__annotated__"
DEST="$ROOT/packages/web/static/docs/module-faces"

mkdir -p "$DEST"

if [ ! -d "$SRC" ] || ! ls "$SRC"/*.png >/dev/null 2>&1; then
  echo "[docs:faces] no annotated faces at $SRC yet — skipping (doc page uses the IoDiagram fallback)"
  exit 0
fi

count=0
for f in "$SRC"/*.png; do
  base="$(basename "$f")"
  cp -f "$f" "$DEST/$base"
  count=$((count + 1))
done

echo "[docs:faces] copied $count face PNG(s) → packages/web/static/docs/module-faces/"
