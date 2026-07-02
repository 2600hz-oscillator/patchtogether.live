// art/scenarios/cocoadelay/profile.test.ts
//
// AUDIO PROFILE for COCOA DELAY (backfill batch 2 — spec §4.1/§4.3,
// .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md), through the
// shared capture harness (art/setup/capture.ts + drivers.ts).
//
// Category: FX / PROCESSOR with a FEEDBACK TAIL — so per spec §4.1 the
// render is ≥1.0 s (1.6 s here) and the driver is a short transient: a
// 60 ms C4 saw burst at t=0 (the moog905 batch-1 burst precedent), then
// silence, so the 200 ms echo train decaying at feedback 0.5 is what the
// gallery waveform/spectrogram shows — dry hit, then echoes marching off.
//
// Patch: the worklet's SHIPPING DEFAULTS, taken directly from the captured
// class's own parameterDescriptors table (delayTime 0.2 s, feedback 0.5,
// wet 0.5, dry 1, drift 0.001, tempo sync off, …) — no hand-copied
// constants to drift.
//
// Rendering path: the REAL worklet processor class (the bluebox batch-1
// pattern). cocoadelay.ts + cocoadelay-core.ts are self-contained pure
// math: the DRIFT modulation runs on the core's own fixed-seed Xorshift
// (the Cocoa Delay original's PRNG — deterministic by construction, never
// Math.random), so we capture the class via the registerProcessor shim and
// pump process() in 128-sample blocks. Zero mirror, zero drift: this IS
// the shipping DSP, including the in-loop filters, stateful drive and
// ducking follower.
//
// SIGNATURE output (owner decision §6b.2): ONE baseline `out`. With this
// mono driver and the default patch (stereoOffset 0, pan 0, static pan
// mode) the worklet's outL/outR are provably identical — asserted below —
// so one profile covers both ports (bus-duplicate rule, spec §4.1).
//
// The .sha pins BOTH the worklet entry and the shared core (the same file
// CHARLOTTE'S ECHOS chains ×4) so a change in either forces an intentional
// `task art:update`.

import { describe, expect, it } from 'vitest';
import { dspSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';
import { vcoTestSignal } from '../../setup/drivers';

const SR = SAMPLE_RATE;
const DURATION_S = 1.6;
const BURST_S = 0.06;
const BLOCK = 128;

// ── Capture the processor class via the registerProcessor shim ─────────────
interface WorkletLike {
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}
type ProcCtor = (new (opts?: unknown) => WorkletLike) & {
  parameterDescriptors?: ReadonlyArray<{ name: string; defaultValue: number }>;
};

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
  await import('../../../packages/dsp/src/cocoadelay');
  g.registerProcessor = prev;
  if (!registered) throw new Error('cocoadelay.ts did not registerProcessor()');
  capturedProc = registered;
  return capturedProc;
}

// ── Render ──────────────────────────────────────────────────────────────────

async function renderProfile(): Promise<Record<string, Float32Array>> {
  const Proc = await loadProcessor();
  const proc = new Proc();
  // Shipping defaults, straight from the descriptor table (single-element
  // arrays = the k-rate/"constant this block" AudioParam shape).
  const descriptors = Proc.parameterDescriptors;
  if (!descriptors) throw new Error('cocoadelay: no parameterDescriptors');
  const params: Record<string, Float32Array> = {};
  for (const d of descriptors) params[d.name] = new Float32Array([d.defaultValue]);

  const n = Math.round(SR * DURATION_S);
  // 60 ms C4 saw burst, then silence — the echo train rings out on its own.
  const burst = vcoTestSignal({ totalS: BURST_S, amp: 0.6 });
  const input = new Float32Array(n);
  input.set(burst, 0);

  const outL = new Float32Array(n);
  const outR = new Float32Array(n);
  const blockL = new Float32Array(BLOCK);
  const blockR = new Float32Array(BLOCK);
  for (let start = 0; start < n; start += BLOCK) {
    const len = Math.min(BLOCK, n - start);
    blockL.fill(0);
    blockR.fill(0);
    // inputs[0] = audio L; the worklet mirrors it onto R when the stereo
    // input is unpatched (inR ?? inputs[0]), and the clock gate is unpatched.
    proc.process(
      [[input.subarray(start, start + len)]],
      [[blockL.subarray(0, len)], [blockR.subarray(0, len)]],
      params,
    );
    outL.set(blockL.subarray(0, len), start);
    outR.set(blockR.subarray(0, len), start);
  }

  // Bus-duplicate proof for the SIGNATURE single-out decision: with the
  // mono driver + default patch, L and R must be the SAME signal.
  for (let i = 0; i < n; i++) {
    if (outL[i]! !== outR[i]!) throw new Error(`outL/outR diverge at sample ${i}`);
  }
  return { out: outL };
}

function rms(b: Float32Array, s = 0, e = b.length): number {
  let x = 0;
  for (let i = s; i < e; i++) x += b[i]! * b[i]!;
  return Math.sqrt(x / Math.max(1, e - s));
}

describe('ART cocoadelay / audio profile (60 ms saw burst → 200 ms echo train, default patch)', () => {
  it('renders the dry burst, discrete decaying echoes and silence between them', async () => {
    const out = (await renderProfile()).out!;
    expect(out.length).toBe(Math.round(SR * DURATION_S));
    expect(out.every(Number.isFinite)).toBe(true);
    // The dry burst dominates the first 60 ms (dryVolume 1).
    expect(rms(out, 0, Math.round(BURST_S * SR))).toBeGreaterThan(0.1);
    // A DISCRETE echo: energy in the first-echo window (~0.2 s, wet 0.5)
    // clearly beats the near-silent gap between burst and echo…
    const gap = rms(out, Math.round(0.1 * SR), Math.round(0.18 * SR));
    const echo1 = rms(out, Math.round(0.19 * SR), Math.round(0.28 * SR));
    expect(echo1).toBeGreaterThan(gap * 3);
    expect(echo1).toBeGreaterThan(0.01);
    // …and the train DECAYS (feedback 0.5 < 1): the tail end is far below
    // the first echo.
    const late = rms(out, Math.round(1.35 * SR), Math.round(1.55 * SR));
    expect(late).toBeLessThan(echo1 * 0.5);
    let peak = 0;
    for (const v of out) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThan(2);
    // Deterministic re-render is bit-identical (fresh processor instance;
    // DRIFT runs on the core's fixed-seed Xorshift, never Math.random).
    const again = (await renderProfile()).out!;
    let diff = 0;
    for (let i = 0; i < out.length; i++) diff = Math.max(diff, Math.abs(out[i]! - again[i]!));
    expect(diff).toBe(0);
  });

  it('pins the out profile baseline (SHA-gated, RMS tier B)', async () => {
    const srcSha = await dspSourceSha('cocoadelay.ts', 'cocoadelay-core.ts');
    await pinAll('cocoadelay', srcSha, await renderProfile());
  });
});
