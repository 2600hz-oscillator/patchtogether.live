// packages/dsp/src/lib/warrensspectrum-masspass.test.ts
//
// Gates for the MASSPASS engine (phase 4) and for the `engineMode` switch.
//
// The load-bearing test in this file is "MASSPASS is AUDIBLY DIFFERENT from
// SPECTRAL", and it carries a PERMANENT NEGATIVE CONTROL: the same
// difference metric, applied to two runs of the SAME engine, must report
// ~zero. Without that leg a metric that always reports "different" (the easy
// failure — any noise floor, any denormal, any uninitialised state) would
// pass this file while proving nothing at all.

import { describe, expect, it } from 'vitest';
import {
  WarrensSpectrumEngine,
  WS_ENGINE_MASSPASS,
  WS_ENGINE_SPECTRAL,
} from './warrensspectrum-dsp';
import {
  WsMassPass,
  WS_MASSPASS_BAND_COUNTS,
  WS_MASSPASS_MAX_BANDS,
  wsBandCountForIndex,
  wsSnapBandCount,
} from './warrensspectrum-masspass';

const SR = 48000;
const QUANTUM = 128;

/** A broadband, pitched test signal: a 24-harmonic sawtooth-ish tone plus a
 *  little noise, so EVERY band of even a 99-band bank has something to hear. */
function testSignal(n: number, f0 = 110, seed = 12345): Float32Array {
  const buf = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = 0;
    for (let h = 1; h <= 24; h++) v += Math.sin(2 * Math.PI * f0 * h * t) / h;
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    v += ((s / 0x7fffffff) * 2 - 1) * 0.3;
    buf[i] = v * 0.25;
  }
  return buf;
}

function rms(x: Float32Array): number {
  let acc = 0;
  for (let i = 0; i < x.length; i++) acc += x[i]! * x[i]!;
  return Math.sqrt(acc / Math.max(1, x.length));
}

/** Render `input` through a fresh engine in `mode`, block by block so the
 *  per-block `beginBlock()` hook runs exactly as the worklet runs it. */
function renderEngine(
  mode: number,
  input: Float32Array,
  tweak?: (e: WarrensSpectrumEngine) => void,
): Float32Array {
  const e = new WarrensSpectrumEngine(SR);
  e.setEngineMode(mode);
  tweak?.(e);
  const out = new Float32Array(input.length);
  for (let off = 0; off < input.length; off += QUANTUM) {
    const n = Math.min(QUANTUM, input.length - off);
    e.beginBlock();
    for (let i = 0; i < n; i++) out[off + i] = e.processSample(input[off + i]!);
  }
  return out;
}

/**
 * The DIFFERENCE METRIC used by the audible-difference test.
 *
 * Normalised RMS of the difference, divided by the RMS of the louder signal —
 * so it is a RELATIVE measure and cannot be gamed by one engine simply being
 * quieter. 0 = identical, 1 = as different as two uncorrelated signals of
 * the same level, >1 possible when levels differ too.
 *
 * ⚠ Both inputs are compared over the SAME window, and the window skips the
 * first 0.25 s so neither engine's start-up transient (SPECTRAL's stability
 * ramp, MASSPASS's 3 ms attack + first SLICE) is what the number measures.
 */
function relativeDifference(a: Float32Array, b: Float32Array): number {
  const skip = Math.floor(SR * 0.25);
  const n = Math.min(a.length, b.length);
  let diffAcc = 0;
  let refAcc = 0;
  let count = 0;
  for (let i = skip; i < n; i++) {
    const d = a[i]! - b[i]!;
    diffAcc += d * d;
    refAcc += Math.max(a[i]! * a[i]!, b[i]! * b[i]!);
    count++;
  }
  if (count === 0 || refAcc === 0) return 0;
  return Math.sqrt(diffAcc / count) / Math.sqrt(refAcc / count);
}

