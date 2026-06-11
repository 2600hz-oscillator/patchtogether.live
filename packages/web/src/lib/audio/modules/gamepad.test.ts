// packages/web/src/lib/audio/modules/gamepad.test.ts
//
// Pure-function coverage for the GAMEPAD helpers + def shape. The
// browser Gamepad API path (navigator.getGamepads()) needs a real
// browser to exercise — covered by the e2e spec.

import { describe, expect, it } from 'vitest';
import {
  applyDeadzone,
  triggerToCv,
  gamepadDef,
  GAMEPAD_OUTPUTS,
  STICK_DEADZONE,
  CALIBRATION_DEADZONE,
  newCalibrationSweep,
  recordCalibrationSample,
  sweepIsUsable,
  finalizeCalibration,
  normalizeAxis,
  applyCalibration,
  type StickCalibration,
  detectChangedControl,
  REMAP_AXIS_THRESHOLD,
  REMAP_BUTTON_THRESHOLD,
  type RawGamepadReading,
} from './gamepad';
import { scaleCv } from '$lib/audio/cv-scale';
import { wavesculptDef } from './wavesculpt';

describe('applyDeadzone', () => {
  it('returns 0 inside the deadzone band', () => {
    expect(applyDeadzone(0)).toBe(0);
    expect(applyDeadzone(STICK_DEADZONE - 0.001)).toBe(0);
    expect(applyDeadzone(-STICK_DEADZONE + 0.001)).toBe(0);
  });

  it('re-normalizes so the value just outside dz starts near 0', () => {
    const justOut = applyDeadzone(STICK_DEADZONE + 0.001);
    expect(justOut).toBeGreaterThan(0);
    expect(justOut).toBeLessThan(0.01);
  });

  it('preserves ±1 at the extremes', () => {
    expect(applyDeadzone(1)).toBeCloseTo(1);
    expect(applyDeadzone(-1)).toBeCloseTo(-1);
  });

  it('clamps inputs > 1 or < -1', () => {
    expect(applyDeadzone(2)).toBeCloseTo(1);
    expect(applyDeadzone(-2)).toBeCloseTo(-1);
  });

  it('handles NaN/Infinity safely', () => {
    expect(applyDeadzone(NaN)).toBe(0);
    expect(applyDeadzone(Infinity)).toBe(0);
  });

  it('respects a custom deadzone', () => {
    expect(applyDeadzone(0.2, 0.3)).toBe(0);
    expect(applyDeadzone(0.4, 0.3)).toBeGreaterThan(0);
  });
});

describe('triggerToCv', () => {
  it('clamps to [0, 1]', () => {
    expect(triggerToCv(-1)).toBe(0);
    expect(triggerToCv(0)).toBe(0);
    expect(triggerToCv(0.5)).toBe(0.5);
    expect(triggerToCv(1)).toBe(1);
    expect(triggerToCv(2)).toBe(1);
  });
});

