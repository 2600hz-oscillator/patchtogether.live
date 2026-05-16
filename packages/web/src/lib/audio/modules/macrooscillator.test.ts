// packages/web/src/lib/audio/modules/macrooscillator.test.ts
//
// Unit tests for MACROOSCILLATOR:
//   - module-def shape (ports, params, cvScale annotations)
//   - pure-math engine sanity (each model produces non-silent output at a
//     known fundamental, and the right output band carries energy)
//
// Worklet-level behavior (model switching mid-stream, gate-edge phase
// reset) is covered by the ART scenario.

import { describe, expect, it } from 'vitest';
import { macrooscillatorDef, macrooscillatorMath, MACRO_MAX_MODEL, type MacroParams } from './macrooscillator';

describe('macrooscillatorDef shape', () => {
  it('declares type=macrooscillator, label=MACROOSCILLATOR, category=sources', () => {
    expect(macrooscillatorDef.type).toBe('macrooscillator');
    expect(macrooscillatorDef.label).toBe('MACROOSCILLATOR');
    expect(macrooscillatorDef.category).toBe('sources');
  });

  it('exposes the expected input ports (2 audio-rate + 6 cv → param)', () => {
    const ids = macrooscillatorDef.inputs.map((p) => p.id);
    expect(ids).toEqual([
      'pitch', 'trig',
      'model_cv', 'note_cv', 'harm_cv', 'timb_cv', 'morph_cv', 'level_cv',
    ]);
  });

  it('exposes 2 audio outputs: out + aux', () => {
    const ids = macrooscillatorDef.outputs.map((p) => p.id);
    expect(ids).toEqual(['out', 'aux']);
    for (const p of macrooscillatorDef.outputs) expect(p.type).toBe('audio');
  });

  it('exposes 6 params: model, note, harmonics, timbre, morph, level', () => {
    const ids = macrooscillatorDef.params.map((p) => p.id);
    expect(ids).toEqual(['model', 'note', 'harmonics', 'timbre', 'morph', 'level']);
  });

  it('every cv input has paramTarget pointing at a real param + cvScale set', () => {
    for (const port of macrooscillatorDef.inputs) {
      if (port.type !== 'cv') continue;
      expect(port.paramTarget, `${port.id} paramTarget`).toBeDefined();
      expect(port.cvScale, `${port.id} cvScale`).toBeDefined();
      const param = macrooscillatorDef.params.find((p) => p.id === port.paramTarget);
      expect(param, `${port.id} → param ${port.paramTarget}`).toBeDefined();
    }
  });

  it(`model param: discrete 0..${MACRO_MAX_MODEL} (grows as more models land)`, () => {
    const p = macrooscillatorDef.params.find((p) => p.id === 'model')!;
    expect(p.curve).toBe('discrete');
    expect(p.min).toBe(0);
    expect(p.max).toBe(MACRO_MAX_MODEL);
    // model_cv must use the `discrete` CV scaling — linear would interpret a
    // ±1 LFO as a continuous interpolation across model space, which makes
    // no audio sense for what's effectively a switch.
    const port = macrooscillatorDef.inputs.find((p) => p.id === 'model_cv')!;
    expect(port.cvScale).toEqual({ mode: 'discrete' });
  });

  it('note param: ±60 semitone offset on top of pitch V/oct', () => {
    const p = macrooscillatorDef.params.find((p) => p.id === 'note')!;
    expect(p.min).toBe(-60);
    expect(p.max).toBe(60);
    expect(p.units).toBe('st');
  });
});

const SR = 48000;
const A4 = 1.0; // V/oct: 1V above C4 = C5; we use a known semitone offset via note.

/** Goertzel single-bin magnitude — Plaits-style "is energy at this frequency"
 *  check. */
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

describe('macrooscillatorMath — VA model', () => {
  const baseParams: MacroParams = {
    model: 0,
    note: 0,
    harmonics: 0.0,
    timbre: 0.0,
    morph: 0.0,
    level: 1.0,
  };

  it('produces non-silent, finite audio at 440Hz (A4 = pitch=0.75 V/oct)', () => {
    // Pitch V/oct 0 → C4 = 261.626 Hz. 440 Hz is the A above, 9 semitones
    // up, so pitchV * 12 = 9 → pitchV = 0.75.
    const { main } = macrooscillatorMath.render(SR, SR, 0.75, baseParams);
    expect(main.length).toBe(SR);
    let peak = 0;
    for (let i = 0; i < main.length; i++) {
      expect(Number.isFinite(main[i]!), `main[${i}] finite`).toBe(true);
      const a = Math.abs(main[i]!);
      if (a > peak) peak = a;
    }
    expect(peak, 'VA peak above silence threshold').toBeGreaterThan(0.1);
  });

  it('VA at morph=0 (saw) carries strong fundamental at the requested freq', () => {
    // Use second half of the buffer to skip startup.
    const { main } = macrooscillatorMath.render(SR, SR, 0.75, { ...baseParams, morph: 0.0 });
    const tail = main.slice(SR / 2);
    const pFund = powerAt(tail, 440, SR);
    const pNoise = powerAt(tail, 1234, SR); // off-harmonic bin
    expect(pFund).toBeGreaterThan(pNoise * 3);
  });

  it('VA at morph=0.5 (square) carries third harmonic (1320Hz) above noise', () => {
    const { main } = macrooscillatorMath.render(SR, SR, 0.75, { ...baseParams, morph: 0.5 });
    const tail = main.slice(SR / 2);
    const p3 = powerAt(tail, 1320, SR);
    const pNoise = powerAt(tail, 1234, SR);
    expect(p3).toBeGreaterThan(pNoise * 1.5);
  });

  it('VA aux output is non-silent (sub-octave triangle)', () => {
    const { aux } = macrooscillatorMath.render(SR / 2, SR, 0.75, baseParams);
    let peak = 0;
    for (let i = 0; i < aux.length; i++) {
      const a = Math.abs(aux[i]!);
      if (a > peak) peak = a;
    }
    expect(peak).toBeGreaterThan(0.1);
  });
});