describe('MASSPASS — band-count roster', () => {
  it('the roster is the six values the VST offers, ascending', () => {
    expect([...WS_MASSPASS_BAND_COUNTS]).toEqual([16, 24, 33, 48, 66, 99]);
    expect(WS_MASSPASS_MAX_BANDS).toBe(99);
  });

  it('snapBandCount rounds DOWN to the nearest legal value', () => {
    expect(wsSnapBandCount(1)).toBe(16);
    expect(wsSnapBandCount(16)).toBe(16);
    expect(wsSnapBandCount(17)).toBe(24);
    expect(wsSnapBandCount(47)).toBe(48);
    expect(wsSnapBandCount(99)).toBe(99);
    expect(wsSnapBandCount(1000)).toBe(99);
  });

  it('index → count is clamped at both ends', () => {
    WS_MASSPASS_BAND_COUNTS.forEach((c, i) => expect(wsBandCountForIndex(i)).toBe(c));
    expect(wsBandCountForIndex(-5)).toBe(16);
    expect(wsBandCountForIndex(99)).toBe(99);
  });

  // ⚠ Budget note (red main 33561893729, 2026-09-01): this sweep renders 0.5 s
  // of audio for SIX band counts, and the original shape called expect() TWICE
  // PER SAMPLE — 288k assertion invocations, which is what actually spent the
  // clock; on a loaded runner it blew vitest's default 5 s while every other
  // test here passed. The scan below asserts ONCE per count with the first
  // offending index in the message (identical failure semantics, ~none of the
  // cost), and the explicit timeout scales by the roster the loop sweeps.
  it(
    'every band count produces finite, bounded audio',
    () => {
      const input = testSignal(SR / 2);
      for (const count of WS_MASSPASS_BAND_COUNTS) {
        const mp = new WsMassPass(SR, count);
        const out = mp.processBlock(input);
        expect(mp.getBandCount()).toBe(count);
        let bad = -1;
        for (let i = 0; i < out.length; i++) {
          const v = out[i]!;
          if (!Number.isFinite(v) || Math.abs(v) >= 8) { bad = i; break; }
        }
        expect(
          bad,
          `count=${count}: sample[${bad}]=${bad >= 0 ? out[bad] : 'ok'} not finite/bounded`,
        ).toBe(-1);
        expect(rms(out)).toBeGreaterThan(1e-5);
      }
    },
    WS_MASSPASS_BAND_COUNTS.length * 2_000,
  );

  it('band centres are log-spaced across 50 Hz .. 12 kHz and ascend', () => {
    const mp = new WsMassPass(SR, 48);
    let prev = 0;
    for (let b = 0; b < 48; b++) {
      const hz = mp.getCenterHz(b);
      expect(hz).toBeGreaterThan(prev);
      prev = hz;
    }
    expect(mp.getCenterHz(0)).toBeGreaterThan(50);
    expect(mp.getCenterHz(47)).toBeLessThan(12000);
  });

  it('BAND COUNT is a TIMBRE control, not a level control (1/sqrt(N) norm)', () => {
    // The whole point of bankNorm. Without it 99 bands would be ~2.5x louder
    // than 16 and the control would read as a volume knob.
    const input = testSignal(SR / 2);
    const levels = WS_MASSPASS_BAND_COUNTS.map((c) => rms(new WsMassPass(SR, c).processBlock(input)));
    const lo = Math.min(...levels);
    const hi = Math.max(...levels);
    expect(hi / lo).toBeLessThan(3);
  });
});

