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

describe('ART macrooscillator / FM 2-OP model spectral character', () => {
  it('clean carrier at timbre=0 → fundamental-dominated sine spectrum', () => {
    // FM with modulation index 0 is just the carrier sine — fundamental
    // should be far above any harmonic.
    const tail = macrooscillatorMath.render(SR, SR, 0.75, {
      model: 2, note: 0, harmonics: 0, timbre: 0, morph: 0, level: 1,
    }).main.slice(SR / 2);
    const pFund = powerAt(tail, 440, SR);
    const pH2 = powerAt(tail, 880, SR);
    const pH3 = powerAt(tail, 1320, SR);
    expect(pFund).toBeGreaterThan(pH2 * 50);
    expect(pFund).toBeGreaterThan(pH3 * 50);
  });

  it('TIMBRE increases the number of audible sidebands (FM richness)', () => {
    // Chowning: FM produces (modulation index) ~= number of audible sidebands.
    // At index=0 we have 1 (the carrier). At index=8 we have ~8+ sidebands.
    // Test by counting bins above a threshold relative to the strongest bin.
    const dirty = macrooscillatorMath.render(SR, SR, 0.75, {
      model: 2, note: 0, harmonics: 0, timbre: 1, morph: 0, level: 1,
    }).main.slice(SR / 2);
    const peak = Math.max(
      powerAt(dirty, 440, SR),
      powerAt(dirty, 880, SR),
    );
    const threshold = peak * 0.05;
    let aboveCount = 0;
    for (let h = 1; h <= 12; h++) {
      if (powerAt(dirty, 440 * h, SR) > threshold) aboveCount++;
    }
    // Expect at least 4 harmonics above the 5%-of-peak threshold.
    expect(aboveCount, `audible harmonics above 5% of peak: ${aboveCount}`).toBeGreaterThanOrEqual(4);
  });

  it('feedback (MORPH) reshapes the spectrum at low TIMBRE (extends sideband structure)', () => {
    // At low modulation index a clean carrier has very little harmonic
    // content; adding self-feedback pushes the carrier toward a saw-like
    // shape and grows the upper-harmonic band. Compare HF (1320Hz) energy
    // between feedback=0 and feedback=1 at low timbre, where feedback is
    // the dominant timbral influence rather than the modulator.
    const noFbk = macrooscillatorMath.render(SR, SR, 0.75, {
      model: 2, note: 0, harmonics: 0, timbre: 0.05, morph: 0, level: 1,
    }).main.slice(SR / 2);
    const fullFbk = macrooscillatorMath.render(SR, SR, 0.75, {
      model: 2, note: 0, harmonics: 0, timbre: 0.05, morph: 1, level: 1,
    }).main.slice(SR / 2);
    // Sum harmonic energy from H2..H5 — feedback should grow it significantly.
    let noBand = 0;
    let fbkBand = 0;
    for (let h = 2; h <= 5; h++) {
      noBand += powerAt(noFbk, 440 * h, SR);
      fbkBand += powerAt(fullFbk, 440 * h, SR);
    }
    expect(
      fbkBand,
      `feedback=1 H2..H5 band ${fbkBand} > feedback=0 ${noBand}`,
    ).toBeGreaterThan(noBand * 2);
  });
});