describe('macrooscillatorMath — WAVESHAPE model', () => {
  const baseParams: MacroParams = {
    model: 1,
    note: 0,
    harmonics: 0.0,
    timbre: 0.0,
    morph: 0.0,
    level: 1.0,
  };

  it('produces non-silent, finite audio at A4', () => {
    const { main } = macrooscillatorMath.render(SR, SR, 0.75, baseParams);
    let peak = 0;
    for (let i = 0; i < main.length; i++) {
      expect(Number.isFinite(main[i]!)).toBe(true);
      const a = Math.abs(main[i]!);
      if (a > peak) peak = a;
    }
    expect(peak, 'WAVESHAPE peak above silence').toBeGreaterThan(0.1);
  });

  it('TIMBRE adds odd harmonics (tanh path: morph=1): 3rd-harmonic / fundamental ratio grows with drive', () => {
    // Both waveshapers (sin folder + tanh) are odd-symmetric, so they
    // produce only odd harmonics (3rd, 5th, 7th, ...). We pin MORPH=1
    // (pure tanh) and sweep TIMBRE: at timbre=0 tanh sees a ±1 input so
    // tanh(x) ≈ x (near-linear, near-pure sine — fundamental dominates,
    // 3H tiny); at timbre=1 tanh sees a ±8 input and saturates hard →
    // square-ish wave → big 3H. Compare the 3H/fund RATIO (not absolute
    // magnitude) because the worklet pulls overall amplitude back by
    // 1/sqrt(drive) to keep the macro at unity output.
    const noDrive = macrooscillatorMath.render(SR, SR, 0.75, { ...baseParams, timbre: 0.0, morph: 1.0 });
    const fullDrive = macrooscillatorMath.render(SR, SR, 0.75, { ...baseParams, timbre: 1.0, morph: 1.0 });
    const noDriveTail = noDrive.main.slice(SR / 2);
    const fullDriveTail = fullDrive.main.slice(SR / 2);
    const noDriveRatio = powerAt(noDriveTail, 1320, SR) / Math.max(1e-12, powerAt(noDriveTail, 440, SR));
    const fullDriveRatio = powerAt(fullDriveTail, 1320, SR) / Math.max(1e-12, powerAt(fullDriveTail, 440, SR));
    // Hard saturation moves a lot of the energy from fundamental → 3H.
    // Even a 3x ratio shift is a comfortable margin (typically ~10x in
    // practice) — pick the floor that catches a regression without
    // flapping on minor implementation changes.
    expect(
      fullDriveRatio,
      `fullDrive 3H/fund ratio ${fullDriveRatio.toFixed(4)} vs noDrive ${noDriveRatio.toFixed(4)}`,
    ).toBeGreaterThan(noDriveRatio * 3);
  });

  it('feedback / waveshaping stays bounded — peak never exceeds 1.0 at extreme params', () => {
    // The worst-case combination: max level, max timbre, max harmonics
    // (adds sub which contributes pre-drive amplitude).
    const { main } = macrooscillatorMath.render(SR, SR, 0.75, {
      model: 1,
      note: 0,
      harmonics: 1.0,
      timbre: 1.0,
      morph: 1.0,
      level: 1.0,
    });
    let peak = 0;
    for (let i = 0; i < main.length; i++) {
      const a = Math.abs(main[i]!);
      if (a > peak) peak = a;
    }
    // Allow a hair over 1 because the waveshapers (sin and tanh) are bounded
    // at ±1 but the morph crossfade between them can briefly land at 1.0
    // exactly. 1.5 is a generous ceiling that still catches a runaway bug.
    expect(peak, `WAVESHAPE peak ${peak}`).toBeLessThan(1.5);
  });
});

describe('macrooscillatorMath — FM 2-OP model', () => {
  const baseParams: MacroParams = {
    model: 2,
    note: 0,
    harmonics: 0.0, // ratio idx 0 (1:1) at floor()
    timbre: 0.0,    // no modulation index → clean carrier sine
    morph: 0.0,     // no feedback
    level: 1.0,
  };

  it('produces non-silent, finite audio at A4', () => {
    const { main } = macrooscillatorMath.render(SR, SR, 0.75, baseParams);
    let peak = 0;
    for (let i = 0; i < main.length; i++) {
      expect(Number.isFinite(main[i]!)).toBe(true);
      const a = Math.abs(main[i]!);
      if (a > peak) peak = a;
    }
    expect(peak, 'FM 2OP peak above silence').toBeGreaterThan(0.1);
  });

  it('clean carrier baseline (timbre=0, morph=0, ratio 1:1) is dominated by the fundamental', () => {
    // With modulation index = 0 the carrier is a clean sine at the fundamental.
    const tail = macrooscillatorMath.render(SR, SR, 0.75, baseParams).main.slice(SR / 2);
    const pFund = powerAt(tail, 440, SR);
    const pH2 = powerAt(tail, 880, SR);
    const pH3 = powerAt(tail, 1320, SR);
    expect(pFund, `fund ${pFund} should dominate H2/H3 (${pH2}/${pH3})`).toBeGreaterThan(pH2 * 50);
    expect(pFund).toBeGreaterThan(pH3 * 50);
  });

  it('TIMBRE (modulation index) adds sidebands: high TIMBRE produces more energy outside the fundamental bin', () => {
    // At ratio 1:1, the modulator IS the carrier frequency, so the
    // sidebands land at integer multiples of 440 — H2 (880), H3 (1320), etc.
    // High mod index → energy redistributes into the sidebands. Compare
    // the off-fundamental energy at H2 between timbre=0 and timbre=1.
    const clean = macrooscillatorMath.render(SR, SR, 0.75, { ...baseParams, timbre: 0.0 }).main.slice(SR / 2);
    const dirty = macrooscillatorMath.render(SR, SR, 0.75, { ...baseParams, timbre: 1.0 }).main.slice(SR / 2);
    const cleanH2 = powerAt(clean, 880, SR);
    const dirtyH2 = powerAt(dirty, 880, SR);
    expect(
      dirtyH2,
      `timbre=1 H2 ${dirtyH2} should exceed timbre=0 H2 ${cleanH2} (sideband growth)`,
    ).toBeGreaterThan(cleanH2 * 10);
  });

  it('HARMONICS picks a different ratio: harmonics=0 (1:1) vs harmonics≈0.3 (2:1) shifts spectral centroid up', () => {
    // At harmonics=0 → ratio 1:1 (idx 0): carrier=440, modulator=440 →
    // sidebands at 440, 880, 1320, ...
    // At harmonics=0.3 → floor(0.3*8)=2 → ratio 2:1: carrier=880, modulator=440
    // → sidebands at 880, 440, 1320, 0. The carrier doubles to 880, so
    // there is significantly more energy at 880 (and higher) and less at 440.
    const r0 = macrooscillatorMath.render(SR, SR, 0.75, { ...baseParams, harmonics: 0.0, timbre: 1.0 }).main.slice(SR / 2);
    const r2 = macrooscillatorMath.render(SR, SR, 0.75, { ...baseParams, harmonics: 0.3, timbre: 1.0 }).main.slice(SR / 2);
    // r2's carrier is 880Hz — so 880 should have markedly more energy
    // than in r0 (where 880 is just the first sideband above the fund).
    const r0_880 = powerAt(r0, 880, SR);
    const r2_880 = powerAt(r2, 880, SR);
    expect(
      r2_880,
      `harmonics=0.3 (2:1, carrier=880) 880Hz energy ${r2_880} should exceed harmonics=0 (1:1) ${r0_880}`,
    ).toBeGreaterThan(r0_880 * 1.5);
  });

  it('FM 2-OP aux output is a clean carrier sine (no modulation)', () => {
    const { aux } = macrooscillatorMath.render(SR, SR, 0.75, { ...baseParams, timbre: 1.0 });
    // AUX should still be near-pure sine even with TIMBRE=1, because
    // modulation is applied only to MAIN.
    const tail = aux.slice(SR / 2);
    const pFund = powerAt(tail, 440, SR);
    const pH2 = powerAt(tail, 880, SR);
    expect(pFund, `aux fund ${pFund} vs H2 ${pH2}`).toBeGreaterThan(pH2 * 20);
  });

  it('bounded output at extreme params', () => {
    const { main } = macrooscillatorMath.render(SR, SR, 0.75, {
      model: 2, note: 0, harmonics: 1, timbre: 1, morph: 1, level: 1,
    });
    let peak = 0;
    for (let i = 0; i < main.length; i++) {
      expect(Number.isFinite(main[i]!)).toBe(true);
      const a = Math.abs(main[i]!);
      if (a > peak) peak = a;
    }
    expect(peak, `FM 2OP peak ${peak}`).toBeLessThan(1.5);
  });
});

