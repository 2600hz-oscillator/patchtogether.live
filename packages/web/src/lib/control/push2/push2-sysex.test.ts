// packages/web/src/lib/control/push2/push2-sysex.test.ts
//
// Golden-vector tests for the PURE Ableton Push 2 User-mode codec. Every byte
// sequence is pinned to the Push 2 MIDI/Display interface spec + ffont/push2-
// python, so a drift in the protocol numbers fails here before it reaches
// hardware.
import { describe, it, expect } from 'vitest';
import {
  PUSH2_MFR_ID,
  PUSH2_DEVICE_MODEL,
  PUSH_WIDTH,
  PUSH_HEIGHT,
  PUSH_PAD_BASE,
  clamp7,
  pushPadNote,
  pushNoteToPad,
  decodeRelativeCc,
  pushColorIndex,
  encodeEnterUserMode,
  encodeExitUserMode,
  encodePadColor,
  encodeButtonLed,
  decodePush2Message,
  isPush2Sysex,
} from './push2-sysex';

describe('Push 2 protocol constants', () => {
  it('uses the Ableton manufacturer id 00 21 1D + device/model 01 01', () => {
    expect([...PUSH2_MFR_ID]).toEqual([0x00, 0x21, 0x1d]);
    expect([...PUSH2_DEVICE_MODEL]).toEqual([0x01, 0x01]);
  });
  it('is an 8×8 grid based at note 36', () => {
    expect(PUSH_WIDTH).toBe(8);
    expect(PUSH_HEIGHT).toBe(8);
    expect(PUSH_PAD_BASE).toBe(36);
  });
});

describe('pushPadNote / pushNoteToPad (36..99, bottom-left origin)', () => {
  it('maps the four corners', () => {
    expect(pushPadNote(0, 0)).toBe(36); // bottom-left
    expect(pushPadNote(7, 0)).toBe(43); // bottom-right
    expect(pushPadNote(0, 7)).toBe(92); // top-left
    expect(pushPadNote(7, 7)).toBe(99); // top-right
  });
  it('round-trips every grid cell', () => {
    for (let y = 0; y < PUSH_HEIGHT; y++) {
      for (let x = 0; x < PUSH_WIDTH; x++) {
        expect(pushNoteToPad(pushPadNote(x, y))).toEqual({ x, y });
      }
    }
  });
  it('rejects non-grid notes', () => {
    expect(pushNoteToPad(35)).toBeNull(); // below the grid
    expect(pushNoteToPad(100)).toBeNull(); // above the grid
    expect(pushNoteToPad(0)).toBeNull();
  });
  it('clamps out-of-range coords defensively', () => {
    expect(pushPadNote(-1, -1)).toBe(36);
    expect(pushPadNote(99, 99)).toBe(99);
  });
});

describe('decodeRelativeCc (relative 2s-complement)', () => {
  it('decodes clockwise (1..63) as positive', () => {
    expect(decodeRelativeCc(1)).toBe(1);
    expect(decodeRelativeCc(63)).toBe(63);
  });
  it('decodes counter-clockwise (64..127) as negative', () => {
    expect(decodeRelativeCc(127)).toBe(-1);
    expect(decodeRelativeCc(65)).toBe(-63);
    expect(decodeRelativeCc(64)).toBe(-64);
  });
  it('zero = no motion', () => {
    expect(decodeRelativeCc(0)).toBe(0);
  });
});

describe('pushColorIndex (stock-palette nearest-anchor)', () => {
  it('snaps the research-confirmed anchors', () => {
    expect(pushColorIndex(0, 0, 0)).toBe(0); // black / off
    expect(pushColorIndex(127, 0, 0)).toBe(127); // red
    expect(pushColorIndex(0, 127, 0)).toBe(126); // green
    expect(pushColorIndex(0, 0, 127)).toBe(125); // blue
    expect(pushColorIndex(127, 127, 127)).toBe(122); // white
  });
  it('a near-black colour maps to off/dim, not a bright hue', () => {
    expect([0, 1]).toContain(pushColorIndex(3, 3, 3));
  });
  it('clamp7 clamps to 0..127', () => {
    expect(clamp7(-5)).toBe(0);
    expect(clamp7(200)).toBe(127);
    expect(clamp7(63.4)).toBe(63);
    expect(clamp7(NaN)).toBe(0);
  });
});

