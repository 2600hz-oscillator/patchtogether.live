// art/scenarios/macrooscillator/spectral-character.test.ts
//
// Audio Regression Test scenarios for MACROOSCILLATOR. The unit tests in
// packages/web/src/lib/audio/modules/macrooscillator.test.ts pin shape
// and basic non-silence + pitch tracking; this file adds longer-render
// scenarios that exercise the engines under typical patch conditions
// and assert spectral content that a player would actually notice.
//
// Each scenario renders a known number of samples via the pure-math
// mirror (macrooscillatorMath.render — same code path the worklet uses)
// and inspects the resulting buffer via Goertzel single-bin DFTs.
//
// Why ART (not unit): these tests render multi-second buffers and exercise
// the algorithm-level invariants ("a Plaits VA at full timbre produces
// HF energy", "WAVESHAPE drive curves are perceptually monotonic in 3H
// content") rather than module-def shape. Same separation pattern as
// art/scenarios/shimmershine/.

import { describe, expect, it } from 'vitest';
import { macrooscillatorMath } from '../../../packages/web/src/lib/audio/modules/macrooscillator';

const SR = 48000;

/** Goertzel-style single-bin magnitude. Normalised by N so values are
 *  comparable across different buffer lengths. */
function powerAt(buf: Float32Array, freq: number, sr: number): number {
  const w = (2 * Math.PI * freq) / sr;
  let re = 0;
  let im = 0;
  for (let i = 0; i < buf.length; i++) {
    re += buf[i]! * Math.cos(w * i);
    im += buf[i]! * Math.sin(w * i);
  }
  return Math.sqrt(re * re + im * im) / buf.length;
}

describe('ART macrooscillator / VA model spectral character', () => {
  it('saw morph (morph=0) carries strong 2nd + 3rd harmonics (Plaits saw signature)', () => {
    // Plaits VA at morph=0 is a sawtooth — band-rich, all integer harmonics.
    // 440 Hz fundamental → expect 880, 1320, 1760, etc. above the noise
    // floor.
    const { main } = macrooscillatorMath.render(SR, SR, 0.75, {
      model: 0, note: 0, harmonics: 0, timbre: 0, morph: 0, level: 1,
    });
    const tail = main.slice(SR / 2);
    const pFund = powerAt(tail, 440, SR);
    const pH2 = powerAt(tail, 880, SR);
    const pH3 = powerAt(tail, 1320, SR);
    // The first three harmonics of a band-limited saw at 440Hz should each
    // be above the off-harmonic noise floor (sampled at 1234 Hz).
    const pNoise = powerAt(tail, 1234, SR);
    expect(pFund, `fund ${pFund} > noise ${pNoise}`).toBeGreaterThan(pNoise * 5);
    expect(pH2, `H2 ${pH2} > noise ${pNoise}`).toBeGreaterThan(pNoise * 2);
    expect(pH3, `H3 ${pH3} > noise ${pNoise}`).toBeGreaterThan(pNoise * 2);
  });

  it('triangle morph (morph=1) has weaker odd-harmonic content than square (morph=0.5)', () => {
    // Triangle's 3rd harmonic is 1/9 the fundamental amplitude (and falls
    // as 1/k² for odd k). Square's 3rd harmonic is 1/3 (falls as 1/k for
    // odd k). So at the same fundamental energy, square's 3H ≫ triangle's
    // 3H — a perceptual "brighter" timbre.
    const triBuf = macrooscillatorMath.render(SR, SR, 0.75, {
      model: 0, note: 0, harmonics: 0, timbre: 0, morph: 1, level: 1,
    }).main.slice(SR / 2);
    const sqrBuf = macrooscillatorMath.render(SR, SR, 0.75, {
      model: 0, note: 0, harmonics: 0, timbre: 0, morph: 0.5, level: 1,
    }).main.slice(SR / 2);
    const triRatio = powerAt(triBuf, 1320, SR) / Math.max(1e-12, powerAt(triBuf, 440, SR));
    const sqrRatio = powerAt(sqrBuf, 1320, SR) / Math.max(1e-12, powerAt(sqrBuf, 440, SR));
    expect(
      sqrRatio,
      `square 3H/fund ratio ${sqrRatio.toFixed(3)} should exceed triangle ${triRatio.toFixed(3)}`,
    ).toBeGreaterThan(triRatio * 2);
  });

  it('TIMBRE-wavefolder adds 2nd-harmonic content (asymmetric folding breaks odd-symmetry)', () => {
    // The morphAB output is mostly odd-symmetric (saw/square/triangle).
    // Push it through the wavefolder (TIMBRE > 0) and the fold-overs
    // break the symmetry → strong even harmonics appear. Square at
    // morph=0.5 + timbre=1 should grow the 2H bin significantly vs the
    // raw morph=0.5 signal at timbre=0.
    const noFold = macrooscillatorMath.render(SR, SR, 0.75, {
      model: 0, note: 0, harmonics: 0, timbre: 0, morph: 0.5, level: 1,
    }).main.slice(SR / 2);
    const fullFold = macrooscillatorMath.render(SR, SR, 0.75, {
      model: 0, note: 0, harmonics: 0, timbre: 1, morph: 0.5, level: 1,
    }).main.slice(SR / 2);
    // 2nd harmonic of 440Hz = 880Hz. Even-harmonic content from
    // asymmetric distortion.
    const h2NoFold = powerAt(noFold, 880, SR);
    const h2FullFold = powerAt(fullFold, 880, SR);
    expect(
      h2FullFold,
      `H2 timbre=1 ${h2FullFold} > H2 timbre=0 ${h2NoFold}`,
    ).toBeGreaterThan(h2NoFold * 2);
  });

  it('finite + bounded output at extreme params (no NaN / Infs / runaway)', () => {
    // Worst case: max harmonics (max detune), max timbre (max fold), max
    // level. VA + WAVESHAPE both. Render 1s; assert every sample is finite
    // and the peak stays below 1.5 (Level caps at 1.0 but two-engine sum
    // never happens — the engines are mutually exclusive — so the only
    // way to exceed 1 is the wavefolder amplifying beyond what its
    // normaliser pulls back. 1.5 catches a regression while leaving room
    // for the wavefolder's natural ringing peaks.)
    for (const model of [0, 1]) {
      const { main, aux } = macrooscillatorMath.render(SR, SR, 0.75, {
        model, note: 12, harmonics: 1, timbre: 1, morph: 1, level: 1,
      });
      let mainPeak = 0;
      let auxPeak = 0;
      for (let i = 0; i < main.length; i++) {
        expect(Number.isFinite(main[i]!), `model=${model} main[${i}] finite`).toBe(true);
        expect(Number.isFinite(aux[i]!), `model=${model} aux[${i}] finite`).toBe(true);
        const a = Math.abs(main[i]!);
        const b = Math.abs(aux[i]!);
        if (a > mainPeak) mainPeak = a;
        if (b > auxPeak) auxPeak = b;
      }
      expect(mainPeak, `model=${model} main peak ${mainPeak}`).toBeLessThan(1.5);
      expect(auxPeak, `model=${model} aux peak ${auxPeak}`).toBeLessThan(1.5);
    }
  });
});