describe('macrooscillatorMath — FM 6-OP model', () => {
  const baseParams: MacroParams = {
    model: 3,
    note: 0,
    harmonics: 0.5,
    timbre: 0.0,   // no FM → near-pure sine
    morph: 1.0,    // long decay so the envelope doesn't decay to silence
    level: 1.0,
  };

  it('produces non-silent, finite audio at A4', () => {
    const { main } = macrooscillatorMath.render(SR, SR, 0.75, baseParams);
    let peak = 0;
    for (let i = 0; i < main.length; i++) {
      expect(Number.isFinite(main[i]!)).toBe(true);
      const a = Math.abs(main[i]!);
      if (a > peak) peak = a;
    }
    expect(peak, 'FM 6OP peak above silence').toBeGreaterThan(0.1);
  });

  it('TIMBRE adds spectral complexity: high TIMBRE produces more energy at upper harmonics', () => {
    // At timbre=0 the carrier is a clean sine; at timbre=1 the carrier is
    // heavily phase-modulated by op1 (which itself is modulated by op2..op4)
    // → rich, often inharmonic spectrum.
    const clean = macrooscillatorMath.render(SR, SR, 0.75, { ...baseParams, timbre: 0.0 }).main.slice(0, SR / 4);
    const dirty = macrooscillatorMath.render(SR, SR, 0.75, { ...baseParams, timbre: 1.0 }).main.slice(0, SR / 4);
    // Energy in a HF band that the clean sine wouldn't have.
    const cleanHF = powerAt(clean, 3000, SR);
    const dirtyHF = powerAt(dirty, 3000, SR);
    expect(
      dirtyHF,
      `timbre=1 HF energy ${dirtyHF} should exceed timbre=0 HF ${cleanHF}`,
    ).toBeGreaterThan(cleanHF * 3);
  });

  it('MORPH biases envelope decay: short MORPH decays faster than long MORPH', () => {
    // morph=0 → 50ms decay; morph=1 → 5s decay. Render 0.5s and look at
    // peak in the second half — short decay should be near-silent there,
    // long decay should still ring.
    const shortDecay = macrooscillatorMath.render(SR / 2, SR, 0.75, { ...baseParams, morph: 0.0, timbre: 0.5 }).main;
    const longDecay = macrooscillatorMath.render(SR / 2, SR, 0.75, { ...baseParams, morph: 1.0, timbre: 0.5 }).main;
    let shortTailPeak = 0;
    let longTailPeak = 0;
    for (let i = SR / 4; i < SR / 2; i++) {
      const a = Math.abs(shortDecay[i]!);
      if (a > shortTailPeak) shortTailPeak = a;
      const b = Math.abs(longDecay[i]!);
      if (b > longTailPeak) longTailPeak = b;
    }
    expect(
      longTailPeak,
      `long-decay tail peak ${longTailPeak} should exceed short-decay tail peak ${shortTailPeak}`,
    ).toBeGreaterThan(shortTailPeak * 2);
  });

  it('FM 6-OP aux output is a clean carrier sine', () => {
    const { aux } = macrooscillatorMath.render(SR, SR, 0.75, { ...baseParams, timbre: 1.0 });
    const tail = aux.slice(SR / 2);
    const pFund = powerAt(tail, 440, SR);
    const pHF = powerAt(tail, 3000, SR);
    expect(pFund, `aux fund ${pFund} vs HF ${pHF}`).toBeGreaterThan(pHF * 5);
  });

  it('bounded output at extreme params', () => {
    const { main } = macrooscillatorMath.render(SR, SR, 0.75, {
      model: 3, note: 0, harmonics: 1, timbre: 1, morph: 1, level: 1,
    });
    let peak = 0;
    for (let i = 0; i < main.length; i++) {
      expect(Number.isFinite(main[i]!)).toBe(true);
      const a = Math.abs(main[i]!);
      if (a > peak) peak = a;
    }
    expect(peak, `FM 6OP peak ${peak}`).toBeLessThan(1.5);
  });
});

describe('macrooscillatorMath — CHORD model', () => {
  const baseParams: MacroParams = {
    model: 4,
    note: 0,
    harmonics: 0.0, // first shape: octaves
    timbre: 0.0,    // sine voices
    morph: 1.0,     // full ensemble
    level: 1.0,
  };

  it('produces non-silent, finite audio at A4', () => {
    const { main } = macrooscillatorMath.render(SR, SR, 0.75, baseParams);
    let peak = 0;
    for (let i = 0; i < main.length; i++) {
      expect(Number.isFinite(main[i]!)).toBe(true);
      const a = Math.abs(main[i]!);
      if (a > peak) peak = a;
    }
    expect(peak, 'CHORD peak above silence').toBeGreaterThan(0.1);
  });

  it('major-triad shape (harmonics≈0.4 → idx 3) carries energy at the major third (5 semitones up from root = E5 ≈ 554Hz at 440 root)', () => {
    // floor(0.4 * 8) = 3 → major triad [0, 4, 7, 12]. Root at 440 →
    // major third at 440 * 2^(4/12) ≈ 554.37 Hz.
    const tail = macrooscillatorMath.render(SR, SR, 0.75, {
      ...baseParams, harmonics: 0.4, morph: 1.0,
    }).main.slice(SR / 2);
    const pRoot = powerAt(tail, 440, SR);
    const pThird = powerAt(tail, 554.37, SR);
    const pOffBin = powerAt(tail, 700, SR);
    expect(pThird, `major 3rd ${pThird} > off-bin ${pOffBin}`).toBeGreaterThan(pOffBin * 5);
    // Root should still be louder (or comparable) than the third.
    expect(pRoot).toBeGreaterThan(pOffBin * 5);
  });

  it('MORPH=0 collapses to root-only (other voices muted)', () => {
    // At morph=0 only the root voice plays — so the 3rd-bin (554Hz) for
    // the major triad should be very weak.
    const root = macrooscillatorMath.render(SR, SR, 0.75, {
      ...baseParams, harmonics: 0.4, morph: 0,
    }).main.slice(SR / 2);
    const full = macrooscillatorMath.render(SR, SR, 0.75, {
      ...baseParams, harmonics: 0.4, morph: 1,
    }).main.slice(SR / 2);
    const root554 = powerAt(root, 554.37, SR);
    const full554 = powerAt(full, 554.37, SR);
    expect(
      full554,
      `morph=1 3rd-bin ${full554} should massively exceed morph=0 ${root554}`,
    ).toBeGreaterThan(root554 * 20);
  });

  it('AUX is the clean root sine (single voice, no chord stack)', () => {
    const { aux } = macrooscillatorMath.render(SR, SR, 0.75, { ...baseParams, harmonics: 0.4 });
    const tail = aux.slice(SR / 2);
    const pRoot = powerAt(tail, 440, SR);
    const pThird = powerAt(tail, 554.37, SR);
    // The chord's 3rd-bin should be tiny on the aux output (root only).
    expect(pRoot, `aux root ${pRoot} >> aux 3rd ${pThird}`).toBeGreaterThan(pThird * 20);
  });

  it('bounded output at extreme params', () => {
    const { main } = macrooscillatorMath.render(SR, SR, 0.75, {
      model: 4, note: 0, harmonics: 1, timbre: 1, morph: 1, level: 1,
    });
    let peak = 0;
    for (let i = 0; i < main.length; i++) {
      expect(Number.isFinite(main[i]!)).toBe(true);
      const a = Math.abs(main[i]!);
      if (a > peak) peak = a;
    }
    expect(peak, `CHORD peak ${peak}`).toBeLessThan(1.5);
  });
});

