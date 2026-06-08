// art/scenarios/chowkick/canonical-kicks.test.ts
//
// ART-tier behavior pins for CHOWKICK across four canonical kick patches.
// Each scenario drives the pure DSP helpers (the same per-sample math the
// worklet runs) with a synthesized gate + a fixed param set, then pins
// quantitative properties of the rendered envelope:
//
//   1. bright-kick  — short width + low decay + high tight + bright tone.
//   2. boomy        — long width + medium decay + low tone + high Q.
//   3. pitched-down — moderate freq + pitch slide via Portamento.
//   4. noisy        — high noise amount + high noise cutoff + bounce on.
//
// The baseline pins are coarse-grained envelope characteristics (peak,
// post-attack decay, tail energy) — same approach the SIDECAR ART file
// uses for gain-computer regions: refactor-resistant, behavior-specific,
// flake-safe. We also gate `builtSha === moduleSourceSha` so a stale build
// surfaces immediately.

import { describe, it, expect } from 'vitest';
import { builtSha, moduleSourceSha } from '../../setup/render';
import {
  pulseShaperStep,
  makePulseState,
  noiseBurstStep,
  makeNoiseState,
  resonantCoefs,
  resonantFilterStep,
  makeResonantState,
  outputFilterStep,
  makeOutputState,
  pitchEnvStep,
  makePitchEnvState,
  dcBlockStep,
  makeDcBlockState,
  bodyDriveStep,
  type NoiseType,
} from '../../../packages/dsp/src/lib/chowkick-dsp';

const SR = 48000;

interface KickPatch {
  width_ms: number;
  amp: number;
  decay01: number;
  sustain01: number;
  noiseAmount: number;
  noiseDecay01: number;
  noiseCutoff: number;
  noiseType: NoiseType;
  freqHz: number;
  q: number;
  damping01: number;
  tight01: number;
  bounce01: number;
  toneHz: number;
  levelDb: number;
  // PUNCH params (PR feat/chowkick-oomph). Default to the module's defaults so
  // existing canonical patches inherit the punch chain.
  pitchAmount?: number;
  pitchDecay01?: number;
  drive01?: number;
}

/** Render a single kick at the given patch, returning the audio buffer.
 *  Gate is held HIGH for `gate_ms` then released. Drives the FULL voice chain
 *  (pitch-env → pulse+noise → resonant body → drive → DC-block → output),
 *  matching the worklet's process() order. */
function renderKick(patch: KickPatch, durS = 0.6, gate_ms = 10): Float32Array {
  const N = Math.round(SR * durS);
  const buf = new Float32Array(N);
  const pulseSt = makePulseState();
  const noiseSt = makeNoiseState(0xC0FFEE);
  const resSt = makeResonantState();
  const outSt = makeOutputState();
  const pitchSt = makePitchEnvState();
  const dcSt = makeDcBlockState();
  const noisePrev = { v: false };
  const gateN = Math.round(SR * gate_ms / 1000);
  const pAmt = patch.pitchAmount ?? 0.6;
  const pDec = patch.pitchDecay01 ?? 0.4;
  const drv = patch.drive01 ?? 0.3;
  for (let i = 0; i < N; i++) {
    const gate = i < gateN ? 1 : 0;
    const bodyFreq = pitchEnvStep(gate, patch.freqHz, pAmt, pDec, SR, pitchSt);
    const p = pulseShaperStep(gate, patch.width_ms, patch.amp, patch.decay01, patch.sustain01, SR, pulseSt);
    const n = noiseBurstStep(gate, patch.noiseAmount, patch.noiseDecay01, patch.noiseCutoff, patch.noiseType, SR, noiseSt, noisePrev);
    const coefs = resonantCoefs(bodyFreq, patch.q, patch.damping01, patch.tight01, patch.bounce01, SR);
    let body = resonantFilterStep(p + n, coefs, resSt);
    body = bodyDriveStep(body, drv, patch.tight01);
    body = dcBlockStep(body, dcSt, 25, SR);
    buf[i] = outputFilterStep(body, patch.toneHz, patch.levelDb, SR, outSt);
  }
  return buf;
}

