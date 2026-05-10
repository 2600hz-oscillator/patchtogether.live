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
    expect(meowboxDef.label).toBe('MEOWBOX');
    expect(meowboxDef.category).toBe('sources');
  });

  it('schema is at v2 (post V/oct fix)', () => {
    // v1 declared `pitch` as a 'cv' input with paramTarget; v2 makes it a
    // true 'pitch' (V/oct audio-rate) input. The persisted-data shape did
    // not change (no params/data renamed), so saves load unchanged — but
    // we bump the version anyway to record the behavioral fix and to
    // enable a future migrate() if needed.
    expect(meowboxDef.schemaVersion).toBe(2);
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
