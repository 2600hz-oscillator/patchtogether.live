// packages/web/src/lib/control/push2/push2-display-frame.test.ts
//
// GOLDEN VECTORS for the Push 2 display framebuffer. This file is the gate that
// stops a subtly-wrong picture shipping: a channel swap or a line-stride error
// still renders *something*, so "it looked fine" is not evidence. Every claim
// here is an exact byte, and the three most likely bugs each have a NEGATIVE
// CONTROL that proves the assertion can see them:
//
//   1. B/R SWAP      — `packBgr565(255,0,0)` must be 0x001F, and must NOT be the
//                      0xF800 a plain-RGB565 implementation would produce.
//   2. MISSING XOR   — an all-black frame must be the repeating shaping pattern
//                      `E7 F3 E7 FF`, not 327,680 zero bytes.
//   3. WRONG STRIDE  — line 1 must start at byte 2048, and bytes 1920..2047 of
//                      every line must be the bare mask (the 128 filler bytes).
//
// No hardware, no DOM — the codec is pure.

import { describe, it, expect } from 'vitest';
import {
  PUSH_DISPLAY_W,
  PUSH_DISPLAY_H,
  PUSH_DISPLAY_BPP,
  PUSH_DISPLAY_LINE_BYTES,
  PUSH_DISPLAY_VISIBLE_LINE_BYTES,
  PUSH_DISPLAY_FILLER_BYTES,
  PUSH_DISPLAY_FRAME_BYTES,
  PUSH_DISPLAY_RGBA_BYTES,
  PUSH_DISPLAY_HEADER,
  PUSH_DISPLAY_XOR_MASK,
  PUSH_DISPLAY_CHUNK_BYTES,
  PUSH_DISPLAY_MIN_FRAME_MS,
  PUSH_DISPLAY_KEEPALIVE_MS,
  PUSH2_USB_VENDOR_ID,
  PUSH2_USB_PRODUCT_ID,
  PUSH2_USB_INTERFACE,
  PUSH2_USB_ENDPOINT,
  packBgr565,
  unpackBgr565,
  packPushFrame,
  packPushFrameInto,
  pushDisplayHeader,
  pushFrameByteOffset,
  pushFrameChunks,
  readPushFramePixel,
  solidPushFrame,
  frameGateDelayMs,
  keepaliveDue,
} from './push2-display-frame';

/** Build a 960×160 RGBA buffer (canvas ImageData layout) from a pixel fn. */
function rgbaImage(
  px: (x: number, y: number) => [number, number, number, number?],
): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(PUSH_DISPLAY_RGBA_BYTES);
  for (let y = 0; y < PUSH_DISPLAY_H; y++) {
    for (let x = 0; x < PUSH_DISPLAY_W; x++) {
      const [r, g, b, a] = px(x, y);
      const i = (y * PUSH_DISPLAY_W + x) * 4;
      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
      buf[i + 3] = a ?? 255;
    }
  }
  return buf;
}

/** The mask byte that applies at a given byte offset in the frame. */
const maskAt = (off: number): number => PUSH_DISPLAY_XOR_MASK[off & 3];

// ---------------------------------------------------------------------------
// Geometry — the numbers everything else is derived from.
// ---------------------------------------------------------------------------