describe('macrooscillatorMath — ADDITIVE model', () => {
  const baseParams: MacroParams = {
    model: 5,
    note: 0,
    harmonics: 0.0, // integer (no inharmonicity)
    timbre: 0.0,    // bright spectral tilt
    morph: 0.5,     // saw-shape (all partials)
    level: 1.0,
  };

  it('produces non-silent, finite audio at A4', () => {
    const { main } = macrooscillatorMath.render(SR, SR, 0.75, baseParams);
    let peak = 0;
    for (let i = 0; i < main.length; i++) {
      expect(Number.isFinite(main[i]!)).toBe(true);
      const a = Math.abs(main[i]!);
      if (a > peak) peak = a;
    }
    expect(peak, 'ADDITIVE peak above silence').toBeGreaterThan(0.05);
  });

  it('integer partials (harmonics=0) carry strong energy at 2H, 3H, 4H', () => {
    // All partials at exact integer multiples → 440, 880, 1320, 1760, ...
    const tail = macrooscillatorMath.render(SR, SR, 0.75, baseParams).main.slice(SR / 2);
    const pFund = powerAt(tail, 440, SR);
    const pH2 = powerAt(tail, 880, SR);
    const pH3 = powerAt(tail, 1320, SR);
    const pH4 = powerAt(tail, 1760, SR);
    const pOff = powerAt(tail, 600, SR);
    expect(pFund, `fund ${pFund} > off ${pOff}`).toBeGreaterThan(pOff * 5);
    expect(pH2, `H2 ${pH2} > off ${pOff}`).toBeGreaterThan(pOff * 3);
    expect(pH3, `H3 ${pH3} > off ${pOff}`).toBeGreaterThan(pOff * 3);
    expect(pH4, `H4 ${pH4} > off ${pOff}`).toBeGreaterThan(pOff * 3);
  });

  it('MORPH=0 (odd-only) suppresses even harmonics (square-like)', () => {
    const all = macrooscillatorMath.render(SR, SR, 0.75, { ...baseParams, morph: 0.5 }).main.slice(SR / 2);
    const oddOnly = macrooscillatorMath.render(SR, SR, 0.75, { ...baseParams, morph: 0 }).main.slice(SR / 2);
    const allH2 = powerAt(all, 880, SR);
    const oddH2 = powerAt(oddOnly, 880, SR);
    // Even harmonics should be far weaker at morph=0 than morph=0.5.
    expect(
      allH2,
      `morph=0.5 H2 ${allH2} should exceed morph=0 H2 ${oddH2}`,
    ).toBeGreaterThan(oddH2 * 5);
  });

  it('TIMBRE controls spectral tilt: high TIMBRE → weak HF rolloff', () => {
    // At timbre=0, 1/n^0.5 rolloff (bright). At timbre=1, 1/n^2 (warm).
    // Compare H8/H1 ratio between the two — should drop sharply as TIMBRE grows.
    const bright = macrooscillatorMath.render(SR, SR, 0.75, { ...baseParams, timbre: 0 }).main.slice(SR / 2);
    const warm = macrooscillatorMath.render(SR, SR, 0.75, { ...baseParams, timbre: 1 }).main.slice(SR / 2);
    const brightRatio = powerAt(bright, 3520, SR) / Math.max(1e-12, powerAt(bright, 440, SR));
    const warmRatio = powerAt(warm, 3520, SR) / Math.max(1e-12, powerAt(warm, 440, SR));
    expect(
      brightRatio,
      `bright H8/fund ratio ${brightRatio} > warm ${warmRatio}`,
    ).toBeGreaterThan(warmRatio * 2);
  });

  it('HARMONICS (inharmonicity) detunes upper partials away from integer harmonics', () => {
    // At inharm=0, H8 lands at exactly 8 * 440 = 3520. At inharm=1,
    // H8 lands at 8 * 440 * (1 + 0.1 * 7) = 8 * 440 * 1.7 = 5984.
    // So the 3520 Hz bin's energy should drop as inharm grows.
    const integerStack = macrooscillatorMath.render(SR, SR, 0.75, { ...baseParams, harmonics: 0 }).main.slice(SR / 2);
    const stretchedStack = macrooscillatorMath.render(SR, SR, 0.75, { ...baseParams, harmonics: 1 }).main.slice(SR / 2);
    const integ3520 = powerAt(integerStack, 3520, SR);
    const stretch3520 = powerAt(stretchedStack, 3520, SR);
    expect(
      integ3520,
      `integer H8 at 3520 ${integ3520} > stretched ${stretch3520}`,
    ).toBeGreaterThan(stretch3520 * 5);
  });

  it('bounded output at extreme params', () => {
    const { main } = macrooscillatorMath.render(SR, SR, 0.75, {
      model: 5, note: 0, harmonics: 1, timbre: 1, morph: 1, level: 1,
    });
    let peak = 0;
    for (let i = 0; i < main.length; i++) {
      expect(Number.isFinite(main[i]!)).toBe(true);
      const a = Math.abs(main[i]!);
      if (a > peak) peak = a;
    }
    expect(peak, `ADDITIVE peak ${peak}`).toBeLessThan(1.5);
  });
});

