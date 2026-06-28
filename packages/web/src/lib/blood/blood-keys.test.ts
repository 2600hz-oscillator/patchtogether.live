// packages/web/src/lib/blood/blood-keys.test.ts
//
// Unit coverage for the BLOOD CV-gate + keyboard → Build-scancode maps. The
// VRT exemption for the `blood` module cites this suite (the live game-loop
// framebuffer + user-supplied data can't be VRT-baselined, so the deterministic
// pieces — the scancode tables — are unit-tested instead).

import { describe, it, expect } from 'vitest';
import {
  CV_GATE_PORT_IDS,
  SCANCODE_FOR_CV_GATE,
  SCANCODE_FOR_KEYBOARD_CODE,
  SC_UP_ARROW,
  SC_LEFT_CONTROL,
  SC_SPACE,
  SC_ESCAPE,
  SC_ENTER,
} from './blood-keys';
import { bloodDef } from '$lib/video/modules/blood';

describe('blood-keys — CV-gate → Build scancode map', () => {
  it('maps every declared CV-gate port id to a Build scancode', () => {
    for (const base of CV_GATE_PORT_IDS) {
      expect(SCANCODE_FOR_CV_GATE[base], `missing scancode for cv-gate '${base}'`).toBeTypeOf('number');
    }
  });

  it('every scancode is a valid 8-bit Build scancode (0..255)', () => {
    for (const base of CV_GATE_PORT_IDS) {
      const sc = SCANCODE_FOR_CV_GATE[base]!;
      expect(sc).toBeGreaterThanOrEqual(0);
      expect(sc).toBeLessThanOrEqual(255);
    }
  });

  it('pins the load-bearing movement/action scancodes (regression)', () => {
    // These exact values come from build/include/scancodes.h; a drift here
    // would silently misroute input to the wrong key.
    expect(SCANCODE_FOR_CV_GATE.up).toBe(SC_UP_ARROW); // 0xc8
    expect(SCANCODE_FOR_CV_GATE.fire).toBe(SC_LEFT_CONTROL); // 0x1d
    expect(SCANCODE_FOR_CV_GATE.use).toBe(SC_SPACE); // 0x39
    expect(SCANCODE_FOR_CV_GATE.esc).toBe(SC_ESCAPE); // 0x01
    expect(SCANCODE_FOR_CV_GATE.enter).toBe(SC_ENTER); // 0x1c
  });
});

describe('blood-keys — KeyboardEvent.code → Build scancode map', () => {
  it('maps the standard movement/action codes', () => {
    expect(SCANCODE_FOR_KEYBOARD_CODE.ArrowUp).toBe(SC_UP_ARROW);
    expect(SCANCODE_FOR_KEYBOARD_CODE.ControlLeft).toBe(SC_LEFT_CONTROL);
    expect(SCANCODE_FOR_KEYBOARD_CODE.Space).toBe(SC_SPACE);
    expect(SCANCODE_FOR_KEYBOARD_CODE.Escape).toBe(SC_ESCAPE);
    expect(SCANCODE_FOR_KEYBOARD_CODE.Enter).toBe(SC_ENTER);
  });

  it('stays off the numpad (NUMPAD+ exclusive collision surface)', () => {
    for (const code of Object.keys(SCANCODE_FOR_KEYBOARD_CODE)) {
      expect(code.startsWith('Numpad'), `blood must not bind numpad code ${code}`).toBe(false);
    }
  });
});

describe('blood module def ↔ keys consistency', () => {
  it('every cv-typed input port has a scancode in the CV-gate map', () => {
    const cvInputs = bloodDef.inputs.filter((p) => p.type === 'cv').map((p) => p.id);
    for (const id of cvInputs) {
      expect(SCANCODE_FOR_CV_GATE[id], `def input '${id}' has no scancode`).toBeTypeOf('number');
    }
    // And the def declares exactly the CV gate ports the map covers.
    expect(new Set(cvInputs)).toEqual(new Set(CV_GATE_PORT_IDS));
  });

  it('esc/enter are declared trigger edges; movement gates are gate edges', () => {
    const byId = new Map(bloodDef.inputs.map((p) => [p.id, p.edge]));
    expect(byId.get('esc')).toBe('trigger');
    expect(byId.get('enter')).toBe('trigger');
    expect(byId.get('up')).toBe('gate');
    expect(byId.get('fire')).toBe('gate');
  });

  it('is single-player single-instance + owner-only (mirrors the DOOM model)', () => {
    expect(bloodDef.maxInstances).toBe(1);
    expect(bloodDef.ownerOnly).toBe(true);
    expect(bloodDef.domain).toBe('video');
    expect(bloodDef.label).toBe('blood'); // lowercase label rule
  });
});
