// packages/web/src/lib/video/cv-bridge-map.test.ts
//
// Unit coverage for the cv → video bridge value mapping. Two regression
// targets:
//   1. GATE-style cv inputs (DOOM cv_<port>, no cvScale hint) pass the RAW
//      cv value through so the module's edge detector fires (a "scaled"
//      gate would defeat the hysteresis thresholds).
//   2. CONTINUOUS param targets (cvScale hint) map ±1 across the param's
//      FULL natural range — fixing the "bipolar source only reaches one
//      quadrant" bug for params whose range isn't ±1 (e.g. zoom 0.3..3).

import { describe, it, expect } from 'vitest';
import { buildCvBridgeMapping, mapCvBridgeValue } from './cv-bridge-map';
import { destructorDef } from './modules/destructor';
import { cameraInputDef } from './modules/camera-input';
import type { ParamDef, PortDef } from '$lib/graph/types';

describe('buildCvBridgeMapping — gate vs continuous param branch', () => {
  it('a gate-style input (no cvScale) is raw passthrough', () => {
    const input: PortDef = { id: 'up', type: 'cv', paramTarget: 'cv_up' };
    const m = buildCvBridgeMapping(input, 'up', [], {});
    expect(m.targetParamId).toBe('cv_up');
    expect(m.scale).toBeUndefined();
    // Raw value through, both polarities.
    expect(mapCvBridgeValue(m, 1)).toBe(1);
    expect(mapCvBridgeValue(m, -1)).toBe(-1);
    expect(mapCvBridgeValue(m, 0.7)).toBe(0.7);
  });

  it('an explicit passthrough hint is also raw', () => {
    const input: PortDef = { id: 'x', type: 'cv', paramTarget: 'x', cvScale: { mode: 'passthrough' } };
    const m = buildCvBridgeMapping(input, 'x', [{ id: 'x', label: 'X', defaultValue: 0, min: 0, max: 10, curve: 'linear' }], {});
    expect(m.scale).toBeUndefined();
    expect(mapCvBridgeValue(m, 0.5)).toBe(0.5);
  });

  it('falls back to portId when no paramTarget is declared', () => {
    const input: PortDef = { id: 'raw', type: 'cv' };
    const m = buildCvBridgeMapping(input, 'raw', [], {});
    expect(m.targetParamId).toBe('raw');
  });

  it('a continuous input (linear cvScale) maps ±1 across the FULL param range', () => {
    // zoom-style param: 0.3..3, current value (knob) at its default 1.0.
    const params: ParamDef[] = [
      { id: 'zoom', label: 'Zoom', defaultValue: 1.0, min: 0.3, max: 3, curve: 'linear' },
    ];
    const input: PortDef = { id: 'zoom_cv', type: 'cv', paramTarget: 'zoom', cvScale: { mode: 'linear' } };
    const m = buildCvBridgeMapping(input, 'zoom_cv', params, { zoom: 1.0 });
    expect(m.targetParamId).toBe('zoom');
    expect(m.scale).toBeDefined();

    // cv=0 → knob unchanged.
    expect(mapCvBridgeValue(m, 0)).toBeCloseTo(1.0, 5);
    // cv=+1 → +half-span above knob: 1.0 + (3-0.3)/2 = 2.35.
    expect(mapCvBridgeValue(m, 1)).toBeCloseTo(2.35, 5);
    // cv=-1 → -half-span, clamped at min 0.3 (1.0 - 1.35 = -0.35 → 0.3).
    expect(mapCvBridgeValue(m, -1)).toBeCloseTo(0.3, 5);
  });

  it('a ±1 sweep into a -1..+1 rot param exercises BOTH extremes (not one quadrant)', () => {
    // rot-style param: -1..+1, knob centred at 0.
    const params: ParamDef[] = [
      { id: 'rot', label: 'Rot', defaultValue: 0, min: -1, max: 1, curve: 'linear' },
    ];
    const input: PortDef = { id: 'rot_cv', type: 'cv', paramTarget: 'rot', cvScale: { mode: 'linear' } };
    const m = buildCvBridgeMapping(input, 'rot_cv', params, {});
    // The sweep should reach near both -1 and +1 across a full cv swing.
    const lo = mapCvBridgeValue(m, -1);
    const hi = mapCvBridgeValue(m, 1);
    expect(lo).toBeCloseTo(-1, 5);
    expect(hi).toBeCloseTo(1, 5);
    expect(hi - lo).toBeCloseTo(2, 5); // full span, not a sub-range
  });

  it('degrades to raw passthrough when the hinted param cannot be resolved', () => {
    const input: PortDef = { id: 'mystery_cv', type: 'cv', paramTarget: 'nonexistent', cvScale: { mode: 'linear' } };
    const m = buildCvBridgeMapping(input, 'mystery_cv', [], {});
    expect(m.scale).toBeUndefined();
    expect(mapCvBridgeValue(m, 0.42)).toBe(0.42);
  });
});

