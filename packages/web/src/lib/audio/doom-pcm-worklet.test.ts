// packages/web/src/lib/audio/doom-pcm-worklet.test.ts
//
// Loudness regression for DOOM's PCM worklet (the −42 dB fix).
//
// The C mixer (native/doomgeneric/doomgeneric/i_pcmgen.c) does
// `int32_t out = accum >> 6;` — a ÷64 "for 8-channel headroom" — so a SINGLE
// SFX at full volume peaks at only ~254/32768 ≈ −42 dBFS. DOOM was ~40 dB too
// quiet since day one. The fix is a FIXED makeup gain + tanh soft-limiter in
// the worklet's process() (we deliberately do NOT touch the C / rebuild the
// WASM). This test pins that the worklet:
//   - lifts a tiny single-SFX-level sample well above the old near-silence floor
//   - stays ~linear (transparent) at low input
//   - soft-saturates (never exceeds ±1) for a loud firefight, instead of
//     hard-clipping
//   - still honours the user's audioGain ('gain' message, clamped 0..4)
//   - writes a clean 0 on underrun
//
// The worklet is a STATIC classic-script asset (served from /doom/), not an
// importable ES module, so we capture its Processor class the same way the DSP
// worklet tests do: shim the AudioWorklet globals + registerProcessor, then eval
// the file's source. We assert behaviour through the captured class's process().

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKLET_PATH = resolve(
  __dirname,
  '../../../static/doom/doom-pcm-worklet.js',
);

