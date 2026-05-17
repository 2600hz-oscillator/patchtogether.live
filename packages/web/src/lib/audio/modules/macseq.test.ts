// packages/web/src/lib/audio/modules/macseq.test.ts
//
// Unit tests for the MACSEQ pure-data helpers:
//   - coerceStep + coerceSteps   (Yjs/persisted shape normalisation)
//   - resolveStepVOct            (pitch resolution; matches base sequencer)
//   - resolveStepModelCv         (MODELCV resolution + HOLD-LAST policy)
//   - MODEL_NAMES                (every name maps to a legal modelIndex)
//
// The audio-thread tick + ConstantSourceNode wiring is exercised by the
// Playwright E2E (e2e/tests/macseq.spec.ts), which is the load-bearing
// integration test for this module.

import { describe, expect, it } from 'vitest';
import {
  coerceStep,
  coerceSteps,
  defaultStep,
  defaultSteps,
  resolveStepVOct,
  resolveStepModelCv,
  mapModelIndexToCv,
  macseqDef,
  MODEL_NAMES,
  MACRO_MAX_MODEL,
  STEP_COUNT,
  type MacseqStep,
} from './macseq';
import { C3_MIDI, midiToVOct } from '$lib/audio/note-entry';
import { scaleCv } from '$lib/audio/cv-scale';

describe('coerceStep', () => {
  it('returns default for non-object input', () => {
    expect(coerceStep(null)).toEqual(defaultStep());
    expect(coerceStep(undefined)).toEqual(defaultStep());
    expect(coerceStep(42)).toEqual(defaultStep());
    expect(coerceStep('x')).toEqual(defaultStep());
  });

  it('accepts a fully-typed step', () => {
    const raw = { on: true, midi: 60, model: 7 };
    expect(coerceStep(raw)).toEqual({ on: true, midi: 60, model: 7 });
  });

  it('rounds non-integer midi', () => {
    expect(coerceStep({ on: false, midi: 60.4, model: 0 }).midi).toBe(60);
    expect(coerceStep({ on: false, midi: 60.6, model: 0 }).midi).toBe(61);
  });

  it('rejects midi outside 33..114', () => {
    expect(coerceStep({ on: false, midi: 32, model: 0 }).midi).toBeNull();
    expect(coerceStep({ on: false, midi: 115, model: 0 }).midi).toBeNull();
  });

  it('null model passes through as null', () => {
    expect(coerceStep({ on: true, midi: 60, model: null }).model).toBeNull();
  });

  it('rounds non-integer model and clamps to legal range', () => {
    expect(coerceStep({ on: true, midi: 60, model: 3.4 }).model).toBe(3);
    expect(coerceStep({ on: true, midi: 60, model: 3.6 }).model).toBe(4);
    // Out-of-range models drop to null (treated as "unset" → HOLD-LAST at
    // run time), rather than silently clamping which would mask data bugs.
    expect(coerceStep({ on: true, midi: 60, model: -1 }).model).toBeNull();
    expect(coerceStep({ on: true, midi: 60, model: MACRO_MAX_MODEL + 1 }).model).toBeNull();
  });

  it('missing model field → null (unset)', () => {
    expect(coerceStep({ on: true, midi: 60 }).model).toBeNull();
  });

  it('missing midi field → C3 default (matches base sequencer)', () => {
    expect(coerceStep({ on: false, model: 5 }).midi).toBe(C3_MIDI);
  });
});

