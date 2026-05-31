#!/usr/bin/env node
/**
 * Slice packages/web/static/img/media-burn-source.png (960x640) into
 * 15 PNG tiles arranged 5 columns x 3 rows. Each tile is 192 wide;
 * row heights are 214 / 213 / 213 (sum = 640, no rounding loss).
 *
 *   col widths : 192 192 192 192 192   (sum 960)
 *   row heights: 214 213 213           (sum 640)
 *
 * Run on-demand to regenerate the assets:
 *   flox activate -- node scripts/build-media-burn-tiles.mjs
 *
 * Source: packages/web/static/img/media-burn-source.png
 * Output: packages/web/static/img/media-burn/tile-r{row}-c{col}.png
 *         (row 0..2 top->bottom, col 0..4 left->right)
 *
 * Also emits packages/web/static/img/media-burn/verify.png — a
 * reassembled mosaic of all 15 tiles for a sanity diff against the
 * source. The mosaic + the source should be byte-equal at the pixel
 * level for cells that fall on lossless boundaries.
 *
 * Mirrors scripts/build-cadillac-png.mjs in style — sharp-based, runs
 * off the committed source, output committed.
 */
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync, statSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, '..', 'packages/web/static/img/media-burn-source.png');
const OUT_DIR = resolve(__dirname, '..', 'packages/web/static/img/media-burn');

const COLS = 5;
const ROWS = 3;
const TOTAL_W = 960;
const TOTAL_H = 640;
const COL_W = TOTAL_W / COLS; // 192
// Row heights: distribute 640 / 3 = 213.333... as 214, 213, 213 so the
// whole picture is exactly covered with integer rows.
const ROW_HEIGHTS = [214, 213, 213];

if (ROW_HEIGHTS.reduce((a, b) => a + b, 0) !== TOTAL_H) {
  throw new Error(`row heights ${ROW_HEIGHTS} must sum to ${TOTAL_H}`);
}
if (!Number.isInteger(COL_W)) {
  throw new Error(`col width ${COL_W} must be integer`);
}

mkdirSync(OUT_DIR, { recursive: true });

// Validate source dims up front so the slicer fails loud on a misshaped input.
const meta = await sharp(SRC).metadata();
if (meta.width !== TOTAL_W || meta.height !== TOTAL_H) {
  throw new Error(
    `expected source ${TOTAL_W}x${TOTAL_H}, got ${meta.width}x${meta.height}`,
  );
}

const cellSizes = [];
let totalBytes = 0;

for (let row = 0; row < ROWS; row++) {
  const top = ROW_HEIGHTS.slice(0, row).reduce((a, b) => a + b, 0);
  const h = ROW_HEIGHTS[row];
  for (let col = 0; col < COLS; col++) {
    const left = col * COL_W;
    const w = COL_W;
    const outPath = `${OUT_DIR}/tile-r${row}-c${col}.png`;
    await sharp(SRC)
      .extract({ left, top, width: w, height: h })
      .png({ compressionLevel: 9 })
      .toFile(outPath);
    const size = statSync(outPath).size;
    totalBytes += size;
    cellSizes.push({ row, col, w, h, left, top, bytes: size });
  }
}

// Reassemble verification image: composite every tile back onto a blank
// 960x640 canvas at its (left, top) and diff vs source.
const composites = [];
for (let row = 0; row < ROWS; row++) {
  const top = ROW_HEIGHTS.slice(0, row).reduce((a, b) => a + b, 0);
  for (let col = 0; col < COLS; col++) {
    composites.push({
      input: `${OUT_DIR}/tile-r${row}-c${col}.png`,
      left: col * COL_W,
      top,
    });
  }
}

const verifyPath = `${OUT_DIR}/verify.png`;
await sharp({
  create: {
    width: TOTAL_W,
    height: TOTAL_H,
    channels: 3,
    background: { r: 255, g: 0, b: 255 }, // magenta gutter so gaps would scream
  },
})
  .composite(composites)
  .png({ compressionLevel: 9 })
  .toFile(verifyPath);

// Diff verify vs source — pixel-level RMSE. Lossless PNG slicing +
// reassembly should round-trip exactly (0 RMSE).
const srcRaw = await sharp(SRC).removeAlpha().raw().toBuffer();
const verifyRaw = await sharp(verifyPath).removeAlpha().raw().toBuffer();
if (srcRaw.length !== verifyRaw.length) {
  throw new Error(
    `verify-vs-source raw size mismatch: src=${srcRaw.length} verify=${verifyRaw.length}`,
  );
}
let sumSq = 0;
let nonzero = 0;
for (let i = 0; i < srcRaw.length; i++) {
  const d = srcRaw[i] - verifyRaw[i];
  if (d !== 0) nonzero++;
  sumSq += d * d;
}
const rmse = Math.sqrt(sumSq / srcRaw.length);

console.log(`Sliced ${ROWS}x${COLS} = ${ROWS * COLS} tiles from ${SRC}`);
for (const c of cellSizes) {
  console.log(
    `  tile-r${c.row}-c${c.col}.png  ${c.w}x${c.h}  @(${c.left},${c.top})  ${(c.bytes / 1024).toFixed(1)} kB`,
  );
}
console.log(`Total tile bytes: ${(totalBytes / 1024).toFixed(1)} kB`);
console.log(`Verify mosaic   : ${verifyPath}`);
console.log(`Verify vs source RMSE: ${rmse.toFixed(4)} (nonzero bytes: ${nonzero}/${srcRaw.length})`);

if (rmse !== 0) {
  throw new Error(
    `verify mosaic does not pixel-match source (rmse=${rmse}); slicing math is wrong`,
  );
}
