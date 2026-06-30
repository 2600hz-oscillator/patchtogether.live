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

  // ── NODE-ONLY headless DOM shim ──────────────────────────────────────────
  // emscripten's SDL2 port + Browser library reach into the DOM (`screen`,
  // `document`, a `<canvas>`, `window`) to size the video mode, create the
  // window and register pointerlock/fullscreen event handlers
  // (scrSetGameMode → videoSetMode → SDL_CreateWindow →
  // Emscripten_RegisterEventHandlers → document.body.requestPointerLock …).
  // node has no DOM, so we inject just enough of one. A REAL BROWSER has all of
  // this natively — so every shim here is purely a node-harness concern
  // (PHASE1-STATUS.md §3), NOT a wasm/engine defect. We render with the SOFTWARE
  // rasteriser (USE_OPENGL off), so the canvas's GL/2D context is never actually
  // used for pixels — the frame is read SDL-independently via softsurface_blitBuffer
  // through our bpt_get_framebuffer seam.
  if (typeof globalThis.screen === 'undefined') {
    globalThis.screen = { width: 640, height: 480, availWidth: 640, availHeight: 480 };
  }
  let fakeCanvas;
  if (typeof globalThis.document === 'undefined') {
    const noop = () => {};
    const makeStyle = () => new Proxy({}, { get: () => '', set: () => true });
    const makeEl = (tag = 'div') => ({
      tagName: String(tag).toUpperCase(),
      style: makeStyle(),
      addEventListener: noop,
      removeEventListener: noop,
      appendChild: (c) => c,
      removeChild: (c) => c,
      setAttribute: noop,
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 640, bottom: 480, width: 640, height: 480 }),
      getContext: () => null, // software render: SDL never draws pixels through this
      requestPointerLock: noop,
      requestFullscreen: noop,
      focus: noop,
      width: 640,
      height: 480,
      clientWidth: 640,
      clientHeight: 480,
    });
    fakeCanvas = makeEl('canvas');
    const body = makeEl('body');
    globalThis.document = {
      body,
      documentElement: makeEl('html'),
      addEventListener: noop,
      removeEventListener: noop,
      createElement: (t) => makeEl(t),
      querySelector: () => fakeCanvas,
      getElementById: () => fakeCanvas,
      getElementsByTagName: () => [fakeCanvas],
      // fullscreen / pointerlock state accessors SDL2 reads
      fullscreenElement: null,
      pointerLockElement: null,
      exitPointerLock: noop,
      exitFullscreen: noop,
      fullscreenEnabled: false,
    };
  }
  if (typeof globalThis.window === 'undefined') {
    globalThis.window = {
      addEventListener: () => {},
      removeEventListener: () => {},
      devicePixelRatio: 1,
      innerWidth: 640,
      innerHeight: 480,
      screen: globalThis.screen,
      document: globalThis.document,
    };
  }

  const { default: loadBlood } = await import(SHIM);
  // emscripten MODULARIZE factory. Hand it our fake canvas so SDL2's
  // Module.canvas resolution uses it instead of probing the DOM further.
  const Module = await loadBlood(fakeCanvas ? { canvas: fakeCanvas } : {});

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

  // bpt_init kicks app_main onto the ASYNCIFY call stack. The shim sets
  // r_maxfps=-2 so the engine presents + YIELDS (emscripten_sleep) on EVERY
  // main-loop iteration; with real shareware data app_main runs all the way
  // through palette/data/weapon/choke/game init and into the main MENU loop,
  // which clears to gMenuColor + rotatesprite()s the menu and presents — so the
  // snapshot we read is the real BLOOD main menu.
  console.log('[blood-harness] bpt_init …');
  try {
    Module.ccall('bpt_init', null, ['number'], [0]);
  } catch (e) {
    fail(`bpt_init threw: ${e && e.message ? e.message : e}`);
  }

  // Sample the framebuffer as the engine cooperatively advances. With
  // r_maxfps=-2 the asyncify stack auto-resumes across the JS event loop on each
  // yield, so we just await the loop and read the latest snapshot. We keep the
  // RICHEST frame we see (the menu, vs the near-black cleared backbuffer the very
  // first present at SDL window-create produces). Bounded by wall-clock.
  const readFrameStats = () => {
    const w = Module.ccall('bpt_get_resx', 'number', [], []);
    const h = Module.ccall('bpt_get_resy', 'number', [], []);
    const fbPtr = Module.ccall('bpt_get_framebuffer', 'number', [], []);
    const fbSize = Module.ccall('bpt_get_framebuffer_size', 'number', [], []);
    if (!fbPtr || fbSize <= 0 || fbSize !== w * h * 4) return { w, h, fbPtr, fbSize, nonZero: 0, distinct: 0 };
    const fb = new Uint8Array(Module.HEAPU8.buffer, fbPtr, fbSize);
    let nonZero = 0;
    const distinct = new Set();
    for (let i = 0; i < fbSize; i += 4) {
      if (fb[i] | fb[i + 1] | fb[i + 2]) nonZero++;
      if (distinct.size < 256) distinct.add((fb[i] << 16) | (fb[i + 1] << 8) | fb[i + 2]);
    }
    return { w, h, fbPtr, fbSize, nonZero, distinct: distinct.size };
  };

  // A real rendered SCREEN (menu/title/E1M1) has THOUSANDS of non-black pixels +
  // many colors. The near-black cleared backbuffer (the first present) does not —
  // so this threshold is what proves we rendered actual content, not a blank
  // surface. (Empirically the shareware main menu is ~15k non-black / ~32 colors.)
  const MIN_NONZERO = 2000;
  const MIN_DISTINCT = 4;
  const DEADLINE_MS = 20000;
  let best = { nonZero: -1, distinct: 0, w: 0, h: 0, fbPtr: 0, fbSize: 0 };
  const start = Date.now();
  while (Date.now() - start < DEADLINE_MS) {
    await new Promise((r) => setTimeout(r, 4));
    const s = readFrameStats();
    if (s.nonZero > best.nonZero) best = s;
    if (best.nonZero >= MIN_NONZERO && best.distinct >= MIN_DISTINCT) break;
  }

  const { w, h, fbPtr, fbSize, nonZero, distinct } = best;
  console.log(`[blood-harness] best frame: ${w}x${h}, fbPtr=${fbPtr}, fbSize=${fbSize}`);
  if (w <= 0 || h <= 0) fail(`implausible resolution ${w}x${h}`);
  if (!fbPtr || fbSize !== w * h * 4) fail(`framebuffer ptr/size inconsistent (${fbSize} vs ${w * h * 4})`);

  const pct = ((nonZero / (fbSize / 4)) * 100).toFixed(1);
  console.log(`[blood-harness] non-black pixels: ${nonZero}/${fbSize / 4} (${pct}%), distinct colors (sampled): ${distinct}`);

  if (nonZero === 0) fail('framebuffer is entirely black — no pixels rendered');
  if (nonZero < MIN_NONZERO || distinct < MIN_DISTINCT)
    fail(
      `frame too sparse (${nonZero} non-black / ${distinct} colors) — engine reached a paint but did not render a real screen ` +
        `within ${DEADLINE_MS}ms (expected the menu: >=${MIN_NONZERO} non-black, >=${MIN_DISTINCT} colors)`,
    );

  console.log('[blood-harness] PASS: blood.wasm linked + rendered a real content frame (main menu).');

  // ── REGRESSION CHECKS (only meaningful with real game data + the menu) ─────
  // Both guard against the two BLOOD bugs fixed alongside the bpt_* shim. They
  // read ONLY the stable bpt_get_framebuffer surface (no debug exports).
  if (wroteData > 0) {
    const grabRGBA = () => {
      const fp = Module.ccall('bpt_get_framebuffer', 'number', [], []);
      const fs = Module.ccall('bpt_get_framebuffer_size', 'number', [], []);
      return new Uint8Array(Module.HEAPU8.buffer, fp, fs).slice();
    };

    // BUG #2 (black scene): the engine loads tiles000.art but the shareware
    // ships SHARE000.ART; the shim aliases it so the main-menu blood-drip border
    // (top of screen) renders. With the ART missing the top band was ~black.
    const topRows = Math.floor(h * 0.1);
    let topNonBlack = 0;
    {
      const fb = grabRGBA();
      for (let y = 0; y < topRows; y++)
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          if (fb[i] | fb[i + 1] | fb[i + 2]) topNonBlack++;
        }
    }
    const TOP_MIN = Math.floor(w * topRows * 0.05); // >=5% of the top band lit
    console.log(`[blood-harness] top-band (drip border) non-black: ${topNonBlack} (need >=${TOP_MIN})`);
    if (topNonBlack < TOP_MIN)
      fail(
        `bug #2 regression: top band is ~black (${topNonBlack}) — game ART (tiles000.art) did not load; ` +
          `the shareware SHARE000.ART -> TILES000.ART alias is broken`,
      );

    // BUG #1 (frozen engine clock): clock_gettime(CLOCK_MONOTONIC_RAW) is
    // unsupported on emscripten, so totalclock never advanced and the menu was
    // FROZEN (no cursor pulse, no animation, game tics dead). With the
    // CLOCK_MONOTONIC fix the idle menu ANIMATES (drip droplets + cursor pulse),
    // so the framebuffer changes over time with NO input.
    const hash = (fb) => {
      let hsh = 0x811c9dc5;
      for (let i = 0; i < fb.length; i += 4) {
        hsh ^= fb[i];
        hsh = (hsh * 0x01000193) >>> 0;
      }
      return hsh >>> 0;
    };
    const h0 = hash(grabRGBA());
    let changed = false;
    const aStart = Date.now();
    while (Date.now() - aStart < 2000) {
      await new Promise((r) => setTimeout(r, 50));
      if (hash(grabRGBA()) !== h0) {
        changed = true;
        break;
      }
    }
    console.log(`[blood-harness] idle menu animates (engine clock advancing): ${changed}`);
    if (!changed)
      fail(
        'bug #1 regression: idle menu framebuffer is FROZEN over 2s — the engine clock (totalclock) ' +
          'is not advancing (CLOCK_MONOTONIC_RAW unsupported on wasm); the menu cursor/animation is dead',
      );

    console.log('[blood-harness] PASS: ART loaded (drip border renders) + engine clock advances (menu animates).');
  }
  process.exit(0);
}

main().catch((e) => fail(`unexpected: ${e && e.stack ? e.stack : e}`));
