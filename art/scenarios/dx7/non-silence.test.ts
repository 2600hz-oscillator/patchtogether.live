// art/scenarios/dx7/non-silence.test.ts
//
// ART scenario for the DX7 module (engine_id = 10, Plaits' SixOpEngine —
// the canonical full-DX7 emulation in patchtogether.live).
//
// Boots dist/plaits.wasm directly under vitest (not via AudioWorklet) and
// renders 1 second per algorithm slice with a held trigger, asserting:
//
//   - all samples finite
//   - peak above silence floor
//   - changing the algorithm knob meaningfully changes spectral content
//
// Pairs with the Playwright E2E in e2e/tests/dx7.spec.ts which exercises
// the same engine through the AudioWorkletProcessor.

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
const ENGINE_DX7 = 10;

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

interface RenderParams {
  note: number;
  algorithm: number;   // 0..1, internally mapped to harmonics → patch_index 0..31
  brightness: number;  // 0..1, mapped to timbre
  envelope: number;    // 0..1, mapped to morph
  trigger: boolean;
}

function renderDx7(
  exp: PlaitsExports,
  voice: number,
  durationS: number,
  params: RenderParams,
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
    fParams[1] = params.algorithm;   // → harmonics → patch_index
    fParams[2] = params.brightness;  // → timbre
    fParams[3] = params.envelope;    // → morph (envelope_control)
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

describe('dx7 / non-silence', () => {
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
    const v = exp.plaits_create(ENGINE_DX7);
    expect(v).toBeGreaterThan(0);
    try {
      const buf = renderDx7(exp, v, DURATION_S, {
        note: 60,
        algorithm: 0,
        brightness: 0.5,
        envelope: 0.5,
        trigger: true,
      });
      expect(buf.length).toBe(SR * DURATION_S);
      const badIdx = buf.findIndex((x) => !Number.isFinite(x));
      expect(badIdx, `non-finite at ${badIdx}`).toBe(-1);
    } finally {
      exp.plaits_destroy(v);
    }
  });

  it('produces audible signal (peak > 0.01, RMS > 0.005)', () => {
    if (!exp) throw new Error('wasm not loaded');
    const v = exp.plaits_create(ENGINE_DX7);
    try {
      const buf = renderDx7(exp, v, DURATION_S, {
        note: 60,
        algorithm: 0,
        brightness: 0.6,
        envelope: 0.5,
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
      expect(rms, `rms too low (rms=${rms})`).toBeGreaterThan(0.005);
    } finally {
      exp.plaits_destroy(v);
    }
  });

  it('changing note shifts low-band vs high-band energy', () => {
    if (!exp) throw new Error('wasm not loaded');
    const lowVoice = exp.plaits_create(ENGINE_DX7);
    const highVoice = exp.plaits_create(ENGINE_DX7);
    try {
      const low = renderDx7(exp, lowVoice, 0.5, {
        note: 36,
        algorithm: 0,
        brightness: 0.6,
        envelope: 0.5,
        trigger: true,
      });
      const high = renderDx7(exp, highVoice, 0.5, {
        note: 84,
        algorithm: 0,
        brightness: 0.6,
        envelope: 0.5,
        trigger: true,
      });

      function bandEnergy(buf: Float32Array, lo: number, hi: number): number {
        let sum = 0;
        for (let f = lo; f <= hi; f += 50) sum += goertzel(buf, SR, f);
        return sum;
      }
      const lowLow = bandEnergy(low, 50, 200);
      const lowHigh = bandEnergy(low, 1000, 3000);
      const highLow = bandEnergy(high, 50, 200);
      const highHigh = bandEnergy(high, 1000, 3000);

      const lowRatio = lowLow / Math.max(1, lowHigh);
      const highRatio = highLow / Math.max(1, highHigh);
      expect(
        lowRatio,
        `low-note voice should weight low band: lowRatio=${lowRatio.toFixed(2)} highRatio=${highRatio.toFixed(2)}`,
      ).toBeGreaterThan(highRatio);
    } finally {
      exp.plaits_destroy(lowVoice);
      exp.plaits_destroy(highVoice);
    }
  });

  it('different algorithm slots produce different spectra', () => {
    // Two voices, same note + brightness, but different algorithm-knob
    // positions — distinct algorithms in our default bank should yield
    // detectably different total energy or spectral distribution.
    if (!exp) throw new Error('wasm not loaded');
    const va = exp.plaits_create(ENGINE_DX7);
    const vb = exp.plaits_create(ENGINE_DX7);
    try {
      // algorithm = 0.0 → patch_index 0 (algorithm 1)
      const a = renderDx7(exp, va, 0.6, {
        note: 60,
        algorithm: 0.0,
        brightness: 0.6,
        envelope: 0.5,
        trigger: true,
      });
      // algorithm = 1.0 → patch_index 31 (algorithm 32 — pure additive,
      // very different sonically from algorithm 1's deep stack).
      const b = renderDx7(exp, vb, 0.6, {
        note: 60,
        algorithm: 1.0,
        brightness: 0.6,
        envelope: 0.5,
        trigger: true,
      });

      function energy(buf: Float32Array): number {
        let e = 0;
        for (let i = 0; i < buf.length; i++) e += buf[i] * buf[i];
        return e;
      }
      const ea = energy(a);
      const eb = energy(b);
      // The two algorithms should not produce identical samples or trivially
      // proportional energy — assert they diverge by at least 10%.
      const ratio = ea > eb ? ea / Math.max(1e-9, eb) : eb / Math.max(1e-9, ea);
      expect(
        ratio,
        `algorithm 1 vs 32 should differ in energy (ea=${ea.toFixed(3)} eb=${eb.toFixed(3)} ratio=${ratio.toFixed(3)})`,
      ).toBeGreaterThan(1.1);
    } finally {
      exp.plaits_destroy(va);
      exp.plaits_destroy(vb);
    }
  });
});