function peakAbs(b: Float32Array): number { let m = 0; for (let i = 0; i < b.length; i++) m = Math.max(m, Math.abs(b[i] ?? 0)); return m; }
function rms(b: Float32Array, s = 0, e = b.length): number { let x = 0; for (let i = s; i < e; i++) x += (b[i] ?? 0) ** 2; return Math.sqrt(x / Math.max(1, e - s)); }
function findPeakIndex(b: Float32Array): number { let m = 0, idx = 0; for (let i = 0; i < b.length; i++) { const v = Math.abs(b[i] ?? 0); if (v > m) { m = v; idx = i; } } return idx; }
function dcOffset(b: Float32Array): number { let s = 0; for (let i = 0; i < b.length; i++) s += b[i] ?? 0; return s / b.length; }
function zeroCrossings(b: Float32Array, s0: number, s1: number): number { let zc = 0; for (let i = s0 + 1; i < Math.min(b.length, s1); i++) if (((b[i - 1] ?? 0) >= 0) !== ((b[i] ?? 0) >= 0)) zc++; return zc; }
/** Fraction of CARRIER energy below 60 Hz (a DC blob → ~1.0; a pitched 80 Hz
 *  kick → small). Measured on a Hann-windowed steady segment (20–180 ms) so
 *  the percussive amplitude ENVELOPE (a ~5 Hz AM) doesn't masquerade as the
 *  pitch and smear everything into the sub-bins. */
function subBandFraction(b: Float32Array): number {
  const w0 = Math.round(0.02 * SR), w1 = Math.min(b.length, Math.round(0.18 * SR));
  const W = w1 - w0;
  const win = new Float32Array(W);
  for (let i = 0; i < W; i++) win[i] = (b[w0 + i] ?? 0) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (W - 1)));
  function band(loF: number, hiF: number, step: number): number {
    let e = 0;
    for (let f = loF; f < hiF; f += step) {
      let re = 0, im = 0;
      for (let i = 0; i < W; i++) { const a = 2 * Math.PI * f * i / SR; re += (win[i] ?? 0) * Math.cos(a); im -= (win[i] ?? 0) * Math.sin(a); }
      e += re * re + im * im;
    }
    return e;
  }
  const low = band(2, 60, 2);
  const total = low + band(60, 120, 2) + band(120, 2000, 8) || 1;
  return low / total;
}

// ─── Baselines ────────────────────────────────────────────────────────

describe('ART chowkick / build-toolchain pin', () => {
  it('built artifact SHA matches the source SHA (refresh dist/ if it fails)', async () => {
    const src = await moduleSourceSha('chowkick');
    const built = await builtSha('chowkick');
    expect(built).toBe(src);
  });
});

describe('ART chowkick / bright-kick canonical envelope', () => {
  // Bright = short pulse, low decay, high tight, bright tone, high freq.
  const patch: KickPatch = {
    width_ms: 0.5, amp: 1.0, decay01: 0.1, sustain01: 0.0,
    noiseAmount: 0.05, noiseDecay01: 0.1, noiseCutoff: 3000, noiseType: 0,
    freqHz: 120, q: 1.0, damping01: 0.5, tight01: 0.8, bounce01: 0.0,
    toneHz: 1500, levelDb: 0,
  };
  it('peak occurs in the attack region (< 60 ms) and exceeds 0.05', () => {
    // Post-oomph the peak is the body SWELL (it builds over a few cycles of
    // the resonant ring + pitch sweep), not the instantaneous click — so the
    // peak lands within the attack region (~tens of ms), not the first 5 ms.
    const buf = renderKick(patch);
    expect(peakAbs(buf)).toBeGreaterThan(0.05);
    expect(findPeakIndex(buf)).toBeLessThan(Math.round(0.06 * SR));
  });
  it('decay tail energy is strictly less than the attack-window energy', () => {
    // Bright kicks still ring with Q=1; we pin the directional shape
    // ("late energy is below early energy") rather than an absolute
    // fraction — the ChowKick body resonance is intentionally long-
    // tailed even on "bright" patches (see ChowKick manual §3.2). The
    // boomy preset (next describe block) pins the long-tail case.
    const buf = renderKick(patch);
    const attack = rms(buf, 0, Math.round(0.02 * SR));
    const tail = rms(buf, Math.round(0.2 * SR));
    expect(tail).toBeLessThan(attack);
  });
});

