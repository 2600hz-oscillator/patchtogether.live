import { describe, expect, it } from 'vitest';
import {
  buildCapsRequest,
  buildSetAbs,
  buildSetVel,
  buildStopAll,
  decodeVal35,
  encodeVal35,
  parsePtzFrame,
} from './ptz-sysex';

// Captured VERBATIM from the multicam helper on real hardware (2026-08-29).
// If the framing on either side drifts, these fixtures are the tie-breaker.

// NexiGo P610 — all three axes ABSOLUTE.
const HW_CAPS_NEXIGO = [
  0xf0, 0x7d, 0x50, 0x54, 0x5a, 0x02, 0x41, 0x03,
  0x01, 0x01, 0x60, 0x52, 0x5a, 0x7f, 0x7f, 0x20, 0x2d, 0x25, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x00, 0x10, 0x7d, 0x01, 0x00, 0x00,
  0x02, 0x01, 0x20, 0x34, 0x79, 0x7f, 0x7f, 0x20, 0x63, 0x13, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x00, 0x70, 0x5c, 0x7e, 0x7f, 0x7f,
  0x03, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x60, 0x17, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x00, 0x3e, 0x05, 0x00, 0x00, 0x00,
  0xf7,
];

// Logitech PTZ Pro 2 — pan/tilt VELOCITY (fixed speed 1..1), zoom ABSOLUTE.
const HW_CAPS_LOGITECH = [
  0xf0, 0x7d, 0x50, 0x54, 0x5a, 0x02, 0x41, 0x03,
  0x01, 0x02, 0x01, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x00,
  0x02, 0x02, 0x01, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x00,
  0x03, 0x01, 0x64, 0x00, 0x00, 0x00, 0x00, 0x68, 0x07, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x00, 0x64, 0x00, 0x00, 0x00, 0x00,
  0xf7,
];

describe('val35 packing', () => {
  it('round-trips representative values including the int32 extremes', () => {
    const values = [
      0, 1, -1, 127, 128, -128, 3040, -27000, -6480, -612000, 612000, 324000,
      2 ** 31 - 1, -(2 ** 31), 2 ** 34 - 1, -(2 ** 34),
    ];
    for (const v of values) {
      const bytes = encodeVal35(v);
      expect(bytes).toHaveLength(5);
      for (const b of bytes) {
        expect(b, `7-bit-safe byte for ${v}`).toBeGreaterThanOrEqual(0);
        expect(b, `7-bit-safe byte for ${v}`).toBeLessThanOrEqual(0x7f);
      }
      expect(decodeVal35(bytes, 0), `round-trip of ${v}`).toBe(v);
    }
  });
});

describe('frame building', () => {
  it('caps request is the documented 8-byte v2 frame', () => {
    expect([...buildCapsRequest()]).toEqual([0xf0, 0x7d, 0x50, 0x54, 0x5a, 0x02, 0x01, 0xf7]);
  });

  it('set-absolute frames carry control id + val35, 7-bit clean', () => {
    const frame = buildSetAbs('zoom', 180);
    expect(frame).toHaveLength(14);
    expect(frame[6]).toBe(0x02);
    expect(frame[7]).toBe(0x03);
    expect(decodeVal35(frame, 8)).toBe(180);
    expect(frame[13]).toBe(0xf7);
    const pan = buildSetAbs('pan', -612000);
    expect(decodeVal35(pan, 8)).toBe(-612000);
    for (const b of [...frame.slice(1, -1), ...pan.slice(1, -1)]) {
      expect(b).toBeLessThanOrEqual(0x7f);
    }
  });

  it('set-velocity frames are signed; zero is the explicit stop', () => {
    const fwd = buildSetVel('pan', 1);
    expect(fwd[6]).toBe(0x03);
    expect(fwd[7]).toBe(0x01);
    expect(decodeVal35(fwd, 8)).toBe(1);
    expect(decodeVal35(buildSetVel('tilt', -1), 8)).toBe(-1);
    expect(decodeVal35(buildSetVel('pan', 0), 8)).toBe(0);
  });

  it('stop-all is the bare 8-byte frame', () => {
    expect([...buildStopAll()]).toEqual([0xf0, 0x7d, 0x50, 0x54, 0x5a, 0x02, 0x04, 0xf7]);
  });
});

describe('parsePtzFrame (v2 caps modes)', () => {
  it('decodes the NexiGo capture — three absolute axes with the measured ranges', () => {
    const frame = parsePtzFrame(HW_CAPS_NEXIGO);
    expect(frame).toEqual({
      kind: 'caps',
      caps: {
        pan: { mode: 'abs', min: -612000, max: 612000, res: 1, cur: 32400 },
        tilt: { mode: 'abs', min: -108000, max: 324000, res: 1, cur: -20880 },
        zoom: { mode: 'abs', min: 0, max: 3040, res: 1, cur: 702 },
      },
    });
  });

  it('decodes the Logitech capture — velocity pan/tilt at fixed speed, absolute zoom', () => {
    const frame = parsePtzFrame(HW_CAPS_LOGITECH);
    expect(frame).toEqual({
      kind: 'caps',
      caps: {
        pan: { mode: 'vel', speedMin: 1, speedMax: 1, speedRes: 1 },
        tilt: { mode: 'vel', speedMin: 1, speedMax: 1, speedRes: 1 },
        zoom: { mode: 'abs', min: 100, max: 1000, res: 1, cur: 100 },
      },
    });
  });

  it('decodes a named error frame', () => {
    const name = 'camera-absent';
    const frame = parsePtzFrame([
      0xf0, 0x7d, 0x50, 0x54, 0x5a, 0x02, 0x42, 0x01,
      ...[...name].map((c) => c.charCodeAt(0)),
      0xf7,
    ]);
    expect(frame).toEqual({ kind: 'error', code: 0x01, name });
  });

  it('ignores foreign, truncated, wrong-tag, and wrong-version frames', () => {
    expect(parsePtzFrame([0xf0, 0x7d, 0x00, 0x00, 0xf7])).toBeNull();
    expect(parsePtzFrame([0xf0, 0x00, 0x21, 0x45, 0x01, 0x02, 0x03, 0xf7])).toBeNull();
    expect(parsePtzFrame(HW_CAPS_NEXIGO.slice(0, 40))).toBeNull();
    const v1 = [...HW_CAPS_NEXIGO];
    v1[5] = 0x01;
    expect(parsePtzFrame(v1), 'a v1 frame is not parseable as v2').toBeNull();
    const missingControl = HW_CAPS_LOGITECH.slice(0, 8 + 17 + 17).concat([0xf7]);
    missingControl[7] = 2;
    expect(parsePtzFrame(missingControl)).toBeNull();
  });
});
