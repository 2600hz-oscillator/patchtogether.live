// packages/web/src/lib/audio/modules/atlantis-catalyst.test.ts
//
// Module-def shape + pure-helper tests for SCENECHANGE (type id remains
// `atlantisCatalyst`). The orchestrator's actual audio behavior
// (setInterval-driven drift + scene transitions) is exercised by the
// Atlantis-patch E2E.

import { describe, it, expect } from 'vitest';
import {
  atlantisCatalystDef,
  driftRateKnobToMeanScenePeriodS,
  pickSceneTarget,
  makePrng,
  captureScene,
  applyScene,
  coerceScene,
  type CatalystScene,
} from './atlantis-catalyst';

describe('atlantisCatalystDef shape', () => {
  it('display label is SCENECHANGE (type id kept atlantisCatalyst for back-compat)', () => {
    expect(atlantisCatalystDef.label).toBe('SCENECHANGE');
    expect(atlantisCatalystDef.type).toBe('atlantisCatalyst');
  });

  it('declares 8 drift outputs + scene_pulse + scene_idx', () => {
    const ids = atlantisCatalystDef.outputs.map((p) => p.id).sort();
    expect(ids).toEqual([
      'drift1', 'drift2', 'drift3', 'drift4',
      'drift5', 'drift6', 'drift7', 'drift8',
      'scene_idx', 'scene_pulse',
    ]);
  });

  it('drift outputs are cv-typed', () => {
    for (let i = 1; i <= 8; i++) {
      const p = atlantisCatalystDef.outputs.find((o) => o.id === `drift${i}`);
      expect(p?.type).toBe('cv');
    }
  });

  it('scene_pulse is a gate; scene_idx is cv', () => {
    expect(atlantisCatalystDef.outputs.find((o) => o.id === 'scene_pulse')?.type).toBe('gate');
    expect(atlantisCatalystDef.outputs.find((o) => o.id === 'scene_idx')?.type).toBe('cv');
  });

  it('declares the HYDROGEN-style transport CV row (play/queue1..4)', () => {
    const inputs = atlantisCatalystDef.inputs.map((p) => p.id);
    for (const k of ['play_cv', 'queue1_cv', 'queue2_cv', 'queue3_cv', 'queue4_cv']) {
      expect(inputs, `missing transport input ${k}`).toContain(k);
    }
  });

  it('exposes nudge / freeze / seed_cv inputs', () => {
    const inputs = atlantisCatalystDef.inputs.map((p) => p.id);
    expect(inputs).toContain('nudge');
    expect(inputs).toContain('freeze');
    expect(inputs).toContain('seed_cv');
  });
});

describe('driftRateKnobToMeanScenePeriodS — log mapping', () => {
  it('knob=0 → max period (~240s)', () => {
    expect(driftRateKnobToMeanScenePeriodS(0)).toBeCloseTo(240, 0);
  });
  it('knob=1 → min period (~4s)', () => {
    expect(driftRateKnobToMeanScenePeriodS(1)).toBeCloseTo(4, 0);
  });
  it('knob=0.5 → geometric mean ~31s', () => {
    const mid = driftRateKnobToMeanScenePeriodS(0.5);
    expect(mid).toBeGreaterThan(25);
    expect(mid).toBeLessThan(40);
  });
});

describe('pickSceneTarget — coherence behaviour', () => {
  it('coherence=1 means every channel converges on the shared voltage (mostly)', () => {
    const prng = makePrng(42);
    const shared = 0.7;
    const next = pickSceneTarget({
      prng, bias: 0, sceneDepth: 1, coherence: 1, shared, current: 0,
    });
    // sceneDepth=1 → fully step toward shared+bias-current.
    expect(next).toBeCloseTo(shared, 5);
  });

  it('coherence=0 makes channels independent (depends only on prng)', () => {
    const a = pickSceneTarget({
      prng: makePrng(1), bias: 0, sceneDepth: 1, coherence: 0, shared: 0.7, current: 0,
    });
    const b = pickSceneTarget({
      prng: makePrng(2), bias: 0, sceneDepth: 1, coherence: 0, shared: 0.7, current: 0,
    });
    // Two independent prngs → different outputs even though shared is identical.
    expect(a).not.toBe(b);
  });

  it('sceneDepth=0 means no step at all (target == current)', () => {
    const next = pickSceneTarget({
      prng: makePrng(1), bias: 0.5, sceneDepth: 0, coherence: 0.5, shared: 0.7, current: 0.3,
    });
    expect(next).toBeCloseTo(0.3, 5);
  });

  it('clamps targets to [-1, +1]', () => {
    const next = pickSceneTarget({
      prng: makePrng(1), bias: 0.99, sceneDepth: 1, coherence: 1, shared: 0.99, current: 0.95,
    });
    expect(next).toBeGreaterThanOrEqual(-1);
    expect(next).toBeLessThanOrEqual(1);
  });
});