describe('gamepad def shape', () => {
  it('declares 18 outputs covering sticks + triggers + buttons', () => {
    expect(gamepadDef.type).toBe('gamepad');
    expect(gamepadDef.domain).toBe('audio');
    expect(gamepadDef.outputs.length).toBe(18);
    const ids = gamepadDef.outputs.map((o) => o.id).sort();
    expect(ids).toEqual(
      ['a', 'b', 'back', 'dd', 'dl', 'dr', 'du', 'lb', 'lt', 'lx', 'ly', 'rb', 'rt', 'rx', 'ry', 'start', 'x', 'y'].sort(),
    );
  });

  it('stick axes + triggers are cv; buttons + dpad are gate', () => {
    const byId = new Map(gamepadDef.outputs.map((o) => [o.id, o.type]));
    for (const k of ['lx', 'ly', 'rx', 'ry', 'lt', 'rt']) {
      expect(byId.get(k), `${k} should be cv`).toBe('cv');
    }
    for (const k of ['lb', 'rb', 'a', 'b', 'x', 'y', 'du', 'dd', 'dl', 'dr', 'start', 'back']) {
      expect(byId.get(k), `${k} should be gate`).toBe('gate');
    }
  });

  it('has no inputs (purely a source module)', () => {
    expect(gamepadDef.inputs).toEqual([]);
  });

  it('exposes a padIndex param clamped 0..3', () => {
    const p = gamepadDef.params.find((x) => x.id === 'padIndex');
    expect(p).toBeDefined();
    expect(p?.min).toBe(0);
    expect(p?.max).toBe(3);
    expect(p?.defaultValue).toBe(0);
    expect(p?.curve).toBe('discrete');
  });

  it('GAMEPAD_OUTPUTS list matches the def outputs 1:1', () => {
    expect(GAMEPAD_OUTPUTS.length).toBe(gamepadDef.outputs.length);
    for (const o of GAMEPAD_OUTPUTS) {
      const defOut = gamepadDef.outputs.find((d) => d.id === o.id);
      expect(defOut, `def missing ${o.id}`).toBeDefined();
      expect(defOut?.type).toBe(o.type);
    }
  });

  // Bug #1 — button-LED labels match the output port labels. The card
  // used to hard-code uppercase IDs (`{btn.toUpperCase()}`) for the LED
  // row while the port labels for the d-pad rendered chevron glyphs
  // (⬆⬇⬅⮕ per the GAMEPAD_OUTPUTS table). Card-side fix: render
  // GAMEPAD_OUTPUTS[id].label for each LED. This test pins the LABELS
  // table so anyone who edits the def's d-pad labels has to update the
  // expected text here too — and any drift between the LED row and the
  // port row is caught at build time, not by a user looking at it.
  it('d-pad output port labels use the U+2B0x chevron family (LED row mirror)', () => {
    const cables = Object.fromEntries(GAMEPAD_OUTPUTS.map((o) => [o.id, o.label]));
    expect(cables['du']).toBe('⬆');
    expect(cables['dd']).toBe('⬇');
    expect(cables['dl']).toBe('⬅');
    expect(cables['dr']).toBe('⮕');
  });

  it('face/shoulder/start/back output port labels are the canonical strings (LED row mirror)', () => {
    const cables = Object.fromEntries(GAMEPAD_OUTPUTS.map((o) => [o.id, o.label]));
    expect(cables['lb']).toBe('LB');
    expect(cables['rb']).toBe('RB');
    expect(cables['a']).toBe('A');
    expect(cables['b']).toBe('B');
    expect(cables['x']).toBe('X');
    expect(cables['y']).toBe('Y');
    expect(cables['start']).toBe('STA');
    expect(cables['back']).toBe('SEL');
  });
});

