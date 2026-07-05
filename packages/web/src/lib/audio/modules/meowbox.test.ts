// packages/web/src/lib/audio/modules/meowbox.test.ts
//
// Unit tests for MEOWBOX module-def shape + the V/oct → Hz conversion mirror
// of the Faust DSP. The full DSP rendering path is exercised by the ART
// scenario in art/scenarios/meowbox/voct-tracking.test.ts.
//
// Background: prior to PR fix/meowbox-voct, the `pitch` input was declared
// `type: 'cv'` with `paramTarget: 'pitch'`, which routed sequencer V/oct
// (1V = 1 octave) directly into a Faust hslider that was interpreted as
// SEMITONES — so 1V from a sequencer produced a +1 semitone shift instead
// of a +1 octave shift. These tests pin the corrected behavior:
//
//   pitch CV +1V == 1 octave up == 2× freq
//   pitch CV  0V == C4 (261.6256 Hz)
//   pitch port type == 'pitch' (V/oct audio-rate, not 'cv'/AudioParam)

import { describe, expect, it } from 'vitest';
import { MEOWBOX_C4_HZ, meowboxBaseFreqHz, meowboxDef } from './meowbox';

describe('meowboxDef: module-def shape', () => {
  it('declares type=meowbox, label=MEOWBOX, category=sources', () => {
    expect(meowboxDef.type).toBe('meowbox');
    expect(meowboxDef.label).toBe('meowbox');
    expect(meowboxDef.category).toBe('sources');
  });

  it('schemaVersion is 1 (no load-time migration)', () => {
    // The `pitch` input port type changed from 'cv' to a true 'pitch' (V/oct
    // audio-rate) input, but the persisted-data shape did not change (no
    // params/data renamed), so saves load unchanged with no migrate callback.
    expect(meowboxDef.schemaVersion).toBe(1);
  });

  it('declares 5 input ports: gate, pitch, morph, decay, level', () => {
    const ids = meowboxDef.inputs.map((p) => p.id).sort();
    expect(ids).toEqual(['decay', 'gate', 'level', 'morph', 'pitch']);
  });

  it('pitch input is type=pitch (1V/oct), NOT cv (the bug being fixed)', () => {
    const pitch = meowboxDef.inputs.find((p) => p.id === 'pitch');
    expect(pitch).toBeDefined();
    // The whole point of this PR: the cable type must be 'pitch' so that
    // sequencer/score/keys outputs (which are 1V/oct) connect with matching
    // semantics, and the engine routes audio-rate V/oct to the Faust input
    // channel rather than to an AudioParam interpreted as semitones.
    expect(pitch!.type).toBe('pitch');
    // 'pitch' inputs do NOT use paramTarget — they're audio-rate node-to-node
    // connections. paramTarget is only meaningful for 'cv' inputs.
    expect(pitch!.paramTarget).toBeUndefined();
  });

  it('gate input is type=gate', () => {
    const gate = meowboxDef.inputs.find((p) => p.id === 'gate');
    expect(gate?.type).toBe('gate');
  });

  it('non-pitch CV inputs (morph, decay, level) keep type=cv with paramTarget', () => {
    for (const id of ['morph', 'decay', 'level']) {
      const p = meowboxDef.inputs.find((x) => x.id === id);
      expect(p, `${id} port exists`).toBeDefined();
      expect(p!.type).toBe('cv');
      expect(p!.paramTarget).toBe(id);
    }
  });

  it('pitch knob is a transposition in semitones (range -36..+36)', () => {
    const p = meowboxDef.params.find((x) => x.id === 'pitch');
    expect(p).toBeDefined();
    expect(p!.units).toBe('semi');
    expect(p!.min).toBe(-36);
    expect(p!.max).toBe(36);
    expect(p!.defaultValue).toBe(0);
  });

  it('exposes 2 stereo audio outputs: L, R', () => {
    const ids = meowboxDef.outputs.map((p) => p.id).sort();
    expect(ids).toEqual(['L', 'R']);
    for (const o of meowboxDef.outputs) expect(o.type).toBe('audio');
  });
});

