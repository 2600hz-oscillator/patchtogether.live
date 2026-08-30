// Transport-layer tests for the VST bridge: the web-side SAB ring MIRRORS
// (must stay byte-identical to packages/dsp/src/lib/vst-bridge-core.ts —
// the LAYOUT PINs below are the same sequences the dsp suite pins) and the
// protocol v1 binary codecs (wire contract with the vst-bridge native
// helper: patchtogether.nativeapps VSTProtocol.swift / BridgeKit MidiWire).
//
// Also the NOTE-TABLE TWIN PIN: the dsp core DUPLICATES the web canon
// (pitchCvToMidiNote / velocityCvToMidi / GATE_THRESHOLD / DEFAULT_VELOCITY)
// because packages/dsp cannot import packages/web source. This suite pins
// the CANONICAL functions against the exact table the dsp suite pins its
// duplicates against — if either side drifts, one twin fails.

import { describe, expect, it } from 'vitest';
import { MidiRingIO, RingIO, createMidiRingSpec, createRingSpec } from './vst-ring';
import {
  VST_HEADER_SIZE,
  VST_MAX_MIDI_EVENTS,
  VST_MIDI_EVENT_SIZE,
  VST_MIDI_HEADER_SIZE,
  channelsToMask,
  decodeBlock,
  decodeMidiBlock,
  encodeBlock,
  encodeMidiBlock,
} from './vst-protocol';
import {
  GATE_THRESHOLD,
  pitchCvToMidiNote,
  velocityCvToMidi,
} from '$lib/audio/modules/midi-out-buddy';
import { DEFAULT_VELOCITY } from '$lib/audio/modules/clip-types';

describe('note-table twin pin (canonical web functions — dsp duplicates pin the same values)', () => {
  it('pitchCvToMidiNote: c3=-1→48, c4=0→60, a4=+0.75→69, c5=+1→72, clamps 12..108', () => {
    const table: Array<[number, number]> = [
      [-4.0, 12], [-1.0, 48], [0.0, 60], [0.75, 69], [1.0, 72], [4.0, 108],
      [-10.0, 12], [10.0, 108],
    ];
    for (const [cv, midi] of table) {
      expect(pitchCvToMidiNote(cv), `${cv} V/oct`).toBe(midi);
    }
  });

  it('velocityCvToMidi floors at 1, caps at 127; DEFAULT_VELOCITY is 100; gate threshold 0.5', () => {
    expect(velocityCvToMidi(0)).toBe(1);
    expect(velocityCvToMidi(1)).toBe(127);
    expect(velocityCvToMidi(0.5)).toBe(64);
    expect(DEFAULT_VELOCITY).toBe(100);
    expect(GATE_THRESHOLD).toBe(0.5);
  });
});