describe('coerceSteps', () => {
  it('returns default STEP_COUNT-length array for non-array input', () => {
    expect(coerceSteps(null)).toHaveLength(STEP_COUNT);
    expect(coerceSteps(undefined)).toHaveLength(STEP_COUNT);
    expect(coerceSteps({})).toHaveLength(STEP_COUNT);
    expect(coerceSteps(coerceSteps(null))).toEqual(defaultSteps());
  });

  it('pads short arrays to length STEP_COUNT (preserves existing slots)', () => {
    const out = coerceSteps([{ on: true, midi: 60, model: 0 }]);
    expect(out).toHaveLength(STEP_COUNT);
    expect(out[0]).toEqual({ on: true, midi: 60, model: 0 });
    for (let i = 1; i < STEP_COUNT; i++) {
      expect(out[i], `step ${i}`).toEqual(defaultStep());
    }
  });

  it('backward-compat: a length-16 saved array widens to STEP_COUNT with empty tail', () => {
    // Pre-pages PR saved 16 steps; old patches must load without losing data
    // (slots 0..15 preserved, 16..127 default-empty).
    const old = Array.from({ length: 16 }, (_, i) => ({ on: i % 2 === 0, midi: 60 + i, model: 0 }));
    const out = coerceSteps(old);
    expect(out).toHaveLength(STEP_COUNT);
    for (let i = 0; i < 16; i++) {
      expect(out[i], `legacy step ${i}`).toEqual({ on: i % 2 === 0, midi: 60 + i, model: 0 });
    }
    for (let i = 16; i < STEP_COUNT; i++) {
      expect(out[i], `widened tail step ${i}`).toEqual(defaultStep());
    }
  });

  it('truncates over-long arrays to STEP_COUNT', () => {
    const raw = Array.from({ length: STEP_COUNT + 16 }, () => ({ on: true, midi: 60, model: 1 }));
    const out = coerceSteps(raw);
    expect(out).toHaveLength(STEP_COUNT);
  });
});

describe('resolveStepVOct (pitch math — matches base sequencer)', () => {
  it('null midi falls back to C3', () => {
    const step: MacseqStep = { on: true, midi: null, model: 0 };
    expect(resolveStepVOct(step, 0)).toBeCloseTo(midiToVOct(C3_MIDI), 12);
  });

  it('uses explicit midi when set', () => {
    const step: MacseqStep = { on: true, midi: 60, model: 0 }; // C4 = 0V
    expect(resolveStepVOct(step, 0)).toBeCloseTo(midiToVOct(60), 12);
  });

  it('adds global octave param after V/oct conversion', () => {
    const step: MacseqStep = { on: true, midi: 60, model: 0 };
    expect(resolveStepVOct(step, 1)).toBeCloseTo(midiToVOct(60) + 1, 12);
    expect(resolveStepVOct(step, -2)).toBeCloseTo(midiToVOct(60) - 2, 12);
  });
});

describe('resolveStepModelCv (MODELCV resolution + HOLD-LAST policy)', () => {
  it('returns the step model when set', () => {
    const step: MacseqStep = { on: true, midi: 60, model: 7 };
    expect(resolveStepModelCv(step, 0)).toBe(7);
  });

  it('null model holds the last emitted value (HOLD-LAST)', () => {
    const step: MacseqStep = { on: false, midi: null, model: null };
    expect(resolveStepModelCv(step, 0)).toBe(0);
    expect(resolveStepModelCv(step, 5)).toBe(5);
    expect(resolveStepModelCv(step, MACRO_MAX_MODEL)).toBe(MACRO_MAX_MODEL);
  });

  it('emits model even on OFF steps (model is continuous, not gated)', () => {
    const step: MacseqStep = { on: false, midi: 60, model: 9 };
    expect(resolveStepModelCv(step, 0)).toBe(9);
  });
});

