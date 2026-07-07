// packages/web/src/lib/audio/modules/writeseq.test.ts
//
// Unit tests for the WRITESEQ pure-data helpers + def shape:
//   - coerceStep / coerceSteps   (Yjs/persisted shape normalisation; preserves
//                                 a finite FUTURE-ROOM shift, ignores OOR midi)
//   - quantizeToNearestStep      (before-midpoint → same; at/after → next; wrap
//                                 at length; stepDur<=0 → current)
//   - resolveStepVOct            (0V = C4 = MIDI 60 round-trip)
//   - vOctToMidi round-trip      (0V = C4 = 60)
//   - def shape                  (inputs cv/gate/clock/rec + transport spread;
//                                 outputs pitch/gate/clock; recArm+overdub
//                                 default 0; length default 16; palette)
//
// The audio-thread tick + ConstantSourceNode wiring + the no-off-by-one
// alignment guarantee are exercised by writeseq-alignment.test.ts (the
// deterministic sample-accurate DRUMMERGIRL gate) + writeseq-transport.test.ts.

import { describe, expect, it } from 'vitest';
import {
  coerceStep,
  coerceSteps,
  defaultStep,
  defaultSteps,
  resolveStepVOct,
  quantizeToNearestStep,
  STEP_COUNT,
} from './writeseq';
import { C4_MIDI, midiToVOct, vOctToMidi } from '$lib/audio/note-entry';

describe('coerceStep', () => {
  it('returns default for non-object input', () => {
    expect(coerceStep(null)).toEqual(defaultStep());
    expect(coerceStep(undefined)).toEqual(defaultStep());
    expect(coerceStep(42)).toEqual(defaultStep());
    expect(coerceStep('x')).toEqual(defaultStep());
  });

  it('default step is off, midi = C4', () => {
    expect(defaultStep()).toEqual({ on: false, midi: C4_MIDI });
  });

  it('accepts a fully-typed step', () => {
    expect(coerceStep({ on: true, midi: 60 })).toEqual({ on: true, midi: 60 });
  });

  it('rounds non-integer midi', () => {
    expect(coerceStep({ on: false, midi: 60.4 }).midi).toBe(60);
    expect(coerceStep({ on: false, midi: 60.6 }).midi).toBe(61);
  });

  it('rejects midi outside 0..127 (never reads past 127)', () => {
    expect(coerceStep({ on: false, midi: -1 }).midi).toBeNull();
    expect(coerceStep({ on: false, midi: 128 }).midi).toBeNull();
    expect(coerceStep({ on: true, midi: 127 }).midi).toBe(127);
    expect(coerceStep({ on: true, midi: 0 }).midi).toBe(0);
  });

  it('explicit null midi stays null', () => {
    expect(coerceStep({ on: true, midi: null }).midi).toBeNull();
  });

  it('missing midi field → C4 default', () => {
    expect(coerceStep({ on: false }).midi).toBe(C4_MIDI);
  });

  it('FUTURE-ROOM: preserves a finite shift, clamped to [-0.5, +0.5]', () => {
    expect(coerceStep({ on: true, midi: 60, shift: 0.25 }).shift).toBe(0.25);
    expect(coerceStep({ on: true, midi: 60, shift: -0.5 }).shift).toBe(-0.5);
    // Out-of-range clamps (not dropped — the field still means "shifted").
    expect(coerceStep({ on: true, midi: 60, shift: 0.9 }).shift).toBe(0.5);
    expect(coerceStep({ on: true, midi: 60, shift: -2 }).shift).toBe(-0.5);
  });

  it('FUTURE-ROOM: a non-finite / non-number shift leaves the field undefined', () => {
    expect(coerceStep({ on: true, midi: 60, shift: NaN }).shift).toBeUndefined();
    expect(coerceStep({ on: true, midi: 60, shift: 'x' }).shift).toBeUndefined();
    expect(coerceStep({ on: true, midi: 60 }).shift).toBeUndefined();
    expect('shift' in coerceStep({ on: true, midi: 60 })).toBe(false);
  });
});