describe('meowboxBaseFreqHz: V/oct → Hz (mirrors Faust baseFreq)', () => {
  it('0V + 0 semis → C4 (261.6256 Hz)', () => {
    expect(meowboxBaseFreqHz(0, 0)).toBeCloseTo(MEOWBOX_C4_HZ, 4);
    expect(meowboxBaseFreqHz(0, 0)).toBeCloseTo(261.6256, 4);
  });

  it('+1V → C5 (523.2511 Hz, one octave up)', () => {
    expect(meowboxBaseFreqHz(1, 0)).toBeCloseTo(523.2511, 3);
  });

  it('-1V → C3 (130.8128 Hz, one octave down)', () => {
    expect(meowboxBaseFreqHz(-1, 0)).toBeCloseTo(130.8128, 3);
  });

  it('+0.5V → ~369.99 Hz (between C4 and C5, exponentially scaled)', () => {
    // 261.6256 * 2^0.5 = 261.6256 * 1.41421356 ≈ 369.9944 Hz (F#4 territory).
    expect(meowboxBaseFreqHz(0.5, 0)).toBeCloseTo(369.9944, 2);
  });

  it('+2V → C6 (1046.5023 Hz, two octaves up)', () => {
    expect(meowboxBaseFreqHz(2, 0)).toBeCloseTo(1046.5023, 2);
  });

  it('-2V → C2 (65.4064 Hz, two octaves down)', () => {
    expect(meowboxBaseFreqHz(-2, 0)).toBeCloseTo(65.4064, 3);
  });

  it('each +1V step doubles the frequency (geometric sequence)', () => {
    const freqs: number[] = [];
    for (let v = -2; v <= 2; v++) freqs.push(meowboxBaseFreqHz(v, 0));
    for (let i = 1; i < freqs.length; i++) {
      const ratio = freqs[i]! / freqs[i - 1]!;
      expect(ratio, `freqs[${i}]/freqs[${i-1}] should be 2 (one octave step)`).toBeCloseTo(2, 4);
    }
  });

  it('pitch knob = +12 semis is equivalent to +1V on the CV', () => {
    // 12 semitones = 1 octave, by definition.
    const viaKnob = meowboxBaseFreqHz(0, 12);
    const viaCv = meowboxBaseFreqHz(1, 0);
    expect(viaKnob).toBeCloseTo(viaCv, 4);
  });

  it('CV and knob add (analog-vco style): +1V CV + +12 semi knob = +2 oct', () => {
    const expected = MEOWBOX_C4_HZ * 4; // two octaves up
    expect(meowboxBaseFreqHz(1, 12)).toBeCloseTo(expected, 3);
  });

  it('pitch knob defaults (0) reproduce the no-CV no-knob C4 case', () => {
    // No CV connected = silent = 0V. Knob at default 0. ⇒ C4.
    const def = meowboxDef.params.find((p) => p.id === 'pitch')!;
    expect(meowboxBaseFreqHz(0, def.defaultValue)).toBeCloseTo(261.6256, 4);
  });

  it('A4-equivalent: +9 semis from C4 = 440 Hz', () => {
    // A4 is 9 semitones above C4. (Standard concert pitch reference.)
    expect(meowboxBaseFreqHz(0, 9)).toBeCloseTo(440.0, 1);
  });
});