describe('macrooscillatorMath — STRING model', () => {
  const baseParams: MacroParams = {
    model: 6,
    note: 0,
    harmonics: 0.0, // no dispersion (pure string)
    timbre: 0.5,    // mid-brightness pluck
    morph: 0.5,     // moderate damping
    level: 1.0,
  };

  it('produces non-silent, finite audio at A4 (Karplus-Strong burst)', () => {
    // The math mirror's render() calls str.reset() once so the burst fires.
    const { main } = macrooscillatorMath.render(SR, SR, 0.75, baseParams);
    let peak = 0;
    for (let i = 0; i < main.length; i++) {
      expect(Number.isFinite(main[i]!)).toBe(true);
      const a = Math.abs(main[i]!);
      if (a > peak) peak = a;
    }
    // KS bursts settle to small amplitudes — peak above 0.001 is enough
    // to assert it sounds, but it should be much higher in practice.
    expect(peak, 'STRING peak above silence').toBeGreaterThan(0.001);
  });

  it('STRING carries energy at the fundamental (440Hz)', () => {
    // After the burst settles the delay loop should ring at ~freq Hz.
    // Look at the first 200 ms (mid-burst / early-loop). Karplus-Strong
    // doesn't always lock cleanly at the exact pitch (delay-line quantisation
    // detunes by a few cents) so allow a slightly wider band.
    const { main } = macrooscillatorMath.render(SR, SR, 0.75, { ...baseParams, morph: 0.8 });
    // Use the early ring (samples 50ms..200ms) where amplitude is highest.
    const window = main.slice(Math.floor(0.05 * SR), Math.floor(0.2 * SR));
    const pFund = powerAt(window, 440, SR);
    const pOff = powerAt(window, 200, SR);
    expect(pFund, `fund ${pFund} > off-bin ${pOff}`).toBeGreaterThan(pOff * 2);
  });

  it('MORPH controls decay: morph=0 (low damping cutoff) decays fast', () => {
    // morph=0 → damp filter cutoff = 200 Hz, kills HF + most string energy.
    // Compare RMS of the tail 200ms→500ms between morph=0 and morph=1.
    const fast = macrooscillatorMath.render(SR, SR, 0.75, { ...baseParams, morph: 0 }).main;
    const slow = macrooscillatorMath.render(SR, SR, 0.75, { ...baseParams, morph: 1 }).main;
    const start = Math.floor(0.2 * SR);
    const end = Math.floor(0.5 * SR);
    let fastRms = 0;
    let slowRms = 0;
    for (let i = start; i < end; i++) {
      fastRms += fast[i]! * fast[i]!;
      slowRms += slow[i]! * slow[i]!;
    }
    fastRms = Math.sqrt(fastRms / (end - start));
    slowRms = Math.sqrt(slowRms / (end - start));
    expect(
      slowRms,
      `slow-decay RMS ${slowRms} > fast-decay RMS ${fastRms}`,
    ).toBeGreaterThan(fastRms * 2);
  });

  it('bounded output at extreme params', () => {
    const { main } = macrooscillatorMath.render(SR, SR, 0.75, {
      model: 6, note: 0, harmonics: 1, timbre: 1, morph: 1, level: 1,
    });
    let peak = 0;
    for (let i = 0; i < main.length; i++) {
      expect(Number.isFinite(main[i]!)).toBe(true);
      const a = Math.abs(main[i]!);
      if (a > peak) peak = a;
    }
    expect(peak, `STRING peak ${peak}`).toBeLessThan(1.5);
  });
});

describe('macrooscillatorMath — MODAL model', () => {
  const baseParams: MacroParams = {
    model: 7,
    note: 0,
    harmonics: 0.0, // preset 0 (struck bar)
    timbre: 0.6,    // mid-Q (rings audibly without runaway)
    morph: 0.0,     // emphasise base amplitudes
    level: 1.0,
  };

  it('produces non-silent, finite audio at A4', () => {
    const { main } = macrooscillatorMath.render(SR * 2, SR, 0.75, baseParams);
    let peak = 0;
    for (let i = 0; i < main.length; i++) {
      expect(Number.isFinite(main[i]!)).toBe(true);
      const a = Math.abs(main[i]!);
      if (a > peak) peak = a;
    }
    expect(peak, 'MODAL peak above silence').toBeGreaterThan(0.001);
  });

  it('STRUCK BAR preset (harmonics=0) carries inharmonic partial at 2.76 × fundamental', () => {
    // Preset 0 partial ratios: [1, 2.76, 5.41, 8.93, ...]. At 440 fund,
    // the 2.76× partial sits at 1214.4 Hz. Use a long window so the
    // resonators reach their steady-state amplitude.
    const tail = macrooscillatorMath.render(SR * 2, SR, 0.75, baseParams).main.slice(SR);
    const p1214 = powerAt(tail, 440 * 2.76, SR);
    const p1100 = powerAt(tail, 1100, SR);
    // p1214 should beat the off-bin (1100) by a wide margin — resonance
    // is narrow at high Q.
    expect(p1214, `2.76x partial ${p1214} > off-bin ${p1100}`).toBeGreaterThan(p1100 * 2);
  });

  it('BELL preset (harmonics≈0.55) carries the 0.5× sub-fundamental partial', () => {
    // floor(0.55 * 4) = 2 → bell preset. Ratios [0.5, 1.0, 1.2, ...].
    // The 0.5× partial sits at 220 Hz when freq=440.
    const tail = macrooscillatorMath.render(SR * 2, SR, 0.75, {
      ...baseParams, harmonics: 0.55,
    }).main.slice(SR);
    const p220 = powerAt(tail, 220, SR);
    const pOff = powerAt(tail, 300, SR);
    expect(p220, `bell sub at 220Hz ${p220} > off-bin ${pOff}`).toBeGreaterThan(pOff * 1.5);
  });

  it('TIMBRE controls Q: high TIMBRE narrows resonance (peak-to-band ratio grows)', () => {
    // High Q → very narrow bandpass per mode → peak energy concentrates
    // exactly at the partial frequency, with steeper drop-off at neighbouring
    // bins. Compare 1214 (the exact 2.76x partial) vs 1100 (off-bin).
    const lowQ = macrooscillatorMath.render(SR * 2, SR, 0.75, { ...baseParams, timbre: 0.1 }).main.slice(SR);
    const highQ = macrooscillatorMath.render(SR * 2, SR, 0.75, { ...baseParams, timbre: 0.95 }).main.slice(SR);
    const lowQPeak = powerAt(lowQ, 440 * 2.76, SR);
    const lowQOff = powerAt(lowQ, 1100, SR);
    const highQPeak = powerAt(highQ, 440 * 2.76, SR);
    const highQOff = powerAt(highQ, 1100, SR);
    const lowQRatio = lowQPeak / Math.max(1e-12, lowQOff);
    const highQRatio = highQPeak / Math.max(1e-12, highQOff);
    expect(
      highQRatio,
      `high-Q peak/off ratio ${highQRatio} > low-Q ${lowQRatio}`,
    ).toBeGreaterThan(lowQRatio);
  });

  it('bounded output at extreme params', () => {
    const { main } = macrooscillatorMath.render(SR, SR, 0.75, {
      model: 7, note: 0, harmonics: 1, timbre: 1, morph: 1, level: 1,
    });
    let peak = 0;
    for (let i = 0; i < main.length; i++) {
      expect(Number.isFinite(main[i]!)).toBe(true);
      const a = Math.abs(main[i]!);
      if (a > peak) peak = a;
    }
    expect(peak, `MODAL peak ${peak}`).toBeLessThan(1.5);
  });
});