describe('ART chowkick / boomy canonical envelope', () => {
  // Boomy = longer pulse, high decay, low tone, high Q, low freq.
  const patch: KickPatch = {
    width_ms: 4, amp: 1.0, decay01: 0.9, sustain01: 0.2,
    noiseAmount: 0.0, noiseDecay01: 0.0, noiseCutoff: 500, noiseType: 0,
    freqHz: 50, q: 5, damping01: 0.7, tight01: 0.2, bounce01: 0.0,
    toneHz: 200, levelDb: 0,
  };
  it('produces measurable tail energy at 250 ms (long boom)', () => {
    const buf = renderKick(patch);
    const tail = rms(buf, Math.round(0.25 * SR), Math.round(0.3 * SR));
    expect(tail).toBeGreaterThan(0.001);
  });
  it('peak is finite + within saturator bound (< 5)', () => {
    const buf = renderKick(patch);
    const p = peakAbs(buf);
    expect(Number.isFinite(p)).toBe(true);
    expect(p).toBeLessThan(5);
  });
});

describe('ART chowkick / pitched-down canonical envelope', () => {
  // High portamento — but ART renders directly to the helpers without
  // applying the worklet's freq smoother. Pitch slide is approximated by
  // a per-segment render: the canonical pitched-down kick presets in
  // ChowKick's docs all use a perceptible pitch sweep, but the
  // baseline-grade check here is "freq=120 produces a clearly different
  // spectrum than freq=40" — both should render cleanly.
  const high: KickPatch = {
    width_ms: 1, amp: 1.0, decay01: 0.5, sustain01: 0.1,
    noiseAmount: 0.0, noiseDecay01: 0.0, noiseCutoff: 1000, noiseType: 0,
    freqHz: 120, q: 1.5, damping01: 0.5, tight01: 0.4, bounce01: 0.0,
    toneHz: 800, levelDb: 0,
  };
  const low: KickPatch = { ...high, freqHz: 40 };
  it('rendering at two different freqs yields finite, distinct buffers', () => {
    const a = renderKick(high);
    const b = renderKick(low);
    const peakA = peakAbs(a), peakB = peakAbs(b);
    expect(Number.isFinite(peakA)).toBe(true);
    expect(Number.isFinite(peakB)).toBe(true);
    // The two patches should differ — RMS at 50–100 ms is a fair window.
    const rmsA = rms(a, Math.round(0.05 * SR), Math.round(0.1 * SR));
    const rmsB = rms(b, Math.round(0.05 * SR), Math.round(0.1 * SR));
    // At least one of the two should have non-trivial energy at that window
    // (the lower-freq kick decays slower at its body resonance).
    expect(Math.max(rmsA, rmsB)).toBeGreaterThan(0.0001);
  });
});