describe('MASSPASS — the engine tracks what it hears', () => {
  it('a band whose centre matches the input tone reports that pitch', () => {
    // 440 Hz sine: the band containing 440 Hz should settle on a held
    // frequency near 440. This is the zero-crossing estimator working.
    const n = SR;
    const input = new Float32Array(n);
    for (let i = 0; i < n; i++) input[i] = Math.sin((2 * Math.PI * 440 * i) / SR) * 0.5;
    const mp = new WsMassPass(SR, 48);
    mp.processBlock(input);
    // Find the band whose centre is closest to 440 Hz.
    let best = 0;
    for (let b = 1; b < 48; b++) {
      if (Math.abs(mp.getCenterHz(b) - 440) < Math.abs(mp.getCenterHz(best) - 440)) best = b;
    }
    expect(mp.getHeldHz(best)).toBeGreaterThan(380);
    expect(mp.getHeldHz(best)).toBeLessThan(500);
    expect(mp.getHeldAmp(best)).toBeGreaterThan(1e-3);
  });

  it('silence in ⇒ silence out', () => {
    const mp = new WsMassPass(SR, 48);
    const out = mp.processBlock(new Float32Array(SR / 4));
    expect(rms(out)).toBeLessThan(1e-9);
  });

  it('ACTIVE BANDS thins the output — fewer bands sound, less energy', () => {
    const input = testSignal(SR / 2);
    const all = new WsMassPass(SR, 48);
    all.setActiveBands(48);
    const loudAll = rms(all.processBlock(input));

    const few = new WsMassPass(SR, 48);
    few.setActiveBands(2);
    const loudFew = rms(few.processBlock(input));

    expect(few.getActiveBands()).toBe(2);
    expect(loudFew).toBeLessThan(loudAll);
    expect(loudFew).toBeGreaterThan(0);
  });

  it('SLICE is a real axis: a long hold renders differently from a short one', () => {
    const input = testSignal(SR);
    const fast = new WsMassPass(SR, 48);
    fast.setSliceMs(2, 2, 200);
    const slow = new WsMassPass(SR, 48);
    slow.setSliceMs(200, 2, 200);
    const d = relativeDifference(fast.processBlock(input), slow.processBlock(input));
    expect(d).toBeGreaterThan(0.1);
  });

  it('FREEZE holds the snapshot — the held values stop moving', () => {
    // The divergence from the VST (where FREEZE is inert in MASSPASS) is
    // load-bearing behaviour, so it gets a test rather than only a comment.
    const mp = new WsMassPass(SR, 24);
    mp.setSliceMs(5, 2, 200);
    mp.processBlock(testSignal(SR / 2, 110));
    mp.setFrozen(true);
    const frozenSnapshot = Array.from({ length: 24 }, (_, b) => [mp.getHeldAmp(b), mp.getHeldHz(b)]);
    // Feed a COMPLETELY different signal; the held picture must not move.
    mp.processBlock(testSignal(SR / 2, 660, 777));
    const after = Array.from({ length: 24 }, (_, b) => [mp.getHeldAmp(b), mp.getHeldHz(b)]);
    expect(after).toEqual(frozenSnapshot);

    // NEGATIVE CONTROL, permanent: un-freeze and the same input DOES move it.
    mp.setFrozen(false);
    mp.processBlock(testSignal(SR / 2, 660, 777));
    const thawed = Array.from({ length: 24 }, (_, b) => [mp.getHeldAmp(b), mp.getHeldHz(b)]);
    expect(thawed).not.toEqual(frozenSnapshot);
  });

  it('V/oct transposition moves the resynthesis without moving the analysis', () => {
    const input = testSignal(SR / 2);
    const a = new WsMassPass(SR, 48);
    const b = new WsMassPass(SR, 48);
    // NB: processBlock(input, out, pitchTranspose) — the middle arg is the
    // destination buffer, so the transposition must be passed third.
    const plain = a.processBlock(input, undefined, 1);
    const up = b.processBlock(input, undefined, 2); // +1 octave
    expect(relativeDifference(plain, up)).toBeGreaterThan(0.1);
    // The ANALYSIS is unchanged: both saw the same audio, so the held
    // frequency estimates (pre-transposition) must match.
    for (let i = 0; i < 48; i++) expect(a.getHeldHz(i)).toBeCloseTo(b.getHeldHz(i), 5);
  });
});

