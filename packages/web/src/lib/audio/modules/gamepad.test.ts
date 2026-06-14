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
  DEFAULT_GAMEPAD_BINDINGS,
  isPhysicalControl,
  bindingForOutput,
  readControlValue,
  setBinding,
  describeControl,
  applyInvert,
  isInvertibleAxis,
  INVERTIBLE_AXES,
  toggleInvertOnData,
  applyBindingToData,
  clearBindingOnData,
  exportMapping,
  applyMapping,
  isGamepadMapping,
  GAMEPAD_PRESETS,
  type GamepadData,
  type GamepadMapping,
  type RemapBindings,
  type PhysicalControl,
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

  // `only` filter — the two remap entry points arm with different families so
  // a "Remap X" can't be captured by a button press and vice-versa.
  it('only:"axis" ignores a button press, picks the swept axis', () => {
    const prev = reading([0, 0, 0, 0], [0, 0, 0]);
    // Button 1 firmly pressed AND axis 2 swept — axis-only must pick the axis.
    const cur = reading([0, 0, 0.9, 0], [0, 1, 0]);
    expect(detectChangedControl(prev, cur, { only: 'axis' })).toEqual({ kind: 'axis', index: 2 });
  });

  it('only:"axis" returns null when only a button moved (a press is ignored)', () => {
    const prev = reading([0, 0], [0, 0]);
    const cur = reading([0, 0], [0, 1]); // only a button pressed
    expect(detectChangedControl(prev, cur, { only: 'axis' })).toBeNull();
  });

  it('only:"button" ignores a swept axis, picks the pressed button', () => {
    const prev = reading([0, 0, 0, 0], [0, 0, 0]);
    // Axis 0 swept AND button 2 pressed — button-only must pick the button.
    const cur = reading([0.95, 0, 0, 0], [0, 0, 1]);
    expect(detectChangedControl(prev, cur, { only: 'button' })).toEqual({ kind: 'button', index: 2 });
  });

  it('only:"button" returns null when only an axis moved (a wobble is ignored)', () => {
    const prev = reading([0, 0], [0]);
    const cur = reading([0.95, 0], [0]); // only an axis swept
    expect(detectChangedControl(prev, cur, { only: 'button' })).toBeNull();
  });

  it('cancel/no-input (prev===null OR nothing past threshold) yields no binding', () => {
    // The cancel/timeout path: the listener never gets a baseline diff that
    // crosses a threshold, so it produces no PhysicalControl.
    expect(detectChangedControl(null, reading([0.9, 0.9], [1]), { only: 'axis' })).toBeNull();
    const prev = reading([0, 0], [0]);
    const stillResting = reading([0.05, -0.03], [0.1]);
    expect(detectChangedControl(prev, stillResting, { only: 'axis' })).toBeNull();
    expect(detectChangedControl(prev, stillResting, { only: 'button' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CONTROL REMAP — per-output binding model (default table + override logic).
// ---------------------------------------------------------------------------
describe('gamepad remap bindings', () => {
  const reading = (axes: number[], btnValues: number[]): RawGamepadReading => ({
    axes,
    buttons: btnValues.map((v) => ({ value: v, pressed: v > 0.5 })),
  });

  it('DEFAULT_GAMEPAD_BINDINGS covers all 18 outputs with the standard mapping', () => {
    const outIds = GAMEPAD_OUTPUTS.map((o) => o.id);
    for (const id of outIds) {
      expect(DEFAULT_GAMEPAD_BINDINGS[id], `default for ${id}`).toBeDefined();
    }
    // Stick axes → axes 0..3; everything else → a button.
    expect(DEFAULT_GAMEPAD_BINDINGS.lx).toEqual({ kind: 'axis', index: 0 });
    expect(DEFAULT_GAMEPAD_BINDINGS.ly).toEqual({ kind: 'axis', index: 1 });
    expect(DEFAULT_GAMEPAD_BINDINGS.rx).toEqual({ kind: 'axis', index: 2 });
    expect(DEFAULT_GAMEPAD_BINDINGS.ry).toEqual({ kind: 'axis', index: 3 });
    expect(DEFAULT_GAMEPAD_BINDINGS.a).toEqual({ kind: 'button', index: 0 });
    expect(DEFAULT_GAMEPAD_BINDINGS.dr).toEqual({ kind: 'button', index: 15 });
  });

  it('isPhysicalControl accepts valid controls + rejects junk', () => {
    expect(isPhysicalControl({ kind: 'axis', index: 0 })).toBe(true);
    expect(isPhysicalControl({ kind: 'button', index: 7 })).toBe(true);
    expect(isPhysicalControl(null)).toBe(false);
    expect(isPhysicalControl({ kind: 'axis' })).toBe(false);
    expect(isPhysicalControl({ kind: 'axis', index: -1 })).toBe(false);
    expect(isPhysicalControl({ kind: 'axis', index: 1.5 })).toBe(false);
    expect(isPhysicalControl({ kind: 'pedal', index: 0 })).toBe(false);
  });

  it('bindingForOutput falls back to the default when there is no override', () => {
    expect(bindingForOutput('a', undefined)).toEqual({ kind: 'button', index: 0 });
    expect(bindingForOutput('a', {})).toEqual({ kind: 'button', index: 0 });
    expect(bindingForOutput('lx', {})).toEqual({ kind: 'axis', index: 0 });
  });

  it('bindingForOutput returns a valid override over the default', () => {
    const b: RemapBindings = { a: { kind: 'button', index: 2 } }; // A driven by physical X
    expect(bindingForOutput('a', b)).toEqual({ kind: 'button', index: 2 });
  });

  it('bindingForOutput ignores a corrupt override (falls back to default)', () => {
    const b = { a: { kind: 'bogus', index: -3 } } as unknown as RemapBindings;
    expect(bindingForOutput('a', b)).toEqual({ kind: 'button', index: 0 });
  });

  it('bindingForOutput returns undefined for an unknown output', () => {
    expect(bindingForOutput('nope', {})).toBeUndefined();
  });

  it('readControlValue reads the right axis / button value', () => {
    const r = reading([0.2, -0.4, 0.9, 0], [0, 0.7, 1]);
    expect(readControlValue(r, { kind: 'axis', index: 2 })).toBeCloseTo(0.9);
    expect(readControlValue(r, { kind: 'button', index: 1 })).toBeCloseTo(0.7);
    // Out-of-range index → 0 (never NaN/undefined).
    expect(readControlValue(r, { kind: 'axis', index: 9 })).toBe(0);
    expect(readControlValue(r, { kind: 'button', index: 9 })).toBe(0);
  });

  it('setBinding produces a new map with the output bound, others untouched', () => {
    const prev: RemapBindings = { b: { kind: 'button', index: 5 } };
    const next = setBinding(prev, 'a', { kind: 'button', index: 2 });
    expect(next.a).toEqual({ kind: 'button', index: 2 });
    expect(next.b).toEqual({ kind: 'button', index: 5 }); // untouched
    // Immutable: the original is unchanged.
    expect(prev.a).toBeUndefined();
  });

  it('arm → detect → setBinding: the X button press binds the `a` output', () => {
    // The button right-click flow, end to end (pure): arm only:'button', the
    // user presses physical X (button 2), the detector returns it, setBinding
    // records `a` → button 2.
    const armBaseline = reading([0, 0, 0, 0], [0, 0, 0, 0]);
    const pressedX = reading([0, 0, 0, 0], [0, 0, 1, 0]);
    const detected = detectChangedControl(armBaseline, pressedX, { only: 'button' });
    expect(detected).toEqual({ kind: 'button', index: 2 });
    const bindings = setBinding(undefined, 'a', detected as PhysicalControl);
    expect(bindingForOutput('a', bindings)).toEqual({ kind: 'button', index: 2 });
    // …and the `a` output now follows physical X: pressing X reads 1 via that
    // binding even though physical A (button 0) is untouched.
    expect(readControlValue(pressedX, bindingForOutput('a', bindings)!)).toBe(1);
    expect(readControlValue(pressedX, bindingForOutput('a', undefined)!)).toBe(0);
  });

  it('arm Remap X → detect → setBinding: the right-stick X axis binds `lx`', () => {
    // The "Remap X" flow: arm only:'axis', the user moves the right-stick X
    // (axis 2), the detector returns it, setBinding records lx → axis 2.
    const armBaseline = reading([0, 0, 0, 0], []);
    const movedRx = reading([0, 0, 0.9, 0], []);
    const detected = detectChangedControl(armBaseline, movedRx, { only: 'axis' });
    expect(detected).toEqual({ kind: 'axis', index: 2 });
    const bindings = setBinding(undefined, 'lx', detected as PhysicalControl);
    expect(bindingForOutput('lx', bindings)).toEqual({ kind: 'axis', index: 2 });
  });

  it('remapping back to the default DROPS the override (back-compat clean state)', () => {
    // Bind `a` → button 2, then remap it back to physical A (its default,
    // button 0) → the override is removed, leaving the clean absent state.
    let bindings = setBinding(undefined, 'a', { kind: 'button', index: 2 });
    expect(bindings.a).toBeDefined();
    bindings = setBinding(bindings, 'a', { kind: 'button', index: 0 });
    expect(bindings.a).toBeUndefined();
    expect(bindingForOutput('a', bindings)).toEqual({ kind: 'button', index: 0 });
  });

  it('two outputs CAN bind the same physical control (no exclusivity)', () => {
    // Conflict policy: a physical control may drive multiple outputs (last
    // write per OUTPUT wins; the same source on two outputs is allowed — both
    // simply follow it).
    let bindings = setBinding(undefined, 'a', { kind: 'button', index: 2 });
    bindings = setBinding(bindings, 'b', { kind: 'button', index: 2 });
    expect(bindingForOutput('a', bindings)).toEqual({ kind: 'button', index: 2 });
    expect(bindingForOutput('b', bindings)).toEqual({ kind: 'button', index: 2 });
  });

  it('describeControl labels standard controls + falls back for unknowns', () => {
    expect(describeControl({ kind: 'axis', index: 2 })).toBe('R-X axis');
    expect(describeControl({ kind: 'button', index: 0 })).toBe('A btn');
    expect(describeControl({ kind: 'button', index: 9 })).toBe('START btn');
    expect(describeControl({ kind: 'axis', index: 7 })).toBe('axis 7');
    expect(describeControl({ kind: 'button', index: 16 })).toBe('btn 16');
  });

  // The exact remap-output-dead bug, at the pure level: setBinding must return
  // FRESH value objects (never alias the input map's entries) so the in-place
  // commit can't re-assign an object already integrated into the Y.Doc tree.
  it('setBinding returns FRESH value objects (no alias to the input bindings)', () => {
    const prev: RemapBindings = { a: { kind: 'button', index: 5 }, b: { kind: 'button', index: 6 } };
    const next = setBinding(prev, 'lx', { kind: 'axis', index: 2 });
    // Carried-over entries are equal in VALUE but DIFFERENT object identities.
    expect(next.a).toEqual(prev.a);
    expect(next.a).not.toBe(prev.a);
    expect(next.b).not.toBe(prev.b);
    // The new entry is also a fresh object.
    expect(next.lx).toEqual({ kind: 'axis', index: 2 });
  });

  it('setBinding drops a corrupt entry in the input map (never carries it over)', () => {
    const prev = { a: { kind: 'bogus', index: -1 }, b: { kind: 'button', index: 6 } } as unknown as RemapBindings;
    const next = setBinding(prev, 'a', { kind: 'button', index: 2 });
    expect(next.b).toEqual({ kind: 'button', index: 6 });
    expect(next.a).toEqual({ kind: 'button', index: 2 });
  });

  it('applyBindingToData on a plain object preserves existing bindings (2nd remap)', () => {
    // Pure (plain-object) mirror of the real-Y.Doc regression — the 2nd commit
    // must keep the first binding AND add the second, not clobber/throw.
    const data: GamepadData = {};
    applyBindingToData(data, 'a', { kind: 'button', index: 2 });
    expect(data.bindings).toEqual({ a: { kind: 'button', index: 2 } });
    applyBindingToData(data, 'rx', { kind: 'axis', index: 5 });
    expect(data.bindings).toEqual({
      a: { kind: 'button', index: 2 },
      rx: { kind: 'axis', index: 5 },
    });
  });

  it('applyBindingToData remapping an axis to its OWN default drops the override, output unaffected', () => {
    const data: GamepadData = {};
    applyBindingToData(data, 'a', { kind: 'button', index: 2 });
    // rx → its default axis 2 → dropped; `a` override survives.
    applyBindingToData(data, 'rx', { kind: 'axis', index: 2 });
    expect(data.bindings?.rx).toBeUndefined();
    expect(data.bindings?.a).toEqual({ kind: 'button', index: 2 });
    // rx falls back to its default control.
    expect(bindingForOutput('rx', data.bindings)).toEqual({ kind: 'axis', index: 2 });
  });

  it('clearBindingOnData removes a single override, leaves others', () => {
    const data: GamepadData = {};
    applyBindingToData(data, 'a', { kind: 'button', index: 2 });
    applyBindingToData(data, 'b', { kind: 'button', index: 3 });
    clearBindingOnData(data, 'a');
    expect(data.bindings?.a).toBeUndefined();
    expect(data.bindings?.b).toEqual({ kind: 'button', index: 3 });
    // Clearing on data with no bindings map is a safe no-op.
    expect(() => clearBindingOnData({}, 'a')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// PER-AXIS INVERT — pure transform + composition with remap (4 toggles).
// ---------------------------------------------------------------------------
describe('gamepad per-axis invert', () => {
  it('INVERTIBLE_AXES is exactly the four stick-axis outputs', () => {
    expect([...INVERTIBLE_AXES].sort()).toEqual(['lx', 'ly', 'rx', 'ry']);
  });

  it('isInvertibleAxis is true only for the four stick axes', () => {
    for (const id of ['lx', 'ly', 'rx', 'ry']) expect(isInvertibleAxis(id)).toBe(true);
    for (const id of ['lt', 'rt', 'a', 'du', 'start', 'nope']) expect(isInvertibleAxis(id)).toBe(false);
  });

  it('applyInvert negates the value (v → -v) when the axis flag is set', () => {
    expect(applyInvert('rx', 0.7, { rx: true })).toBeCloseTo(-0.7);
    expect(applyInvert('rx', -0.4, { rx: true })).toBeCloseTo(0.4);
    expect(applyInvert('ly', 1, { ly: true })).toBe(-1);
  });

  it('applyInvert keeps the range + centre (0 stays 0; ±1 stays ±1 magnitude)', () => {
    // -0 === 0 (centre is unchanged); use closeTo so the sign of zero doesn't matter.
    expect(applyInvert('lx', 0, { lx: true })).toBeCloseTo(0);
    expect(applyInvert('lx', 1, { lx: true })).toBe(-1);
    expect(applyInvert('lx', -1, { lx: true })).toBe(1);
  });

  it('applyInvert is a no-op when the flag is absent/false or invert map missing', () => {
    expect(applyInvert('rx', 0.7, {})).toBeCloseTo(0.7);
    expect(applyInvert('rx', 0.7, { rx: false })).toBeCloseTo(0.7);
    expect(applyInvert('rx', 0.7, undefined)).toBeCloseTo(0.7);
    expect(applyInvert('rx', 0.7, { lx: true })).toBeCloseTo(0.7); // a DIFFERENT axis
  });

  it('applyInvert never touches non-axis outputs (triggers / buttons)', () => {
    // Even if a (nonsensical) flag is present for a non-axis id, it passes through.
    expect(applyInvert('lt', 0.9, { lx: true } as never)).toBeCloseTo(0.9);
    expect(applyInvert('a', 1, { rx: true })).toBe(1);
  });

  it('invert composes AFTER a remap (apply to the already-remapped value)', () => {
    // The read loop reads the (possibly remapped) axis, shapes it, THEN inverts.
    // Model that order: remap rx → axis 0, read its value, invert.
    const reading: RawGamepadReading = { axes: [0.6, 0, 0, 0], buttons: [] };
    const bindings = setBinding(undefined, 'rx', { kind: 'axis', index: 0 });
    const ctrl = bindingForOutput('rx', bindings)!;
    const shaped = applyDeadzone(readControlValue(reading, ctrl)); // remapped + deadzoned
    expect(shaped).toBeGreaterThan(0.5);
    const inverted = applyInvert('rx', shaped, { rx: true });
    expect(inverted).toBeCloseTo(-shaped, 6);
    expect(inverted).toBeLessThan(-0.5);
  });

  it('toggleInvertOnData flips a flag on/off in place + cleans an emptied map', () => {
    const data: GamepadData = {};
    toggleInvertOnData(data, 'rx');
    expect(data.invert).toEqual({ rx: true });
    toggleInvertOnData(data, 'ly');
    expect(data.invert).toEqual({ rx: true, ly: true });
    // Toggle rx back off → flag deleted, ly stays.
    toggleInvertOnData(data, 'rx');
    expect(data.invert).toEqual({ ly: true });
    // Toggle the last flag off → the whole invert map is dropped (clean state).
    toggleInvertOnData(data, 'ly');
    expect(data.invert).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// RIGHT-STICK CALIBRATION — the right stick stores its OWN StickCalibration
// record on node.data.rightStickCalibration, applied to rx/ry exactly as the
// left's is to lx/ly. The calibration MATH is shared (already covered above);
// these pin that the right record is independent + symmetric on GamepadData.
// (The read-loop application is covered end-to-end by the e2e spec.)
// ---------------------------------------------------------------------------
describe('right-stick calibration (symmetric to left)', () => {
  const cal: StickCalibration = { minX: -0.6, maxX: 0.6, minY: -0.6, maxY: 0.6, deadzone: 0.1 };

  it('left + right calibration records are independent fields on GamepadData', () => {
    const data: GamepadData = {};
    data.leftStickCalibration = { ...cal };
    data.rightStickCalibration = { minX: -0.7, maxX: 0.8, minY: -0.75, maxY: 0.7, deadzone: 0.1 };
    expect(data.leftStickCalibration).not.toEqual(data.rightStickCalibration);
    // Clearing one leaves the other intact.
    delete data.leftStickCalibration;
    expect(data.leftStickCalibration).toBeUndefined();
    expect(data.rightStickCalibration?.maxX).toBeCloseTo(0.8);
  });

  it('the right stick reuses the SAME applyCalibration math (full deflection → ±1)', () => {
    // The right stick reads its own axes (2,3) but maps them through the exact
    // same applyCalibration. A reduced ±0.6 range maps to (near) ±1.
    expect(applyCalibration(0.6, 0, cal).x).toBeCloseTo(1, 4);
    expect(applyCalibration(-0.6, 0, cal).x).toBeCloseTo(-1, 4);
    expect(applyCalibration(0, 0.6, cal).y).toBeCloseTo(1, 4);
    expect(applyCalibration(0, -0.6, cal).y).toBeCloseTo(-1, 4);
  });
});

// ---------------------------------------------------------------------------
// SAVE / LOAD MAPPING + built-in PRESETS — exportMapping / applyMapping /
// isGamepadMapping / GAMEPAD_PRESETS (pure paths; the real-Y.Doc apply trap is
// covered in gamepad-remap-ydoc.test.ts).
// ---------------------------------------------------------------------------
describe('gamepad save/load mapping', () => {
  const fullData = (): GamepadData => ({
    bindings: { a: { kind: 'button', index: 2 }, rx: { kind: 'axis', index: 0 } },
    invert: { ly: true, rx: true },
    leftStickCalibration: { minX: -0.7, maxX: 0.8, minY: -0.75, maxY: 0.7, deadzone: 0.1 },
    rightStickCalibration: { minX: -0.6, maxX: 0.6, minY: -0.6, maxY: 0.6, deadzone: 0.12 },
  });

  it('exportMapping pulls the persistable fields into a fresh plain object', () => {
    const data = fullData();
    const m = exportMapping(data);
    expect(m.bindings).toEqual(data.bindings);
    expect(m.invert).toEqual(data.invert);
    expect(m.leftStickCalibration).toEqual(data.leftStickCalibration);
    expect(m.rightStickCalibration).toEqual(data.rightStickCalibration);
  });

  it('exportMapping never aliases the source (deep, fresh values)', () => {
    const data = fullData();
    const m = exportMapping(data);
    expect(m.bindings).not.toBe(data.bindings);
    expect(m.bindings!.a).not.toBe(data.bindings!.a);
    expect(m.invert).not.toBe(data.invert);
    expect(m.leftStickCalibration).not.toBe(data.leftStickCalibration);
    expect(m.rightStickCalibration).not.toBe(data.rightStickCalibration);
  });

  it('exportMapping omits absent/empty fields (clean minimal mapping)', () => {
    expect(exportMapping({})).toEqual({});
    expect(exportMapping(undefined)).toEqual({});
    expect(exportMapping({ invert: {} })).toEqual({});
    expect(exportMapping({ bindings: {} })).toEqual({});
  });

  it('round-trips: export then apply onto a fresh node yields equivalent data', () => {
    const data = fullData();
    const m = exportMapping(data);
    const target: GamepadData = {};
    applyMapping(target, m);
    expect(target.bindings).toEqual(data.bindings);
    expect(target.invert).toEqual(data.invert);
    expect(target.leftStickCalibration).toEqual(data.leftStickCalibration);
    expect(target.rightStickCalibration).toEqual(data.rightStickCalibration);
  });

  it('applyMapping over EXISTING data replaces it wholesale (no leftover keys)', () => {
    const target: GamepadData = {
      bindings: { b: { kind: 'button', index: 5 }, lx: { kind: 'axis', index: 3 } },
      invert: { lx: true },
      leftStickCalibration: { minX: -1, maxX: 1, minY: -1, maxY: 1, deadzone: 0.1 },
    };
    applyMapping(target, { bindings: { a: { kind: 'button', index: 2 } }, invert: { rx: true } });
    // Old bindings/invert/calibration are gone; only the new mapping remains.
    expect(target.bindings).toEqual({ a: { kind: 'button', index: 2 } });
    expect(target.invert).toEqual({ rx: true });
    expect(target.leftStickCalibration).toBeUndefined();
  });

  it('applying an EMPTY mapping clears everything to the default state', () => {
    const target = fullData();
    applyMapping(target, {});
    expect(target.bindings).toBeUndefined();
    expect(target.invert).toBeUndefined();
    expect(target.leftStickCalibration).toBeUndefined();
    expect(target.rightStickCalibration).toBeUndefined();
  });

  it('apply twice (idempotent) yields the same data, never throws (plain-object mirror)', () => {
    const m = exportMapping(fullData());
    const target: GamepadData = {};
    expect(() => { applyMapping(target, m); applyMapping(target, m); }).not.toThrow();
    expect(target.bindings).toEqual(m.bindings);
    expect(target.invert).toEqual(m.invert);
  });

  it('applyMapping sanitises garbage sub-fields (corrupt binding dropped, never thrown)', () => {
    const target: GamepadData = {};
    const garbage = {
      bindings: { a: { kind: 'bogus', index: -1 }, b: { kind: 'button', index: 3 } },
      invert: { lx: true, nope: true },
      leftStickCalibration: { minX: 'x' },
    } as unknown as GamepadMapping;
    expect(() => applyMapping(target, garbage)).not.toThrow();
    // The corrupt binding is dropped; the valid one survives.
    expect(target.bindings).toEqual({ b: { kind: 'button', index: 3 } });
    // Only the valid invert axis survives.
    expect(target.invert).toEqual({ lx: true });
    // The malformed calibration is ignored.
    expect(target.leftStickCalibration).toBeUndefined();
  });

  it('applyMapping ignores wholesale-garbage (non-object) input without throwing', () => {
    const target = fullData();
    // A totally invalid mapping is treated as an empty mapping (clears state).
    expect(() => applyMapping(target, null as unknown as GamepadMapping)).not.toThrow();
    expect(target.bindings).toBeUndefined();
  });

  it('isGamepadMapping accepts valid + empty, rejects garbage', () => {
    expect(isGamepadMapping({})).toBe(true);
    expect(isGamepadMapping({ bindings: { a: { kind: 'button', index: 0 } } })).toBe(true);
    expect(isGamepadMapping({ unknownKey: 1 })).toBe(true); // extra keys ignored
    expect(isGamepadMapping(null)).toBe(false);
    expect(isGamepadMapping(42)).toBe(false);
    expect(isGamepadMapping('nope')).toBe(false);
    expect(isGamepadMapping({ bindings: 5 })).toBe(false);
    expect(isGamepadMapping({ invert: 'x' })).toBe(false);
  });

  it('a mapping survives JSON round-trip (save → parse → apply)', () => {
    const m = exportMapping(fullData());
    const reparsed: unknown = JSON.parse(JSON.stringify(m));
    expect(isGamepadMapping(reparsed)).toBe(true);
    const target: GamepadData = {};
    applyMapping(target, reparsed as GamepadMapping);
    expect(target.bindings).toEqual(m.bindings);
    expect(target.rightStickCalibration).toEqual(m.rightStickCalibration);
  });
});

describe('gamepad built-in presets', () => {
  it('GAMEPAD_PRESETS contains the "NXT Gladiator" entry', () => {
    const names = GAMEPAD_PRESETS.map((p) => p.name);
    expect(names).toContain('NXT Gladiator');
  });

  it('every preset has a valid (loadable) mapping', () => {
    for (const p of GAMEPAD_PRESETS) {
      expect(isGamepadMapping(p.mapping), `${p.name} mapping shape`).toBe(true);
    }
  });

  it('applying the "NXT Gladiator" preset does not throw + lands its real mapping', () => {
    const preset = GAMEPAD_PRESETS.find((p) => p.name === 'NXT Gladiator')!;
    const target: GamepadData = {};
    expect(() => applyMapping(target, preset.mapping)).not.toThrow();
    // 'a' is NOT remapped by the preset → stays the standard button 0.
    expect(bindingForOutput('a', target.bindings)).toEqual({ kind: 'button', index: 0 });
    // The right stick is the owner's real remap: rx→axis 3, ry→axis 2 (inverted),
    // and x is on button 21. The left stick is left at its standard axes.
    expect(bindingForOutput('rx', target.bindings)).toEqual({ kind: 'axis', index: 3 });
    expect(bindingForOutput('ry', target.bindings)).toEqual({ kind: 'axis', index: 2 });
    expect(bindingForOutput('x', target.bindings)).toEqual({ kind: 'button', index: 21 });
    expect(bindingForOutput('lx', target.bindings)).toEqual({ kind: 'axis', index: 0 });
    expect(target.invert?.ry).toBe(true);
    // The measured stick calibration travels with the preset.
    expect(target.leftStickCalibration?.deadzone).toBe(0.1);
    expect(target.rightStickCalibration?.maxX).toBe(1);
  });
});
