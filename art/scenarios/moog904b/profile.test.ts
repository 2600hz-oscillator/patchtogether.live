// art/scenarios/moog904b/profile.test.ts
//
// AUDIO PROFILE for MOOG 904B (voltage controlled high pass filter)
// (backfill batch 2 — spec §4.1/§4.3,
// .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md), through the
// shared capture harness (art/setup/capture.ts + drivers.ts).
//
// Category: FILTER — driven by the canonical VCO test signal (C4 saw,
// phase pinned to 0) with a deterministic exponential cutoff sweep. For a
// HIGH-pass the sweep runs DOWNWARD, 8 kHz → 60 Hz: at the start only the
// saw's topmost harmonics survive (thin, quiet); as the cutoff falls
// through the harmonic stack the signal fills back in until the full saw
// passes — the closing-HP gesture is what the spectrogram shows.
//
// Rendering path: the REAL worklet processor class (the bluebox batch-1
// pattern). moog904b.ts is self-contained pure math — the 4× cascaded
// one-pole hpDerive stages live in the WORKLET, not the lib, and there is
// no RNG (unlike the 904A's thermal-noise dither) — so we capture the
// class via the registerProcessor shim and pump process() in 128-sample
// blocks. Zero mirror, zero drift: this IS the shipping DSP, including the
// 80 Hz cutoff-knob smoother (primed at 1 kHz, so the first ~2 ms ease
// toward the sweep's 8 kHz start — the shipping behaviour on a knob jump).
// Patch: shipping defaults (RANGE 1 = LOW, ×1); the sweep rides the a-rate
// `cutoff` AudioParam with full-length arrays, so segment values are
// sample-exact.
//
// SIGNATURE output (owner decision §6b.2): the single mono `audio` out.
//
// The .sha pins the worklet entry + BOTH libs its per-sample path runs
// through (the ladder core and the WtParamSmoother in wavetable-osc), so a
// change in any of them forces an intentional `task art:update`.

import { describe, expect, it } from 'vitest';
import { dspSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';
import { vcoTestSignal } from '../../setup/drivers';

const SR = SAMPLE_RATE;
const DURATION_S = 1.0;
const BLOCK = 128;

// Deterministic exponential cutoff sweep — DOWNWARD for the high-pass.
const SWEEP_FROM_HZ = 8000;
const SWEEP_TO_HZ = 60;

// Worklet shipping default: RANGE 1 = LOW (×1).
const RANGE = 1;

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
  g.sampleRate = SR; // the worklet ctor reads the global sampleRate
  const prev = g.registerProcessor;
  let registered: ProcCtor | null = null;
  g.registerProcessor = (_n, ctor) => {
    registered = ctor;
  };
  await import('../../../packages/dsp/src/moog904b');
  g.registerProcessor = prev;
  if (!registered) throw new Error('moog904b.ts did not registerProcessor()');
  capturedProc = registered;
  return capturedProc;
}

// ── Render ──────────────────────────────────────────────────────────────────

async function renderProfile(): Promise<Record<string, Float32Array>> {
  const Proc = await loadProcessor();
  const proc = new Proc();
  const input = vcoTestSignal({ totalS: DURATION_S }); // C4 saw, amp 0.5
  const n = input.length;
  // Full-length a-rate cutoff schedule (sample-exact sweep values).
  const cutoff = new Float32Array(n);
  const ratio = SWEEP_TO_HZ / SWEEP_FROM_HZ;
  for (let i = 0; i < n; i++) cutoff[i] = SWEEP_FROM_HZ * Math.pow(ratio, i / (n - 1));
  const range = new Float32Array([RANGE]); // k-rate switch
  const out = new Float32Array(n);
  const block = new Float32Array(BLOCK);
  for (let start = 0; start < n; start += BLOCK) {
    const len = Math.min(BLOCK, n - start);
    block.fill(0);
    proc.process(
      [[input.subarray(start, start + len)]], // inputs[0] = audio (cutoff_cv unpatched)
      [[block.subarray(0, len)]],
      { cutoff: cutoff.subarray(start, start + len), range },
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

describe('ART moog904b / audio profile (ladder HP 8 kHz → 60 Hz closing sweep over C4 saw)', () => {
  it('renders a finite high-pass sweep that fills in as the cutoff falls', async () => {
    const out = (await renderProfile()).audio!;
    expect(out.length).toBe(Math.round(SR * DURATION_S));
    expect(out.every(Number.isFinite)).toBe(true);
    let peak = 0;
    for (const v of out) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(0.1);
    expect(peak).toBeLessThan(2);
    // HP character: with the cutoff at ~8 kHz only the saw's top harmonics
    // pass (C4 fundamental 261.6 Hz ≪ cutoff) — quiet; by the end the
    // cutoff (60 Hz) is below the fundamental and the full saw passes.
    const early = rms(out, Math.round(0.05 * SR), Math.round(0.25 * SR));
    const late = rms(out, Math.round(0.75 * SR), Math.round(0.95 * SR));
    expect(late).toBeGreaterThan(early * 3);
    // Deterministic re-render is bit-identical (fresh processor instance,
    // no RNG anywhere in the 904B path).
    const again = (await renderProfile()).audio!;
    let diff = 0;
    for (let i = 0; i < out.length; i++) diff = Math.max(diff, Math.abs(out[i]! - again[i]!));
    expect(diff).toBe(0);
  });

  it('pins the audio profile baseline (SHA-gated, RMS tier B)', async () => {
    const srcSha = await dspSourceSha(
      'moog904b.ts',
      'lib/moog-ladder-dsp.ts',
      'lib/wavetable-osc.ts',
    );
    await pinAll('moog904b', srcSha, await renderProfile());
  });
});