describe('display geometry', () => {
  it('is 960×160 at 2 bytes/px with a 2048-byte line stride', () => {
    expect(PUSH_DISPLAY_W).toBe(960);
    expect(PUSH_DISPLAY_H).toBe(160);
    expect(PUSH_DISPLAY_BPP).toBe(2);
    expect(PUSH_DISPLAY_VISIBLE_LINE_BYTES).toBe(1920); // 960 px × 2 bytes
    expect(PUSH_DISPLAY_LINE_BYTES).toBe(2048);
    expect(PUSH_DISPLAY_FILLER_BYTES).toBe(128); // 2048 − 1920
    expect(PUSH_DISPLAY_FRAME_BYTES).toBe(327680); // 160 × 2048
    expect(PUSH_DISPLAY_RGBA_BYTES).toBe(614400); // 960 × 160 × 4
  });

  it('chunks the frame into exactly 20 × 16 KB bulk transfers', () => {
    expect(PUSH_DISPLAY_FRAME_BYTES / PUSH_DISPLAY_CHUNK_BYTES).toBe(20);
  });

  it('pins the USB topology of the vendor-specific display interface', () => {
    expect(PUSH2_USB_VENDOR_ID).toBe(0x2982);
    expect(PUSH2_USB_PRODUCT_ID).toBe(0x1967);
    expect(PUSH2_USB_INTERFACE).toBe(0);
    expect(PUSH2_USB_ENDPOINT).toBe(1);
  });

  it('pushFrameByteOffset uses the 2048 stride, not the 1920 visible bytes', () => {
    expect(pushFrameByteOffset(0, 0)).toBe(0);
    expect(pushFrameByteOffset(1, 0)).toBe(2);
    expect(pushFrameByteOffset(959, 0)).toBe(1918);
    expect(pushFrameByteOffset(0, 1)).toBe(2048); // ← NOT 1920
    expect(pushFrameByteOffset(0, 159)).toBe(325632);
  });
});

// ---------------------------------------------------------------------------
// The pixel word — BGR565, and the swap that would look almost right.
// ---------------------------------------------------------------------------

describe('packBgr565 — the golden vectors', () => {
  it('packs the primaries to their exact BGR565 words', () => {
    // bits 15..11 BLUE · 10..5 green · 4..0 RED
    expect(packBgr565(255, 0, 0)).toBe(0x001f); // red  → low 5 bits
    expect(packBgr565(0, 255, 0)).toBe(0x07e0); // green→ middle 6 bits
    expect(packBgr565(0, 0, 255)).toBe(0xf800); // blue → high 5 bits
    expect(packBgr565(255, 255, 255)).toBe(0xffff);
    expect(packBgr565(0, 0, 0)).toBe(0x0000);
  });

  it('NEGATIVE CONTROL: a B/R swap is a DIFFERENT word — the vectors can see it', () => {
    // What a reflexive RGB565 implementation emits for pure RED:
    const swappedRed = ((255 >> 3) << 11) | ((0 >> 2) << 5) | (0 >> 3);
    expect(swappedRed).toBe(0xf800);
    expect(packBgr565(255, 0, 0)).not.toBe(swappedRed);
    // …and symmetrically for pure BLUE.
    const swappedBlue = ((0 >> 3) << 11) | ((0 >> 2) << 5) | (255 >> 3);
    expect(swappedBlue).toBe(0x001f);
    expect(packBgr565(0, 0, 255)).not.toBe(swappedBlue);
    // …and this is WHY the test image must be chromatic: on the grey axis the
    // two implementations agree exactly, so a grey card would never catch it.
    const greySwapped = ((200 >> 3) << 11) | ((200 >> 2) << 5) | (200 >> 3);
    expect(packBgr565(200, 200, 200)).toBe(greySwapped);
  });

  it('truncates to 5/6/5 bits — the low bits of each channel are dropped', () => {
    expect(packBgr565(7, 0, 0)).toBe(0x0000); // 7 >> 3 = 0
    expect(packBgr565(8, 0, 0)).toBe(0x0001); // 8 >> 3 = 1
    expect(packBgr565(0, 3, 0)).toBe(0x0000); // 3 >> 2 = 0
    expect(packBgr565(0, 4, 0)).toBe(0x0020); // 4 >> 2 = 1, << 5
    expect(packBgr565(0, 0, 7)).toBe(0x0000);
    expect(packBgr565(0, 0, 8)).toBe(0x0800); // 1 << 11
  });

  it('clamps out-of-range + non-finite channels instead of corrupting the word', () => {
    expect(packBgr565(300, 300, 300)).toBe(0xffff);
    expect(packBgr565(-5, -5, -5)).toBe(0x0000);
    expect(packBgr565(NaN, NaN, NaN)).toBe(0x0000);
    // The real hazard: an unclamped `(b & 0xf8) << 8` with b = 300 would spill
    // into bit 16 and produce a word > 0xFFFF.
    expect(packBgr565(0, 0, 300)).toBeLessThanOrEqual(0xffff);
  });

  it('unpackBgr565 inverts the primaries exactly (5/6-bit replication)', () => {
    expect(unpackBgr565(0x001f)).toEqual({ r: 255, g: 0, b: 0 });
    expect(unpackBgr565(0x07e0)).toEqual({ r: 0, g: 255, b: 0 });
    expect(unpackBgr565(0xf800)).toEqual({ r: 0, g: 0, b: 255 });
    expect(unpackBgr565(0x0000)).toEqual({ r: 0, g: 0, b: 0 });
    expect(unpackBgr565(0xffff)).toEqual({ r: 255, g: 255, b: 255 });
  });
});