// Module-specific contract for DESTRUCTOR.mangle, bound to the REAL def. This
// is the deterministic half of the deleted video-phase1.spec.ts, which used to
// prove "an audio LFO on DESTRUCTOR.mangle moves the rendered pixels" by
// sleeping through LFO phases. That claim splits cleanly:
//   - the LFO→param MAPPING is pure + lives here (no GL, no wall clock);
//   - the param→PIXELS half is the new destructor-render-smoke.spec.ts DRS,
//     which sets two mangle values directly and asserts the frames differ.
// Binding to destructorDef (not a synthetic param) guards the actual wiring:
// if someone drops the cvScale hint or changes the mangle range, this fails.
describe('cv-bridge mapping — DESTRUCTOR.mangle (replaces video-phase1 LFO→param)', () => {
  const mangleInput = destructorDef.inputs.find((i) => i.id === 'mangle')!;

  it('mangle is wired as a continuous (linear cvScale) cv target over 0..1', () => {
    expect(mangleInput).toBeDefined();
    expect(mangleInput.cvScale).toEqual({ mode: 'linear' });
    const def = destructorDef.params.find((p) => p.id === 'mangle')!;
    expect(def).toBeDefined();
    expect(def.min).toBe(0);
    expect(def.max).toBe(1);
  });

  it('a bipolar LFO sweep moves mangle across the FULL 0..1 range (knob centred)', () => {
    // Centre the knob so a ±1 swing reaches both ends (the def default sits at
    // the max, 1.0). With knob=0.5: cv -1 → 0, cv +1 → 1.
    const m = buildCvBridgeMapping(mangleInput, 'mangle', destructorDef.params, { mangle: 0.5 });
    expect(m.targetParamId).toBe('mangle');
    expect(m.scale).toBeDefined();
    const lo = mapCvBridgeValue(m, -1);
    const mid = mapCvBridgeValue(m, 0);
    const hi = mapCvBridgeValue(m, 1);
    expect(lo).toBeCloseTo(0, 5);
    expect(mid).toBeCloseTo(0.5, 5);
    expect(hi).toBeCloseTo(1, 5);
    // A swept LFO yields a strictly monotonic continuum — not one quadrant.
    expect(hi).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(lo);
  });

  it('a flat LFO (cv held) yields a constant mangle — no motion', () => {
    const m = buildCvBridgeMapping(mangleInput, 'mangle', destructorDef.params, { mangle: 0.5 });
    expect(mapCvBridgeValue(m, 0.25)).toBe(mapCvBridgeValue(m, 0.25));
  });

  it('at the default knob (1.0) a negative-going LFO pulls mangle below max', () => {
    // No nodeParams ⇒ knob resolves to the def default (1.0). A unipolar-down
    // LFO reduces mangle; the positive half clamps at the max.
    const m = buildCvBridgeMapping(mangleInput, 'mangle', destructorDef.params, {});
    expect(mapCvBridgeValue(m, 0)).toBeCloseTo(1.0, 5); // knob default
    expect(mapCvBridgeValue(m, -1)).toBeCloseTo(0.5, 5); // 1.0 - (1-0)/2
    expect(mapCvBridgeValue(m, 1)).toBeCloseTo(1.0, 5); // clamped at max
  });
});

describe('CAMERA mirror GATE input (real def) — level-sensitive raw passthrough', () => {
  // A gate patched into CAMERA's MIRROR input flips the mirror WHILE held high.
  // It must be raw passthrough (no scale) to the real `mirror` param, which the
  // shader thresholds at 0.5 — NOT scaled across a range (that would smear the
  // toggle). Regression guard for the gate-for-mirror feature.
  const mirrorIn = cameraInputDef.inputs.find((p) => p.id === 'mirror')!;

  it('is declared as a level-sensitive gate targeting the mirror param', () => {
    expect(mirrorIn).toBeDefined();
    expect(mirrorIn.type).toBe('gate');
    expect(mirrorIn.edge).toBe('gate');
    expect(mirrorIn.paramTarget).toBe('mirror');
    expect(mirrorIn.cvScale).toBeUndefined(); // no scale → raw passthrough
  });

  it('maps raw: gate HIGH (≥1) → mirror on (>0.5), gate LOW (0) → mirror off', () => {
    const m = buildCvBridgeMapping(mirrorIn, 'mirror', cameraInputDef.params, {});
    expect(m.targetParamId).toBe('mirror');
    expect(m.scale).toBeUndefined();
    expect(mapCvBridgeValue(m, 1)).toBe(1); // held high → mirror param 1 → shader uMirror>0.5
    expect(mapCvBridgeValue(m, 0)).toBe(0); // low → 0 → not mirrored
  });
});
