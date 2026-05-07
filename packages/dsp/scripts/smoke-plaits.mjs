// packages/dsp/scripts/smoke-plaits.mjs
//
// Boot the freshly-built dist/plaits.wasm in plain Node, instantiate a
// voice for each registered engine_id, render 1 second of audio with a
// gate held high and fixed params, assert non-silence + finite-ness.
//
// Useful as a "the wasm is plausibly working" check before involving the
// AudioWorkletProcessor harness or Playwright. Runs in <2s and prints a
// summary of peak / RMS / non-zero count per engine.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM = join(__dirname, '..', 'dist', 'plaits.wasm');

const SR = 48000;
const DURATION_S = 1.0;
const INNER_BLOCK = 12;
const ENGINE_FM = 9;
const ENGINE_DX7 = 10;

const env = {
  emscripten_notify_memory_growth: () => {},
  emscripten_resize_heap: () => 0,
  abort: () => {
    throw new Error('plaits wasm aborted');
  },
};
const wasi = {
  fd_close: () => 0,
  fd_seek: () => 0,
  fd_write: () => 0,
  proc_exit: () => {},
};

const bytes = await readFile(WASM);
const mod = await WebAssembly.compile(bytes);
const inst = await WebAssembly.instantiate(mod, { env, wasi_snapshot_preview1: wasi });
const e = inst.exports;
// Run C++ global constructors (zero-initializes static state, fills in
// virtual function pointer tables, etc.). Without this the LUTs in
// resources.cc are accessed before they're laid out and we OOB.
e.__wasm_call_ctors();

function smokeOne(label, engineId, harmonics) {
  const voice = e.plaits_create(engineId);
  if (!voice) throw new Error(`plaits_create(${engineId}) returned 0`);

  const paramsPtr = e.malloc(7 * 4);
  const outPtr = e.malloc(INNER_BLOCK * 4);
  const auxPtr = e.malloc(INNER_BLOCK * 4);

  const totalFrames = SR * DURATION_S;
  const blocks = Math.ceil(totalFrames / INNER_BLOCK);

  const fParams = new Float32Array(e.memory.buffer, paramsPtr, 6);
  const iParams = new Int32Array(e.memory.buffer, paramsPtr, 7);

  // note=60 (middle C). For FM engine harmonics maps to FM ratio; for the
  // DX7 (SixOpEngine) it picks a patch index 0..31.
  fParams[0] = 60;
  fParams[1] = harmonics;
  fParams[2] = 0.5;
  fParams[3] = 0.0;
  fParams[4] = 0.5;
  fParams[5] = 1.0;
  iParams[6] = 1;

  const all = new Float32Array(totalFrames);
  let written = 0;
  for (let b = 0; b < blocks && written < totalFrames; b++) {
    e.plaits_render(voice, paramsPtr, outPtr, auxPtr, INNER_BLOCK);
    const outView = new Float32Array(e.memory.buffer, outPtr, INNER_BLOCK);
    const n = Math.min(INNER_BLOCK, totalFrames - written);
    all.set(outView.subarray(0, n), written);
    written += n;
  }

  let peak = 0;
  let energy = 0;
  let nonzero = 0;
  let bad = -1;
  for (let i = 0; i < all.length; i++) {
    const v = all[i];
    if (!Number.isFinite(v)) {
      bad = i;
      break;
    }
    const a = Math.abs(v);
    if (a > peak) peak = a;
    energy += v * v;
    if (a > 1e-6) nonzero++;
  }

  if (bad >= 0) {
    console.error(`SMOKE FAIL [${label}]: non-finite sample at ${bad}: ${all[bad]}`);
    process.exit(1);
  }

  const rms = Math.sqrt(energy / all.length);
  console.log(`${label} smoke:`, {
    peak: peak.toFixed(4),
    rms: rms.toFixed(4),
    nonzero,
    total: all.length,
  });

  if (peak < 0.01) {
    console.error(`SMOKE FAIL [${label}]: signal peak below silence threshold`);
    process.exit(1);
  }
  if (nonzero < all.length / 4) {
    console.error(`SMOKE FAIL [${label}]: too many silent samples`);
    process.exit(1);
  }

  e.free(paramsPtr);
  e.free(outPtr);
  e.free(auxPtr);
  e.plaits_destroy(voice);
}

smokeOne('plaits-fm', ENGINE_FM, 0.5);
smokeOne('dx7', ENGINE_DX7, 0.0);
console.log('SMOKE OK');