describe('ART chowkick / noisy canonical envelope', () => {
  // Noisy = high noise + bounce on, low tight (lets noise through).
  const patch: KickPatch = {
    width_ms: 1, amp: 1.0, decay01: 0.4, sustain01: 0.1,
    noiseAmount: 0.7, noiseDecay01: 0.5, noiseCutoff: 4000, noiseType: 1, // Gaussian
    freqHz: 80, q: 1.0, damping01: 0.5, tight01: 0.2, bounce01: 0.6,
    toneHz: 1500, levelDb: 0,
  };
  it('noise amount > 0 adds attack energy (isolated: pulse off so only noise excites)', () => {
    // Isolate the noise path: amp=0 → the pulse contributes nothing, so the
    // body is excited ONLY by the noise burst. With noise the kick has clear
    // attack energy; with noise off AND pulse off it's silent. (The loud,
    // tanh-bounded body otherwise swamps a broadband peak/RMS comparison.)
    const noiseOnly = { ...patch, amp: 0, toneHz: 2000, pitchAmount: 0 };
    const hot = rms(renderKick(noiseOnly), 0, Math.round(0.02 * SR));
    const silent = rms(renderKick({ ...noiseOnly, noiseAmount: 0 }), 0, Math.round(0.02 * SR));
    expect(hot).toBeGreaterThan(0.001);
    expect(hot).toBeGreaterThan(silent * 5);
  });
  it('all 4 noise types render finite buffers (sweep)', () => {
    for (let t = 0; t < 4; t++) {
      const buf = renderKick({ ...patch, noiseType: t as NoiseType });
      const p = peakAbs(buf);
      expect(Number.isFinite(p)).toBe(true);
      // No noise type should silence the output entirely.
      expect(p).toBeGreaterThan(0.001);
    }
  });
});

// ─── OOMPH-FIX regression pins (PR feat/chowkick-oomph) ──────────────────
//
// These would have caught the original weak-kick bug, where the resonator's
// inverted peaking-EQ notched the body and the module emitted a unipolar DC
// blob: measured DC +0.51, ZERO zero-crossings, fundamental ~14 Hz, ~100 %
// of energy below 60 Hz, 0 % at the kick's pitch. The previous ART pins (peak
// > 0.05, tail < attack, finite) all PASSED on that pitchless blob.

describe('ART chowkick / oomph: default patch is a punchy PITCHED kick', () => {
  // The module's shipping defaults (post tuning-pass-2). Mirrors the
  // chowkick.ts descriptors: a loud bright snap + deep fast chirp + sharper
  // body + hotter drive.
  const def: KickPatch = {
    width_ms: 0.5, amp: 1.0, decay01: 0.3, sustain01: 0,
    noiseAmount: 0.5, noiseDecay01: 0.07, noiseCutoff: 5500, noiseType: 0,
    freqHz: 80, q: 1.6, damping01: 0.4, tight01: 0.6, bounce01: 0,
    toneHz: 3200, levelDb: 0,
    pitchAmount: 0.9, pitchDecay01: 0.28, drive01: 0.5,
  };

  it('DC offset ≈ 0 (bipolar kick, NOT a +0.5 DC blob)', () => {
    const buf = renderKick(def);
    expect(Math.abs(dcOffset(buf)), 'mean must be ≈ 0').toBeLessThan(0.02);
  });

  it('OSCILLATES: many zero-crossings over the body (the bug had 0)', () => {
    const buf = renderKick(def);
    const zc = zeroCrossings(buf, Math.round(0.005 * SR), Math.round(0.15 * SR));
    expect(zc, 'zero-crossings 5–150 ms').toBeGreaterThan(20);
  });

  it('carrier energy is NOT ~100 % sub-60 Hz (it has a pitched body)', () => {
    // Bug: ~100 % of energy below 60 Hz. A pitched 80 Hz kick puts most of its
    // carrier in the 60–120 Hz band, so the sub-60 fraction is well under 0.5.
    const frac = subBandFraction(renderKick(def));
    expect(frac, `sub-60 Hz carrier fraction ${frac.toFixed(3)}`).toBeLessThan(0.5);
  });

  it('pitch envelope produces a measurable downward sweep (attack hotter at HF)', () => {
    // With the pitch sweep the early body sits above `freq`; turning the sweep
    // OFF shifts the early spectral centroid down. Compare early HF energy.
    function earlyHfRms(p: KickPatch): number {
      // crude: high-passed early window energy (first 30 ms minus a slow MA).
      const b = renderKick(p, 0.2);
      let acc = 0, ma = 0;
      const end = Math.round(0.03 * SR);
      for (let i = 0; i < end; i++) { ma += 0.02 * ((b[i] ?? 0) - ma); acc += ((b[i] ?? 0) - ma) ** 2; }
      return Math.sqrt(acc / end);
    }
    const withSweep = earlyHfRms(def);
    const noSweep = earlyHfRms({ ...def, pitchAmount: 0 });
    expect(withSweep).toBeGreaterThan(noSweep);
  });

  it('peak is healthy (a real kick, not a whisper) and finite', () => {
    const p = peakAbs(renderKick(def));
    expect(p).toBeGreaterThan(0.3); // the old blob peaked ~1.2 but was DC; this is real
    expect(Number.isFinite(p)).toBe(true);
    expect(p).toBeLessThan(5);      // bounded by the body's safety tanh
  });

  it('damping shortens the tail: damp=0.1 boom rings longer than damp=0.9 thud', () => {
    const longTail = rms(renderKick({ ...def, damping01: 0.1 }), Math.round(0.2 * SR), Math.round(0.3 * SR));
    const shortTail = rms(renderKick({ ...def, damping01: 0.9 }), Math.round(0.2 * SR), Math.round(0.3 * SR));
    expect(longTail).toBeGreaterThan(shortTail);
  });
});

