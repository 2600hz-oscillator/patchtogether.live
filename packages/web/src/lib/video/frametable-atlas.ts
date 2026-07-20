// packages/web/src/lib/video/frametable-atlas.ts
//
// FRAMETABLE — pure PNG sprite-sheet ATLAS layout math (the `.frametable.png`
// file format). NO WebGL / NO DOM here — every function is a pure, jsdom-safe
// transform so the SAVE tiler + LOAD detiler share ONE source of truth that is
// unit-tested (frametable-atlas.test.ts), the wavetable-parser.ts analogue.
//
// The file is a single lossless PNG contact-sheet of ALL 60 ring frames laid
// out on a FIXED 10×6 = 60 grid (no blanks, no codec → CI/SwiftShader-safe).
// Each tile is one ring frame at the saved half-res; the tile size is INFERRED
// on load from the decoded atlas dimensions (`tileW = atlasW/COLS`,
// `tileH = atlasH/ROWS`), so the file is self-describing from its dimensions +
// the fixed grid — no custom chunks (canvas `toBlob` can't write PNG tEXt).
//
// FRAME ORDERING = CHRONOLOGICAL (oldest→newest), tile index `c` → grid cell
// `col = c % COLS, row = floor(c / COLS)` (row 0 = TOP), independent of the live
// ring's rotating write head:
//   • SAVE: chronological frame `c` (0 = oldest) is ring layer `(head + c) % N`
//     (`head` = next-to-write = the OLDEST layer)  → chronoToLayer.
//   • LOAD: tile `c` is written straight into ring layer `c`, then `head := 0`
//     (⇒ newest completed = N-1), so the mapping round-trips symmetrically.
//
// Y-ORIENTATION (pinned by the round-trip unit test). GL `readPixels` is
// BOTTOM-origin, canvases are TOP-origin, and the LOAD upload uses
// `UNPACK_FLIP_Y_WEBGL = true`. The consistent, human-viewable convention:
//   • SAVE flips each readback tile's rows (flipRowsY) so the atlas PNG is
//     UPRIGHT (a human-viewable contact sheet), placed at `tileRect(c)`.
//   • LOAD uploads the upright atlas with UNPACK_FLIP_Y_WEBGL = true and detiles
//     with `tileUvTransform(c)` (whose `oy` folds in the grid-row flip). The two
//     vertical flips compose to identity, so a saved frame reloads bit-exact
//     (proven by the flipRowsY-involution + layout-identity tests).

import { FRAMETABLE_RING_FRAMES, wrapIndex } from './frametable-core';

/** Atlas grid — a FIXED 10×6 contact sheet = exactly 60 tiles (one per ring
 *  frame), no blanks. Matched to FRAMETABLE_RING_FRAMES; a mismatch is a bug. */
export const FRAMETABLE_ATLAS_COLS = 10;
export const FRAMETABLE_ATLAS_ROWS = 6;
export const FRAMETABLE_ATLAS_TILES = FRAMETABLE_ATLAS_COLS * FRAMETABLE_ATLAS_ROWS; // 60

/** Suggested double-extension for the file (a valid PNG; the `.frametable`
 *  marker signals the tiling convention). `accept` string for the file input. */
export const FRAMETABLE_FILE_EXT = '.frametable.png';
export const FRAMETABLE_FILE_ACCEPT = '.frametable.png,.png,image/png';

/** Chronological tile index `c` (0..59) → its grid cell. Row 0 = TOP. */
export function tileColRow(c: number): { col: number; row: number } {
  const t = ((Math.trunc(c) % FRAMETABLE_ATLAS_TILES) + FRAMETABLE_ATLAS_TILES) % FRAMETABLE_ATLAS_TILES;
  return { col: t % FRAMETABLE_ATLAS_COLS, row: Math.floor(t / FRAMETABLE_ATLAS_COLS) };
}

/** Pixel rect of chronological tile `c` in a TOP-origin atlas of `tileW × tileH`
 *  tiles — the SAVE tiler's `drawImage`/`putImageData` destination. */
export function tileRect(
  c: number,
  tileW: number,
  tileH: number,
): { sx: number; sy: number; sw: number; sh: number } {
  const { col, row } = tileColRow(c);
  return { sx: col * tileW, sy: row * tileH, sw: tileW, sh: tileH };
}