interface PcmProcessor {
  port: { onmessage: ((ev: { data: unknown }) => void) | null };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
type ProcCtor = new () => PcmProcessor;

// The single-SFX float peak the C mixer emits after s16→f32: 254/32768.
const SINGLE_SFX_F32 = 254 / 32768; // ≈ 0.00775
const MAKEUP = 24; // mirror the worklet's named const (kept in lockstep here)

let Processor: ProcCtor;

beforeAll(() => {
  const src = readFileSync(WORKLET_PATH, 'utf8');
  const g = globalThis as unknown as Record<string, unknown>;
  const prevAWP = g.AudioWorkletProcessor;
  const prevReg = g.registerProcessor;
  let captured: ProcCtor | null = null;
  // Minimal AudioWorkletProcessor base: a `port` with an onmessage slot.
  g.AudioWorkletProcessor = class {
    port = { onmessage: null as ((ev: { data: unknown }) => void) | null };
  };
  g.registerProcessor = (_name: string, ctor: ProcCtor) => {
    captured = ctor;
  };
  // The asset is a classic script (registerProcessor at top level); eval it in
  // this scope so the shimmed globals are visible.
  // eslint-disable-next-line no-eval
  (0, eval)(src);
  g.AudioWorkletProcessor = prevAWP;
  g.registerProcessor = prevReg;
  if (!captured) throw new Error('doom-pcm-worklet did not registerProcessor');
  Processor = captured;
});

/** Enqueue `samples` into the processor via its 'pcm' port message, then drain
 *  one process() block of `frames` mono samples. Returns the ch0 output. */
function pump(proc: PcmProcessor, samples: Float32Array, frames: number): Float32Array {
  proc.port.onmessage?.({ data: { type: 'pcm', samples } });
  const ch0 = new Float32Array(frames);
  proc.process([], [[ch0]]);
  return ch0;
}

describe('doom-pcm-worklet — makeup gain + soft limiter (−42 dB fix)', () => {
  it('lifts a single-SFX-level sample well above the old near-silence floor', () => {
    const proc = new Processor();
    const N = 64;
    const out = pump(proc, new Float32Array(N).fill(SINGLE_SFX_F32), N);
    // Old behaviour (gain 1, no makeup) left this at ≈ 0.00775 (−42 dB).
    // With MAKEUP=24 + tanh it lands at tanh(0.186) ≈ 0.184 (≈ −14.7 dB).
    const v = out[0]!;
    expect(v).toBeGreaterThan(0.1); // emphatically louder than the old floor
    expect(v).toBeCloseTo(Math.tanh(SINGLE_SFX_F32 * MAKEUP), 4);
  });

  it('is ~linear (transparent) at low input — tanh ≈ identity for small x', () => {
    const proc = new Processor();
    // A very quiet sample: makeup*x is tiny → tanh barely bends it.
    const x = 0.0005;
    const out = pump(proc, new Float32Array(8).fill(x), 8);
    const expected = x * MAKEUP; // tanh(small) ≈ small
    expect(out[0]!).toBeCloseTo(expected, 5);
  });

  it('soft-saturates a loud firefight to within ±1 (no overshoot / runaway)', () => {
    const proc = new Processor();
    // A near-full-scale C-mixer sample (loud overlapping SFX). makeup pushes it
    // far past 1.0; tanh must NEVER exceed ±1 (a plain makeup*x would run away
    // to >20). It asymptotes toward 1 — soft, not a hard digital clip.
    const loud = 0.9;
    const out = pump(proc, new Float32Array(16).fill(loud), 16);
    for (const v of out) {
      expect(v).toBeLessThanOrEqual(1); // bounded — never overshoots
      expect(v).toBeGreaterThan(0.9);   // but is driven loud (saturated)
    }
    // Symmetric for negative input.
    const proc2 = new Processor();
    const outNeg = pump(proc2, new Float32Array(16).fill(-loud), 16);
    for (const v of outNeg) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThan(-0.9);
    }
    // The soft KNEE (vs a hard clip): a moderately-hot sample that overshoots
    // 1.0 linearly is rolled BELOW 1.0 by tanh, not flattened at exactly 1.0.
    const proc3 = new Processor();
    const knee = 0.06; // makeup*x = 1.44 > 1 linearly → tanh(1.44) ≈ 0.894
    const outKnee = pump(proc3, new Float32Array(8).fill(knee), 8);
    expect(outKnee[0]!).toBeLessThan(1);
    expect(outKnee[0]!).toBeCloseTo(Math.tanh(knee * MAKEUP), 4);
  });

  it('honours the user audioGain (gain message) on top of the makeup', () => {
    const proc = new Processor();
    proc.port.onmessage?.({ data: { type: 'gain', value: 0 } });
    const muted = pump(proc, new Float32Array(8).fill(SINGLE_SFX_F32), 8);
    expect(muted[0]!).toBe(0); // tanh(0) — gain 0 mutes

    const proc2 = new Processor();
    proc2.port.onmessage?.({ data: { type: 'gain', value: 2 } });
    const hot = pump(proc2, new Float32Array(8).fill(SINGLE_SFX_F32), 8);
    expect(hot[0]!).toBeCloseTo(Math.tanh(SINGLE_SFX_F32 * MAKEUP * 2), 4);
    // gain 2 is louder than gain 1.
    const proc3 = new Processor();
    const nominal = pump(proc3, new Float32Array(8).fill(SINGLE_SFX_F32), 8);
    expect(hot[0]!).toBeGreaterThan(nominal[0]!);
  });

  it('clamps the user gain to [0,4]', () => {
    const proc = new Processor();
    proc.port.onmessage?.({ data: { type: 'gain', value: 99 } });
    const out = pump(proc, new Float32Array(8).fill(SINGLE_SFX_F32), 8);
    // Clamped to 4, not 99 → tanh(0.00775*24*4) = tanh(0.744) ≈ 0.63, not ~1.
    expect(out[0]!).toBeCloseTo(Math.tanh(SINGLE_SFX_F32 * MAKEUP * 4), 4);
    expect(out[0]!).toBeLessThan(0.95);
  });

  it('writes a clean 0 on underrun (empty ring)', () => {
    const proc = new Processor();
    const ch0 = new Float32Array(8);
    proc.process([], [[ch0]]); // nothing enqueued
    for (const v of ch0) expect(v).toBe(0);
  });

  it('duplicates ch0 into every output channel (L = R)', () => {
    const proc = new Processor();
    proc.port.onmessage?.({ data: { type: 'pcm', samples: new Float32Array(8).fill(SINGLE_SFX_F32) } });
    const ch0 = new Float32Array(8);
    const ch1 = new Float32Array(8);
    proc.process([], [[ch0, ch1]]);
    for (let i = 0; i < 8; i++) expect(ch1[i]).toBe(ch0[i]);
  });
});
