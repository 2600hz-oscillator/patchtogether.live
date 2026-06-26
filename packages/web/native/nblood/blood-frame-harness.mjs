// blood-frame-harness.mjs
//
// Phase-1 KILL-GATE harness: boot the linked blood.wasm far enough to render
// ONE valid frame + assert a non-empty, plausibly-valid framebuffer. The
// NBlood analogue of how the DOOM build/spike validates a frame.
//
// Run (after a node-targeted link — see build-blood-wasm.sh BLOOD_LINK=1 +
// BLOOD_OUT=blood-node BLOOD_ENVIRONMENT=node):
//   flox activate -- node packages/web/native/nblood/blood-frame-harness.mjs
//
// Game data (BLOOD.RFF / TILES000.ART) is user-supplied + NOT redistributable
// (PHASE0-STATUS.md §3). If a BLOOD_DATA dir is provided we write its files into
// MEMFS so the engine reaches the real game render; with NO data the engine
// reaches its pre-game / data-missing screen, which STILL paints a frame — and
// that pre-game frame is what the kill-gate asserts when no lawful data is
// available. Either way we prove the software-render path produces pixels.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
// The node-targeted build artifact (BLOOD_OUT=blood-node).
const SHIM = process.env.BLOOD_JS
  ? process.env.BLOOD_JS
  : join(HERE, '..', '..', 'static', 'blood', 'blood-node.js');

const DATA_DIR = process.env.BLOOD_DATA || ''; // optional user-supplied Blood install

function fail(msg) {
  console.error(`[blood-harness] FAIL: ${msg}`);
  process.exit(1);
}

async function main() {
  if (!existsSync(SHIM)) {
    fail(
      `blood module not built at ${SHIM}.\n` +
        `  Build it: BLOOD_LINK=1 BLOOD_OUT=blood-node BLOOD_ENVIRONMENT=node \\\n` +
        `            flox activate -- bash packages/web/native/build-blood-wasm.sh`,
    );
  }

  const { default: loadBlood } = await import(SHIM);
  // emscripten MODULARIZE factory. We pass no canvas (headless software render).
  const Module = await loadBlood();

  // Write user-supplied data files into MEMFS under /blood (if provided).
  let wroteData = 0;
  if (DATA_DIR && existsSync(DATA_DIR)) {
    try {
      Module.FS.mkdir('/blood');
    } catch {
      /* may already exist */
    }
    for (const name of readdirSync(DATA_DIR)) {
      const p = join(DATA_DIR, name);
      if (!statSync(p).isFile()) continue;
      const bytes = readFileSync(p);
      Module.FS.writeFile(`/blood/${basename(name)}`, bytes);
      wroteData++;
    }
    // app_main looks for game data on the search path; chdir into /blood.
    try {
      Module.FS.chdir('/blood');
    } catch {
      /* */
    }
  }
  console.log(`[blood-harness] data files written to MEMFS: ${wroteData}`);

  // bpt_init kicks app_main onto the ASYNCIFY call stack; it runs until the
  // first videoShowFrame (our shim) snapshots a frame + suspends. Because
  // app_main is ASYNCIFY-suspended, the ccall returns control here.
  console.log('[blood-harness] bpt_init …');
  try {
    Module.ccall('bpt_init', null, ['number'], [0]);
  } catch (e) {
    fail(`bpt_init threw: ${e && e.message ? e.message : e}`);
  }

  // Pump a bounded number of frames to give the engine time to reach a paint
  // (the menu / pre-game screen blits each frame). Each bpt_tick resumes the
  // suspended app_main to the next videoShowFrame.
  const MAX_FRAMES = 240;
  let hasFrame = 0;
  for (let i = 0; i < MAX_FRAMES; i++) {
    hasFrame = Module.ccall('bpt_has_frame', 'number', [], []);
    if (hasFrame) break;
    try {
      Module.ccall('bpt_tick', null, [], []);
    } catch (e) {
      fail(`bpt_tick threw at frame ${i}: ${e && e.message ? e.message : e}`);
    }
    // Let any pending asyncify continuation + microtasks flush.
    await new Promise((r) => setTimeout(r, 0));
  }

  hasFrame = Module.ccall('bpt_has_frame', 'number', [], []);
  if (!hasFrame) fail(`no frame presented after ${MAX_FRAMES} bpt_tick frames`);

  const w = Module.ccall('bpt_get_resx', 'number', [], []);
  const h = Module.ccall('bpt_get_resy', 'number', [], []);
  const fbPtr = Module.ccall('bpt_get_framebuffer', 'number', [], []);
  const fbSize = Module.ccall('bpt_get_framebuffer_size', 'number', [], []);
  console.log(`[blood-harness] frame presented: ${w}x${h}, fbPtr=${fbPtr}, fbSize=${fbSize}`);

  if (w <= 0 || h <= 0) fail(`implausible resolution ${w}x${h}`);
  if (!fbPtr || fbSize !== w * h * 4) fail(`framebuffer ptr/size inconsistent (${fbSize} vs ${w * h * 4})`);

  // Validate the framebuffer is non-empty: count non-black, non-uniform pixels.
  const fb = new Uint8Array(Module.HEAPU8.buffer, fbPtr, fbSize);
  let nonZero = 0;
  let distinct = new Set();
  for (let i = 0; i < fbSize; i += 4) {
    const r = fb[i], g = fb[i + 1], b = fb[i + 2];
    if (r | g | b) nonZero++;
    if (distinct.size < 64) distinct.add((r << 16) | (g << 8) | b);
  }
  const pct = ((nonZero / (fbSize / 4)) * 100).toFixed(1);
  console.log(`[blood-harness] non-black pixels: ${nonZero}/${fbSize / 4} (${pct}%), distinct colors (sampled): ${distinct.size}`);

  // A valid rendered frame has SOME non-black pixels AND more than one color
  // (a uniform fill would be a stuck/blank surface, not a render).
  if (nonZero === 0) fail('framebuffer is entirely black — no pixels rendered');
  if (distinct.size < 2) fail('framebuffer is a single uniform color — not a real render');

  console.log('[blood-harness] PASS: blood.wasm linked + rendered one valid frame.');
  process.exit(0);
}

main().catch((e) => fail(`unexpected: ${e && e.stack ? e.stack : e}`));