describe('meowboxBaseFreqHz: knob ↔ CV equivalence (the user-reported invariant)', () => {
  // The bug report: "meowbox pitch cv input does not really track pitch and is
  // different behavior than the pitch control in the module". The fix lives in
  // packages/dsp/src/meowbox.dsp, where baseFreq sums CV (volts) + knob (semis/12)
  // inside a single exp2 — so the two paths are mathematically commutative and
  // any (V, semi) ↔ (V', semi') pair with `V + semi/12 = V' + semi'/12` yields
  // the same Hz. These cases nail down that invariant numerically; the actual
  // audible rendering is exercised in
  // art/scenarios/meowbox/voct-tracking.test.ts (FFT) and
  // e2e/tests/meowbox.spec.ts (sequencer → meowbox).
  //
  // ±2 cent tolerance — well below the just-noticeable-difference of ~5 cents
  // for trained ears, so any future regression that splits the two paths
  // would fail audibly AND fail this test.
  const TOL_CENTS = 2;
  const centsBetween = (a: number, b: number) => 1200 * Math.log2(a / b);

  function expectEquivalent(a: { v: number; s: number }, b: { v: number; s: number }, label: string) {
    const hzA = meowboxBaseFreqHz(a.v, a.s);
    const hzB = meowboxBaseFreqHz(b.v, b.s);
    const cents = Math.abs(centsBetween(hzA, hzB));
    expect(
      cents,
      `${label}: (${a.v}V,${a.s}semi)=${hzA.toFixed(3)} Hz vs (${b.v}V,${b.s}semi)=${hzB.toFixed(3)} Hz — diff ${cents.toFixed(2)} cents`,
    ).toBeLessThan(TOL_CENTS);
  }

  it('knob +12 semi (octave) ≡ CV +1V (octave) — at C4 baseline', () => {
    expectEquivalent({ v: 0, s: 12 }, { v: 1, s: 0 }, 'octave up via knob vs CV');
  });

  it('knob +24 semi ≡ CV +2V — two octaves', () => {
    expectEquivalent({ v: 0, s: 24 }, { v: 2, s: 0 }, 'two octaves up');
  });

  it('knob -12 semi ≡ CV -1V — octave down', () => {
    expectEquivalent({ v: 0, s: -12 }, { v: -1, s: 0 }, 'octave down');
  });

  it('partial split: knob +6 semi + CV +0.5V ≡ knob 0 + CV +1V (full octave)', () => {
    // The non-trivial case — the sum-point inside baseFreq must add linearly
    // before the exp2, not separately exp2 and multiply (which would also
    // give the right answer here but break for asymmetric splits).
    expectEquivalent({ v: 0.5, s: 6 }, { v: 1, s: 0 }, '½ knob + ½ CV vs full CV');
  });

  it('asymmetric: knob -12 semi + CV +2V ≡ knob 0 + CV +1V (CV - 1oct of knob)', () => {
    expectEquivalent({ v: 2, s: -12 }, { v: 1, s: 0 }, 'CV +2V minus 1oct knob == CV +1V');
  });

  it('fine-grained: knob +1 semi ≡ CV +1/12 V (the finest 1V/oct division)', () => {
    expectEquivalent({ v: 0, s: 1 }, { v: 1 / 12, s: 0 }, 'one semitone');
  });

  it('full knob range matches CV at ±3V (the knob spans ±3 octaves)', () => {
    // The pitch knob's -36..+36 semi range = ±3 octaves. So twisting the knob
    // fully one way matches the same pitch you'd get from a ±3V CV input —
    // confirming the knob is a true subset of V/oct semantics.
    expectEquivalent({ v: 0, s: 36 }, { v: 3, s: 0 }, 'knob max ≡ +3V CV');
    expectEquivalent({ v: 0, s: -36 }, { v: -3, s: 0 }, 'knob min ≡ -3V CV');
  });

  it('zero point: knob=0 + CV=0V always produces C4 (no DC offset bug)', () => {
    // Guards against a regression where someone might add a "+ 0.5" or "* 2"
    // term that breaks the (0,0) → C4 anchor.
    expect(meowboxBaseFreqHz(0, 0)).toBeCloseTo(MEOWBOX_C4_HZ, 6);
  });

  it('sweep equivalence: across 0..+1V, knob path equals CV path at every step', () => {
    // Walks the (V/oct CV) ↔ (knob semis) tradeoff in 1-semi steps from C4 up
    // to C5 (12 semis = 1 V). Every point must agree. This is the "the knob
    // is just a different control surface for the same V/oct quantity" claim.
    for (let s = 0; s <= 12; s++) {
      const viaKnob = meowboxBaseFreqHz(0, s);
      const viaCv = meowboxBaseFreqHz(s / 12, 0);
      const cents = Math.abs(centsBetween(viaKnob, viaCv));
      expect(
        cents,
        `step ${s}: knob=${s}semi (${viaKnob.toFixed(3)} Hz) vs CV=${(s/12).toFixed(4)}V (${viaCv.toFixed(3)} Hz) — diff ${cents.toFixed(3)} cents`,
      ).toBeLessThan(TOL_CENTS);
    }
  });
});
