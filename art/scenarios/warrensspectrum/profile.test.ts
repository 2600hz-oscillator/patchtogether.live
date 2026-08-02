// art/scenarios/warrensspectrum/profile.test.ts
//
// AUDIO PROFILE for WARREN'S SPECTRUM (the audio-profile gate — spec
// .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md §4.1/§4.3),
// through the shared capture harness (art/setup/capture.ts).
//
// Category: SPECTRAL EFFECT — driven by a fixed synthetic source rather than a
// gate, because the module analyses whatever is patched in and generates
// nothing on its own.
//
// Rendering path: the pure-TS engine core
// (packages/dsp/src/lib/warrensspectrum-dsp.ts `WarrensSpectrumEngine`) — the
// SAME object the AudioWorklet runs, not a mirror of it. The `.sha` pins both
// that lib AND the worklet entry, so a change to either forces an intentional
// `task art:update`.
//
// ── WHY A GOLDEN IS POSSIBLE AT ALL ───────────────────────────────────────
// A spectral resynthesizer has a huge state space, and "produces non-silent
// output" passes for an engine that is subtly broken. A byte-exact baseline
// only works because the ONE stochastic element — the SMS residual's noise
// generator — is an xorshift32 seeded to a constant (WS_RESIDUAL_NOISE_SEED,
// matching SpectralResynth.cpp:200). That is a DESIGN CONSTRAINT on the
// engine, not an accident, and `warrensspectrum-dsp.test.ts` asserts
// byte-reproducibility so this file cannot silently become unpinnable.
//
// ── WHY THESE THREE ───────────────────────────────────────────────────────
// `resynth` and `residual-off` render the IDENTICAL input with RESIDUAL at
// its default and at zero. Their DIFFERENCE is the SMS residual — the one
// respect in which phase 1 is recognisably the VST (its own header calls
// RESIDUAL "the #1 fix for the vocaler/robot vibe"). Pinning both means a
// regression that kills the residual moves one baseline and not the other,
// which localises the fault instead of just reddening.
// `freeze-hold` pins the FREEZE sustain, which is where an amplitude-smoothing
// bug shows up as slow drift rather than as an obvious break.

import { describe, expect, it } from 'vitest';
import { WarrensSpectrumEngine } from '../../../packages/dsp/src/lib/warrensspectrum-dsp';
import { captureOutputs, dspSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';

const SR = SAMPLE_RATE;
const DURATION_S = 0.75;
const FREEZE_DURATION_S = 1.0;
const FREEZE_AT_S = 0.5;

/** The module's own declared defaults (packages/web/src/lib/audio/modules/
 *  warrensspectrum.ts). Stated once so a scenario reads as a deviation from
 *  the shipped defaults rather than as an unexplained pile of numbers. */
const DEFAULTS = {
  partials: 64,
  floorDb: -42,
  stability: 3,
  lock: 0.75,
  residual: 0.5,
  shape: 0,
  slewSec: 0.6,
  sliceMs: 10,
  centerCents: 0,
} as const;

/** Deterministic white noise (xorshift32) — the source must be reproducible
 *  for the baseline to mean anything. */
function seededNoise(n: number, seed: number): Float32Array {
  const buf = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    buf[i] = (s / 4294967295) * 2 - 1;
  }
  return buf;
}

/** One RBJ high-pass biquad — bands the noise so the "sibilant" is unambiguous. */
function highpass(x: Float32Array, fc: number): Float32Array {
  const w = (2 * Math.PI * fc) / SR;
  const alpha = Math.sin(w) / (2 * 0.7071);
  const cosw = Math.cos(w);
  const a0 = 1 + alpha;
  const b0 = (1 + cosw) / 2 / a0;
  const b1 = -(1 + cosw) / a0;
  const b2 = (1 + cosw) / 2 / a0;
  const a1 = (-2 * cosw) / a0;
  const a2 = (1 - alpha) / a0;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i]!;
    const yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    y[i] = yi;
    x2 = x1; x1 = xi; y2 = y1; y1 = yi;
  }
  return y;
}

/**
 * The source under analysis: a 10-harmonic 220 Hz tone (all energy below
 * 2.2 kHz) plus a >5 kHz noise band. The sinusoidal tracker spends its budget
 * on the harmonics; the noise band is precisely what it discards, so the
 * residual's contribution is separable by ear and by measurement.
 */