describe('ART macrooscillator / WAVESHAPE model spectral character', () => {
  it('clean-sine baseline (morph=1 / timbre=0 / harm=0) is dominated by the fundamental', () => {
    // tanh(sin(x)) with drive=1 (timbre=0) is ≈ sin(x) — near-pure sine.
    // The fundamental should dominate the 3rd harmonic by a wide margin.
    const tail = macrooscillatorMath.render(SR, SR, 0.75, {
      model: 1, note: 0, harmonics: 0, timbre: 0, morph: 1, level: 1,
    }).main.slice(SR / 2);
    const pFund = powerAt(tail, 440, SR);
    const pH3 = powerAt(tail, 1320, SR);
    // tanh(sin(x)) at drive=1 isn't exactly pure sine (tiny 3H from tanh's
    // mild S-shape), so the ratio settles around 12-15× in practice.
    // 10× is a comfortable lower bound that catches a "drive accidentally
    // engaged at timbre=0" regression without flapping.
    expect(pFund, `clean-sine fund ${pFund}, H3 ${pH3}`).toBeGreaterThan(pH3 * 10);
  });

  it('HARMONICS adds sub-octave energy: 220Hz bin grows with harmonics knob', () => {
    // WAVESHAPE's HARMONICS macro mixes in a sub-octave sine (one octave
    // below the fundamental). At 440Hz fundamental, sub = 220Hz.
    const noSub = macrooscillatorMath.render(SR, SR, 0.75, {
      model: 1, note: 0, harmonics: 0.0, timbre: 0, morph: 1, level: 1,
    }).main.slice(SR / 2);
    const fullSub = macrooscillatorMath.render(SR, SR, 0.75, {
      model: 1, note: 0, harmonics: 1.0, timbre: 0, morph: 1, level: 1,
    }).main.slice(SR / 2);
    const noSub220 = powerAt(noSub, 220, SR);
    const fullSub220 = powerAt(fullSub, 220, SR);
    expect(
      fullSub220,
      `220Hz (sub) harmonics=1 ${fullSub220} vs harmonics=0 ${noSub220}`,
    ).toBeGreaterThan(noSub220 * 10);
  });
});

describe('ART macrooscillator / V/oct tracking', () => {
  // CV-range-uniformity / V/oct convention is 1 unit = 1 octave from C4
  // (261.6256 Hz). MACROOSCILLATOR's pitch input must follow this exactly
  // so it composes with the rest of the modular (sequencer step CV, score
  // pitch CV, etc.) without per-module fudge factors.
  const testCases: { pitchV: number; note: number; expected: number; name: string }[] = [
    { pitchV: 0, note: 0, expected: 261.6256, name: 'pitch=0, note=0 → C4' },
    { pitchV: 1, note: 0, expected: 523.2511, name: 'pitch=+1 → C5' },
    { pitchV: -1, note: 0, expected: 130.8128, name: 'pitch=-1 → C3' },
    { pitchV: 0, note: 12, expected: 523.2511, name: 'note=+12 → C5 (same as pitch=+1)' },
    { pitchV: 0.75, note: 0, expected: 440.0, name: 'pitch=0.75 → A4 (440Hz tuning ref)' },
  ];

  for (const c of testCases) {
    it(`VA V/oct: ${c.name}`, () => {
      const { main } = macrooscillatorMath.render(SR, SR, c.pitchV, {
        model: 0, note: c.note, harmonics: 0, timbre: 0, morph: 0, level: 1,
      });
      const tail = main.slice(SR / 2);
      const pExp = powerAt(tail, c.expected, SR);
      // Compare against a ±5% off-bin to verify the energy peak sits at
      // the requested freq (not 100 Hz off).
      const pLow = powerAt(tail, c.expected * 0.93, SR);
      const pHigh = powerAt(tail, c.expected * 1.07, SR);
      expect(
        pExp,
        `expected ${c.expected.toFixed(2)}Hz bin > ±5% off-bins (${pExp.toFixed(4)} vs ${pLow.toFixed(4)} / ${pHigh.toFixed(4)})`,
      ).toBeGreaterThan(pLow * 2);
      expect(pExp).toBeGreaterThan(pHigh * 2);
    });
  }
});
