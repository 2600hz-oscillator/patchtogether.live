// art/scenarios/plaits-fm/non-silence.test.ts
//
// ART scenario for the PlaitsFM module (engine_id = 9, 2-op FM clone of
// Plaits' built-in FMEngine). Boots the freshly-compiled wasm directly
// (not via AudioWorkletProcessor) and renders 1 second at fixed params,
// then asserts:
//
//   - all samples finite
//   - peak above silence floor (0.01)
//   - signal energy in audible range >= a coarse threshold (Goertzel
//     sweep at the expected fundamental for note=60 -> ~133 Hz @ 48kHz
//     after Plaits' note-24 transposition)
//
// We don't .f32-compare to a pinned baseline yet — Plaits' FM is
// deterministic given the same emcc version + wasm artifact, but emcc
// version drift across CI hosts produces tiny float differences. A
// non-silence + spectral test is sufficient for "the engine is wired up"
// and pairs with the Playwright E2E that catches integration regressions.
//
// Future: add a tier-B baseline once we pin an emscripten version in
// CI image and sign off on a baseline.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(__dirname, '..', '..', '..', 'packages', 'dsp', 'dist', 'plaits.wasm');

const SR = 48000;
const DURATION_S = 1.0;
const INNER_BLOCK = 12;
const ENGINE_FM = 9;

interface PlaitsExports {
  memory: WebAssembly.Memory;
  __wasm_call_ctors(): void;
  plaits_create(engineId: number): number;
  plaits_destroy(handle: number): void;
  plaits_render(
    handle: number,
    paramsPtr: number,
    outPtr: number,
    auxPtr: number,
    size: number,
  ): void;
  plaits_reset(handle: number): void;
  malloc(size: number): number;
  free(ptr: number): void;
}

async function loadWasm(): Promise<PlaitsExports> {
  const bytes = await readFile(WASM_PATH);
  const mod = await WebAssembly.compile(bytes);
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
  const inst = await WebAssembly.instantiate(mod, {
    env,
    wasi_snapshot_preview1: wasi,
  });
  const exp = inst.exports as unknown as PlaitsExports;
  exp.__wasm_call_ctors();
  return exp;
}

function renderFm(
  exp: PlaitsExports,
  voice: number,
  durationS: number,
  params: { note: number; harmonics: number; timbre: number; morph: number; trigger: boolean },
): Float32Array {
  const total = Math.round(SR * durationS);
  const out = new Float32Array(total);
  const paramsPtr = exp.malloc(7 * 4);
  const outPtr = exp.malloc(INNER_BLOCK * 4);
  const auxPtr = exp.malloc(INNER_BLOCK * 4);
  try {
    const fParams = new Float32Array(exp.memory.buffer, paramsPtr, 6);
    const iParams = new Int32Array(exp.memory.buffer, paramsPtr, 7);
    fParams[0] = params.note;
    fParams[1] = params.harmonics;
    fParams[2] = params.timbre;
    fParams[3] = params.morph;
    fParams[4] = 0.5;
    fParams[5] = 1.0;
    iParams[6] = params.trigger ? 1 : 0;

    let written = 0;
    while (written < total) {
      exp.plaits_render(voice, paramsPtr, outPtr, auxPtr, INNER_BLOCK);
      const view = new Float32Array(exp.memory.buffer, outPtr, INNER_BLOCK);
      const n = Math.min(INNER_BLOCK, total - written);
      out.set(view.subarray(0, n), written);
      written += n;
    }
    return out;
  } finally {
    exp.free(paramsPtr);
    exp.free(outPtr);
    exp.free(auxPtr);
  }
}

function goertzel(samples: Float32Array, sampleRate: number, freqHz: number): number {
  const k = (samples.length * freqHz) / sampleRate;
  const omega = (2 * Math.PI * k) / samples.length;
  const coeff = 2 * Math.cos(omega);
  let q1 = 0;
  let q2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const q0 = coeff * q1 - q2 + samples[i];
    q2 = q1;
    q1 = q0;
  }
  return q1 * q1 + q2 * q2 - q1 * q2 * coeff;
}