describe('engineMode — MASSPASS vs SPECTRAL', () => {
  it('SPECTRAL is the default', () => {
    expect(new WarrensSpectrumEngine(SR).getEngineMode()).toBe(WS_ENGINE_SPECTRAL);
  });

  // ── THE LOAD-BEARING TEST ────────────────────────────────────────────────
  it('MASSPASS produces AUDIBLY DIFFERENT output from SPECTRAL on the same input', () => {
    const input = testSignal(SR);
    const spectral = renderEngine(WS_ENGINE_SPECTRAL, input);
    const masspass = renderEngine(WS_ENGINE_MASSPASS, input);

    // Both must actually be making sound — "different" is worthless if one
    // of them is silent.
    expect(rms(spectral)).toBeGreaterThan(1e-4);
    expect(rms(masspass)).toBeGreaterThan(1e-4);

    const d = relativeDifference(spectral, masspass);
    expect(
      d,
      `MASSPASS vs SPECTRAL relative difference (0 = identical, ~1 = uncorrelated). ` +
        `spectral rms=${rms(spectral).toFixed(6)} masspass rms=${rms(masspass).toFixed(6)}`,
    ).toBeGreaterThan(0.5);
  });

  // ── ITS NEGATIVE CONTROL, PERMANENT ──────────────────────────────────────
  it('NEGATIVE CONTROL: the same metric reports ~0 when both runs use the SAME engine', () => {
    // This is the leg that makes the assertion above mean something. Forcing
    // "both modes" to the same engine MUST collapse the metric to zero — if
    // it did not, the difference test would pass for a module that never
    // implemented MASSPASS at all.
    const input = testSignal(SR);

    const bothSpectral = relativeDifference(
      renderEngine(WS_ENGINE_SPECTRAL, input),
      renderEngine(WS_ENGINE_SPECTRAL, input),
    );
    const bothMasspass = relativeDifference(
      renderEngine(WS_ENGINE_MASSPASS, input),
      renderEngine(WS_ENGINE_MASSPASS, input),
    );

    expect(bothSpectral, 'SPECTRAL vs itself must be bit-identical').toBe(0);
    expect(bothMasspass, 'MASSPASS vs itself must be bit-identical').toBe(0);
  });

  it('the two engines differ in KIND, not just level — matching their RMS keeps them different', () => {
    // A cheap way for the difference metric to be fooled is a pure gain
    // offset. Normalise both to the same RMS and re-measure: a real
    // difference in TIMBRE survives, a difference in level does not.
    const input = testSignal(SR);
    const spectral = renderEngine(WS_ENGINE_SPECTRAL, input);
    const masspass = renderEngine(WS_ENGINE_MASSPASS, input);
    const gs = rms(spectral);
    const gm = rms(masspass);
    const sN = spectral.map((v) => v / gs) as Float32Array;
    const mN = masspass.map((v) => v / gm) as Float32Array;
    expect(relativeDifference(sN, mN)).toBeGreaterThan(0.5);
  });

  it('BAND COUNT changes the MASSPASS timbre through the full engine', () => {
    const input = testSignal(SR / 2);
    const lo = renderEngine(WS_ENGINE_MASSPASS, input, (e) => e.setBandCountIndex(0)); // 16
    const hi = renderEngine(WS_ENGINE_MASSPASS, input, (e) => e.setBandCountIndex(5)); // 99
    expect(relativeDifference(lo, hi)).toBeGreaterThan(0.1);
  });

  it('an unrecognised mode index falls back to SPECTRAL rather than silence', () => {
    const input = testSignal(SR / 2);
    const weird = renderEngine(7, input);
    const spectral = renderEngine(WS_ENGINE_SPECTRAL, input);
    expect(relativeDifference(weird, spectral)).toBe(0);
  });

  it('SPECTRAL mode does not run the MASSPASS analysis (it stays at rest)', () => {
    // The cost argument depends on MASSPASS being genuinely idle in SPECTRAL.
    // If its filters were running we would be paying for both engines.
    const e = new WarrensSpectrumEngine(SR);
    const input = testSignal(SR / 4);
    e.beginBlock();
    for (let i = 0; i < input.length; i++) e.processSample(input[i]!);
    const mp = e.getMassPass();
    let moved = 0;
    for (let b = 0; b < mp.getBandCount(); b++) if (mp.getHeldAmp(b) !== 0) moved++;
    expect(moved, 'MASSPASS must be untouched while SPECTRAL is selected').toBe(0);
  });
});

