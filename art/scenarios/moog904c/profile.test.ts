// art/scenarios/moog904c/profile.test.ts
//
// AUDIO PROFILE for MOOG 904C (voltage controlled filter coupler)
// (backfill batch 2 — spec §4.1/§4.3,
// .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md), through the
// shared capture harness (art/setup/capture.ts + drivers.ts).
//
// Category: FILTER — the coupler tracks a 904A-style LP and a 904B-style
// HP around one shared cutoff as a voltage-controlled BAND-PASS. Driver:
// the canonical C4 saw with the deterministic 120 Hz → 8 kHz exponential
// cutoff sweep (batch-1 resofilter span), so the passband SWEEPS THROUGH
// the saw's harmonic stack: quiet at the extremes (band below the
// fundamental / band above the strong harmonics), LOUDEST as the band
// crosses the FUNDAMENTAL — by far the saw's strongest partial — at
// cutoff ≈ 174–476 Hz (≈ 0.10–0.30 s of the sweep): the coupler's
// signature gesture.
//
// Patch: worklet shipping defaults (WIDTH 0.5, MODE 0 = band-pass).
//
// Rendering path: the REAL worklet processor class (the bluebox batch-1
// pattern). moog904c.ts is self-contained pure math — the LP→HP series
// topology (lp4 tap into 4× cascaded hpDerive stages) lives in the
// WORKLET, not the lib, and there is no RNG and no smoother — so we
// capture the class via the registerProcessor shim and pump process() in
// 128-sample blocks, riding the sweep on the a-rate `cutoff` AudioParam
// with full-length arrays (sample-exact values). Zero mirror, zero drift.
//
// SIGNATURE output (owner decision §6b.2): the single mono `audio` out.
//
// The .sha pins BOTH the worklet entry and the ladder lib (combinedSourceSha
// discipline) so a change in either forces an intentional `task art:update`.

import { describe, expect, it } from 'vitest';
import { dspSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';
import { vcoTestSignal } from '../../setup/drivers';

const SR = SAMPLE_RATE;
const DURATION_S = 1.0;
const BLOCK = 128;

// Deterministic exponential band-centre sweep.
const SWEEP_FROM_HZ = 120;
const SWEEP_TO_HZ = 8000;

// Worklet shipping defaults (moog904c.ts parameterDescriptors).
const WIDTH = 0.5;
const MODE = 0; // band-pass

// ── Capture the processor class via the registerProcessor shim ─────────────
interface WorkletLike {
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}
type ProcCtor = new (opts?: unknown) => WorkletLike;

let capturedProc: ProcCtor | null = null;
async function loadProcessor(): Promise<ProcCtor> {
  if (capturedProc) return capturedProc;
  const g = globalThis as unknown as {
    sampleRate?: number;
    registerProcessor?: (n: string, c: ProcCtor) => void;
  };
  g.sampleRate = SR; // the worklet ctor (and clampCorner) read the global
  const prev = g.registerProcessor;
  let registered: ProcCtor | null = null;
  g.registerProcessor = (_n, ctor) => {
    registered = ctor;
  };
  await import('../../../packages/dsp/src/moog904c');
  g.registerProcessor = prev;
  if (!registered) throw new Error('moog904c.ts did not registerProcessor()');
  capturedProc = registered;
  return capturedProc;
}

// ── Render ──────────────────────────────────────────────────────────────────

async function renderProfile(): Promise<Record<string, Float32Array>> {
  const Proc = await loadProcessor();
  const proc = new Proc();
  const input = vcoTestSignal({ totalS: DURATION_S }); // C4 saw, amp 0.5
  const n = input.length;
  const cutoff = new Float32Array(n);
  const ratio = SWEEP_TO_HZ / SWEEP_FROM_HZ;
  for (let i = 0; i < n; i++) cutoff[i] = SWEEP_FROM_HZ * Math.pow(ratio, i / (n - 1));
  const width = new Float32Array([WIDTH]);
  const mode = new Float32Array([MODE]);
  const out = new Float32Array(n);
  const block = new Float32Array(BLOCK);
  for (let start = 0; start < n; start += BLOCK) {
    const len = Math.min(BLOCK, n - start);
    block.fill(0);
    proc.process(
      [[input.subarray(start, start + len)]], // inputs[0] = audio
      [[block.subarray(0, len)]],
      { cutoff: cutoff.subarray(start, start + len), width, mode },
    );
    out.set(block.subarray(0, len), start);
  }
  return { audio: out };
}

function rms(b: Float32Array, s = 0, e = b.length): number {
  let x = 0;
  for (let i = s; i < e; i++) x += b[i]! * b[i]!;
  return Math.sqrt(x / Math.max(1, e - s));
}

describe('ART moog904c / audio profile (coupled band-pass sweep through a C4 saw, default patch)', () => {
  it('renders a finite band-pass sweep that peaks crossing the harmonic stack', async () => {
    const out = (await renderProfile()).audio!;
    expect(out.length).toBe(Math.round(SR * DURATION_S));
    expect(out.every(Number.isFinite)).toBe(true);
    let peak = 0;
    for (const v of out) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(0.05);
    expect(peak).toBeLessThan(2);
    // Band-pass character: the band [0.55·fc, 1.5·fc] contains the C4
    // fundamental (261.6 Hz — the saw's dominant partial) for fc ≈ 174–476
    // Hz, i.e. ≈ 0.10–0.30 s into the exponential sweep. That crossing is
    // the loud part; at the very start (band tops out ~230 Hz) and the very
    // end (band 4.4–12 kHz, only tiny high harmonics) little passes.
    // (The start window is only ~2.2× quieter, not orders of magnitude: at
    // fc ≈ 155 Hz the LP corner sits at 1.5·fc ≈ 232 Hz, a fraction of an
    // octave below the fundamental, so the skirt still leaks some of it.)
    const start = rms(out, 0, Math.round(0.06 * SR));
    const fundCross = rms(out, Math.round(0.12 * SR), Math.round(0.3 * SR));
    const end = rms(out, Math.round(0.88 * SR), Math.round(0.98 * SR));
    expect(fundCross).toBeGreaterThan(start * 1.5);
    expect(fundCross).toBeGreaterThan(end * 2);
    // Deterministic re-render is bit-identical (fresh processor instance,
    // no RNG / no smoother in the 904C path).
    const again = (await renderProfile()).audio!;
    let diff = 0;
    for (let i = 0; i < out.length; i++) diff = Math.max(diff, Math.abs(out[i]! - again[i]!));
    expect(diff).toBe(0);
  });

  it('pins the audio profile baseline (SHA-gated, RMS tier B)', async () => {
    const srcSha = await dspSourceSha('moog904c.ts', 'lib/moog-ladder-dsp.ts');
    await pinAll('moog904c', srcSha, await renderProfile());
  });
});