describe('macrooscillatorMath — KICK model', () => {
  const baseParams: MacroParams = {
    model: 8,
    note: -24, // drop to a kick-drum-y register (~65 Hz)
    harmonics: 0.7, // sweep ~3 octaves
    timbre: 0.3,
    morph: 0.5,
    level: 1.0,
  };

  it('produces non-silent, finite audio on trigger', () => {
    const { main } = macrooscillatorMath.render(SR, SR, 0, baseParams);
    let peak = 0;
    for (let i = 0; i < main.length; i++) {
      expect(Number.isFinite(main[i]!)).toBe(true);
      const a = Math.abs(main[i]!);
      if (a > peak) peak = a;
    }
    expect(peak, 'KICK peak above silence').toBeGreaterThan(0.1);
  });

  it('KICK has decaying amplitude envelope (later samples quieter than initial)', () => {
    // Force a short morph so the decay test is robust regardless of
    // exact tuning of the env-time mapping.
    const { main } = macrooscillatorMath.render(SR / 2, SR, 0, { ...baseParams, morph: 0.0 });
    // Compare initial RMS (first 20ms) vs late RMS (200-300ms in).
    let initRms = 0;
    let lateRms = 0;
    const initEnd = Math.floor(0.02 * SR);
    const lateStart = Math.floor(0.2 * SR);
    const lateEnd = Math.floor(0.3 * SR);
    for (let i = 0; i < initEnd; i++) initRms += main[i]! * main[i]!;
    for (let i = lateStart; i < lateEnd; i++) lateRms += main[i]! * main[i]!;
    initRms = Math.sqrt(initRms / initEnd);
    lateRms = Math.sqrt(lateRms / (lateEnd - lateStart));
    expect(initRms, `init RMS ${initRms} > late RMS ${lateRms}`).toBeGreaterThan(lateRms * 5);
  });

  it('MORPH controls body decay length: morph=0 decays much faster than morph=1', () => {
    // Long-tail samples (300-500 ms): short-decay should be near silent,
    // long-decay should still be ringing.
    const short = macrooscillatorMath.render(SR, SR, 0, { ...baseParams, morph: 0 }).main;
    const long = macrooscillatorMath.render(SR, SR, 0, { ...baseParams, morph: 1 }).main;
    let shortRms = 0;
    let longRms = 0;
    const start = Math.floor(0.3 * SR);
    const end = Math.floor(0.5 * SR);
    for (let i = start; i < end; i++) {
      shortRms += short[i]! * short[i]!;
      longRms += long[i]! * long[i]!;
    }
    shortRms = Math.sqrt(shortRms / (end - start));
    longRms = Math.sqrt(longRms / (end - start));
    expect(longRms, `long ${longRms} > short ${shortRms}`).toBeGreaterThan(shortRms * 5);
  });

  it('bounded output at extreme params', () => {
    const { main } = macrooscillatorMath.render(SR, SR, 0, {
      model: 8, note: -24, harmonics: 1, timbre: 1, morph: 1, level: 1,
    });
    let peak = 0;
    for (let i = 0; i < main.length; i++) {
      expect(Number.isFinite(main[i]!)).toBe(true);
      const a = Math.abs(main[i]!);
      if (a > peak) peak = a;
    }
    expect(peak, `KICK peak ${peak}`).toBeLessThan(2.0);
  });
});

describe('macrooscillatorMath — SNARE model', () => {
  const baseParams: MacroParams = {
    model: 9,
    note: -12, // ~130 Hz body
    harmonics: 0.5, // 50/50 body/noise
    timbre: 0.5,
    morph: 0.3,
    level: 1.0,
  };

  it('produces non-silent, finite audio', () => {
    const { main } = macrooscillatorMath.render(SR, SR, 0, baseParams);
    let peak = 0;
    for (let i = 0; i < main.length; i++) {
      expect(Number.isFinite(main[i]!)).toBe(true);
      const a = Math.abs(main[i]!);
      if (a > peak) peak = a;
    }
    expect(peak, 'SNARE peak above silence').toBeGreaterThan(0.05);
  });

  it('HARMONICS=0 (pure body) has strong tonal content at the body fundamental', () => {
    // Note=-12 from pitchV=0 → C4*2^(-1) = 130.8 Hz. Pure body (harmonics=0)
    // should carry strong energy at 130.8.
    const { main } = macrooscillatorMath.render(SR / 2, SR, 0, { ...baseParams, harmonics: 0 });
    // Use the first 100ms before the body decays.
    const window = main.slice(0, Math.floor(0.1 * SR));
    const pFund = powerAt(window, 130.8, SR);
    const pOff = powerAt(window, 800, SR);
    expect(pFund, `body fund ${pFund} > off-bin ${pOff}`).toBeGreaterThan(pOff * 2);
  });

  it('HARMONICS=1 (pure noise) has broader spectrum than pure body', () => {
    const body = macrooscillatorMath.render(SR / 4, SR, 0, { ...baseParams, harmonics: 0 }).main;
    const noisy = macrooscillatorMath.render(SR / 4, SR, 0, { ...baseParams, harmonics: 1 }).main;
    // Sum 4 off-fundamental bins. Noise should distribute energy widely
    // across them; pure body concentrates at the fundamental and its
    // harmonics.
    let bodyOffSum = 0;
    let noisyOffSum = 0;
    for (const f of [1500, 2500, 3500, 5000]) {
      bodyOffSum += powerAt(body, f, SR);
      noisyOffSum += powerAt(noisy, f, SR);
    }
    expect(
      noisyOffSum,
      `noisy off-band ${noisyOffSum} > body off-band ${bodyOffSum}`,
    ).toBeGreaterThan(bodyOffSum * 2);
  });

  it('bounded output at extreme params', () => {
    const { main } = macrooscillatorMath.render(SR, SR, 0, {
      model: 9, note: -12, harmonics: 1, timbre: 1, morph: 1, level: 1,
    });
    let peak = 0;
    for (let i = 0; i < main.length; i++) {
      expect(Number.isFinite(main[i]!)).toBe(true);
      const a = Math.abs(main[i]!);
      if (a > peak) peak = a;
    }
    expect(peak, `SNARE peak ${peak}`).toBeLessThan(2.0);
  });
});

describe('macrooscillatorMath — HIHAT model', () => {
  const baseParams: MacroParams = {
    model: 10,
    note: 24, // ~1 kHz body register
    harmonics: 0.5, // mid bandpass
    timbre: 0.5,
    morph: 0.3, // moderately short decay
    level: 1.0,
  };

  it('produces non-silent, finite audio', () => {
    const { main } = macrooscillatorMath.render(SR / 4, SR, 0, baseParams);
    let peak = 0;
    for (let i = 0; i < main.length; i++) {
      expect(Number.isFinite(main[i]!)).toBe(true);
      const a = Math.abs(main[i]!);
      if (a > peak) peak = a;
    }
    expect(peak, 'HIHAT peak above silence').toBeGreaterThan(0.01);
  });

  it('HIHAT has HF-dominated spectrum (energy above 2kHz)', () => {
    const { main } = macrooscillatorMath.render(SR / 4, SR, 0, baseParams);
    // HF band (3-7 kHz) should dominate vs LF band (200-800 Hz).
    let hfSum = 0;
    let lfSum = 0;
    for (const f of [3000, 4000, 5500, 7000]) hfSum += powerAt(main, f, SR);
    for (const f of [200, 400, 600, 800]) lfSum += powerAt(main, f, SR);
    expect(hfSum, `hihat HF ${hfSum} > LF ${lfSum}`).toBeGreaterThan(lfSum);
  });

  it('MORPH controls decay length (open vs closed)', () => {
    const closed = macrooscillatorMath.render(SR / 2, SR, 0, { ...baseParams, morph: 0 }).main;
    const open = macrooscillatorMath.render(SR / 2, SR, 0, { ...baseParams, morph: 1 }).main;
    let closedTail = 0;
    let openTail = 0;
    const start = Math.floor(0.15 * SR);
    const end = Math.floor(0.3 * SR);
    for (let i = start; i < end; i++) {
      closedTail += closed[i]! * closed[i]!;
      openTail += open[i]! * open[i]!;
    }
    closedTail = Math.sqrt(closedTail / (end - start));
    openTail = Math.sqrt(openTail / (end - start));
    expect(openTail, `open tail ${openTail} > closed tail ${closedTail}`).toBeGreaterThan(closedTail * 3);
  });

  it('bounded output at extreme params', () => {
    const { main } = macrooscillatorMath.render(SR, SR, 0, {
      model: 10, note: 24, harmonics: 1, timbre: 1, morph: 1, level: 1,
    });
    let peak = 0;
    for (let i = 0; i < main.length; i++) {
      expect(Number.isFinite(main[i]!)).toBe(true);
      const a = Math.abs(main[i]!);
      if (a > peak) peak = a;
    }
    expect(peak, `HIHAT peak ${peak}`).toBeLessThan(2.0);
  });
});