describe('vst-ring audio ring (web mirror of the dsp SAB ring)', () => {
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

describe('vst-ring MIDI event ring (web mirror of the dsp SAB ring)', () => {
  it('round-trips events in order, drops when full', () => {
    const ring = new MidiRingIO(createMidiRingSpec(4));
    for (let i = 0; i < 4; i++) expect(ring.write(i, 0x90, 60 + i, 100, 3)).toBe(true);
    expect(ring.write(9, 0x90, 99, 100, 3)).toBe(false);
    const seen: Array<[number, number]> = [];
    expect(ring.read(10, (t, _d0, d1) => seen.push([t, d1]))).toBe(4);
    expect(seen).toEqual([[0, 60], [1, 61], [2, 62], [3, 63]]);
  });

  it('LAYOUT PIN: identical to the dsp core (lo/hi u32, len@8, data@9..11)', () => {
    // Same raw-byte assertions as vst-bridge-core.test.ts — if either
    // half's layout drifts, one of the twin tests fails.
    const spec = createMidiRingSpec(8);
    const ring = new MidiRingIO(spec);
    ring.write(2 ** 32 + 5, 0x90, 60, 100, 3);
    const raw = new Uint8Array(spec.data);
    expect([...raw.slice(0, 16)]).toEqual([
      5, 0, 0, 0,
      1, 0, 0, 0,
      3,
      0x90, 60, 100,
      0, 0, 0, 0,
    ]);
    const header = new Int32Array(spec.header);
    expect(header[0]).toBe(1);
    expect(header[1]).toBe(0);
  });
});

describe('vst-protocol 0x01 audio codec', () => {
  it('encodes/decodes a stereo block round trip (mask 0b11, seq, sampleTime, planes)', () => {
    const buf = encodeBlock(42, 12345, [0, 1], 4, (ch, i) => ch + i / 10);
    expect(buf.byteLength).toBe(VST_HEADER_SIZE + 2 * 4 * 4);
    const block = decodeBlock(buf);
    expect(block).not.toBeNull();
    expect(block!.seq).toBe(42);
    expect(block!.sampleTime).toBe(12345);
    expect(block!.frameCount).toBe(4);
    expect([...block!.planes.keys()]).toEqual([0, 1]);
    expect(block!.planes.get(1)![2]).toBeCloseTo(1.2, 5);
  });

  it('mask-0 CLOCK block: frames advance, no planes — 20 bytes on the wire', () => {
    const buf = encodeBlock(7, 999, [], 128, () => 0);
    expect(buf.byteLength).toBe(VST_HEADER_SIZE);
    const dv = new DataView(buf);
    expect(dv.getUint32(12, true)).toBe(0); // mask 0
    expect(dv.getUint16(16, true)).toBe(128); // frameCount still advances
    const block = decodeBlock(buf);
    expect(block).not.toBeNull();
    expect(block!.frameCount).toBe(128);
    expect(block!.planes.size).toBe(0);
  });

  it('sampleTime survives beyond 2^32 (u64 on the wire)', () => {
    const big = 2 ** 40 + 12345;
    const block = decodeBlock(encodeBlock(0, big, [0], 1, () => 0));
    expect(block!.sampleTime).toBe(big);
  });

  it('wire layout matches protocol v1 (little-endian, 20-byte header)', () => {
    const buf = encodeBlock(0x0102, 7, [0], 1, () => 1.0);
    const dv = new DataView(buf);
    expect(dv.getUint8(0)).toBe(0x01);
    expect(dv.getUint8(1) & 0x01).toBe(0x01);
    expect(dv.getUint16(2, true)).toBe(0x0102);
    expect(Number(dv.getBigUint64(4, true))).toBe(7);
    expect(dv.getUint32(12, true)).toBe(1);
    expect(dv.getUint16(16, true)).toBe(1);
    expect(dv.getFloat32(20, true)).toBe(1.0);
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
    expect(channelsToMask([0, 1])).toBe(0b11);
  });
});

describe('vst-protocol 0x02 MIDI codec', () => {
  it('encodes/decodes a batch round trip (len 1/2/3, zero-padded)', () => {
    const buf = encodeMidiBlock(3, [
      { sampleTime: 100, d0: 0x90, d1: 60, d2: 100, len: 3 },
      { sampleTime: 150, d0: 0xd0, d1: 64, d2: 0, len: 2 },
      { sampleTime: 200, d0: 0xf8, d1: 0, d2: 0, len: 1 },
    ]);
    expect(buf.byteLength).toBe(VST_MIDI_HEADER_SIZE + 3 * VST_MIDI_EVENT_SIZE);
    const block = decodeMidiBlock(buf);
    expect(block).not.toBeNull();
    expect(block!.seq).toBe(3);
    expect(block!.events).toEqual([
      { sampleTime: 100, bytes: [0x90, 60, 100] },
      { sampleTime: 150, bytes: [0xd0, 64] },
      { sampleTime: 200, bytes: [0xf8] },
    ]);
  });

  it('wire layout matches MidiWire.swift (LE header 8B, 12B events, u64 sampleTime)', () => {
    const big = 2 ** 32 + 9;
    const buf = encodeMidiBlock(0x0405, [
      { sampleTime: big, d0: 0x80, d1: 48, d2: 0, len: 3 },
    ]);
    const dv = new DataView(buf);
    expect(dv.getUint8(0)).toBe(0x02);            // type
    expect(dv.getUint8(1)).toBe(0);               // flags
    expect(dv.getUint16(2, true)).toBe(0x0405);   // seq LE
    expect(dv.getUint16(4, true)).toBe(1);        // count
    expect(dv.getUint16(6, true)).toBe(0);        // reserved
    expect(Number(dv.getBigUint64(8, true))).toBe(big); // event sampleTime
    expect(dv.getUint8(16)).toBe(3);              // len
    expect(dv.getUint8(17)).toBe(0x80);
    expect(dv.getUint8(18)).toBe(48);
    expect(dv.getUint8(19)).toBe(0);
  });

  it('zero-pads unused data bytes even when given noise', () => {
    const buf = encodeMidiBlock(0, [{ sampleTime: 0, d0: 0xf8, d1: 0x7f, d2: 0x7f, len: 1 }]);
    const dv = new DataView(buf);
    expect(dv.getUint8(18)).toBe(0);
    expect(dv.getUint8(19)).toBe(0);
  });

  it('caps a batch at VST_MAX_MIDI_EVENTS', () => {
    const events = Array.from({ length: VST_MAX_MIDI_EVENTS + 1 }, (_, i) => ({
      sampleTime: i, d0: 0xf8, d1: 0, d2: 0, len: 1,
    }));
    const buf = encodeMidiBlock(0, events);
    expect(new DataView(buf).getUint16(4, true)).toBe(VST_MAX_MIDI_EVENTS);
    expect(buf.byteLength).toBe(VST_MIDI_HEADER_SIZE + VST_MAX_MIDI_EVENTS * VST_MIDI_EVENT_SIZE);
  });

  it('rejects malformed MIDI blocks instead of throwing', () => {
    expect(decodeMidiBlock(new ArrayBuffer(4))).toBeNull();
    const good = encodeMidiBlock(0, [{ sampleTime: 0, d0: 0x90, d1: 60, d2: 1, len: 3 }]);
    expect(decodeMidiBlock(good.slice(0, good.byteLength - 1))).toBeNull(); // size mismatch
    const badType = good.slice(0);
    new DataView(badType).setUint8(0, 0x01);
    expect(decodeMidiBlock(badType)).toBeNull();
    const badLen = good.slice(0);
    new DataView(badLen).setUint8(16, 4);
    expect(decodeMidiBlock(badLen)).toBeNull();
    const zeroLen = good.slice(0);
    new DataView(zeroLen).setUint8(16, 0);
    expect(decodeMidiBlock(zeroLen)).toBeNull();
    // count over the cap in the header
    const overCount = good.slice(0);
    new DataView(overCount).setUint16(4, VST_MAX_MIDI_EVENTS + 1, true);
    expect(decodeMidiBlock(overCount)).toBeNull();
  });
});