/**
 * COPY-pass detile UV transform for chronological tile `c`: sample the atlas
 * scratch texture at `vUv * (sx, sy) + (ox, oy)`. `oy` folds in the grid-row
 * flip for the `UNPACK_FLIP_Y_WEBGL = true` upload of the upright atlas, so tile
 * `c` samples exactly the region the SAVE tiler wrote it to.
 */
export function tileUvTransform(c: number): { sx: number; sy: number; ox: number; oy: number } {
  const { col, row } = tileColRow(c);
  return {
    sx: 1 / FRAMETABLE_ATLAS_COLS,
    sy: 1 / FRAMETABLE_ATLAS_ROWS,
    ox: col / FRAMETABLE_ATLAS_COLS,
    // FLIP_Y upload: atlas TOP-origin grid row `row` lands at texture-v top.
    oy: (FRAMETABLE_ATLAS_ROWS - 1 - row) / FRAMETABLE_ATLAS_ROWS,
  };
}

/** SAVE mapping: chronological frame `c` (0 = oldest) → ring layer, given the
 *  write `head` (= next-to-write = the OLDEST layer). */
export function chronoToLayer(head: number, c: number, ringFrames: number = FRAMETABLE_RING_FRAMES): number {
  return wrapIndex(head + c, ringFrames);
}

/** Inverse of {@link chronoToLayer}: ring layer → chronological frame index. */
export function layerToChrono(head: number, layer: number, ringFrames: number = FRAMETABLE_RING_FRAMES): number {
  return wrapIndex(layer - head, ringFrames);
}

/** Derived atlas geometry + validity from decoded PNG dimensions. `valid` iff
 *  the dimensions divide EXACTLY into the fixed 10×6 grid (else the file is not
 *  a frametable atlas — the card shows an error, mirroring WAVECEL's uploadError). */
export function atlasGeometry(
  atlasW: number,
  atlasH: number,
): { cols: number; rows: number; tileW: number; tileH: number; frames: number; valid: boolean } {
  const tileW = atlasW / FRAMETABLE_ATLAS_COLS;
  const tileH = atlasH / FRAMETABLE_ATLAS_ROWS;
  const valid =
    Number.isFinite(atlasW) &&
    Number.isFinite(atlasH) &&
    atlasW > 0 &&
    atlasH > 0 &&
    Number.isInteger(tileW) &&
    Number.isInteger(tileH) &&
    tileW > 0 &&
    tileH > 0;
  return {
    cols: FRAMETABLE_ATLAS_COLS,
    rows: FRAMETABLE_ATLAS_ROWS,
    tileW,
    tileH,
    frames: FRAMETABLE_ATLAS_TILES,
    valid,
  };
}

/** Atlas pixel dimensions for a given tile size (the SAVE canvas size). */
export function atlasDimensions(tileW: number, tileH: number): { width: number; height: number } {
  return { width: FRAMETABLE_ATLAS_COLS * tileW, height: FRAMETABLE_ATLAS_ROWS * tileH };
}

/**
 * Vertically flip an RGBA row-major pixel buffer (row 0 ↔ row h-1). Pure; returns
 * a NEW Uint8ClampedArray. The SAVE tiler calls it to turn a BOTTOM-origin GL
 * `readPixels` tile into a TOP-origin (upright) tile for the atlas canvas; it is
 * an involution (`flipRowsY(flipRowsY(x)) === x`), which — composed with the
 * LOAD's `UNPACK_FLIP_Y_WEBGL = true` — is what makes the round-trip bit-exact.
 */
export function flipRowsY(
  rgba: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
): Uint8ClampedArray<ArrayBuffer> {
  const stride = w * 4;
  // Fresh ArrayBuffer-backed array (not ArrayBufferLike) so the result drops
  // straight into `new ImageData(...)` on the SAVE path with no copy/cast.
  const out = new Uint8ClampedArray(rgba.length);
  for (let y = 0; y < h; y++) {
    const src = y * stride;
    const dst = (h - 1 - y) * stride;
    out.set(rgba.subarray(src, src + stride), dst);
  }
  return out;
}

/** Default file name for a saved frametable (mirrors recorderbox's sanitizer
 *  shape: `frametable-YYYYMMDD-HHMMSS.frametable.png`). Pure — `now` injectable. */
export function frametableFileName(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `frametable-${stamp}${FRAMETABLE_FILE_EXT}`;
}