describe('makePrng — determinism', () => {
  it('same seed produces same sequence', () => {
    const a = makePrng(1234);
    const b = makePrng(1234);
    for (let i = 0; i < 10; i++) expect(a()).toBe(b());
  });

  it('different seeds produce different first values', () => {
    expect(makePrng(1)()).not.toBe(makePrng(2)());
  });
});

describe('captureScene / applyScene — round-trip', () => {
  const live = {
    driftRate: 0.42, chaos: 0.31, coherence: 0.66, sceneDepth: 0.81,
    autoMode: 1, bias: -0.25, level: 0.7,
  };
  const drift = [0.1, -0.2, 0.3, -0.4, 0.5, -0.6, 0.7, -0.8];

  it('captureScene records all 8 drift values + the 7 live params', () => {
    const snap = captureScene(live, drift);
    expect(snap.drift).toEqual(drift);
    expect(snap.driftRate).toBe(0.42);
    expect(snap.chaos).toBe(0.31);
    expect(snap.coherence).toBe(0.66);
    expect(snap.sceneDepth).toBe(0.81);
    expect(snap.autoMode).toBe(1);
    expect(snap.bias).toBe(-0.25);
    expect(snap.level).toBe(0.7);
  });

  it('captureScene pads short drift arrays to length 8 (defensive)', () => {
    const snap = captureScene(live, [0.1, 0.2]);
    expect(snap.drift).toHaveLength(8);
    expect(snap.drift[0]).toBe(0.1);
    expect(snap.drift[1]).toBe(0.2);
    expect(snap.drift[7]).toBe(0);
  });

  it('captureScene returns an own copy — mutating drift later does not bleed', () => {
    const driftMut = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
    const snap = captureScene(live, driftMut);
    driftMut[0] = 999;
    expect(snap.drift[0]).toBe(0.1);
  });

  it('applyScene restores every live param into the passed-in object (mutates in place)', () => {
    const snap = captureScene(live, drift);
    const target = {
      driftRate: 0, chaos: 0, coherence: 0, sceneDepth: 0,
      autoMode: 0, bias: 0, level: 0,
    };
    const result = applyScene(snap, target);
    expect(result.live).toBe(target);
    expect(target.driftRate).toBe(0.42);
    expect(target.chaos).toBe(0.31);
    expect(target.coherence).toBe(0.66);
    expect(target.sceneDepth).toBe(0.81);
    expect(target.autoMode).toBe(1);
    expect(target.bias).toBe(-0.25);
    expect(target.level).toBe(0.7);
  });

  it('applyScene returns driftTargets in [-1, 1] (clamped)', () => {
    const wild: CatalystScene = {
      driftRate: 0, chaos: 0, coherence: 0, sceneDepth: 0,
      autoMode: 0, bias: 0, level: 0,
      drift: [99, -99, 0, 0, 0, 0, 0, 0],
    };
    const target = {
      driftRate: 0, chaos: 0, coherence: 0, sceneDepth: 0,
      autoMode: 0, bias: 0, level: 0,
    };
    const { driftTargets } = applyScene(wild, target);
    expect(driftTargets[0]).toBe(1);
    expect(driftTargets[1]).toBe(-1);
  });
});

describe('coerceScene — defensive parsing', () => {
  it('returns null for non-object input', () => {
    expect(coerceScene(null)).toBeNull();
    expect(coerceScene(undefined)).toBeNull();
    expect(coerceScene(42)).toBeNull();
    expect(coerceScene('hello')).toBeNull();
  });

  it('returns null when drift is not an array', () => {
    expect(coerceScene({ drift: 'oops' })).toBeNull();
    expect(coerceScene({ })).toBeNull();
  });

  it('coerces a valid object round-tripped through JSON', () => {
    const snap = captureScene(
      { driftRate: 0.5, chaos: 0.6, coherence: 0.7, sceneDepth: 0.8, autoMode: 1, bias: 0.1, level: 0.9 },
      [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
    );
    const jsoned = JSON.parse(JSON.stringify(snap));
    const back = coerceScene(jsoned);
    expect(back).not.toBeNull();
    expect(back!.drift).toEqual(snap.drift);
    expect(back!.driftRate).toBe(0.5);
    expect(back!.level).toBe(0.9);
  });

  it('clamps drift values to [-1, +1] when reading from arbitrary input', () => {
    const back = coerceScene({
      drift: [5, -5, 0.5, -0.5, 0, 0, 0, 0],
      driftRate: 0.5, chaos: 0.5, coherence: 0.5, sceneDepth: 0.5,
      autoMode: 1, bias: 0, level: 1,
    });
    expect(back).not.toBeNull();
    expect(back!.drift[0]).toBe(1);
    expect(back!.drift[1]).toBe(-1);
    expect(back!.drift[2]).toBe(0.5);
  });

  it('falls back to defaults for missing numeric fields', () => {
    const back = coerceScene({ drift: [0, 0, 0, 0, 0, 0, 0, 0] });
    expect(back).not.toBeNull();
    expect(typeof back!.driftRate).toBe('number');
    expect(typeof back!.level).toBe('number');
  });
});