// ---------------------------------------------------------------------------
// GAMEPAD stick → WAVESCULPT camera-joystick mapping (full-range regression)
//
// The reported regression: patching a GAMEPAD stick to WAVESCULPT's X-Y
// camera joystick couldn't reach the extremes ("full range doesn't work").
// The end-to-end mapping a stick axis travels is:
//
//   raw axis  → applyDeadzone(raw)  → CV in [-1, +1]
//             → scaleCv(cv, knob, min, max, {linear})  → effective param
//
// (the gamepad module emits the de-deadzoned CV; the engine's cv-scale
// chain — see cv-scale.ts — applies the linear scaling onto the
// destination param when the cable lands on a `cvScale:'linear'` port,
// which pos_x/pos_y both are). This composed test pins that the FULL
// param range is reachable, that centre is neutral, and that the Y axis
// is inverted the way the camera convention expects — so a future tweak
// to either half of the chain can't silently re-clamp the stick.
// ---------------------------------------------------------------------------
describe('GAMEPAD stick → WAVESCULPT camera mapping (composed full-range)', () => {
  // WAVESCULPT pos_x / pos_y: bipolar ±1, default knob 0, linear cv-scale.
  const posX = wavesculptDef.params.find((p) => p.id === 'pos_x')!;
  const posY = wavesculptDef.params.find((p) => p.id === 'pos_y')!;
  const posXPort = wavesculptDef.inputs.find((p) => p.id === 'pos_x')!;
  const posYPort = wavesculptDef.inputs.find((p) => p.id === 'pos_y')!;

  /** Stick X → pos_x effective value (no Y inversion). */
  const stickToPosX = (raw: number, knob = posX.defaultValue) =>
    scaleCv(applyDeadzone(raw), knob, posX.min, posX.max, posXPort.cvScale!);
  /** Stick Y → pos_y effective value (gamepad inverts Y so +1 = stick up). */
  const stickToPosY = (raw: number, knob = posY.defaultValue) =>
    scaleCv(-applyDeadzone(raw), knob, posY.min, posY.max, posYPort.cvScale!);

  it('camera ports are bipolar ±1 with a linear cv-scale (mapping precondition)', () => {
    for (const [param, port] of [[posX, posXPort], [posY, posYPort]] as const) {
      expect(param.min).toBe(-1);
      expect(param.max).toBe(1);
      expect(param.defaultValue).toBe(0);
      expect(port.cvScale?.mode).toBe('linear');
    }
  });

  it('full stick deflection reaches BOTH extremes of pos_x', () => {
    // The core regression assertion: stick hard-right/left must hit ±1,
    // not some fraction of it.
    expect(stickToPosX(1)).toBeCloseTo(1, 5);
    expect(stickToPosX(-1)).toBeCloseTo(-1, 5);
    // Over-range raw (some pads report slightly > 1) still pins at the edge.
    expect(stickToPosX(1.5)).toBeCloseTo(1, 5);
    expect(stickToPosX(-1.5)).toBeCloseTo(-1, 5);
  });

  it('full stick deflection reaches BOTH extremes of pos_y (Y inverted)', () => {
    // Stick pushed UP (raw axis = -1 per the W3C spec) → pos_y = +1.
    expect(stickToPosY(-1)).toBeCloseTo(1, 5);
    // Stick pushed DOWN (raw = +1) → pos_y = -1.
    expect(stickToPosY(1)).toBeCloseTo(-1, 5);
  });

  it('centre stick is neutral (sits exactly on the knob value)', () => {
    expect(stickToPosX(0)).toBe(0);
    expect(stickToPosY(0)).toBe(0);
    // Inside the deadzone band the dot must not drift off centre.
    expect(stickToPosX(STICK_DEADZONE - 0.001)).toBe(0);
    expect(stickToPosY(STICK_DEADZONE - 0.001)).toBe(0);
  });

  it('mapping is monotonic across the stick travel (no dead spots mid-range)', () => {
    let prev = -Infinity;
    for (let raw = -1; raw <= 1.0001; raw += 0.1) {
      const v = stickToPosX(raw);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = v;
    }
    // Half-deflection lands roughly half-way (after the small dz renormalize)
    // — i.e. the response is a genuine sweep, not a near-binary snap.
    const half = stickToPosX(0.5);
    expect(half).toBeGreaterThan(0.3);
    expect(half).toBeLessThan(0.6);
  });

  it('the live knob recentres the sweep but the extremes stay clamped to ±1', () => {
    // Knob nudged toward +0.5: the AudioParam clamps at its natural max, so
    // a hard-right stick still pins at +1 (Eurorack "CV pushes the knob,
    // outside the range it pins" semantics).
    expect(stickToPosX(1, 0.5)).toBeCloseTo(1, 5);
    // Centre stick now sits on the knob.
    expect(stickToPosX(0, 0.5)).toBe(0.5);
    // Hard-left still reaches the bottom of the range.
    expect(stickToPosX(-1, 0.5)).toBeCloseTo(-0.5, 5);
  });
});