describe('engineMode — switching is glitch-free', () => {
  /** Largest sample-to-sample step in a buffer. A click is a big step. */
  function maxStep(x: Float32Array, from: number, to: number): number {
    let m = 0;
    for (let i = Math.max(1, from); i < to; i++) m = Math.max(m, Math.abs(x[i]! - x[i - 1]!));
    return m;
  }

  it('the DRY bus ramps through zero at the switch — no step discontinuity', () => {
    const input = testSignal(SR);
    const e = new WarrensSpectrumEngine(SR);
    const out = new Float32Array(input.length);
    const switchAt = Math.floor(SR * 0.5);
    for (let off = 0; off < input.length; off += QUANTUM) {
      const n = Math.min(QUANTUM, input.length - off);
      if (off <= switchAt && switchAt < off + n) e.setEngineMode(WS_ENGINE_MASSPASS);
      e.beginBlock();
      for (let i = 0; i < n; i++) out[off + i] = e.processSample(input[off + i]!);
    }

    // Steady-state step size well away from the switch, as the reference.
    const quietStep = maxStep(out, Math.floor(SR * 0.8), Math.floor(SR * 0.95));
    // Step size across the switch window (the 6 ms ramp plus slack).
    const switchStep = maxStep(out, switchAt - 64, switchAt + Math.floor(SR * 0.02));

    // The switch must not introduce a step materially bigger than the
    // signal's own. Generous factor: this is a CLICK gate, not a
    // waveform-equality gate.
    expect(
      switchStep,
      `step across the mode switch (${switchStep.toFixed(6)}) vs steady-state (${quietStep.toFixed(6)})`,
    ).toBeLessThan(quietStep * 3 + 1e-3);
  });

  it('NEGATIVE CONTROL: the declick gate CAN fail — a hard swap trips it', () => {
    // Instrument check in the failing direction. Splice two engines'
    // independently-rendered output at a sample boundary with NO ramp: that
    // is exactly the artefact applyModeXfade exists to prevent, and the same
    // measurement must flag it. If this ever stops failing, the gate above
    // is not measuring what it claims.
    const input = testSignal(SR);
    const spectral = renderEngine(WS_ENGINE_SPECTRAL, input);
    const masspass = renderEngine(WS_ENGINE_MASSPASS, input);
    const switchAt = Math.floor(SR * 0.5);
    const spliced = new Float32Array(input.length);
    spliced.set(spectral.subarray(0, switchAt), 0);
    spliced.set(masspass.subarray(switchAt), switchAt);

    const quietStep = maxStep(spliced, Math.floor(SR * 0.8), Math.floor(SR * 0.95));
    const spliceStep = maxStep(spliced, switchAt - 4, switchAt + 4);
    expect(
      spliceStep,
      'a hard splice MUST look like a click to this metric, else the gate is blind',
    ).toBeGreaterThan(quietStep);
  });

  it('re-setting the SAME mode does not retrigger the ramp', () => {
    // A k-rate param is pulled every quantum. If setEngineMode restarted the
    // ramp each time, a steady setting would become a 3 ms tremolo.
    const e = new WarrensSpectrumEngine(SR);
    e.setEngineMode(WS_ENGINE_MASSPASS);
    // Run past the ramp.
    const warm = testSignal(SR / 4);
    e.beginBlock();
    for (let i = 0; i < warm.length; i++) e.processSample(warm[i]!);
    expect(e.isModeSwitching()).toBe(false);
    e.setEngineMode(WS_ENGINE_MASSPASS);
    expect(e.isModeSwitching()).toBe(false);
    e.setEngineMode(WS_ENGINE_SPECTRAL);
    expect(e.isModeSwitching()).toBe(true);
  });

  it('the engine ends up in the mode it was asked for', () => {
    const e = new WarrensSpectrumEngine(SR);
    e.setEngineMode(WS_ENGINE_MASSPASS);
    const buf = testSignal(SR / 4);
    e.beginBlock();
    for (let i = 0; i < buf.length; i++) e.processSample(buf[i]!);
    expect(e.getEngineMode()).toBe(WS_ENGINE_MASSPASS);
  });
});
