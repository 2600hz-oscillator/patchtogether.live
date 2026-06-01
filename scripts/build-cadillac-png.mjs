#!/usr/bin/env node
/**
 * Alpha-key the white background out of cadillac-source.png to produce
 * cadillac.png. Luminance threshold ~240+ → fully transparent. Pixels
 * below threshold but with high lightness fade smoothly into alpha so
 * we don't get a hard sawtooth edge around chrome highlights.
 *
 * Run on-demand to regenerate the asset:
 *   flox activate -- node scripts/build-cadillac-png.mjs
 *
 * Source: packages/web/static/img/cadillac-source.png
 * Output: packages/web/static/img/cadillac.png
 *
 * The output is committed (PNG, small) so the runtime doesn't need
 * sharp. This script is documentation + reproducibility, not a build
 * step.
 */
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, '..', 'packages/web/static/img/cadillac-source.png');
const OUT = resolve(__dirname, '..', 'packages/web/static/img/cadillac.png');

// Soft threshold: pixels with min(R,G,B) >= HARD become fully alpha=0;
// pixels with min(R,G,B) in [SOFT, HARD] fade linearly. Anything below
// SOFT keeps full alpha (255). Using min() instead of luminance keeps
// pale-yellow chrome highlights opaque (their min is much lower than
// pure white's).
const HARD = 245;
const SOFT = 225;

const { data, info } = await sharp(SRC)
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

const { width, height, channels } = info;
if (channels !== 4) {
  throw new Error(`expected 4 channels after ensureAlpha, got ${channels}`);
}

const out = Buffer.from(data); // copy
for (let i = 0; i < out.length; i += 4) {
  const r = out[i];
  const g = out[i + 1];
  const b = out[i + 2];
  const m = Math.min(r, g, b);
  let a = 255;
  if (m >= HARD) a = 0;
  else if (m >= SOFT) a = Math.round(255 * (1 - (m - SOFT) / (HARD - SOFT)));
  out[i + 3] = a;
}

await sharp(out, { raw: { width, height, channels: 4 } })
  .png({ compressionLevel: 9 })
  .toFile(OUT);

console.log(`wrote ${OUT} (${width}x${height})`);