// ---------------------------------------------------------------------------
// LEFT-STICK CALIBRATION — pure math (Gladiator NXT first deliverable).
//
// The full flow exercised here, GL/hardware-free:
//   newCalibrationSweep() → recordCalibrationSample()× (the user sweep) →
//   sweepIsUsable() (gate) → finalizeCalibration() (one-time committed record)
//   → applyCalibration()/normalizeAxis() (the per-frame read-loop mapping).
// ---------------------------------------------------------------------------
describe('calibration sweep capture', () => {
  it('seeds an empty sweep that is NOT yet usable', () => {
    const s = newCalibrationSweep();
    expect(s.samples).toBe(0);
    expect(sweepIsUsable(s)).toBe(false);
  });

  it('records observed min/max across a sweep', () => {
    const s = newCalibrationSweep();
    recordCalibrationSample(s, 0.0, 0.0);
    recordCalibrationSample(s, -0.8, 0.7);
    recordCalibrationSample(s, 0.9, -0.85);
    expect(s.minX).toBeCloseTo(-0.8);
    expect(s.maxX).toBeCloseTo(0.9);
    expect(s.minY).toBeCloseTo(-0.85);
    expect(s.maxY).toBeCloseTo(0.7);
    expect(s.samples).toBe(3);
  });

  it('ignores non-finite samples (disconnected pad) without corrupting the range', () => {
    const s = newCalibrationSweep();
    recordCalibrationSample(s, -0.5, 0.5);
    recordCalibrationSample(s, NaN, 0.9);
    recordCalibrationSample(s, 0.6, Infinity);
    // Only the first sample was finite on both axes.
    expect(s.minX).toBeCloseTo(-0.5);
    expect(s.maxX).toBeCloseTo(-0.5);
    expect(s.samples).toBe(1);
  });

  it('clamps over-range raw samples to the legal [-1,1] axis band', () => {
    const s = newCalibrationSweep();
    recordCalibrationSample(s, -1.5, 1.4);
    recordCalibrationSample(s, 2.0, -3.0);
    expect(s.minX).toBe(-1);
    expect(s.maxX).toBe(1);
    expect(s.minY).toBe(-1);
    expect(s.maxY).toBe(1);
  });

  it('is usable only after a non-trivial span on BOTH axes', () => {
    const s = newCalibrationSweep();
    // A wide X sweep but a tiny Y span → not usable (Y range too small).
    recordCalibrationSample(s, -0.9, 0.0);
    recordCalibrationSample(s, 0.9, 0.01);
    recordCalibrationSample(s, 0.0, -0.01);
    expect(sweepIsUsable(s)).toBe(false);
    // Add a real Y span → now usable.
    recordCalibrationSample(s, 0.0, 0.5);
    recordCalibrationSample(s, 0.0, -0.5);
    expect(sweepIsUsable(s)).toBe(true);
  });

  it('rejects a usable check with too few samples even if span is wide', () => {
    const s = newCalibrationSweep();
    recordCalibrationSample(s, -1, -1);
    recordCalibrationSample(s, 1, 1);
    // Only 2 samples — below the floor.
    expect(sweepIsUsable(s)).toBe(false);
  });
});

describe('finalizeCalibration', () => {
  it('returns null for an unusable sweep (keeps prior calibration)', () => {
    expect(finalizeCalibration(newCalibrationSweep())).toBeNull();
  });

  it('locks in the observed range + default deadzone', () => {
    const s = newCalibrationSweep();
    recordCalibrationSample(s, -0.8, 0.7);
    recordCalibrationSample(s, 0.85, -0.75);
    recordCalibrationSample(s, 0.0, 0.0);
    const cal = finalizeCalibration(s)!;
    expect(cal).not.toBeNull();
    expect(cal.minX).toBeCloseTo(-0.8);
    expect(cal.maxX).toBeCloseTo(0.85);
    expect(cal.minY).toBeCloseTo(-0.75);
    expect(cal.maxY).toBeCloseTo(0.7);
    expect(cal.deadzone).toBe(CALIBRATION_DEADZONE);
  });

  it('clamps a custom deadzone into [0, 0.9]', () => {
    const s = newCalibrationSweep();
    recordCalibrationSample(s, -1, -1);
    recordCalibrationSample(s, 1, 1);
    recordCalibrationSample(s, 0, 0);
    expect(finalizeCalibration(s, -1)!.deadzone).toBe(0);
    expect(finalizeCalibration(s, 5)!.deadzone).toBe(0.9);
  });
});