describe('mapModelIndexToCv (round-trip via discrete CV scaler)', () => {
  it('idx=0 → cv=-1, idx=MAX → cv=+1', () => {
    expect(mapModelIndexToCv(0)).toBeCloseTo(-1, 12);
    expect(mapModelIndexToCv(MACRO_MAX_MODEL)).toBeCloseTo(1, 12);
  });

  it('clamps out-of-range input', () => {
    expect(mapModelIndexToCv(-5)).toBeCloseTo(-1, 12);
    expect(mapModelIndexToCv(MACRO_MAX_MODEL + 99)).toBeCloseTo(1, 12);
  });

  it('rounds non-integer input', () => {
    // 7.4 → 7, 7.6 → 8
    expect(mapModelIndexToCv(7.4)).toBeCloseTo(mapModelIndexToCv(7), 12);
    expect(mapModelIndexToCv(7.6)).toBeCloseTo(mapModelIndexToCv(8), 12);
  });

  it('every legal idx round-trips through the engine discrete CV scaler', () => {
    // Simulates the MACSEQ → MODELCV (-1..+1) → MACROOSCILLATOR.model_cv
    // (cvScale: 'discrete', paramTarget: 'model', min=0 max=MACRO_MAX_MODEL)
    // round-trip. `scaleCv` is the math the engine's audio-graph scaler
    // emits per sample (knob=0 because the param has no manual offset in
    // this test). The output must equal the input idx for every legal
    // index — that's the contract MACSEQ depends on.
    const hint = { mode: 'discrete' as const };
    for (let idx = 0; idx <= MACRO_MAX_MODEL; idx++) {
      const cv = mapModelIndexToCv(idx);
      const recovered = scaleCv(cv, 0, 0, MACRO_MAX_MODEL, hint);
      expect(recovered, `idx=${idx} (${MODEL_NAMES[idx]}), cv=${cv}`).toBe(idx);
    }
  });
});

describe('MODEL_NAMES (single source of truth)', () => {
  it('covers every legal modelIndex', () => {
    expect(MODEL_NAMES).toHaveLength(MACRO_MAX_MODEL + 1);
  });

  it('every name maps to a valid integer modelIndex via array position', () => {
    for (let idx = 0; idx < MODEL_NAMES.length; idx++) {
      const name = MODEL_NAMES[idx];
      expect(name, `index ${idx}`).toBeTruthy();
      // The MODELCV value for a step pointing at MODEL_NAMES[idx] is the
      // integer `idx` — that's the whole contract between MACSEQ and the
      // MACROOSCILLATOR's `model` AudioParam.
      const step: MacseqStep = { on: true, midi: 60, model: idx };
      expect(resolveStepModelCv(step, 0), `name=${name}`).toBe(idx);
    }
  });

  it('contains the documented Plaits-style engine roster', () => {
    // Locking the order down so a reorder in macrooscillator.ts is loud:
    // MACSEQ saves persist `model: <integer>`, so the mapping must stay
    // stable across versions (or a migration must be written).
    expect(MODEL_NAMES).toEqual([
      'VA', 'WAVESHAPE', 'FM 2OP', 'FM 6OP', 'CHORD', 'ADDITIVE',
      'STRING', 'MODAL', 'KICK', 'SNARE', 'HIHAT', 'WAVETABLE', 'GRANULAR',
      'SPEECH',
    ]);
  });
});

describe('macseqDef (module def shape)', () => {
  it('declares the three signature outputs (pitch, gate, modelcv) + clock', () => {
    const ids = macseqDef.outputs.map((o) => o.id);
    expect(ids).toContain('pitch');
    expect(ids).toContain('gate');
    expect(ids).toContain('modelcv');
    expect(ids).toContain('clock');
  });

  it('MODELCV is a `cv` cable so it terminates on macrooscillator.model_cv', () => {
    const modelcv = macseqDef.outputs.find((o) => o.id === 'modelcv');
    expect(modelcv).toBeDefined();
    expect(modelcv!.type).toBe('cv');
  });

  it('inputs include external clock-in', () => {
    const ids = macseqDef.inputs.map((i) => i.id);
    expect(ids).toContain('clock');
  });

  it('isPlaying param defaults to 0 (explicit play)', () => {
    const p = macseqDef.params.find((x) => x.id === 'isPlaying');
    expect(p?.defaultValue).toBe(0);
  });

  it('has 128 steps (STEP_COUNT) — page-nav PR widened capacity', () => {
    expect(STEP_COUNT).toBe(128);
    expect(defaultSteps()).toHaveLength(128);
  });

  it('length param: max=128, default=16 (1 page of audible steps)', () => {
    const p = macseqDef.params.find((x) => x.id === 'length');
    expect(p?.max).toBe(128);
    expect(p?.defaultValue).toBe(16);
    expect(p?.min).toBe(1);
  });
});
