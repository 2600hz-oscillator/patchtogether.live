// packages/web/src/lib/grid/mext.test.ts
//
// Golden-vector unit tests for the mext codec. Hardware-free — these byte
// vectors ARE the protocol contract; if a refactor changes a byte, the test
// fails before it ever reaches a real grid.

import { describe, it, expect } from 'vitest';
import {
  FTDI_VENDOR_ID,
  GRID_BAUD_RATE,
  GRID_WIDTH,
  GRID_HEIGHT,
  GRID_CELLS,
  LED_LEVEL_MAX,
  USB_PACKET_BYTES,
  PAD_BYTE,
  clampLevel,
  encodeLedSet,
  encodeLedAll,
  encodeFullFrame,
  batchFrames,
  padToPacket,
  MSG_QUERY,
  MSG_REQUEST_ID,
  MSG_REQUEST_SIZE,
  createGridRxParser,
  gridFamilyFromId,
  type GridRxEvent,
} from './mext';

describe('mext constants', () => {
  it('targets the FTDI UART at 115200 and a 16×8 / 128-cell grid', () => {
    expect(FTDI_VENDOR_ID).toBe(0x0403);
    expect(GRID_BAUD_RATE).toBe(115200);
    expect(GRID_WIDTH).toBe(16);
    expect(GRID_HEIGHT).toBe(8);
    expect(GRID_CELLS).toBe(128);
    expect(LED_LEVEL_MAX).toBe(15);
  });
});

describe('clampLevel', () => {
  it('clamps + rounds into 0..15', () => {
    expect(clampLevel(-5)).toBe(0);
    expect(clampLevel(0)).toBe(0);
    expect(clampLevel(7.4)).toBe(7);
    expect(clampLevel(7.6)).toBe(8);
    expect(clampLevel(15)).toBe(15);
    expect(clampLevel(99)).toBe(15);
    expect(clampLevel(NaN)).toBe(0);
  });
});

describe('encodeLedSet (0x18)', () => {
  it('produces [0x18, x, y, level]', () => {
    expect([...encodeLedSet(3, 5, 12)]).toEqual([0x18, 3, 5, 12]);
    expect([...encodeLedSet(0, 0, 0)]).toEqual([0x18, 0, 0, 0]);
    expect([...encodeLedSet(15, 7, 15)]).toEqual([0x18, 15, 7, 15]);
  });
  it('clamps level and out-of-range coordinates', () => {
    expect([...encodeLedSet(3, 5, 99)]).toEqual([0x18, 3, 5, 15]);
    expect([...encodeLedSet(99, 99, 4)]).toEqual([0x18, 15, 7, 4]); // x→15, y→7
    expect([...encodeLedSet(-1, -1, -1)]).toEqual([0x18, 0, 0, 0]);
  });
});

describe('encodeLedAll (0x19)', () => {
  it('produces [0x19, level]', () => {
    expect([...encodeLedAll(0)]).toEqual([0x19, 0]);
    expect([...encodeLedAll(15)]).toEqual([0x19, 15]);
    expect([...encodeLedAll(40)]).toEqual([0x19, 15]);
  });
});

describe('handshake TX messages', () => {
  it('are the single-byte system commands', () => {
    expect([...MSG_QUERY]).toEqual([0x00]);
    expect([...MSG_REQUEST_ID]).toEqual([0x01]);
    expect([...MSG_REQUEST_SIZE]).toEqual([0x05]);
  });
});

describe('batchFrames', () => {
  it('concatenates minimal frames', () => {
    const out = batchFrames([encodeLedSet(0, 0, 1), encodeLedSet(1, 0, 2)]);
    expect([...out]).toEqual([0x18, 0, 0, 1, 0x18, 1, 0, 2]);
  });
  it('returns empty for no frames', () => {
    expect(batchFrames([]).length).toBe(0);
  });
});

describe('padToPacket', () => {
  it('pads up to the next 64-byte boundary with 0xFF', () => {
    const out = padToPacket(new Uint8Array([0x18, 1, 2, 3]));
    expect(out.length).toBe(USB_PACKET_BYTES);
    expect([...out.slice(0, 4)]).toEqual([0x18, 1, 2, 3]);
    expect(out[4]).toBe(PAD_BYTE);
    expect(out[63]).toBe(PAD_BYTE);
  });
  it('leaves an exact-multiple run untouched and an empty run empty', () => {
    const exact = new Uint8Array(USB_PACKET_BYTES).fill(1);
    expect(padToPacket(exact)).toBe(exact);
    expect(padToPacket(new Uint8Array(0)).length).toBe(0);
  });
  it('rounds a 65-byte run up to 128', () => {
    expect(padToPacket(new Uint8Array(65)).length).toBe(128);
  });
});