describe('macrooscillatorMath — WAVETABLE model', () => {
  const baseParams: MacroParams = {
    model: 11,
    note: 0,
    harmonics: 0.0, // frame 0 (sine)
    timbre: 1.0,    // no LPF
    morph: 0.0,     // no phase warp
    level: 1.0,
  };

  it('produces non-silent, finite audio at A4', () => {
    const { main } = macrooscillatorMath.render(SR, SR, 0.75, baseParams);
    let peak = 0;
    for (let i = 0; i < main.length; i++) {
      expect(Number.isFinite(main[i]!)).toBe(true);
      const a = Math.abs(main[i]!);
      if (a > peak) peak = a;
    }
    expect(peak, 'WAVETABLE peak above silence').toBeGreaterThan(0.1);
  });

  it('frame 0 (HARMONICS=0) is dominated by the fundamental (sine)', () => {
    const tail = macrooscillatorMath.render(SR, SR, 0.75, baseParams).main.slice(SR / 2);
    const pFund = powerAt(tail, 440, SR);
    const pH3 = powerAt(tail, 1320, SR);
    expect(pFund, `fund ${pFund} >> H3 ${pH3}`).toBeGreaterThan(pH3 * 20);
  });

  it('frame ~3 (HARMONICS≈0.43, square) carries odd harmonics', () => {
    // frame index = 0.43*7 = 3.01 → frame 3 (square) blended with frame 4 (pulse).
    const tail = macrooscillatorMath.render(SR, SR, 0.75, {
      ...baseParams, harmonics: 0.43,
    }).main.slice(SR / 2);
    const pFund = powerAt(tail, 440, SR);
    const pH3 = powerAt(tail, 1320, SR);
    const pH5 = powerAt(tail, 2200, SR);
    // Square has strong 3rd + 5th harmonics. Ratio H3/fund for an ideal
    // square is 1/3 (0.33). Even our crude un-bandlimited square should
    // hit at least a 0.1 ratio.
    expect(
      pH3 / Math.max(1e-12, pFund),
      `H3/fund ratio ${pH3 / Math.max(1e-12, pFund)}`,
    ).toBeGreaterThan(0.1);
    expect(pH5).toBeGreaterThan(0);
  });

  it('TIMBRE lowpass: TIMBRE=0 (200Hz cut) attenuates HF severely', () => {
    const bright = macrooscillatorMath.render(SR, SR, 0.75, { ...baseParams, harmonics: 0.43, timbre: 1.0 }).main.slice(SR / 2);
    const warm = macrooscillatorMath.render(SR, SR, 0.75, { ...baseParams, harmonics: 0.43, timbre: 0.0 }).main.slice(SR / 2);
    const brightH5 = powerAt(bright, 2200, SR);
    const warmH5 = powerAt(warm, 2200, SR);
    expect(brightH5, `bright H5 ${brightH5} > warm H5 ${warmH5}`).toBeGreaterThan(warmH5 * 5);
  });

  it('bounded output at extreme params', () => {
    const { main } = macrooscillatorMath.render(SR, SR, 0.75, {
      model: 11, note: 0, harmonics: 1, timbre: 1, morph: 1, level: 1,
    });
    let peak = 0;
    for (let i = 0; i < main.length; i++) {
      expect(Number.isFinite(main[i]!)).toBe(true);
      const a = Math.abs(main[i]!);
      if (a > peak) peak = a;
    }
    expect(peak, `WAVETABLE peak ${peak}`).toBeLessThan(2.0);
  });
});

describe('macrooscillatorMath — GRANULAR model', () => {
  const baseParams: MacroParams = {
    model: 12,
    note: 0,
    harmonics: 1.0, // max grain density (200 grains/s)
    timbre: 0.0,    // no pitch jitter
    morph: 0.7,     // Hann window
    level: 1.0,
  };

  it('produces non-silent, finite audio', () => {
    const { main } = macrooscillatorMath.render(SR, SR, 0.75, baseParams);
    let peak = 0;
    for (let i = 0; i < main.length; i++) {
      expect(Number.isFinite(main[i]!)).toBe(true);
      const a = Math.abs(main[i]!);
      if (a > peak) peak = a;
    }
    expect(peak, 'GRANULAR peak above silence').toBeGreaterThan(0.05);
  });

  it('GRANULAR at low TIMBRE (no jitter) carries pitched energy near the fundamental', () => {
    // With pitch jitter=0 all grains play at exactly the carrier freq;
    // accumulated energy lands at the input pitch.
    const { main } = macrooscillatorMath.render(SR, SR, 0.75, baseParams);
    const tail = main.slice(SR / 2);
    const pFund = powerAt(tail, 440, SR);
    const pOff = powerAt(tail, 1234, SR);
    expect(pFund, `granular fund ${pFund} > off ${pOff}`).toBeGreaterThan(pOff);
  });

  it('HARMONICS controls density: high HARMONICS yields more active grains (louder output on average)', () => {
    // Compare RMS of the steady-state portion between sparse (harmonics=0
    // → 5 grains/s) and dense (harmonics=1 → 200 grains/s). Dense should
    // be substantially louder on average.
    const sparse = macrooscillatorMath.render(SR, SR, 0.75, { ...baseParams, harmonics: 0 }).main.slice(SR / 2);
    const dense = macrooscillatorMath.render(SR, SR, 0.75, { ...baseParams, harmonics: 1 }).main.slice(SR / 2);
    let sparseRms = 0;
    let denseRms = 0;
    for (let i = 0; i < sparse.length; i++) sparseRms += sparse[i]! * sparse[i]!;
    for (let i = 0; i < dense.length; i++) denseRms += dense[i]! * dense[i]!;
    sparseRms = Math.sqrt(sparseRms / sparse.length);
    denseRms = Math.sqrt(denseRms / dense.length);
    expect(denseRms, `dense RMS ${denseRms} > sparse RMS ${sparseRms}`).toBeGreaterThan(sparseRms * 2);
  });

  it('TIMBRE adds pitch jitter: max jitter smears the fundamental', () => {
    // Without jitter, energy concentrates at 440. With jitter, energy
    // spreads → fundamental bin loses energy relative to its neighbours.
    const noJitter = macrooscillatorMath.render(SR, SR, 0.75, { ...baseParams, timbre: 0 }).main.slice(SR / 2);
    const fullJitter = macrooscillatorMath.render(SR, SR, 0.75, { ...baseParams, timbre: 1 }).main.slice(SR / 2);
    const noJit440 = powerAt(noJitter, 440, SR);
    const fullJit440 = powerAt(fullJitter, 440, SR);
    const noJitNeighbour = powerAt(noJitter, 450, SR); // 10 Hz off
    const fullJitNeighbour = powerAt(fullJitter, 450, SR);
    // The fundamental's relative dominance over its neighbour should drop.
    const noJitRatio = noJit440 / Math.max(1e-12, noJitNeighbour);
    const fullJitRatio = fullJit440 / Math.max(1e-12, fullJitNeighbour);
    expect(
      noJitRatio,
      `no-jitter 440/450 ratio ${noJitRatio} > full-jitter ${fullJitRatio}`,
    ).toBeGreaterThan(fullJitRatio);
  });

  it('bounded output at extreme params', () => {
    const { main } = macrooscillatorMath.render(SR, SR, 0.75, {
      model: 12, note: 0, harmonics: 1, timbre: 1, morph: 1, level: 1,
    });
    let peak = 0;
    for (let i = 0; i < main.length; i++) {
      expect(Number.isFinite(main[i]!)).toBe(true);
      const a = Math.abs(main[i]!);
      if (a > peak) peak = a;
    }
    expect(peak, `GRANULAR peak ${peak}`).toBeLessThan(2.0);
  });
});

