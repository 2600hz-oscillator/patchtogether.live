#!/usr/bin/env node
/**
 * Build packages/web/src/lib/ui/example-patches/media-burn.imp.json — the
 * MEDIA BURN demo envelope. 15 PICTUREBOX nodes (each with the matching
 * tile's base64 JPEG bytes already on `node.data.imageBytes`) arranged
 * in a 5x3 flush grid + 1 CADILLAC node positioned to start hitting the
 * rightmost tile exactly 1 second after spawn.
 *
 * Mirrors the shape of glitches.imp.json (PR #430): an envelope JSON
 * carrying `update` = base64(Y.encodeStateAsUpdate(ydoc)). The runtime
 * loader (loadEnvelopeIntoStore) decodes the update into a temp Y.Doc,
 * runs per-module migrations, then atomically swaps into the live store.
 *
 * Source tiles: packages/web/static/img/media-burn/tile-r{0..2}-c{0..4}.png
 *   -> encoded JPEG q=85 (matches Picturebox's imageMime='image/jpeg').
 *
 * Layout + cadillac math: imported from media-burn-math.ts so the
 * pinned unit test stays load-bearing for whatever the envelope ships.
 *
 * Run on-demand to regenerate:
 *   flox activate -- node scripts/build-media-burn-envelope.mjs
 */

import sharp from 'sharp';
import * as Y from 'yjs';
import { syncedStore, getYjsDoc } from '@syncedstore/core';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TILE_DIR = resolve(__dirname, '..', 'packages/web/static/img/media-burn');
const OUT_PATH = resolve(
  __dirname,
  '..',
  'packages/web/src/lib/ui/example-patches/media-burn.imp.json',
);

// -- Pinned constants, MUST match media-burn-math.ts. We inline them
//    rather than import the TS module so this script stays plain-node
//    (no ts-loader). The unit test in media-burn-math.test.ts asserts
//    the imported constants and they're 1:1 with these.
const ROWS = 3;
const COLS = 5;
const CARD_W = 220;
const CARD_H = 240;
const BASE_X = 0;
const BASE_Y = 0;
const CADILLAC_WIDTH = 375;
const CADILLAC_SPEED = 300;
const SECONDS_UNTIL_HIT = 1;

// Mirrors media-burn-math.ts cadillacStartX:
//   startX = rightmostTileXR + speed * secondsUntilHit
const xR = BASE_X + COLS * CARD_W; // 1100
const cadillacX = xR + CADILLAC_SPEED * SECONDS_UNTIL_HIT; // 1400
const cadillacY = BASE_Y + (ROWS * CARD_H) / 2 - 47; // center on middle row; -47 = CAR_H/2

// -- Picturebox schemaVersion (mirrors packages/web/src/lib/video/modules/picturebox.ts).
//    Current def is v4; the tile data shape (imageBytes-only) matches a fresh
//    v4 "choose image" node, so re-exporting at the current stamp needs no
//    data transform. (Per-module old-patch migrate() was dropped in cleanup 2/5.)
const PICTUREBOX_SCHEMA_VERSION = 4;
// -- Cadillac schemaVersion.
const CADILLAC_SCHEMA_VERSION = 1;

// -- JPEG-encode each tile so the runtime's base64ToImageBitmap (which
//    Blob-wraps with image/jpeg) decodes them. PNG tiles get re-encoded
//    here.
async function encodeTileAsJpegBase64(row, col) {
  const path = `${TILE_DIR}/tile-r${row}-c${col}.png`;
  const jpegBuf = await sharp(path).jpeg({ quality: 85 }).toBuffer();
  return { base64: jpegBuf.toString('base64'), bytes: jpegBuf.length };
}

// -- Build the syncedStore + populate it inside a single transact so
//    the resulting Y update is one atomic batch.
const store = syncedStore({ nodes: {}, edges: {} });
const ydoc = getYjsDoc(store);

let totalImageBytes = 0;
await ydoc.transact(async () => {
  // We can't actually run async work inside transact — Y.Doc.transact
  // runs the function synchronously and immediately commits. Hoist the
  // encode loop to outside the transact, populate a plain array first,
  // then sync-write into the store inside the real transact below.
});

// 1) Encode tiles up front (async).
const tilePayloads = [];
for (let row = 0; row < ROWS; row++) {
  for (let col = 0; col < COLS; col++) {
    const { base64, bytes } = await encodeTileAsJpegBase64(row, col);
    totalImageBytes += bytes;
    tilePayloads.push({ row, col, base64, bytes });
  }
}

// 2) Sync transact — write 15 PICTUREBOXes + 1 CADILLAC into Y.Doc.
ydoc.transact(() => {
  for (const t of tilePayloads) {
    const id = `media-burn-pb-r${t.row}-c${t.col}`;
    store.nodes[id] = {
      id,
      type: 'picturebox',
      domain: 'video',
      position: {
        x: BASE_X + t.col * CARD_W,
        y: BASE_Y + t.row * CARD_H,
      },
      params: {},
      data: {
        imageBytes: t.base64,
        imageMime: 'image/jpeg',
        imageName: `media-burn/tile-r${t.row}-c${t.col}.jpg`,
        name: `MEDIA-BURN-${t.row}-${t.col}`,
      },
    };
  }
  const cadId = 'media-burn-cadillac';
  store.nodes[cadId] = {
    id: cadId,
    type: 'cadillac',
    domain: 'meta',
    position: { x: cadillacX, y: cadillacY },
    params: {},
    data: {
      // Deliberately NO spawnedAtMs / spawnerClientId here. The
      // overlay's `?? Date.now()` fallback (CadillacOverlay.svelte
      // L110) makes load-time === spawn-time, so the 1-second-to-hit
      // math holds regardless of when the demo is loaded. Likewise the
      // missing spawnerClientId means every connected peer thinks it
      // owns writes (provider==null branch on L125) — only matters if
      // someone loads the demo into a live multiplayer rackspace,
      // which is a strict superset of the single-player happy path.
      name: 'MEDIA-BURN-CADILLAC',
    },
  };
});

// 3) Envelope. moduleSchemas only needs the types the patch actually
//    uses; loadEnvelopeIntoStore falls back to schemaVersion 1 for any
//    type it doesn't find here.
const envelope = {
  envelopeVersion: 1,
  savedAt: new Date().toISOString(),
  moduleSchemas: {
    picturebox: PICTUREBOX_SCHEMA_VERSION,
    cadillac: CADILLAC_SCHEMA_VERSION,
  },
  update: Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString('base64'),
};

writeFileSync(OUT_PATH, JSON.stringify(envelope, null, 2));

const envelopeKB = Math.round(JSON.stringify(envelope).length / 1024);
const imageKB = Math.round(totalImageBytes / 1024);
console.log(`Wrote ${OUT_PATH}`);
console.log(`  15 PICTUREBOX tiles (${imageKB} kB raw JPEG, base64 -> envelope ${envelopeKB} kB)`);
console.log(`  1 CADILLAC @ (${cadillacX}, ${cadillacY}) [start=${cadillacX}, xR=${xR}, hits @ t=${SECONDS_UNTIL_HIT}s]`);
