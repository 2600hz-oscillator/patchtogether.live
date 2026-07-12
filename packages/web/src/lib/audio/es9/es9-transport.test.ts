// Transport-layer tests for the ES-9 bridge: the web-side SAB ring MIRROR
// (must stay byte-identical to packages/dsp/src/lib/es9-bridge-core.ts —
// the LAYOUT PIN below is the same sequence the dsp suite pins) and the
// protocol v1 binary codec (wire contract with the es9-bridge native app).

import { describe, expect, it } from 'vitest';
import { RingIO, createRingSpec } from './es9-ring';
import {
  ES9_HEADER_SIZE,
  channelsToMask,
  decodeBlock,
  encodeBlock,
} from './es9-protocol';

describe('es9-ring (web mirror of the dsp SAB ring)', () => {
  it('round-trips frames across the wrap boundary', () => {
    const ring = new RingIO(createRingSpec(2, 64));
    for (let cycle = 0; cycle < 3; cycle++) {
      expect(ring.write(48, (ch, i) => ch * 1000 + cycle * 48 + i)).toBe(48);
      const seen: number[][] = [[], []];
      expect(ring.read(48, (ch, i, v) => { seen[ch]![i] = v; })).toBe(48);
      for (let ch = 0; ch < 2; ch++) {
        for (let i = 0; i < 48; i++) {
          expect(seen[ch]![i]).toBe(ch * 1000 + cycle * 48 + i);
        }
      }
    }
  });

  it('writes short on overflow, reads short on underrun, skips', () => {
    const ring = new RingIO(createRingSpec(1, 32));
    expect(ring.write(40, (_ch, i) => i)).toBe(32);
    expect(ring.free).toBe(0);
    expect(ring.read(10, () => {})).toBe(10);
    expect(ring.skip(100)).toBe(22);
    expect(ring.occupancy).toBe(0);
  });

  it('LAYOUT PIN: identical to the dsp core (plane-per-channel, header [head, tail])', () => {
    // Same raw-byte assertions as es9-bridge-core.test.ts — if either half's
    // layout drifts, one of the twin tests fails.
    const spec = createRingSpec(2, 8);
    const ring = new RingIO(spec);
    ring.write(3, (ch, i) => ch * 10 + i);
    const raw = new Float32Array(spec.data);
    expect([raw[0], raw[1], raw[2]]).toEqual([0, 1, 2]);
    expect([raw[8], raw[9]]).toEqual([10, 11]);
    const header = new Int32Array(spec.header);
    expect(header[0]).toBe(3);
    expect(header[1]).toBe(0);
  });
});

describe('es9-protocol binary codec', () => {
  it('encodes/decodes a block round trip (mask, seq, planes)', () => {
    const buf = encodeBlock(42, 12345, [1, 3], 4, (ch, i) => ch + i / 10);
    expect(buf.byteLength).toBe(ES9_HEADER_SIZE + 2 * 4 * 4);
    const block = decodeBlock(buf);
    expect(block).not.toBeNull();
    expect(block!.seq).toBe(42);
    expect(block!.frameCount).toBe(4);
    expect([...block!.planes.keys()]).toEqual([1, 3]);
    expect(block!.planes.get(3)![2]).toBeCloseTo(3.2, 5);
  });

  it('wire layout matches protocol v1 (little-endian, 20-byte header)', () => {
    const buf = encodeBlock(0x0102, 7, [0], 1, () => 1.0);
    const dv = new DataView(buf);
    expect(dv.getUint8(0)).toBe(0x01);              // type
    expect(dv.getUint8(1) & 0x01).toBe(0x01);       // planar flag
    expect(dv.getUint16(2, true)).toBe(0x0102);     // seq LE
    expect(Number(dv.getBigUint64(4, true))).toBe(7);
    expect(dv.getUint32(12, true)).toBe(1);         // mask: channel 0
    expect(dv.getUint16(16, true)).toBe(1);         // frameCount
    expect(dv.getFloat32(20, true)).toBe(1.0);      // first sample
  });

  it('rejects malformed blocks instead of throwing', () => {
    expect(decodeBlock(new ArrayBuffer(4))).toBeNull();
    const good = encodeBlock(0, 0, [0], 2, () => 0);
    const truncated = good.slice(0, good.byteLength - 1);
    expect(decodeBlock(truncated)).toBeNull();
    const badType = good.slice(0);
    new DataView(badType).setUint8(0, 0x7f);
    expect(decodeBlock(badType)).toBeNull();
    const zeroFrames = good.slice(0);
    new DataView(zeroFrames).setUint16(16, 0, true);
    expect(decodeBlock(zeroFrames)).toBeNull();
  });

  it('channelsToMask sets the right bits', () => {
    expect(channelsToMask([])).toBe(0);
    expect(channelsToMask([0, 15])).toBe(0b1000_0000_0000_0001);
  });
});
