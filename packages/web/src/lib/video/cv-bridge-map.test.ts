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
