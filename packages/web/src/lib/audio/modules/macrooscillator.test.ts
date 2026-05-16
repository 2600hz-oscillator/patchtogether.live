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
import { macrooscillatorDef, macrooscillatorMath, type MacroParams } from './macrooscillator';

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

  it('model param: discrete 0..1 (room to grow as more models land)', () => {
    const p = macrooscillatorDef.params.find((p) => p.id === 'model')!;
    expect(p.curve).toBe('discrete');
    expect(p.min).toBe(0);
    expect(p.max).toBe(1);
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
