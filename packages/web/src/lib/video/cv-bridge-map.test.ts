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
import { buildCvBridgeMapping, cvBridgeKnobTracksBase, mapCvBridgeValue, CvActivityDetector, CV_ACTIVITY_MOVE_EPS, CV_ACTIVITY_IDLE_MS, CV_ACTIVITY_IDLE_TICKS } from './cv-bridge-map';
import { destructorDef } from './modules/destructor';
import { cameraInputDef } from './modules/camera-input';
import { quadralogicalDef } from './modules/quadralogical';
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

// ── center: 'default' — absolute-position params track the input, ignoring a
//    stale saved base (the QUADRALOGICAL joystick-offset bug). ──
//
// The reported bug: a gamepad → QUADRALOGICAL X/Y patch, saved with the pad at a
// non-centre position, reloaded with the physical stick centred, read as an
// up-and-to-the-right offset. Cause: the cv→video bridge baked the STORED pos_x
// as the modulation centre, so effective = storedBase + cv. `center: 'default'`
// centres on the param default instead, so a cabled value equals the input and
// no stored base can offset it. Bound to the REAL def so dropping the flag fails.
describe("center: 'default' — cabled joystick X/Y tracks the input (ignores stored base)", () => {
  const posXInput = quadralogicalDef.inputs.find((i) => i.id === 'pos_x')!;
  const posYInput = quadralogicalDef.inputs.find((i) => i.id === 'pos_y')!;

  it('pos_x / pos_y declare cvScale linear + center=default on the real def', () => {
    expect(posXInput.cvScale).toEqual({ mode: 'linear', center: 'default' });
    expect(posYInput.cvScale).toEqual({ mode: 'linear', center: 'default' });
  });

  it("resolves the modulation centre to the param DEFAULT (0), not the stored base", () => {
    // Simulate the owner's poisoned save: stored pos_x well off-centre.
    const m = buildCvBridgeMapping(posXInput, 'pos_x', quadralogicalDef.params, {
      pos_x: 0.4764564431012892,
    });
    expect(m.scale).toBeDefined();
    expect(m.scale!.knob).toBe(0); // default, NOT the stored 0.476
  });

  it("a centred stick (cv≈0) reads CENTRE — the 0.476/0.569 offset is healed", () => {
    const mx = buildCvBridgeMapping(posXInput, 'pos_x', quadralogicalDef.params, { pos_x: 0.4764564431012892 });
    const my = buildCvBridgeMapping(posYInput, 'pos_y', quadralogicalDef.params, { pos_y: 0.5694425543051558 });
    // Physical stick centred → cv 0 → effective 0 (centre), NOT the saved base.
    expect(mapCvBridgeValue(mx, 0)).toBeCloseTo(0, 5);
    expect(mapCvBridgeValue(my, 0)).toBeCloseTo(0, 5);
  });

  it('a cabled value EQUALS the input across the range (pos is [-1,1], linear)', () => {
    const m = buildCvBridgeMapping(posXInput, 'pos_x', quadralogicalDef.params, { pos_x: 0.9 });
    // For a [-1,1] linear param centred on 0, effective == cv (halfSpan = 1).
    for (const cv of [-1, -0.5, 0, 0.25, 0.5, 1]) {
      expect(mapCvBridgeValue(m, cv)).toBeCloseTo(cv, 5);
    }
  });

  it('the stored base is IRRELEVANT — same output for any saved pos_x', () => {
    const a = buildCvBridgeMapping(posXInput, 'pos_x', quadralogicalDef.params, { pos_x: -0.8 });
    const b = buildCvBridgeMapping(posXInput, 'pos_x', quadralogicalDef.params, { pos_x: 0.3 });
    const c = buildCvBridgeMapping(posXInput, 'pos_x', quadralogicalDef.params, {}); // no stored value
    for (const cv of [-1, -0.4, 0, 0.6, 1]) {
      expect(mapCvBridgeValue(a, cv)).toBeCloseTo(mapCvBridgeValue(b, cv), 5);
      expect(mapCvBridgeValue(a, cv)).toBeCloseTo(mapCvBridgeValue(c, cv), 5);
    }
  });

  it('CONTRAST: a bias param (no center) still centres on the STORED base', () => {
    // diamond_margin is a bias-style control — a knob you set, CV wobbles around.
    // It must KEEP the stored value as its centre (the fix is scoped to pos_x/y).
    const marginInput = quadralogicalDef.inputs.find((i) => i.id === 'diamond_margin')!;
    expect(marginInput.cvScale).toEqual({ mode: 'linear' }); // no center → 'param'
    const m = buildCvBridgeMapping(marginInput, 'diamond_margin', quadralogicalDef.params, {
      diamond_margin: 0.5,
    });
    // cv=0 → the stored base, not the default.
    expect(mapCvBridgeValue(m, 0)).toBeCloseTo(0.5, 5);
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

describe('cvBridgeKnobTracksBase (#2236 — a CV-driven fader must be movable)', () => {
  const zoom: ParamDef = {
    id: 'zoom', label: 'Zoom', defaultValue: 1, min: 0.4, max: 1.6, curve: 'linear',
  };

  it('tracks the base for an ordinary bias-knob param', () => {
    const m = buildCvBridgeMapping(
      { id: 'zoom', type: 'cv', paramTarget: 'zoom', cvScale: { mode: 'linear' } } as PortDef,
      'zoom', [zoom], { zoom: 1 },
    );
    expect(cvBridgeKnobTracksBase(m)).toBe(true);
  });

  it('does NOT track the base for an absolute-position param', () => {
    // `center: 'default'` exists so a cabled joystick tracks its SOURCE and a
    // stale stored position cannot offset it. Refreshing the centre for these
    // would reintroduce the exact bug that hint prevents.
    const m = buildCvBridgeMapping(
      { id: 'zoom', type: 'cv', paramTarget: 'zoom', cvScale: { mode: 'linear', center: 'default' } } as PortDef,
      'zoom', [zoom], { zoom: 0.4 },
    );
    expect(cvBridgeKnobTracksBase(m)).toBe(false);
  });

  it('is false for a gate target, which has no centre at all', () => {
    const m = buildCvBridgeMapping(
      { id: 'cv_fire', type: 'cv' } as PortDef, 'cv_fire', [zoom], {},
    );
    expect(m.scale).toBeUndefined();
    expect(cvBridgeKnobTracksBase(m)).toBe(false);
  });

  it('re-centring moves the whole sweep with the fader', () => {
    // The owner's case: zoom cabled from a stick, fader dragged from the bottom
    // of its range to the middle. Before the fix the centre stayed where the
    // CABLE was made, so the drag was overwritten within a frame.
    const m = buildCvBridgeMapping(
      { id: 'zoom', type: 'cv', paramTarget: 'zoom', cvScale: { mode: 'linear' } } as PortDef,
      'zoom', [zoom], { zoom: 0.406 },
    );
    // Parked at the bottom: downward CV pins, upward reaches ~half the fader.
    expect(mapCvBridgeValue(m, -1)).toBeCloseTo(0.4, 3);
    expect(mapCvBridgeValue(m, 1)).toBeCloseTo(1.006, 3);

    // The engine re-centres on the live manual base each tick.
    m.scale!.knob = 1.0;
    expect(mapCvBridgeValue(m, -1)).toBeCloseTo(0.4, 3);
    expect(mapCvBridgeValue(m, 1)).toBeCloseTo(1.6, 3);
  });
});

describe('CvActivityDetector — the "is the stick moving?" seam', () => {
  const mk = (opts?: { moveEps?: number; idleHoldMs?: number; idleHoldTicks?: number }) =>
    new CvActivityDetector({ moveEps: 0.01, idleHoldMs: 300, ...opts });

  it('starts IDLE, and the first sample only seats the anchor (a cable patched to a parked source announces no phantom gesture)', () => {
    const d = mk();
    expect(d.active).toBe(false);
    // First sample is a big value — but there is no PRIOR anchor to move from.
    expect(d.update(0.8, 0)).toBe(false);
    // Holding that value stays idle.
    expect(d.update(0.8, 100)).toBe(false);
    expect(d.active).toBe(false);
  });

  it('movement ≥ moveEps activates; sub-eps jitter never does', () => {
    const d = mk();
    d.update(0, 0);
    expect(d.update(0.005, 16)).toBe(false); // below eps — noise
    expect(d.update(0.009, 32)).toBe(false); // still below eps vs anchor 0
    expect(d.update(0.02, 48)).toBe(true); // crossed eps → active
  });

  it('slow drift ACCUMULATES against the movement anchor instead of hiding under the per-tick delta', () => {
    const d = mk();
    d.update(0, 0);
    // +0.004/tick — every per-tick delta is under eps, but the drift crosses
    // eps vs the anchor on the third sample.
    expect(d.update(0.004, 16)).toBe(false);
    expect(d.update(0.008, 32)).toBe(false);
    expect(d.update(0.012, 48)).toBe(true);
  });

  it('stays ACTIVE while movements keep arriving inside the hold, then decays to IDLE once BOTH legs pass (ticks AND ms)', () => {
    const d = mk();
    d.update(0, 0);
    expect(d.update(0.5, 100)).toBe(true);
    expect(d.update(0.3, 350)).toBe(true); // moved again → both hold legs refreshed
    expect(d.update(0.3, 500)).toBe(true); // still tick 1, 150 ms < 300 ms → active
    expect(d.update(0.3, 649)).toBe(true); // still tick 2, 299 ms — ms leg unmet
    expect(d.update(0.3, 651)).toBe(false); // still tick 3 AND 301 ms → idle
    expect(d.active).toBe(false);
  });

  it('re-activates from IDLE on the next real movement', () => {
    const d = mk();
    d.update(0, 0);
    d.update(0.5, 10);
    d.update(0.5, 400); // still ticks 1..3 past the ms hold → idle
    d.update(0.5, 420);
    d.update(0.5, 440);
    expect(d.active).toBe(false);
    expect(d.update(0.6, 450)).toBe(true);
  });

  it('NEGATIVE CONTROL (stalled bridge): wall-clock passing with NO ticks must not decay — the tick leg gates it', () => {
    const d = new CvActivityDetector();
    d.update(0, 0);
    expect(d.update(0.5, 16)).toBe(true);
    // The bridge stalls (throttled tab / contended shard): zero ticks for 10 s.
    // On resume the source has been OBSERVED still for only 1 tick — however
    // much wall-clock passed, the grab must hold until the tick floor is met.
    let t = 10_000;
    for (let tick = 1; tick < CV_ACTIVITY_IDLE_TICKS; tick++) {
      expect(d.update(0.5, (t += 16)), `still tick ${tick}/${CV_ACTIVITY_IDLE_TICKS} (wall-clock ${t} ms, far past the ${CV_ACTIVITY_IDLE_MS} ms leg)`).toBe(true);
    }
    expect(d.update(0.5, (t += 16)), 'tick floor reached with the ms leg long past → idle').toBe(false);
  });

  it('NEGATIVE CONTROL (fast renderer): ticks passing inside the wall-clock hold must not decay — the ms leg gates it', () => {
    const d = new CvActivityDetector();
    d.update(0, 0);
    expect(d.update(0.5, 16)).toBe(true); // movement at 16 ms → hold ends at 316 ms
    // 60 fps: a still tick every 16 ms — far more ticks than the floor, all
    // inside the 300 ms hold. Every one must stay ACTIVE.
    let stillTicks = 0;
    for (let t = 32; t <= 300; t += 16) {
      stillTicks += 1;
      expect(d.update(0.5, t), `still tick ${stillTicks} at ${t} ms (ms leg unmet: ${t - 16} ms < ${CV_ACTIVITY_IDLE_MS} ms)`).toBe(true);
    }
    // Validate the control itself: the tick floor really was exceeded.
    expect(stillTicks).toBeGreaterThan(CV_ACTIVITY_IDLE_TICKS);
    expect(d.update(0.5, 16 + CV_ACTIVITY_IDLE_MS + 1), 'ms leg now met too → idle').toBe(false);
  });

  it('respects custom thresholds', () => {
    const d = mk({ moveEps: 0.2, idleHoldMs: 50, idleHoldTicks: 2 });
    d.update(0, 0);
    expect(d.update(0.1, 10)).toBe(false); // under the wider eps
    expect(d.update(0.3, 20)).toBe(true);
    expect(d.update(0.3, 71)).toBe(true); // still tick 1 < 2 — tick leg unmet despite 51 ms > 50 ms
    expect(d.update(0.3, 72)).toBe(false); // still tick 2 AND 52 ms > 50 ms hold → idle
  });

  it('defaults are the exported constants', () => {
    const d = new CvActivityDetector();
    d.update(0, 0);
    expect(d.update(CV_ACTIVITY_MOVE_EPS, 10)).toBe(true);
    let t = 10 + CV_ACTIVITY_IDLE_MS;
    for (let tick = 1; tick < CV_ACTIVITY_IDLE_TICKS; tick++) {
      expect(d.update(CV_ACTIVITY_MOVE_EPS, (t += 1)), `still tick ${tick} past the ms hold`).toBe(true);
    }
    expect(d.update(CV_ACTIVITY_MOVE_EPS, (t += 1))).toBe(false);
  });
});