describe('encodeFullFrame', () => {
  it('emits one 0x18 per cell, padded to a packet boundary', () => {
    const levels = new Uint8Array(GRID_CELLS).fill(0);
    levels[0] = 9; // (0,0)
    levels[GRID_WIDTH + 1] = 4; // (1,1)
    const out = encodeFullFrame(levels);
    // 128 cells × 4 bytes = 512, already a multiple of 64.
    expect(out.length).toBe(512);
    expect([...out.slice(0, 4)]).toEqual([0x18, 0, 0, 9]);
    // cell (1,1) is index 17 → byte offset 17*4 = 68.
    expect([...out.slice(68, 72)]).toEqual([0x18, 1, 1, 4]);
  });
});

describe('createGridRxParser', () => {
  it('decodes a key-down and key-up', () => {
    const p = createGridRxParser();
    expect(p.push([0x21, 3, 5])).toEqual<GridRxEvent[]>([{ type: 'key', x: 3, y: 5, s: 1 }]);
    expect(p.push([0x20, 3, 5])).toEqual<GridRxEvent[]>([{ type: 'key', x: 3, y: 5, s: 0 }]);
  });

  it('decodes multiple frames in one push', () => {
    const p = createGridRxParser();
    const evs = p.push([0x21, 0, 0, 0x21, 15, 7, 0x20, 0, 0]);
    expect(evs).toEqual<GridRxEvent[]>([
      { type: 'key', x: 0, y: 0, s: 1 },
      { type: 'key', x: 15, y: 7, s: 1 },
      { type: 'key', x: 0, y: 0, s: 0 },
    ]);
  });

  it('buffers a partial frame across pushes', () => {
    const p = createGridRxParser();
    expect(p.push([0x21, 4])).toEqual([]); // incomplete
    expect(p.push([6])).toEqual<GridRxEvent[]>([{ type: 'key', x: 4, y: 6, s: 1 }]);
  });

  it('resyncs past an unknown leading byte', () => {
    const p = createGridRxParser();
    // 0x7e is not a known command → dropped, then a clean key frame follows.
    const evs = p.push([0x7e, 0x21, 2, 2]);
    expect(evs).toEqual<GridRxEvent[]>([{ type: 'key', x: 2, y: 2, s: 1 }]);
  });

  it('decodes a size response', () => {
    const p = createGridRxParser();
    expect(p.push([0x05, 16, 8])).toEqual<GridRxEvent[]>([{ type: 'size', x: 16, y: 8 }]);
  });

  it('decodes an id response and strips trailing spaces', () => {
    const p = createGridRxParser();
    const id = 'monome 128 m1000123';
    const bytes = [0x01];
    for (let i = 0; i < 32; i++) bytes.push(i < id.length ? id.charCodeAt(i) : 0x20);
    const evs = p.push(bytes);
    expect(evs).toEqual<GridRxEvent[]>([{ type: 'id', id }]);
  });

  it('reset() drops a buffered partial frame', () => {
    const p = createGridRxParser();
    p.push([0x21, 4]); // partial
    p.reset();
    expect(p.push([0x21, 1, 1])).toEqual<GridRxEvent[]>([{ type: 'key', x: 1, y: 1, s: 1 }]);
  });
});

describe('gridFamilyFromId (codec selection §1.5)', () => {
  it('routes mext-varibright ids to mext', () => {
    expect(gridFamilyFromId('m1000123')).toBe('mext');
    expect(gridFamilyFromId('monome 128 m0000420')).toBe('mext');
  });
  it('routes old 40h / series ids to series', () => {
    expect(gridFamilyFromId('m40h0001')).toBe('series');
    expect(gridFamilyFromId('m128-0001')).toBe('series');
    expect(gridFamilyFromId('m64-99')).toBe('series');
    expect(gridFamilyFromId('m256-5')).toBe('series');
  });
});