describe('normalizeAxis (per-axis calibrated mapping)', () => {
  it('maps observed-min → -1 and observed-max → +1', () => {
    // A worn / flight stick that only reaches [-0.7, +0.8].
    expect(normalizeAxis(-0.7, -0.7, 0.8, 0)).toBeCloseTo(-1, 5);
    expect(normalizeAxis(0.8, -0.7, 0.8, 0)).toBeCloseTo(1, 5);
  });

  it('maps the calibrated CENTER → 0 even when the stick rests off-zero', () => {
    // Loose centre: range [-0.6, +0.9] → centre +0.15.
    expect(normalizeAxis(0.15, -0.6, 0.9, 0)).toBeCloseTo(0, 5);
  });

  it('saturates past the calibrated extremes (outer deadzone)', () => {
    expect(normalizeAxis(0.95, -0.7, 0.8, 0)).toBe(1);
    expect(normalizeAxis(-0.95, -0.7, 0.8, 0)).toBe(-1);
  });

  it('returns 0 (never NaN) for a degenerate min==max calibration', () => {
    expect(normalizeAxis(0.5, 0.3, 0.3, 0)).toBe(0);
    expect(Number.isNaN(normalizeAxis(0.5, 0.3, 0.3, 0))).toBe(false);
  });

  it('applies + re-normalizes a per-axis deadzone', () => {
    // Symmetric [-1,1] range, dz 0.1: a sample just inside dz → 0, just
    // outside → near-0 (renormalized), full → 1.
    expect(normalizeAxis(0.05, -1, 1, 0.1)).toBe(0);
    const justOut = normalizeAxis(0.11, -1, 1, 0.1);
    expect(justOut).toBeGreaterThan(0);
    expect(justOut).toBeLessThan(0.02);
    expect(normalizeAxis(1, -1, 1, 0.1)).toBeCloseTo(1, 5);
  });
});

