import { describe, expect, it } from 'vitest';
import {
  buildCapsRequest,
  buildSetAbs,
  decodeVal35,
  encodeVal35,
  parsePtzFrame,
} from './ptz-sysex';

// Captured VERBATIM from the helper on real hardware (NexiGo P610,
// 2026-08-29): the caps reply pt-ptz sent over the virtual PT-PTZ source.
// If the framing on either side drifts, this fixture is the tie-breaker.
const HARDWARE_CAPS_REPLY = [
  0xf0, 0x7d, 0x50, 0x54, 0x5a, 0x01, 0x41, 0x03,
  0x01, 0x60, 0x52, 0x5a, 0x7f, 0x7f, 0x20, 0x2d, 0x25, 0x00, 0x00, 0x01,
  0x00, 0x00, 0x00, 0x00, 0x08, 0x2d, 0x7e, 0x7f, 0x7f,
  0x02, 0x20, 0x34, 0x79, 0x7f, 0x7f, 0x20, 0x63, 0x13, 0x00, 0x00, 0x01,
  0x00, 0x00, 0x00, 0x00, 0x30, 0x4d, 0x7f, 0x7f, 0x7f,
  0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x60, 0x17, 0x00, 0x00, 0x00, 0x01,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
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
  it('caps request is the documented 8-byte frame', () => {
    expect([...buildCapsRequest()]).toEqual([0xf0, 0x7d, 0x50, 0x54, 0x5a, 0x01, 0x01, 0xf7]);
  });

  it('set-absolute frames carry control id + val35, 7-bit clean', () => {
    const frame = buildSetAbs('zoom', 180);
    expect(frame).toHaveLength(14);
    expect(frame[6]).toBe(0x02);
    expect(frame[7]).toBe(0x03);
    expect(decodeVal35(frame, 8)).toBe(180);
    expect(frame[13]).toBe(0xf7);
    const pan = buildSetAbs('pan', -612000);
    expect(pan[7]).toBe(0x01);
    expect(decodeVal35(pan, 8)).toBe(-612000);
    for (const b of [...frame.slice(1, -1), ...pan.slice(1, -1)]) {
      expect(b).toBeLessThanOrEqual(0x7f);
    }
  });
});

describe('parsePtzFrame', () => {
  it('decodes the hardware-captured caps reply to the measured P610 ranges', () => {
    const frame = parsePtzFrame(HARDWARE_CAPS_REPLY);
    expect(frame).toEqual({
      kind: 'caps',
      caps: {
        pan: { min: -612000, max: 612000, res: 1, cur: -27000 },
        tilt: { min: -108000, max: 324000, res: 1, cur: -6480 },
        zoom: { min: 0, max: 3040, res: 1, cur: 0 },
      },
    });
  });

  it('decodes a named error frame', () => {
    const name = 'camera-absent';
    const frame = parsePtzFrame([
      0xf0, 0x7d, 0x50, 0x54, 0x5a, 0x01, 0x42, 0x01,
      ...[...name].map((c) => c.charCodeAt(0)),
      0xf7,
    ]);
    expect(frame).toEqual({ kind: 'error', code: 0x01, name });
  });

  it('ignores foreign, truncated, and wrong-tag frames', () => {
    expect(parsePtzFrame([0xf0, 0x7d, 0x00, 0x00, 0xf7])).toBeNull();
    expect(parsePtzFrame([0xf0, 0x00, 0x21, 0x45, 0x01, 0x02, 0x03, 0xf7])).toBeNull();
    expect(parsePtzFrame(HARDWARE_CAPS_REPLY.slice(0, 40))).toBeNull();
    const missingControl = HARDWARE_CAPS_REPLY.slice(0, 8 + 21 + 21).concat([0xf7]);
    missingControl[7] = 2;
    expect(parsePtzFrame(missingControl)).toBeNull();
  });
});