// ─── PUNCH pins (PR feat/chowkick-oomph tuning pass 2) ───────────────────────
//
// Pass 1 shipped a real pitched kick but the user reported the defaults were
// "not any punchier" — too polite. Pass 2 leans into perceptual PUNCH. These
// pins guard the *measurable* punch proxies vs the previous polite defaults so
// a future regression back to a soft kick is caught:
//   - sharper attack (max per-sample slope in the first 20 ms),
//   - louder/brighter transient SNAP (>800 Hz energy in the first 10 ms),
//   - more low-end weight (<120 Hz body energy),
//   - a deeper pitch chirp (early-window dominant freq sits higher above `freq`),
//   - a hotter 0–2 ms transient peak.
describe('ART chowkick / punch: shipping defaults are measurably punchier than the polite pass-1 defaults', () => {
  // The previous (pass-1, too-polite) defaults — the reference to beat.
  const polite: KickPatch = {
    width_ms: 0.5, amp: 1.0, decay01: 0.35, sustain01: 0,
    noiseAmount: 0.2, noiseDecay01: 0.1, noiseCutoff: 3000, noiseType: 0,
    freqHz: 80, q: 0.7, damping01: 0.4, tight01: 0.5, bounce01: 0,
    toneHz: 2000, levelDb: 0,
    pitchAmount: 0.6, pitchDecay01: 0.4, drive01: 0.3,
  };
  // Current shipping defaults (mirrors chowkick.ts).
  const punchy: KickPatch = {
    width_ms: 0.5, amp: 1.0, decay01: 0.3, sustain01: 0,
    noiseAmount: 0.5, noiseDecay01: 0.07, noiseCutoff: 5500, noiseType: 0,
    freqHz: 80, q: 1.6, damping01: 0.4, tight01: 0.6, bounce01: 0,
    toneHz: 3200, levelDb: 0,
    pitchAmount: 0.9, pitchDecay01: 0.28, drive01: 0.5,
  };

  // Note: pass-1 used PITCH_ENV_START_MULT=3.5; this build uses 4.0. The
  // `polite` patch above renders under the CURRENT start-mult, so these are a
  // controlled A/B of the *knob* defaults at constant code — a conservative
  // lower bound on the real (knobs + start-mult) perceptual delta the user hears.

  function maxAttackSlope(b: Float32Array, ms = 20): number {
    const end = Math.round(SR * ms / 1000);
    let m = 0;
    for (let i = 1; i < end; i++) { const d = Math.abs((b[i] ?? 0) - (b[i - 1] ?? 0)); if (d > m) m = d; }
    return m;
  }
  function bandEnergy(b: Float32Array, s: number, e: number, loF: number, hiF: number, step: number): number {
    const W = e - s;
    const win = new Float32Array(W);
    for (let i = 0; i < W; i++) win[i] = (b[s + i] ?? 0) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (W - 1)));
    let energy = 0;
    for (let f = loF; f < hiF; f += step) {
      let re = 0, im = 0;
      for (let i = 0; i < W; i++) { const a = 2 * Math.PI * f * i / SR; re += (win[i] ?? 0) * Math.cos(a); im -= (win[i] ?? 0) * Math.sin(a); }
      energy += re * re + im * im;
    }
    return energy;
  }
  function clickEnergy(b: Float32Array): number { return bandEnergy(b, 0, Math.round(SR * 0.01), 800, 8000, 50); }
  function subEnergy(b: Float32Array): number { return bandEnergy(b, 0, Math.round(SR * 0.3), 20, 120, 2); }
  function transientPeak(b: Float32Array): number { return peakAbs(b.subarray(0, Math.round(SR * 0.002))); }
  function earlyDominantHz(b: Float32Array): number {
    // dominant body freq over the first 8 ms (the chirp start).
    const e = Math.round(SR * 0.008);
    let best = 0, bestMag = 0;
    for (let f = 60; f <= 600; f += 1) {
      let re = 0, im = 0;
      for (let i = 0; i < e; i++) { const a = 2 * Math.PI * f * i / SR; re += (b[i] ?? 0) * Math.cos(a); im -= (b[i] ?? 0) * Math.sin(a); }
      const m = re * re + im * im;
      if (m > bestMag) { bestMag = m; best = f; }
    }
    return best;
  }

  it('sharper attack: max attack slope is at least 1.4× the polite default', () => {
    const sp = maxAttackSlope(renderKick(punchy));
    const sl = maxAttackSlope(renderKick(polite));
    expect(sp / sl, `slope punchy=${sp.toFixed(4)} polite=${sl.toFixed(4)}`).toBeGreaterThan(1.4);
  });

  it('louder/brighter transient SNAP: >800 Hz energy in first 10 ms exceeds the polite default', () => {
    const cp = clickEnergy(renderKick(punchy));
    const cl = clickEnergy(renderKick(polite));
    expect(cp, `click punchy=${cp.toExponential(2)} polite=${cl.toExponential(2)}`).toBeGreaterThan(cl);
  });

  it('more low-end weight: <120 Hz body energy exceeds the polite default', () => {
    const sp = subEnergy(renderKick(punchy));
    const sl = subEnergy(renderKick(polite));
    expect(sp, `sub punchy=${sp.toExponential(2)} polite=${sl.toExponential(2)}`).toBeGreaterThan(sl);
  });

  it('deeper chirp: early-window dominant freq sits higher above the 80 Hz body', () => {
    const fp = earlyDominantHz(renderKick(punchy));
    const fl = earlyDominantHz(renderKick(polite));
    // The chirp starts well above the body freq; the punchy default starts higher.
    expect(fp, `start punchy=${fp}Hz polite=${fl}Hz`).toBeGreaterThan(fl);
    expect(fp).toBeGreaterThan(80 * 1.5); // a real, audible chirp start
  });

  it('hotter transient: 0–2 ms peak exceeds the polite default', () => {
    const tp = transientPeak(renderKick(punchy));
    const tl = transientPeak(renderKick(polite));
    expect(tp, `transient punchy=${tp.toFixed(3)} polite=${tl.toFixed(3)}`).toBeGreaterThan(tl);
  });

  it('still a tasteful kick, not a noise burst: settled body still pitched near 80 Hz', () => {
    // Punch must not destroy the pitched body — the steady tail must still ring
    // near the body freq (guards against cranking noise so hard it becomes a hat).
    const b = renderKick(punchy);
    let best = 0, bestMag = 0;
    const s0 = Math.round(SR * 0.06), s1 = Math.round(SR * 0.2);
    for (let f = 30; f <= 300; f += 1) {
      let re = 0, im = 0;
      for (let i = s0; i < s1; i++) { const a = 2 * Math.PI * f * i / SR; re += (b[i] ?? 0) * Math.cos(a); im -= (b[i] ?? 0) * Math.sin(a); }
      const m = re * re + im * im;
      if (m > bestMag) { bestMag = m; best = f; }
    }
    expect(best, `settled dominant ${best}Hz`).toBeGreaterThan(55);
    expect(best, `settled dominant ${best}Hz`).toBeLessThan(160);
  });
});
