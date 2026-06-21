// packages/web/src/lib/control/launchpad/launchpad-sysex.test.ts
//
// Golden-vector tests for the PURE Launchpad Mini Mk3 programmer-mode codec.
// Every byte sequence here is pinned to the Novation Launchpad Mini MK3
// Programmer's Reference (cross-checked with lpminimk3 / launchpad.py), so a
// drift in the protocol numbers fails here before it ever reaches hardware.

import { describe, it, expect } from 'vitest';
import {
  NOVATION_MFR_ID,
  LP_MINI_MK3_PRODUCT,
  LP_WIDTH,
  LP_HEIGHT,
  LP_RGB_MAX,
  CC_UP,
  CC_DOWN,
  CC_LEFT,
  CC_RIGHT,
  CC_SESSION,
  CC_LOGO,
  SCENE_CCS,
  clampRgb,
  padNote,
  noteToPad,
  sceneRowForCc,
  isTopCc,
  encodeEnterProgrammerMode,
  encodeExitProgrammerMode,
  encodeLedRgb,
  encodePadRgb,
  encodeLedRgbBatch,
  decodeMidiMessage,
  isMiniMk3Sysex,
} from './launchpad-sysex';

const hex = (b: Uint8Array) => Array.from(b, (n) => n.toString(16).padStart(2, '0')).join(' ');

describe('Launchpad protocol constants', () => {
  it('uses the Novation manufacturer id 00 20 29 + Mini Mk3 product 02 0d', () => {
    expect([...NOVATION_MFR_ID]).toEqual([0x00, 0x20, 0x29]);
    expect([...LP_MINI_MK3_PRODUCT]).toEqual([0x02, 0x0d]);
  });
  it('is an 8×8 grid with 0-127 RGB', () => {
    expect(LP_WIDTH).toBe(8);
    expect(LP_HEIGHT).toBe(8);
    expect(LP_RGB_MAX).toBe(127);
  });
  it('top-row CCs are 91-95 (▲▼◀▶ Session) and logo is 99', () => {
    expect([CC_UP, CC_DOWN, CC_LEFT, CC_RIGHT, CC_SESSION]).toEqual([91, 92, 93, 94, 95]);
    expect(CC_LOGO).toBe(99);
  });
  it('scene-column CCs are 89,79,…,19 top→bottom', () => {
    expect([...SCENE_CCS]).toEqual([89, 79, 69, 59, 49, 39, 29, 19]);
  });
});

describe('padNote / noteToPad (programmer-mode 11..88, bottom-left origin)', () => {
  it('maps the four corners', () => {
    expect(padNote(0, 0)).toBe(11); // bottom-left
    expect(padNote(7, 0)).toBe(18); // bottom-right
    expect(padNote(0, 7)).toBe(81); // top-left
    expect(padNote(7, 7)).toBe(88); // top-right
  });
  it('round-trips every grid cell', () => {
    for (let y = 0; y < LP_HEIGHT; y++) {
      for (let x = 0; x < LP_WIDTH; x++) {
        expect(noteToPad(padNote(x, y))).toEqual({ x, y });
      }
    }
  });
  it('rejects non-grid notes (scene/top CCs, out of range, garbage)', () => {
    expect(noteToPad(10)).toBeNull(); // col 0 → invalid
    expect(noteToPad(19)).toBeNull(); // a scene CC value, col 9 → invalid
    expect(noteToPad(89)).toBeNull();
    expect(noteToPad(99)).toBeNull(); // logo
    expect(noteToPad(0)).toBeNull();
    expect(noteToPad(127)).toBeNull();
  });
  it('clamps out-of-range coords defensively', () => {
    expect(padNote(-1, -1)).toBe(11);
    expect(padNote(99, 99)).toBe(88);
  });
});

describe('clampRgb', () => {
  it('clamps to 0..127 and integerizes', () => {
    expect(clampRgb(-5)).toBe(0);
    expect(clampRgb(200)).toBe(127);
    expect(clampRgb(63.4)).toBe(63);
    expect(clampRgb(NaN)).toBe(0);
  });
});

describe('programmer-mode enter/exit (golden vectors)', () => {
  it('enter = F0 00 20 29 02 0D 0E 01 F7', () => {
    expect([...encodeEnterProgrammerMode()]).toEqual([
      0xf0, 0x00, 0x20, 0x29, 0x02, 0x0d, 0x0e, 0x01, 0xf7,
    ]);
  });
  it('exit = F0 00 20 29 02 0D 0E 00 F7', () => {
    expect([...encodeExitProgrammerMode()]).toEqual([
      0xf0, 0x00, 0x20, 0x29, 0x02, 0x0d, 0x0e, 0x00, 0xf7,
    ]);
  });
});

