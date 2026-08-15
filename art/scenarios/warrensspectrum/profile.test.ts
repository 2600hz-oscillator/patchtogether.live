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
import {
  WarrensSpectrumEngine,
  WS_ENGINE_MASSPASS,
} from '../../../packages/dsp/src/lib/warrensspectrum-dsp';
import { captureOutputs, dspSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';

/** AudioWorklet render-quantum size — the engine's `beginBlock()` cadence. */
const QUANTUM = 128;

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

/** Per-key overrides for makeEngine/renderProfile. DEFAULTS is `as const`, so
 *  its properties carry LITERAL types (`residual: 0.5`) — `Partial<typeof
 *  DEFAULTS>` would only re-admit the default itself (`renderProfile({
 *  residual: 0 })` is TS2322 "0 is not assignable to 0.5"). An override is any
 *  number; only the KEYS come from DEFAULTS. */
type EngineOverrides = { [K in keyof typeof DEFAULTS]?: number };

function makeEngine(overrides: EngineOverrides = {}): WarrensSpectrumEngine {
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
  overrides: EngineOverrides = {},
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

/**
 * MASSPASS render at the shipped defaults, at a chosen BAND COUNT INDEX.
 *
 * `beginBlock()` is called on the 128-sample quantum boundary, exactly as the
 * worklet calls it — MASSPASS re-runs its loudest-band selection there, so a
 * render that skipped it would pin a picture the real module never produces.
 */
function renderMassPass(bandCountIdx: number, durationS = DURATION_S): Record<string, Float32Array> {
  const input = source(durationS);
  const e = makeEngine();
  e.setBandCountIndex(bandCountIdx);
  e.setEngineMode(WS_ENGINE_MASSPASS);
  // Run the mode-change declick out before capture starts, so the baseline
  // pins the ENGINE and not the 6 ms ramp into it.
  e.beginBlock();
  for (let i = 0; i < QUANTUM * 4; i++) e.processSample(0);
  return captureOutputs({ durationS, outputs: ['out'] }, (i) => {
    if (i % QUANTUM === 0) e.beginBlock();
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

  it('MASSPASS is a DIFFERENT ENGINE, not a variation — and both are audible', () => {
    // The attribution test for the two MASSPASS pins below. If SPECTRAL and
    // MASSPASS ever rendered the same thing, `masspass-24` would silently be
    // a third copy of `resynth` and the second engine would be unprotected.
    const spectral = renderProfile().out!;
    const mass = renderMassPass(1).out!;
    const from = Math.round(0.2 * SR);
    const rmsOf = (b: Float32Array) => {
      let s = 0;
      for (let i = from; i < b.length; i++) s += b[i]! * b[i]!;
      return Math.sqrt(s / (b.length - from));
    };
    expect(rmsOf(spectral), 'SPECTRAL must be audible').toBeGreaterThan(0.02);
    expect(rmsOf(mass), 'MASSPASS must be audible').toBeGreaterThan(0.005);

    let diff = 0;
    let ref = 0;
    for (let i = from; i < spectral.length; i++) {
      diff += (spectral[i]! - mass[i]!) ** 2;
      ref += Math.max(spectral[i]! ** 2, mass[i]! ** 2);
    }
    expect(
      Math.sqrt(diff / Math.max(ref, 1e-12)),
      'relative RMS difference between SPECTRAL and MASSPASS (dimensionless)',
    ).toBeGreaterThan(0.5);
  });

  it('BAND COUNT is a real axis — 16 bands and 99 bands are different renders', () => {
    // Guards `masspass-24` / `masspass-99` from pinning the same audio twice.
    const lo = renderMassPass(0).out!; // 16
    const hi = renderMassPass(5).out!; // 99
    let diff = 0;
    let ref = 0;
    for (let i = 0; i < lo.length; i++) {
      diff += (lo[i]! - hi[i]!) ** 2;
      ref += Math.max(lo[i]! ** 2, hi[i]! ** 2);
    }
    expect(
      Math.sqrt(diff / Math.max(ref, 1e-12)),
      'relative RMS difference between 16 and 99 bands (dimensionless)',
    ).toBeGreaterThan(0.1);
  });

  it('pins the spectral-resynth AND masspass profiles (SHA-gated, RMS tier B)', async () => {
    // ⚠ The SHA basis includes the MASSPASS core and the shared voice module.
    // Without them a change to the second engine (or to the shape morph both
    // engines render through) would leave every baseline here PASSING while
    // the audio moved — the pin would be gated on a file the change never
    // touched. Adding a scenario means adding its sources here.
    const srcSha = await dspSourceSha(
      'lib/warrensspectrum-dsp.ts',
      'lib/warrensspectrum-masspass.ts',
      'lib/warrensspectrum-voice.ts',
      'warrensspectrum.ts',
    );
    await pinAll('warrensspectrum', srcSha, {
      resynth: renderProfile().out!,
      'residual-off': renderProfile({ residual: 0 }).out!,
      'freeze-hold': renderFreeze().out!,
      // MASSPASS at its default 24 bands and at the 99-band maximum — the
      // two ends of the engine's one structural control, and the pair that
      // makes a band-count regression localise instead of just reddening.
      'masspass-24': renderMassPass(1).out!,
      'masspass-99': renderMassPass(5).out!,
    });
  });
});