describe('applyCalibration (full per-frame mapping incl. radial deadzone)', () => {
  const cal: StickCalibration = { minX: -0.7, maxX: 0.8, minY: -0.75, maxY: 0.7, deadzone: 0.1 };

  it('full deflection reaches ±1 on each axis', () => {
    expect(applyCalibration(0.8, 0, cal).x).toBeCloseTo(1, 4);
    expect(applyCalibration(-0.7, 0, cal).x).toBeCloseTo(-1, 4);
    expect(applyCalibration(0, 0.7, cal).y).toBeCloseTo(1, 4);
    expect(applyCalibration(0, -0.75, cal).y).toBeCloseTo(-1, 4);
  });

  it('rest-at-calibrated-centre reads {0,0} (no snap-back drift)', () => {
    const cx = (cal.minX + cal.maxX) / 2;
    const cy = (cal.minY + cal.maxY) / 2;
    const out = applyCalibration(cx, cy, cal);
    expect(out.x).toBe(0);
    expect(out.y).toBe(0);
  });

  it('radial deadzone gates small diagonal noise inside the dz circle', () => {
    // A small diagonal nudge whose per-axis components are each below the
    // radial dz radius → both axes 0 (the radial guard, not just per-axis).
    const cx = (cal.minX + cal.maxX) / 2;
    const cy = (cal.minY + cal.maxY) / 2;
    // Nudge just a hair off centre — magnitude well under 0.1.
    const out = applyCalibration(cx + 0.01, cy + 0.01, cal);
    expect(out.x).toBe(0);
    expect(out.y).toBe(0);
  });

  it('preserves direction past the deadzone (does not snap to an axis)', () => {
    // A diagonal push to (maxX, minY): X normalizes toward +1, Y toward -1.
    // Both components stay non-zero (no snap to an axis).
    const out = applyCalibration(0.8, -0.75, cal);
    expect(out.x).toBeGreaterThan(0.5);
    expect(out.y).toBeLessThan(-0.5);
    // Magnitude does not exceed the unit-square diagonal.
    expect(Math.hypot(out.x, out.y)).toBeLessThanOrEqual(Math.SQRT2 + 1e-6);
  });

  it('never emits NaN for a degenerate calibration', () => {
    const degen: StickCalibration = { minX: 0, maxX: 0, minY: 0, maxY: 0, deadzone: 0.1 };
    const out = applyCalibration(0.5, 0.5, degen);
    expect(Number.isNaN(out.x)).toBe(false);
    expect(Number.isNaN(out.y)).toBe(false);
    expect(out.x).toBe(0);
    expect(out.y).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CONTROL-REMAP DETECTION — pure diff (broad-control-support feasibility core).
// ---------------------------------------------------------------------------
describe('detectChangedControl', () => {
  const reading = (axes: number[], btnValues: number[]): RawGamepadReading => ({
    axes,
    buttons: btnValues.map((v) => ({ value: v, pressed: v > 0.5 })),
  });

  it('returns null on the first poll (no baseline to diff)', () => {
    expect(detectChangedControl(null, reading([0, 0], [0]))).toBeNull();
  });

  it('returns null when nothing moved past the threshold', () => {
    const prev = reading([0, 0, 0, 0], [0, 0, 0]);
    const cur = reading([0.1, -0.1, 0, 0], [0.2, 0, 0]); // all sub-threshold
    expect(detectChangedControl(prev, cur)).toBeNull();
  });

  it('detects a swept axis as the changed control', () => {
    const prev = reading([0, 0, 0, 0], []);
    const cur = reading([0, 0, 0.9, 0], []); // axis 2 swept
    expect(detectChangedControl(prev, cur)).toEqual({ kind: 'axis', index: 2 });
  });

  it('detects a pressed button as the changed control', () => {
    const prev = reading([0, 0], [0, 0, 0, 0]);
    const cur = reading([0, 0], [0, 0, 1, 0]); // button 2 pressed
    expect(detectChangedControl(prev, cur)).toEqual({ kind: 'button', index: 2 });
  });

  it('picks the LARGEST-magnitude change when several move (deliberate vs jitter)', () => {
    const prev = reading([0, 0, 0], [0, 0]);
    // axis 0 nudged a bit (0.55), axis 1 fully swept (0.95) → axis 1 wins.
    const cur = reading([0.55, 0.95, 0], [0, 0]);
    expect(detectChangedControl(prev, cur)).toEqual({ kind: 'axis', index: 1 });
  });

  it('honours custom thresholds', () => {
    const prev = reading([0, 0], [0]);
    const cur = reading([0.3, 0, 0, 0], [0]);
    // Below the default axis threshold…
    expect(detectChangedControl(prev, cur)).toBeNull();
    // …but above a lowered one.
    expect(detectChangedControl(prev, cur, { axisThreshold: 0.2 })).toEqual({ kind: 'axis', index: 0 });
  });

  it('ignores non-finite samples without throwing', () => {
    const prev = reading([0, 0], [0]);
    // axis 0 is NaN (skipped, no throw), axis 1 swept, no button moved → axis 1.
    const cur: RawGamepadReading = { axes: [NaN, 0.9], buttons: [{ value: 0, pressed: false }] };
    expect(detectChangedControl(prev, cur)).toEqual({ kind: 'axis', index: 1 });
  });

  it('exposes sensible default thresholds', () => {
    expect(REMAP_AXIS_THRESHOLD).toBeGreaterThan(0);
    expect(REMAP_AXIS_THRESHOLD).toBeLessThanOrEqual(1);
    expect(REMAP_BUTTON_THRESHOLD).toBeGreaterThan(0);
    expect(REMAP_BUTTON_THRESHOLD).toBeLessThanOrEqual(1);
  });
});