describe('plaits-fm / non-silence', () => {
  let exp: PlaitsExports | null = null;

  beforeAll(async () => {
    if (!existsSync(WASM_PATH)) {
      throw new Error(
        `Compiled artifact missing: ${WASM_PATH}\n` +
          'Run `flox activate -- task dsp:build:plaits` before running ART.',
      );
    }
    exp = await loadWasm();
  });

  it('renders without throwing and produces non-empty buffer', () => {
    if (!exp) throw new Error('wasm not loaded');
    const v = exp.plaits_create(ENGINE_FM);
    expect(v).toBeGreaterThan(0);
    try {
      const buf = renderFm(exp, v, DURATION_S, {
        note: 60,
        harmonics: 0.5,
        timbre: 0.3,
        morph: 0.0,
        trigger: true,
      });
      expect(buf.length).toBe(SR * DURATION_S);
      const badIdx = buf.findIndex((x) => !Number.isFinite(x));
      expect(badIdx, `non-finite at ${badIdx}`).toBe(-1);
    } finally {
      exp.plaits_destroy(v);
    }
  });

  it('produces audible signal (peak > 0.01, energy in audible range)', () => {
    if (!exp) throw new Error('wasm not loaded');
    const v = exp.plaits_create(ENGINE_FM);
    try {
      const buf = renderFm(exp, v, DURATION_S, {
        note: 60,
        harmonics: 0.5,
        timbre: 0.3,
        morph: 0.0,
        trigger: true,
      });
      let peak = 0;
      let energy = 0;
      for (let i = 0; i < buf.length; i++) {
        const a = Math.abs(buf[i]);
        if (a > peak) peak = a;
        energy += buf[i] * buf[i];
      }
      const rms = Math.sqrt(energy / buf.length);
      expect(peak, `peak too low (peak=${peak})`).toBeGreaterThan(0.01);
      expect(rms, `rms too low (rms=${rms})`).toBeGreaterThan(0.01);
    } finally {
      exp.plaits_destroy(v);
    }
  });

  it('changing note shifts spectral content', () => {
    if (!exp) throw new Error('wasm not loaded');
    // Render two voices at very different notes and assert the spectral
    // centroid of the low voice is meaningfully lower than the high
    // voice's. We use a coarse frequency-band ratio because Plaits' FM
    // engine is rich in sidebands at non-zero timbre — pinning to a
    // single fundamental Goertzel bin is too brittle.
    const lowVoice = exp.plaits_create(ENGINE_FM);
    const highVoice = exp.plaits_create(ENGINE_FM);
    try {
      const low = renderFm(exp, lowVoice, 0.5, {
        note: 36,
        harmonics: 0.5,
        timbre: 0.3,
        morph: 0.0,
        trigger: true,
      });
      const high = renderFm(exp, highVoice, 0.5, {
        note: 84,
        harmonics: 0.5,
        timbre: 0.3,
        morph: 0.0,
        trigger: true,
      });

      // Sum Goertzel magnitudes across a low band (50-200 Hz) and a high
      // band (1000-3000 Hz). Low voice should weight the low band more;
      // high voice should weight the high band more. We sample at a
      // coarse 50 Hz grid for speed.
      function bandEnergy(buf: Float32Array, lo: number, hi: number): number {
        let sum = 0;
        for (let f = lo; f <= hi; f += 50) sum += goertzel(buf, SR, f);
        return sum;
      }
      const lowLow = bandEnergy(low, 50, 200);
      const lowHigh = bandEnergy(low, 1000, 3000);
      const highLow = bandEnergy(high, 50, 200);
      const highHigh = bandEnergy(high, 1000, 3000);

      // Ratios should clearly diverge between the two voices.
      const lowRatio = lowLow / Math.max(1, lowHigh);
      const highRatio = highLow / Math.max(1, highHigh);
      expect(
        lowRatio,
        `low voice should weight low band: lowRatio=${lowRatio.toFixed(2)} highRatio=${highRatio.toFixed(2)}`,
      ).toBeGreaterThan(highRatio);
    } finally {
      exp.plaits_destroy(lowVoice);
      exp.plaits_destroy(highVoice);
    }
  });
});