function source(durationS: number): Float32Array {
  const n = Math.round(durationS * SR);
  let banded = seededNoise(n, 0x5eed1234);
  for (let pass = 0; pass < 3; pass++) banded = highpass(banded, 5000);
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let tone = 0;
    for (let k = 1; k <= 10; k++) tone += (1 / k) * Math.sin((2 * Math.PI * 220 * k * i) / SR);
    buf[i] = 0.35 * tone + 0.5 * banded[i]!;
  }
  return buf;
}

function makeEngine(overrides: Partial<typeof DEFAULTS> = {}): WarrensSpectrumEngine {
  const o = { ...DEFAULTS, ...overrides };
  const e = new WarrensSpectrumEngine(SR);
  e.setPartials(o.partials);
  e.setFloorDb(o.floorDb);
  e.setStabilityFrames(o.stability);
  e.setLock(o.lock);
  e.setResidual(o.residual);
  e.setShape(o.shape);
  e.setSlewSeconds(o.slewSec);
  e.setSliceMs(o.sliceMs);
  e.setCenterCents(o.centerCents);
  return e;
}

/** Steady render at the module's declared defaults, overridable. */
function renderProfile(
  overrides: Partial<typeof DEFAULTS> = {},
  durationS = DURATION_S,
): Record<string, Float32Array> {
  const input = source(durationS);
  const e = makeEngine(overrides);
  return captureOutputs({ durationS, outputs: ['out'] }, (i) => ({ out: e.processSample(input[i]!) }));
}

/** FREEZE engaged half-way through, at the defaults. */
function renderFreeze(): Record<string, Float32Array> {
  const input = source(FREEZE_DURATION_S);
  const e = makeEngine();
  const freezeAt = Math.round(FREEZE_AT_S * SR);
  return captureOutputs({ durationS: FREEZE_DURATION_S, outputs: ['out'] }, (i) => {
    if (i === freezeAt) e.setFrozen(true);
    return { out: e.processSample(input[i]!) };
  });
}

describe("ART warren's spectrum / audio profile (spectral resynth)", () => {
  it('renders audible, bounded, deterministic output at the shipped defaults', () => {
    const buf = renderProfile().out!;
    expect(buf.length).toBe(Math.round(SR * DURATION_S));
    expect(buf.every((v) => Number.isFinite(v) && Math.abs(v) < 8)).toBe(true);
    // Audible once the bank has acquired (skip the first 0.2 s).
    const from = Math.round(0.2 * SR);
    let sum = 0;
    for (let i = from; i < buf.length; i++) sum += buf[i]! * buf[i]!;
    expect(Math.sqrt(sum / (buf.length - from))).toBeGreaterThan(0.02);
    // Byte-identical re-render — the precondition for the pins below.
    const again = renderProfile().out!;
    for (let i = 0; i < buf.length; i += 997) expect(again[i]).toBe(buf[i]);
  });

  it('the RESIDUAL is what separates the two steady baselines (not a level trim)', () => {
    // Guards the pins from becoming a tautology: if these two renders were
    // ever identical, `resynth` and `residual-off` would pin the same thing
    // twice and the residual would be unprotected.
    const wet = renderProfile().out!;
    const dry = renderProfile({ residual: 0 }).out!;
    let diff = 0;
    let ref = 0;
    for (let i = 0; i < wet.length; i++) {
      diff += (wet[i]! - dry[i]!) ** 2;
      ref += wet[i]! * wet[i]!;
    }
    expect(
      Math.sqrt(diff / Math.max(ref, 1e-12)),
      'relative RMS difference between RESIDUAL 0.5 and RESIDUAL 0 (dimensionless)',
    ).toBeGreaterThan(0.1);
  });

  it('pins the spectral-resynth profiles (SHA-gated, RMS tier B)', async () => {
    const srcSha = await dspSourceSha('lib/warrensspectrum-dsp.ts', 'warrensspectrum.ts');
    await pinAll('warrensspectrum', srcSha, {
      resynth: renderProfile().out!,
      'residual-off': renderProfile({ residual: 0 }).out!,
      'freeze-hold': renderFreeze().out!,
    });
  });
});