describe('coerceSteps', () => {
  it('returns default STEP_COUNT-length array for non-array input', () => {
    expect(coerceSteps(null)).toHaveLength(STEP_COUNT);
    expect(coerceSteps(undefined)).toHaveLength(STEP_COUNT);
    expect(coerceSteps({})).toHaveLength(STEP_COUNT);
    expect(coerceSteps(coerceSteps(null))).toEqual(defaultSteps());
  });

  it('pads short arrays to STEP_COUNT (preserves existing slots)', () => {
    const out = coerceSteps([{ on: true, midi: 60 }]);
    expect(out).toHaveLength(STEP_COUNT);
    expect(out[0]).toEqual({ on: true, midi: 60 });
    for (let i = 1; i < STEP_COUNT; i++) {
      expect(out[i], `step ${i}`).toEqual(defaultStep());
    }
  });

  it('preserves a finite shift across an array coerce', () => {
    const out = coerceSteps([{ on: true, midi: 64, shift: 0.1 }]);
    expect(out[0]).toEqual({ on: true, midi: 64, shift: 0.1 });
  });
});

describe('quantizeToNearestStep', () => {
  const stepDur = 0.125; // 16th @ 120 bpm
  const start = 1.0;
  const len = 16;

  it('before the midpoint → current step', () => {
    expect(quantizeToNearestStep(start, 3, start, stepDur, len)).toBe(3);
    expect(quantizeToNearestStep(start + stepDur * 0.49, 3, start, stepDur, len)).toBe(3);
  });

  it('at / after the midpoint → next step', () => {
    expect(quantizeToNearestStep(start + stepDur * 0.5, 3, start, stepDur, len)).toBe(4);
    expect(quantizeToNearestStep(start + stepDur * 0.99, 3, start, stepDur, len)).toBe(4);
  });

  it('wraps the next step at length', () => {
    expect(quantizeToNearestStep(start + stepDur * 0.6, len - 1, start, stepDur, len)).toBe(0);
  });

  it('an on-beat press (press ≈ start) → current step (no off-by-one)', () => {
    // press a hair before AND a hair after start, both well before the midpoint.
    expect(quantizeToNearestStep(start - 0.001, 0, start, stepDur, len)).toBe(0);
    expect(quantizeToNearestStep(start + 0.001, 0, start, stepDur, len)).toBe(0);
  });

  it('stepDur <= 0 → current step', () => {
    expect(quantizeToNearestStep(start + 1, 5, start, 0, len)).toBe(5);
    expect(quantizeToNearestStep(start + 1, 5, start, -1, len)).toBe(5);
  });

  it('clamps length to [1, STEP_COUNT]', () => {
    // length 0 → clamped to 1, so everything maps to step 0.
    expect(quantizeToNearestStep(start, 0, start, stepDur, 0)).toBe(0);
    expect(quantizeToNearestStep(start + stepDur * 0.6, 0, start, stepDur, 1)).toBe(0);
  });
});

describe('resolveStepVOct + vOctToMidi round-trip', () => {
  it('0V = C4 = MIDI 60', () => {
    expect(midiToVOct(C4_MIDI)).toBe(0);
    expect(vOctToMidi(0)).toBe(C4_MIDI);
  });

  it('resolveStepVOct uses midi → V/oct + global octave; null falls back to C4', () => {
    expect(resolveStepVOct({ on: true, midi: 60 }, 0)).toBe(0);
    expect(resolveStepVOct({ on: true, midi: 72 }, 0)).toBe(1); // +1 octave
    expect(resolveStepVOct({ on: true, midi: null }, 0)).toBe(0); // C4 fallback
    expect(resolveStepVOct({ on: true, midi: 60 }, 1)).toBe(1); // global octave
  });

  it('vOctToMidi inverts midiToVOct across a sweep', () => {
    for (let m = 36; m <= 96; m++) {
      expect(vOctToMidi(midiToVOct(m))).toBe(m);
    }
  });
});