describe('ART macrooscillator / FM 6-OP model spectral character', () => {
  it('clean stack at timbre=0 has dominant fundamental (carrier sees no FM)', () => {
    // At modulation index = 0 all modulators are silent → carrier is pure
    // sine. Long MORPH so the envelope doesn't decay over the test window.
    const tail = macrooscillatorMath.render(SR, SR, 0.75, {
      model: 3, note: 0, harmonics: 0.5, timbre: 0, morph: 1, level: 1,
    }).main.slice(0, SR / 4);
    const pFund = powerAt(tail, 440, SR);
    const pH3 = powerAt(tail, 1320, SR);
    expect(pFund, `fund ${pFund} should dominate H3 ${pH3}`).toBeGreaterThan(pH3 * 10);
  });

  it('TIMBRE produces wide-band content (FM stack with multiple modulators)', () => {
    // 6-op FM with high mod index across multiple operators produces
    // very dense spectra. Check that HF content exists.
    const buf = macrooscillatorMath.render(SR / 2, SR, 0.75, {
      model: 3, note: 0, harmonics: 0.7, timbre: 1, morph: 1, level: 1,
    }).main.slice(0, SR / 8);
    // Energy at 2kHz, 4kHz should both be non-trivial.
    const p2k = powerAt(buf, 2000, SR);
    const p4k = powerAt(buf, 4000, SR);
    // Compare with a "clean" reference (modIndex=0).
    const cleanBuf = macrooscillatorMath.render(SR / 2, SR, 0.75, {
      model: 3, note: 0, harmonics: 0.7, timbre: 0, morph: 1, level: 1,
    }).main.slice(0, SR / 8);
    const clean2k = powerAt(cleanBuf, 2000, SR);
    const clean4k = powerAt(cleanBuf, 4000, SR);
    expect(p2k, `dirty 2kHz ${p2k} vs clean ${clean2k}`).toBeGreaterThan(clean2k * 3);
    expect(p4k, `dirty 4kHz ${p4k} vs clean ${clean4k}`).toBeGreaterThan(clean4k * 3);
  });

  it('MORPH controls envelope length: percussive vs sustain', () => {
    // morph=0 → 50ms decay. Energy in samples 0.2s → 0.4s should be very low.
    // morph=1 → 5s decay. Same window should still ring.
    const shortDecay = macrooscillatorMath.render(SR / 2, SR, 0.75, {
      model: 3, note: 0, harmonics: 0.5, timbre: 0.5, morph: 0, level: 1,
    }).main;
    const longDecay = macrooscillatorMath.render(SR / 2, SR, 0.75, {
      model: 3, note: 0, harmonics: 0.5, timbre: 0.5, morph: 1, level: 1,
    }).main;
    // RMS over 0.2s → 0.5s.
    const start = Math.floor(SR * 0.2);
    const end = Math.floor(SR * 0.5);
    let shortRms = 0;
    let longRms = 0;
    for (let i = start; i < end; i++) {
      shortRms += shortDecay[i]! * shortDecay[i]!;
      longRms += longDecay[i]! * longDecay[i]!;
    }
    shortRms = Math.sqrt(shortRms / (end - start));
    longRms = Math.sqrt(longRms / (end - start));
    expect(longRms, `long-tail RMS ${longRms} > short-tail RMS ${shortRms}`).toBeGreaterThan(shortRms * 5);
  });

  it('finite + bounded output at extreme FM params', () => {
    for (const model of [2, 3]) {
      const { main, aux } = macrooscillatorMath.render(SR, SR, 0.75, {
        model, note: 0, harmonics: 1, timbre: 1, morph: 1, level: 1,
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

describe('ART macrooscillator / CHORD model spectral character', () => {
  it('major triad at harmonics≈0.4 produces a 3-note chord: root + maj3 + perfect5', () => {
    // floor(0.4 * 8) = 3 → [0, 4, 7, 12]. Root 440 → 554.37 (maj3), 659.26 (5th), 880 (8va).
    const tail = macrooscillatorMath.render(SR, SR, 0.75, {
      model: 4, note: 0, harmonics: 0.4, timbre: 0, morph: 1, level: 1,
    }).main.slice(SR / 2);
    const pRoot = powerAt(tail, 440, SR);
    const pMaj3 = powerAt(tail, 554.37, SR);
    const pPerf5 = powerAt(tail, 659.26, SR);
    const pOctave = powerAt(tail, 880, SR);
    const pOffBin = powerAt(tail, 700, SR);
    // All four chord tones should be well above the off-bin noise floor.
    expect(pRoot).toBeGreaterThan(pOffBin * 3);
    expect(pMaj3).toBeGreaterThan(pOffBin * 3);
    expect(pPerf5).toBeGreaterThan(pOffBin * 3);
    expect(pOctave).toBeGreaterThan(pOffBin * 3);
  });

  it('minor triad (harmonics≈0.3) carries a minor 3rd instead of a major 3rd', () => {
    // floor(0.3 * 8) = 2 → [0, 3, 7, 12]. Minor 3rd = 440 * 2^(3/12) ≈ 523.25.
    const tail = macrooscillatorMath.render(SR, SR, 0.75, {
      model: 4, note: 0, harmonics: 0.3, timbre: 0, morph: 1, level: 1,
    }).main.slice(SR / 2);
    const pMaj3 = powerAt(tail, 554.37, SR); // major 3rd bin
    const pMin3 = powerAt(tail, 523.25, SR); // minor 3rd bin
    expect(
      pMin3,
      `minor triad: min3 ${pMin3} should exceed maj3 ${pMaj3}`,
    ).toBeGreaterThan(pMaj3 * 5);
  });

  it('TIMBRE crossfades voice waveform from sine to saw (3rd harmonic of root grows with timbre)', () => {
    // Same chord shape, sine voices vs saw voices. Saw voices have rich
    // harmonic content; sine voices have almost none above the fundamental.
    // The 3rd harmonic of the root (1320Hz at 440) should grow as timbre
    // moves sine→saw.
    const sine = macrooscillatorMath.render(SR, SR, 0.75, {
      model: 4, note: 0, harmonics: 0.4, timbre: 0, morph: 1, level: 1,
    }).main.slice(SR / 2);
    const saw = macrooscillatorMath.render(SR, SR, 0.75, {
      model: 4, note: 0, harmonics: 0.4, timbre: 1, morph: 1, level: 1,
    }).main.slice(SR / 2);
    const sine1320 = powerAt(sine, 1320, SR);
    const saw1320 = powerAt(saw, 1320, SR);
    expect(saw1320, `saw 1320 ${saw1320} > sine 1320 ${sine1320}`).toBeGreaterThan(sine1320 * 5);
  });
});

describe('ART macrooscillator / ADDITIVE model spectral character', () => {
  it('many integer partials are audible (additive synthesis signature)', () => {
    // At inharm=0, timbre=0 (bright tilt), morph=0.5 (all partials), the
    // spectrum is roughly a band-limited saw. Count how many integer harmonic
    // bins clear a fixed threshold.
    const tail = macrooscillatorMath.render(SR, SR, 0.75, {
      model: 5, note: 0, harmonics: 0, timbre: 0, morph: 0.5, level: 1,
    }).main.slice(SR / 2);
    const fund = powerAt(tail, 440, SR);
    const threshold = fund * 0.05;
    let audibleCount = 0;
    for (let h = 1; h <= 12; h++) {
      if (powerAt(tail, 440 * h, SR) > threshold) audibleCount++;
    }
    expect(audibleCount, `audible partials at threshold: ${audibleCount}`).toBeGreaterThanOrEqual(6);
  });

  it('inharmonicity (HARMONICS=1) shifts partials away from integer multiples', () => {
    // At harmonics=1, partial n lands at n * f * (1 + 0.1 * (n-1)).
    // For n=4 at 440: 4 * 440 * 1.3 = 2288 Hz instead of 1760 Hz.
    // → 2288 should have non-trivial energy, 1760 (the would-be integer
    // partial) should be relatively weak.
    const stretched = macrooscillatorMath.render(SR, SR, 0.75, {
      model: 5, note: 0, harmonics: 1, timbre: 0, morph: 0.5, level: 1,
    }).main.slice(SR / 2);
    const p2288 = powerAt(stretched, 2288, SR);
    const p1760 = powerAt(stretched, 1760, SR);
    expect(
      p2288,
      `stretched partial at 2288 ${p2288} > integer-position 1760 ${p1760}`,
    ).toBeGreaterThan(p1760);
  });

  it('TIMBRE shifts spectral centroid: bright → warm reduces HF energy', () => {
    // Sum HF energy above 2 kHz at timbre=0 and timbre=1. Bright should
    // dominate.
    const bright = macrooscillatorMath.render(SR, SR, 0.75, {
      model: 5, note: 0, harmonics: 0, timbre: 0, morph: 0.5, level: 1,
    }).main.slice(SR / 2);
    const warm = macrooscillatorMath.render(SR, SR, 0.75, {
      model: 5, note: 0, harmonics: 0, timbre: 1, morph: 0.5, level: 1,
    }).main.slice(SR / 2);
    let brightHF = 0;
    let warmHF = 0;
    for (let h = 5; h <= 10; h++) {
      brightHF += powerAt(bright, 440 * h, SR);
      warmHF += powerAt(warm, 440 * h, SR);
    }
    expect(brightHF, `bright HF ${brightHF} > warm HF ${warmHF}`).toBeGreaterThan(warmHF * 5);
  });

  it('CHORD + ADDITIVE finite + bounded at extreme params', () => {
    for (const model of [4, 5]) {
      const { main, aux } = macrooscillatorMath.render(SR, SR, 0.75, {
        model, note: 0, harmonics: 1, timbre: 1, morph: 1, level: 1,
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

describe('ART macrooscillator / STRING model spectral character', () => {
  it('Karplus-Strong loop carries strong fundamental (string is pitched)', () => {
    // 200 ms into the burst, the delay loop has settled into a periodic
    // ring at ~freq Hz. Use a generous window to see the lock.
    const buf = macrooscillatorMath.render(SR, SR, 0.75, {
      model: 6, note: 0, harmonics: 0, timbre: 0.5, morph: 0.9, level: 1,
    }).main;
    const window = buf.slice(Math.floor(0.1 * SR), Math.floor(0.4 * SR));
    const pFund = powerAt(window, 440, SR);
    const pH2 = powerAt(window, 880, SR);
    const pOff = powerAt(window, 200, SR);
    expect(pFund, `fund ${pFund} > off-bin ${pOff}`).toBeGreaterThan(pOff * 2);
    // Karplus-Strong also generates significant H2 + H3 content.
    expect(pH2).toBeGreaterThan(pOff);
  });

  it('TIMBRE controls excitation brightness: brighter pluck has more initial HF energy', () => {
    // Compare the first 20 ms of the burst — bright excitation = high
    // HF energy, dull excitation = mostly LF.
    const dull = macrooscillatorMath.render(Math.floor(0.05 * SR), SR, 0.75, {
      model: 6, note: 0, harmonics: 0, timbre: 0, morph: 0.8, level: 1,
    }).main;
    const bright = macrooscillatorMath.render(Math.floor(0.05 * SR), SR, 0.75, {
      model: 6, note: 0, harmonics: 0, timbre: 1, morph: 0.8, level: 1,
    }).main;
    // HF energy band 3-6 kHz (sum 3 bins).
    let dullHF = 0, brightHF = 0;
    for (const f of [3000, 4500, 6000]) {
      dullHF += powerAt(dull, f, SR);
      brightHF += powerAt(bright, f, SR);
    }
    expect(brightHF, `bright HF ${brightHF} > dull HF ${dullHF}`).toBeGreaterThan(dullHF * 2);
  });

  it('STRING + MODAL finite + bounded at extreme params', () => {
    for (const model of [6, 7]) {
      const { main, aux } = macrooscillatorMath.render(SR, SR, 0.75, {
        model, note: 0, harmonics: 1, timbre: 1, morph: 1, level: 1,
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
      expect(mainPeak, `model=${model} main peak ${mainPeak}`).toBeLessThan(2.0);
      expect(auxPeak, `model=${model} aux peak ${auxPeak}`).toBeLessThan(2.0);
    }
  });
});

describe('ART macrooscillator / MODAL model spectral character', () => {
  it('struck-bar preset: multiple inharmonic partials audible at 1×, 2.76×, 5.41× fund', () => {
    // Render 2 seconds at mid-Q to let multiple impulses excite the
    // resonators and settle into a steady ring.
    const tail = macrooscillatorMath.render(SR * 2, SR, 0.75, {
      model: 7, note: 0, harmonics: 0, timbre: 0.6, morph: 0, level: 1,
    }).main.slice(SR);
    const pFund = powerAt(tail, 440, SR);
    const pH276 = powerAt(tail, 440 * 2.76, SR);
    const pH541 = powerAt(tail, 440 * 5.41, SR);
    const pOff = powerAt(tail, 700, SR);
    expect(pFund, `fund ${pFund} > off ${pOff}`).toBeGreaterThan(pOff * 2);
    expect(pH276, `2.76x ${pH276} > off ${pOff}`).toBeGreaterThan(pOff * 1.5);
    expect(pH541, `5.41x ${pH541} > off ${pOff}`).toBeGreaterThan(pOff * 0.5); // upper partials are weaker
  });

  it('MORPH biases mode amplitudes: high MORPH emphasises upper modes', () => {
    // At morph=0 the base amps [1.0, 0.6, 0.4, 0.3, 0.2, 0.15] dominate
    // → fundamental loudest. At morph=1 the linear ramp i/N dominates
    // → 5th and 6th modes ascend, fundamental falls back.
    const lowMorph = macrooscillatorMath.render(SR * 2, SR, 0.75, {
      model: 7, note: 0, harmonics: 0, timbre: 0.6, morph: 0, level: 1,
    }).main.slice(SR);
    const highMorph = macrooscillatorMath.render(SR * 2, SR, 0.75, {
      model: 7, note: 0, harmonics: 0, timbre: 0.6, morph: 1, level: 1,
    }).main.slice(SR);
    // Highest mode is 18.64×440 = 8200 Hz. Compare its bin between the two.
    const lowMorph8200 = powerAt(lowMorph, 8200, SR);
    const highMorph8200 = powerAt(highMorph, 8200, SR);
    expect(
      highMorph8200,
      `morph=1 8.2kHz mode ${highMorph8200} > morph=0 ${lowMorph8200}`,
    ).toBeGreaterThan(lowMorph8200);
  });
});

describe('ART macrooscillator / KICK drum spectral character', () => {
  it('kick has LF-dominated spectrum (energy below 200Hz dominates HF)', () => {
    // Kick at note=-24 (~65 Hz) with no sweep → mostly LF energy.
    const { main } = macrooscillatorMath.render(SR, SR, 0, {
      model: 8, note: -24, harmonics: 0, timbre: 0.2, morph: 0.5, level: 1,
    });
    const window = main.slice(0, Math.floor(0.1 * SR));
    let lfSum = 0;
    let hfSum = 0;
    for (const f of [60, 90, 120, 180]) lfSum += powerAt(window, f, SR);
    for (const f of [2000, 3000, 4000, 5000]) hfSum += powerAt(window, f, SR);
    expect(lfSum, `kick LF ${lfSum} > HF ${hfSum}`).toBeGreaterThan(hfSum * 3);
  });

  it('HARMONICS controls pitch sweep: high HARMONICS adds initial chirp HF energy', () => {
    // With harmonics=1 the kick starts 4 octaves higher and sweeps down,
    // so the first 5ms should have significant HF content.
    const noSweep = macrooscillatorMath.render(Math.floor(0.01 * SR), SR, 0, {
      model: 8, note: -24, harmonics: 0, timbre: 0, morph: 0.3, level: 1,
    }).main;
    const fullSweep = macrooscillatorMath.render(Math.floor(0.01 * SR), SR, 0, {
      model: 8, note: -24, harmonics: 1, timbre: 0, morph: 0.3, level: 1,
    }).main;
    const noSweepHF = powerAt(noSweep, 800, SR);
    const fullSweepHF = powerAt(fullSweep, 800, SR);
    expect(
      fullSweepHF,
      `chirp HF ${fullSweepHF} > no-sweep HF ${noSweepHF}`,
    ).toBeGreaterThan(noSweepHF * 3);
  });
});

describe('ART macrooscillator / SNARE drum spectral character', () => {
  it('snare with HARMONICS=1 is noise-dominated (energy spread across HF)', () => {
    const { main } = macrooscillatorMath.render(SR / 4, SR, 0, {
      model: 9, note: -12, harmonics: 1, timbre: 0.8, morph: 0.3, level: 1,
    });
    // Variance of energy across many off-harmonic bins should be small —
    // noise spreads roughly evenly. Use sum of HF bins as a proxy for
    // "broadband energy present".
    let hfBandSum = 0;
    for (const f of [1500, 2500, 3500, 5500, 7000]) {
      hfBandSum += powerAt(main, f, SR);
    }
    expect(hfBandSum, `snare HF band sum ${hfBandSum}`).toBeGreaterThan(0.01);
  });

  it('snare with HARMONICS=0 carries the body fundamental at the note pitch', () => {
    // note=-12 → 130.8 Hz body.
    const { main } = macrooscillatorMath.render(SR / 4, SR, 0, {
      model: 9, note: -12, harmonics: 0, timbre: 0.5, morph: 0.3, level: 1,
    });
    const window = main.slice(0, Math.floor(0.05 * SR));
    const pFund = powerAt(window, 130.8, SR);
    const pOff = powerAt(window, 700, SR);
    expect(pFund, `body fund ${pFund} > off ${pOff}`).toBeGreaterThan(pOff);
  });
});

describe('ART macrooscillator / HIHAT drum spectral character', () => {
  it('open hihat (MORPH=1) decays much slower than closed hihat (MORPH=0)', () => {
    const closed = macrooscillatorMath.render(SR / 2, SR, 0, {
      model: 10, note: 24, harmonics: 0.5, timbre: 0.5, morph: 0, level: 1,
    }).main;
    const open = macrooscillatorMath.render(SR / 2, SR, 0, {
      model: 10, note: 24, harmonics: 0.5, timbre: 0.5, morph: 1, level: 1,
    }).main;
    let closedTail = 0;
    let openTail = 0;
    const start = Math.floor(0.2 * SR);
    const end = Math.floor(0.4 * SR);
    for (let i = start; i < end; i++) {
      closedTail += closed[i]! * closed[i]!;
      openTail += open[i]! * open[i]!;
    }
    closedTail = Math.sqrt(closedTail / (end - start));
    openTail = Math.sqrt(openTail / (end - start));
    expect(openTail, `open tail ${openTail} > closed tail ${closedTail}`).toBeGreaterThan(closedTail * 5);
  });

  it('HARMONICS shifts the bandpass centre (low → closed, high → open)', () => {
    // At harmonics=0 the bandpass centre is 2kHz; at harmonics=1 it's 10kHz.
    // Compare energy at 8kHz between the two.
    const low = macrooscillatorMath.render(Math.floor(0.05 * SR), SR, 0, {
      model: 10, note: 24, harmonics: 0, timbre: 0.3, morph: 0.5, level: 1,
    }).main;
    const high = macrooscillatorMath.render(Math.floor(0.05 * SR), SR, 0, {
      model: 10, note: 24, harmonics: 1, timbre: 0.3, morph: 0.5, level: 1,
    }).main;
    const low8k = powerAt(low, 8000, SR);
    const high8k = powerAt(high, 8000, SR);
    expect(high8k, `high-cut 8kHz ${high8k} > low-cut 8kHz ${low8k}`).toBeGreaterThan(low8k * 2);
  });

  it('KICK + SNARE + HIHAT finite + bounded at extreme params', () => {
    for (const model of [8, 9, 10]) {
      const { main, aux } = macrooscillatorMath.render(SR, SR, 0, {
        model, note: 0, harmonics: 1, timbre: 1, morph: 1, level: 1,
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
      expect(mainPeak, `model=${model} main peak ${mainPeak}`).toBeLessThan(2.5);
      expect(auxPeak, `model=${model} aux peak ${auxPeak}`).toBeLessThan(2.5);
    }
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