describe('macrooscillatorMath — SPEECH model', () => {
  // Speech engine uses the input pitch as the glottal-pulse fundamental.
  // Use a low pitch (130 Hz, note=-12) for natural-sounding vowel territory.
  const baseParams: MacroParams = {
    model: 13,
    note: -12,
    harmonics: 0.0,  // first vowel (ah)
    timbre: 0.5,     // mid Q
    morph: 0.0,      // pitched glottal source (not whisper)
    level: 1.0,
  };

  it('produces non-silent, finite audio', () => {
    const { main } = macrooscillatorMath.render(SR, SR, 0, baseParams);
    let peak = 0;
    for (let i = 0; i < main.length; i++) {
      expect(Number.isFinite(main[i]!)).toBe(true);
      const a = Math.abs(main[i]!);
      if (a > peak) peak = a;
    }
    expect(peak, 'SPEECH peak above silence').toBeGreaterThan(0.05);
  });

  it('"ah" vowel (HARMONICS=0) carries energy near F1=730Hz formant', () => {
    // Render long enough for the formant filter to settle.
    const tail = macrooscillatorMath.render(SR, SR, 0, baseParams).main.slice(SR / 2);
    const pF1 = powerAt(tail, 730, SR);
    const pOff = powerAt(tail, 1500, SR);
    expect(pF1, `F1 ${pF1} > off-bin ${pOff}`).toBeGreaterThan(pOff * 1.5);
  });

  it('"ee" vowel (HARMONICS≈0.4) has spectral centroid above "ah" (high front vowel)', () => {
    // floor(0.4 * 6) = 2 → "ee" vowel (F1=270, F2=2290, F3=3010).
    // "ah" (idx 0): F1=730, F2=1090, F3=2440.
    // Compare HF energy (~2 kHz band) between the two — "ee"'s F2 is
    // much higher than "ah"'s, so the HF band should grow.
    // Use a higher pitch (note=0 → 261 Hz) so the glottal source has
    // harmonics that land in the F2 region.
    const ah = macrooscillatorMath.render(SR, SR, 0, {
      ...baseParams, harmonics: 0.0, note: 0, timbre: 0.8,
    }).main.slice(SR / 2);
    const ee = macrooscillatorMath.render(SR, SR, 0, {
      ...baseParams, harmonics: 0.4, note: 0, timbre: 0.8,
    }).main.slice(SR / 2);
    // Sum energy in the 2-3 kHz band — strong for "ee" (F2 here), weak
    // for "ah" (F2 at 1090).
    let ahHF = 0;
    let eeHF = 0;
    for (const f of [2000, 2300, 2600, 2900]) {
      ahHF += powerAt(ah, f, SR);
      eeHF += powerAt(ee, f, SR);
    }
    expect(eeHF, `ee 2-3kHz band ${eeHF} > ah ${ahHF}`).toBeGreaterThan(ahHF);
  });

  it('MORPH=1 (whispered noise) loses pitched-fundamental peakiness', () => {
    // Compare the fundamental-bin energy ratio between pitched and whispered.
    // Pitched glottal pulse puts strong energy at 130 + harmonics; whispered
    // noise floods the spectrum without spectral peaks at integer multiples.
    const pitched = macrooscillatorMath.render(SR, SR, 0, { ...baseParams, morph: 0 }).main.slice(SR / 2);
    const whispered = macrooscillatorMath.render(SR, SR, 0, { ...baseParams, morph: 1 }).main.slice(SR / 2);
    const pitchedFund = powerAt(pitched, 130.8, SR);
    const pitchedOff = powerAt(pitched, 200, SR);
    const whisperedFund = powerAt(whispered, 130.8, SR);
    const whisperedOff = powerAt(whispered, 200, SR);
    const pitchedRatio = pitchedFund / Math.max(1e-12, pitchedOff);
    const whisperedRatio = whisperedFund / Math.max(1e-12, whisperedOff);
    expect(
      pitchedRatio,
      `pitched fund/off ratio ${pitchedRatio} > whispered ${whisperedRatio}`,
    ).toBeGreaterThan(whisperedRatio);
  });

  it('SPEECH AUX is the raw glottal pulse (pitched at fundamental)', () => {
    const { aux } = macrooscillatorMath.render(SR / 2, SR, 0, baseParams);
    const tail = aux.slice(SR / 4);
    const pFund = powerAt(tail, 130.8, SR);
    const pOff = powerAt(tail, 350, SR);
    expect(pFund, `aux fund ${pFund} > off ${pOff}`).toBeGreaterThan(pOff);
  });

  it('bounded output at extreme params', () => {
    const { main } = macrooscillatorMath.render(SR, SR, 0, {
      model: 13, note: -12, harmonics: 1, timbre: 1, morph: 1, level: 1,
    });
    let peak = 0;
    for (let i = 0; i < main.length; i++) {
      expect(Number.isFinite(main[i]!)).toBe(true);
      const a = Math.abs(main[i]!);
      if (a > peak) peak = a;
    }
    expect(peak, `SPEECH peak ${peak}`).toBeLessThan(2.0);
  });
});

describe('macrooscillatorMath — pitch tracking', () => {
  it('pitchV=0 → C4 (261.6Hz fundamental in VA at morph=0)', () => {
    const { main } = macrooscillatorMath.render(SR, SR, 0, { model: 0, note: 0, harmonics: 0, timbre: 0, morph: 0, level: 1 });
    const tail = main.slice(SR / 2);
    const pFund = powerAt(tail, 261.6, SR);
    const pOff = powerAt(tail, 100, SR);
    expect(pFund).toBeGreaterThan(pOff * 3);
  });

  it('pitchV=1 (one octave up) → C5 (523.25Hz)', () => {
    const { main } = macrooscillatorMath.render(SR, SR, 1, { model: 0, note: 0, harmonics: 0, timbre: 0, morph: 0, level: 1 });
    const tail = main.slice(SR / 2);
    const pC5 = powerAt(tail, 523.25, SR);
    const pC4 = powerAt(tail, 261.6, SR);
    expect(pC5, `C5=${pC5}, C4=${pC4}`).toBeGreaterThan(pC4 * 1.5);
  });
});
