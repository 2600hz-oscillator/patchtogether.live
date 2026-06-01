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
} from './gamepad';

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