describe('User-mode enter/exit (golden vectors)', () => {
  it('enter = F0 00 21 1D 01 01 0A 01 F7', () => {
    expect([...encodeEnterUserMode()]).toEqual([0xf0, 0x00, 0x21, 0x1d, 0x01, 0x01, 0x0a, 0x01, 0xf7]);
  });
  it('exit = F0 00 21 1D 01 01 0A 00 F7', () => {
    expect([...encodeExitUserMode()]).toEqual([0xf0, 0x00, 0x21, 0x1d, 0x01, 0x01, 0x0a, 0x00, 0xf7]);
  });
});

describe('LED encoders (golden vectors)', () => {
  it('encodePadColor = Note-On <note> <paletteIndex>', () => {
    expect([...encodePadColor(36, 126)]).toEqual([0x90, 36, 126]);
    expect([...encodePadColor(99, 0)]).toEqual([0x90, 99, 0]);
  });
  it('encodeButtonLed = CC <cc> <value>', () => {
    expect([...encodeButtonLed(85, 127)]).toEqual([0xb0, 85, 127]);
  });
  it('clamps LED values', () => {
    expect([...encodePadColor(36, 999)]).toEqual([0x90, 36, 127]);
  });
});

describe('decodePush2Message (RX)', () => {
  it('decodes a pad press → (x,y) + velocity', () => {
    expect(decodePush2Message([0x90, 36, 100])).toEqual({ type: 'pad', x: 0, y: 0, s: 1, velocity: 100 });
    expect(decodePush2Message([0x90, 99, 64])).toEqual({ type: 'pad', x: 7, y: 7, s: 1, velocity: 64 });
  });
  it('decodes a pad release (Note-Off + Note-On vel 0)', () => {
    expect(decodePush2Message([0x80, 43, 0])).toEqual({ type: 'pad', x: 7, y: 0, s: 0, velocity: 0 });
    expect(decodePush2Message([0x90, 43, 0])).toEqual({ type: 'pad', x: 7, y: 0, s: 0, velocity: 0 });
  });
  it('decodes a CC (button / encoder) with its raw value + press flag', () => {
    expect(decodePush2Message([0xb0, 85, 127])).toEqual({ type: 'cc', cc: 85, s: 1, value: 127 });
    expect(decodePush2Message([0xb0, 71, 1])).toEqual({ type: 'cc', cc: 71, s: 1, value: 1 }); // encoder +1
    expect(decodePush2Message([0xb0, 85, 0])).toEqual({ type: 'cc', cc: 85, s: 0, value: 0 });
  });
  it('returns null for malformed / uninteresting messages', () => {
    expect(decodePush2Message([0x90, 36])).toBeNull(); // too short
    expect(decodePush2Message([0xf8])).toBeNull(); // a clock byte
    expect(decodePush2Message([0x90, 35, 100])).toBeNull(); // note below the grid
  });
});

describe('isPush2Sysex', () => {
  it('matches our device header only', () => {
    expect(isPush2Sysex(encodeEnterUserMode())).toBe(true);
    expect(isPush2Sysex([0xf0, 0x00, 0x20, 0x29, 0x02, 0x0d, 0x0e, 0x01, 0xf7])).toBe(false); // a Launchpad frame
    expect(isPush2Sysex([0xf0, 0x00, 0x00])).toBe(false);
    expect(isPush2Sysex([0x90, 36, 100])).toBe(false); // not even SysEx
  });
});