describe('RGB lighting SysEx (golden vectors)', () => {
  it('encodeLedRgb wraps a single type-3 spec: …03 03 <idx> <r> <g> <b> F7', () => {
    // Light the top-right pad (note 88) full green.
    expect([...encodeLedRgb(88, 0, 127, 0)]).toEqual([
      0xf0, 0x00, 0x20, 0x29, 0x02, 0x0d, 0x03, 0x03, 88, 0, 127, 0, 0xf7,
    ]);
  });
  it('encodePadRgb addresses by (x,y) cell', () => {
    expect(hex(encodePadRgb(0, 0, 12, 34, 56))).toBe(hex(encodeLedRgb(11, 12, 34, 56)));
  });
  it('clamps RGB components', () => {
    expect([...encodeLedRgb(11, 999, -1, 50.9)]).toEqual([
      0xf0, 0x00, 0x20, 0x29, 0x02, 0x0d, 0x03, 0x03, 11, 127, 0, 51, 0xf7,
    ]);
  });
  it('encodeLedRgbBatch packs many specs into one SysEx', () => {
    const out = encodeLedRgbBatch([
      { index: 11, r: 1, g: 2, b: 3 },
      { index: 88, r: 4, g: 5, b: 6 },
    ]);
    expect([...out]).toEqual([
      0xf0, 0x00, 0x20, 0x29, 0x02, 0x0d, 0x03,
      0x03, 11, 1, 2, 3,
      0x03, 88, 4, 5, 6,
      0xf7,
    ]);
  });
  it('an empty batch produces no bytes', () => {
    expect(encodeLedRgbBatch([]).length).toBe(0);
  });
});

describe('decodeMidiMessage (RX)', () => {
  it('decodes a pad press (Note-On) → its (x,y) + velocity', () => {
    // Note-On ch1, note 11 (bottom-left), vel 100.
    expect(decodeMidiMessage([0x90, 11, 100])).toEqual({
      type: 'pad', x: 0, y: 0, s: 1, velocity: 100,
    });
  });
  it('decodes a pad release (Note-Off and Note-On vel 0)', () => {
    expect(decodeMidiMessage([0x80, 88, 0])).toEqual({
      type: 'pad', x: 7, y: 7, s: 0, velocity: 0,
    });
    expect(decodeMidiMessage([0x90, 88, 0])).toEqual({
      type: 'pad', x: 7, y: 7, s: 0, velocity: 0,
    });
  });
  it('ignores the channel nibble', () => {
    // Note-On ch 3 (0x92) still decodes as a pad.
    expect(decodeMidiMessage([0x92, 11, 64])?.type).toBe('pad');
  });
  it('decodes a top-row button (CC 95 Session/SHIFT)', () => {
    expect(decodeMidiMessage([0xb0, CC_SESSION, 127])).toEqual({
      type: 'top', cc: 95, s: 1,
    });
    expect(decodeMidiMessage([0xb0, CC_UP, 0])).toEqual({ type: 'top', cc: 91, s: 0 });
  });
  it('decodes a scene-column button → its bottom-origin row', () => {
    // CC 89 is the TOP scene button → row 7; CC 19 is the bottom → row 0.
    expect(decodeMidiMessage([0xb0, 89, 127])).toEqual({ type: 'scene', row: 7, cc: 89, s: 1 });
    expect(decodeMidiMessage([0xb0, 19, 127])).toEqual({ type: 'scene', row: 0, cc: 19, s: 1 });
  });
  it('decodes any other CC (e.g. the logo) as a generic cc event', () => {
    expect(decodeMidiMessage([0xb0, CC_LOGO, 127])).toEqual({ type: 'cc', cc: 99, s: 1 });
  });
  it('returns null for malformed / uninteresting messages', () => {
    expect(decodeMidiMessage([0x90, 11])).toBeNull(); // too short
    expect(decodeMidiMessage([0xf8])).toBeNull(); // a clock byte
    expect(decodeMidiMessage([0x90, 10, 100])).toBeNull(); // note not on the grid
  });
});

describe('helpers', () => {
  it('sceneRowForCc maps CCs ↔ rows and rejects non-scene CCs', () => {
    expect(sceneRowForCc(89)).toBe(7);
    expect(sceneRowForCc(19)).toBe(0);
    expect(sceneRowForCc(59)).toBe(4); // index 3 (top→bottom) → row 7-3 = 4
    expect(sceneRowForCc(49)).toBe(3);
    expect(sceneRowForCc(91)).toBeNull(); // a top CC, not a scene CC
    expect(sceneRowForCc(0)).toBeNull();
  });
  it('isTopCc covers 91..98 only', () => {
    expect(isTopCc(91)).toBe(true);
    expect(isTopCc(98)).toBe(true);
    expect(isTopCc(90)).toBe(false);
    expect(isTopCc(99)).toBe(false); // logo, not top row
  });
  it('isMiniMk3Sysex matches our product header only', () => {
    expect(isMiniMk3Sysex(encodeEnterProgrammerMode())).toBe(true);
    // A Launchpad X frame (product 02 0c) is NOT ours.
    expect(isMiniMk3Sysex([0xf0, 0x00, 0x20, 0x29, 0x02, 0x0c, 0x0e, 0x01, 0xf7])).toBe(false);
    expect(isMiniMk3Sysex([0xf0, 0x00, 0x00])).toBe(false);
    expect(isMiniMk3Sysex([0x90, 11, 100])).toBe(false); // not even SysEx
  });
});