// ---------------------------------------------------------------------------
// The frame — header, size, shaping, stride.
// ---------------------------------------------------------------------------

describe('the frame header', () => {
  it('is exactly FF CC AA 88 followed by twelve 00', () => {
    const h = pushDisplayHeader();
    expect(h.length).toBe(16);
    expect([...h]).toEqual([0xff, 0xcc, 0xaa, 0x88, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect([...h]).toEqual([...PUSH_DISPLAY_HEADER]);
  });

  it('hands out a COPY — a caller cannot mutate the protocol bytes', () => {
    const a = pushDisplayHeader();
    a[0] = 0x00;
    expect(pushDisplayHeader()[0]).toBe(0xff);
  });
});

describe('packPushFrame — size + signal shaping', () => {
  it('emits exactly 327,680 bytes', () => {
    const frame = packPushFrame(rgbaImage(() => [0, 0, 0]));
    expect(frame.length).toBe(PUSH_DISPLAY_FRAME_BYTES);
  });

  it('NEGATIVE CONTROL for the XOR: an all-BLACK frame is the repeating mask, not zeros', () => {
    // Black packs to word 0x0000, so every output byte is 0 ^ mask = mask. If the
    // shaping XOR were dropped, this frame would be 327,680 zero bytes and every
    // one of these assertions would fail.
    const frame = packPushFrame(rgbaImage(() => [0, 0, 0]));
    expect([...frame.slice(0, 8)]).toEqual([0xe7, 0xf3, 0xe7, 0xff, 0xe7, 0xf3, 0xe7, 0xff]);
    let mismatches = 0;
    for (let i = 0; i < frame.length; i++) if (frame[i] !== maskAt(i)) mismatches++;
    expect(mismatches).toBe(0);
    expect(frame.some((b) => b !== 0)).toBe(true); // …and it is definitely not zeros
  });

  it('writes the low byte FIRST (little-endian) with the mask phase applied per byte', () => {
    // Pixel (0,0) = pure red → word 0x001F → bytes 1F 00 → XOR with E7 F3.
    const frame = packPushFrame(rgbaImage((x, y) => (x === 0 && y === 0 ? [255, 0, 0] : [0, 0, 0])));
    expect(frame[0]).toBe(0x1f ^ 0xe7); // 0xF8
    expect(frame[1]).toBe(0x00 ^ 0xf3); // 0xF3
  });

  it('advances the mask phase across the pixel — (1,0) uses mask bytes E7 FF', () => {
    const frame = packPushFrame(rgbaImage((x, y) => (x === 1 && y === 0 ? [255, 0, 0] : [0, 0, 0])));
    expect(frame[2]).toBe(0x1f ^ 0xe7); // 0xF8
    expect(frame[3]).toBe(0x00 ^ 0xff); // 0xFF
  });

  it('NEGATIVE CONTROL for the stride: line 1 starts at byte 2048 and 1920..2047 is filler', () => {
    // Row 0 all black, row 1 all blue. Under a (wrong) 1920-byte stride, row 1
    // would begin at 1920 and every assertion below would flip.
    const frame = packPushFrame(rgbaImage((_x, y) => (y === 1 ? [0, 0, 255] : [0, 0, 0])));
    // The 128 filler bytes of line 0 are still SHAPED, so they read as the mask.
    for (let off = PUSH_DISPLAY_VISIBLE_LINE_BYTES; off < PUSH_DISPLAY_LINE_BYTES; off++) {
      expect(frame[off]).toBe(maskAt(off));
    }
    // Line 1's first pixel is blue (word 0xF800 → bytes 00 F8) at offset 2048.
    expect(frame[2048]).toBe(0x00 ^ 0xe7); // 0xE7
    expect(frame[2049]).toBe(0xf8 ^ 0xf3); // 0x0B
    // And byte 1920 (where a 1920-stride would have put it) is filler, not blue.
    expect(frame[1920]).toBe(maskAt(1920));
  });

  it('every line carries its 128 filler bytes (160 lines × 128 = 20,480 bytes)', () => {
    const frame = packPushFrame(rgbaImage(() => [17, 200, 33]));
    let filler = 0;
    for (let y = 0; y < PUSH_DISPLAY_H; y++) {
      const base = y * PUSH_DISPLAY_LINE_BYTES;
      for (let off = base + PUSH_DISPLAY_VISIBLE_LINE_BYTES; off < base + PUSH_DISPLAY_LINE_BYTES; off++) {
        if (frame[off] === maskAt(off)) filler++;
      }
    }
    expect(filler).toBe(PUSH_DISPLAY_H * PUSH_DISPLAY_FILLER_BYTES);
  });

  it('IGNORES alpha — the panel is opaque', () => {
    const opaque = packPushFrame(rgbaImage(() => [255, 0, 0, 255]));
    const transparent = packPushFrame(rgbaImage(() => [255, 0, 0, 0]));
    expect([...transparent.slice(0, 64)]).toEqual([...opaque.slice(0, 64)]);
  });

  it('reads pixels back out of the packed frame (consistency check, not a format proof)', () => {
    // A round-trip is invariant to a SYMMETRIC error (a swap in both pack and
    // unpack round-trips perfectly and is still wrong on hardware) — the exact
    // byte vectors above are the format gate. This asserts placement: the right
    // colour at the right coordinate, including the corners.
    const at = (x: number, y: number): [number, number, number] =>
      x === 0 && y === 0
        ? [255, 0, 0]
        : x === PUSH_DISPLAY_W - 1 && y === 0
          ? [0, 255, 0]
          : x === 0 && y === PUSH_DISPLAY_H - 1
            ? [0, 0, 255]
            : x === PUSH_DISPLAY_W - 1 && y === PUSH_DISPLAY_H - 1
              ? [255, 255, 255]
              : [0, 0, 0];
    const frame = packPushFrame(rgbaImage(at));
    expect(readPushFramePixel(frame, 0, 0)).toEqual({ r: 255, g: 0, b: 0 });
    expect(readPushFramePixel(frame, 959, 0)).toEqual({ r: 0, g: 255, b: 0 });
    expect(readPushFramePixel(frame, 0, 159)).toEqual({ r: 0, g: 0, b: 255 });
    expect(readPushFramePixel(frame, 959, 159)).toEqual({ r: 255, g: 255, b: 255 });
    expect(readPushFramePixel(frame, 400, 80)).toEqual({ r: 0, g: 0, b: 0 });
    expect(readPushFramePixel(frame, -1, 0)).toEqual({ r: 0, g: 0, b: 0 }); // out of range
    expect(readPushFramePixel(frame, 0, 999)).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('packs a per-pixel gradient at the right offsets (no row/column transposition)', () => {
    // r varies with x, b with y — a transposed writer would swap them.
    const frame = packPushFrame(rgbaImage((x, y) => [(x & 31) << 3, 0, (y & 31) << 3]));
    for (const [x, y] of [
      [0, 0],
      [37, 5],
      [512, 128],
      [959, 159],
    ] as const) {
      const px = readPushFramePixel(frame, x, y);
      expect({ x, y, r: px.r >> 3, b: px.b >> 3 }).toEqual({ x, y, r: x & 31, b: y & 31 });
    }
  });

  it('THROWS on a mis-sized source or destination (a caller bug, not a hardware state)', () => {
    expect(() => packPushFrame(new Uint8ClampedArray(1000))).toThrow(/614400/);
    expect(() => packPushFrameInto(rgbaImage(() => [0, 0, 0]), new Uint8Array(1000))).toThrow(
      /327680/,
    );
  });

  it('packPushFrameInto reuses the caller buffer (no 320 KB churn per frame)', () => {
    const out = new Uint8Array(PUSH_DISPLAY_FRAME_BYTES);
    const ret = packPushFrameInto(rgbaImage(() => [255, 0, 0]), out);
    expect(ret).toBe(out);
    // Re-packing a different picture overwrites EVERY byte — no stale pixels.
    packPushFrameInto(rgbaImage(() => [0, 0, 255]), out);
    expect(readPushFramePixel(out, 0, 0)).toEqual({ r: 0, g: 0, b: 255 });
    expect(readPushFramePixel(out, 959, 159)).toEqual({ r: 0, g: 0, b: 255 });
  });
});

describe('solidPushFrame', () => {
  it('matches packing a uniformly-coloured image, byte for byte', () => {
    const viaPack = packPushFrame(rgbaImage(() => [12, 240, 90]));
    const viaSolid = solidPushFrame(12, 240, 90);
    expect(viaSolid.length).toBe(viaPack.length);
    let diff = 0;
    for (let i = 0; i < viaPack.length; i++) if (viaPack[i] !== viaSolid[i]) diff++;
    expect(diff).toBe(0);
  });

  it('defaults to black — which is the shaped mask pattern, not zeros', () => {
    const frame = solidPushFrame();
    expect([...frame.slice(0, 4)]).toEqual([...PUSH_DISPLAY_XOR_MASK]);
  });
});

describe('pushFrameChunks', () => {
  it('splits a frame into 20 contiguous 16 KB chunks covering every byte', () => {
    const frame = packPushFrame(rgbaImage((x) => [x & 255, 0, 0]));
    const chunks = pushFrameChunks(frame);
    expect(chunks).toHaveLength(20);
    expect(chunks.every((c) => c.length === PUSH_DISPLAY_CHUNK_BYTES)).toBe(true);
    expect(chunks.reduce((n, c) => n + c.length, 0)).toBe(PUSH_DISPLAY_FRAME_BYTES);
    // Reassembling the chunks reproduces the frame exactly.
    const joined = new Uint8Array(PUSH_DISPLAY_FRAME_BYTES);
    let off = 0;
    for (const c of chunks) {
      joined.set(c, off);
      off += c.length;
    }
    expect(readPushFramePixel(joined, 300, 77)).toEqual(readPushFramePixel(frame, 300, 77));
  });

  it('handles a non-dividing chunk size with a short final chunk', () => {
    const chunks = pushFrameChunks(solidPushFrame(), 100000);
    expect(chunks.map((c) => c.length)).toEqual([100000, 100000, 100000, 27680]);
  });
});

// ---------------------------------------------------------------------------
// Pacing decisions (pure — the timers live in the transport).
// ---------------------------------------------------------------------------

describe('frameGateDelayMs — the ~30 Hz floor', () => {
  it('sends immediately when nothing has been sent yet', () => {
    expect(frameGateDelayMs(1000, -Infinity)).toBe(0);
  });
  it('holds a frame that arrives inside the 33 ms window, and reports the wait', () => {
    expect(PUSH_DISPLAY_MIN_FRAME_MS).toBe(33);
    expect(frameGateDelayMs(1000, 1000)).toBe(33);
    expect(frameGateDelayMs(1010, 1000)).toBe(23);
    expect(frameGateDelayMs(1032.5, 1000)).toBe(1); // ceil — never round DOWN to 0
  });
  it('sends once the window has elapsed', () => {
    expect(frameGateDelayMs(1033, 1000)).toBe(0);
    expect(frameGateDelayMs(9999, 1000)).toBe(0);
  });
});

describe('keepaliveDue — the ~2 s blackout guard', () => {
  it('is false until something has been sent', () => {
    expect(keepaliveDue(5000, -Infinity)).toBe(false);
  });
  it('fires at the 500 ms mark, not before', () => {
    expect(PUSH_DISPLAY_KEEPALIVE_MS).toBe(500);
    expect(keepaliveDue(1499, 1000)).toBe(false);
    expect(keepaliveDue(1500, 1000)).toBe(true);
    expect(keepaliveDue(2600, 1000)).toBe(true);
  });
  it('leaves headroom under the device’s ~2 s blackout', () => {
    expect(PUSH_DISPLAY_KEEPALIVE_MS * 3).toBeLessThan(2000);
  });
});
