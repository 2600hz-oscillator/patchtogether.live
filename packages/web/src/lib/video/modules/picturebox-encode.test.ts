// packages/web/src/lib/video/modules/picturebox-encode.test.ts
//
// Pure helper tests. The full image-decode/encode round-trip needs an
// OffscreenCanvas (browser-only); that's covered by the e2e specs.
// Here we just verify the math + the base64 codec.

import { describe, expect, it } from 'vitest';
import {
  TARGET_W,
  TARGET_H,
  computeZoomFitCrop,
  bytesToBase64,
  base64ToBytes,
  countGifFrames,
  isAnimatedGif,
  GIF_MIME,
  MAX_GIF_BYTES,
} from './picturebox-encode';

/** Build a syntactically-valid GIF89a byte stream with `numFrames` image
 *  descriptors (each preceded by a Graphic Control Extension), optionally with a
 *  Global Colour Table — exercising every block the frame counter must skip. */
function buildGif(numFrames: number, withGct = false): Uint8Array {
  const b: number[] = [];
  b.push(0x47, 0x49, 0x46, 0x38, 0x39, 0x61); // "GIF89a"
  const packed = withGct ? 0x80 : 0x00; // GCT flag; size bits 0 → 2 entries
  b.push(0x0a, 0x00, 0x0a, 0x00, packed, 0x00, 0x00); // Logical Screen Descriptor (10×10)
  if (withGct) for (let i = 0; i < 3 * 2; i++) b.push(0x00); // 2-entry global colour table
  for (let f = 0; f < numFrames; f++) {
    b.push(0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00); // Graphic Control Ext (delay 10)
    b.push(0x2c, 0x00, 0x00, 0x00, 0x00, 0x0a, 0x00, 0x0a, 0x00, 0x00); // Image Descriptor
    b.push(0x02, 0x01, 0x44, 0x00); // LZW min code size + one data sub-block + terminator
  }
  b.push(0x3b); // trailer
  return new Uint8Array(b);
}

describe('picturebox-encode — TARGET dimensions', () => {
  it('matches the engine resolution (1024 x 768, 4:3)', () => {
    expect(TARGET_W).toBe(1024);
    expect(TARGET_H).toBe(768);
    expect(TARGET_W / TARGET_H).toBeCloseTo(4 / 3, 5);
  });
});

describe('picturebox-encode — computeZoomFitCrop', () => {
  it('exactly-sized source maps 1:1 with no offset', () => {
    const r = computeZoomFitCrop(TARGET_W, TARGET_H);
    expect(r.dx).toBe(0);
    expect(r.dy).toBe(0);
    expect(r.dw).toBe(TARGET_W);
    expect(r.dh).toBe(TARGET_H);
  });

  it('wider source (16:9 1280x720) crops left+right (negative dx)', () => {
    // 4:3 target: scale = max(TW/1280, TH/720) = TH/720 (the height limits),
    // so dh fills the target height exactly and dw overhangs (cropped sides).
    const r = computeZoomFitCrop(1280, 720);
    expect(r.dh).toBeCloseTo(TARGET_H, 1);
    expect(r.dw).toBeCloseTo((1280 / 720) * TARGET_H, 1);
    expect(r.dx).toBeLessThan(0);
    expect(r.dy).toBeCloseTo(0, 1);
  });

  it('taller source (3:4) crops top+bottom (negative dy)', () => {
    // 4:3 target vs a 3:4 portrait source: the WIDTH limits, so dw fills the
    // target width and dh overhangs (cropped top+bottom).
    const r = computeZoomFitCrop(TARGET_H, TARGET_W); // portrait 3:4
    expect(r.dw).toBeCloseTo(TARGET_W, 1);
    expect(r.dh).toBeCloseTo((TARGET_W / TARGET_H) * TARGET_W, 1);
    expect(r.dx).toBeCloseTo(0, 1);
    expect(r.dy).toBeLessThan(0);
  });

  it('square source maps to a centered square that fills the width', () => {
    // 4:3 target, square source: scale = max(TW/s, TH/s) = TW/s (width limits)
    // → a TARGET_W × TARGET_W square, centered vertically (dy negative).
    const r = computeZoomFitCrop(1000, 1000);
    expect(r.dw).toBeCloseTo(TARGET_W, 1);
    expect(r.dh).toBeCloseTo(TARGET_W, 1);
    expect(r.dx).toBeCloseTo(0, 1);
    expect(r.dy).toBeCloseTo((TARGET_H - TARGET_W) / 2, 1);
  });

  it('respects custom target dimensions', () => {
    const r = computeZoomFitCrop(100, 100, 200, 100);
    // scale = max(2, 1) = 2 → dw=200, dh=200
    expect(r.dw).toBe(200);
    expect(r.dh).toBe(200);
    expect(r.dx).toBe(0);
    expect(r.dy).toBe(-50);
  });

  it('degenerate (zero or negative) source size returns a defensive default', () => {
    const r = computeZoomFitCrop(0, 480);
    expect(r.dx).toBe(0);
    expect(r.dy).toBe(0);
    expect(r.dw).toBe(TARGET_W);
    expect(r.dh).toBe(TARGET_H);
  });
});

describe('picturebox-encode — base64 round-trip', () => {
  it('round-trips a small byte sequence', () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const b64 = bytesToBase64(bytes);
    expect(typeof b64).toBe('string');
    expect(b64.length).toBeGreaterThan(0);
    const decoded = base64ToBytes(b64);
    expect(Array.from(decoded)).toEqual(Array.from(bytes));
  });

  it('round-trips a larger byte sequence (chunked path > 0x8000 bytes)', () => {
    const bytes = new Uint8Array(0x10000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
    const b64 = bytesToBase64(bytes);
    const decoded = base64ToBytes(b64);
    expect(decoded.length).toBe(bytes.length);
    // Spot-check a few bytes
    expect(decoded[0]).toBe(0);
    expect(decoded[255]).toBe(255);
    expect(decoded[256]).toBe(0);
    expect(decoded[bytes.length - 1]).toBe(255);
  });

  it('empty input round-trips cleanly', () => {
    const empty = new Uint8Array(0);
    expect(bytesToBase64(empty)).toBe('');
    expect(base64ToBytes('').length).toBe(0);
  });
});

describe('picturebox-encode — countGifFrames / isAnimatedGif', () => {
  it('counts a single-frame gif as 1 (still → NOT animated)', () => {
    const g = buildGif(1);
    expect(countGifFrames(g)).toBe(1);
    expect(isAnimatedGif(g)).toBe(false);
  });

  it('counts a multi-frame gif and flags it animated', () => {
    expect(countGifFrames(buildGif(2))).toBe(2);
    expect(countGifFrames(buildGif(5))).toBe(5);
    expect(isAnimatedGif(buildGif(2))).toBe(true);
    expect(isAnimatedGif(buildGif(4))).toBe(true);
  });

  it('skips a Global Colour Table without miscounting', () => {
    expect(countGifFrames(buildGif(3, /* withGct */ true))).toBe(3);
    expect(isAnimatedGif(buildGif(3, true))).toBe(true);
  });

  it('returns 0 for non-GIF bytes (a JPEG SOI, PNG magic, empty)', () => {
    expect(countGifFrames(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(0);
    expect(countGifFrames(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(0);
    expect(countGifFrames(new Uint8Array(0))).toBe(0);
    expect(isAnimatedGif(new Uint8Array([0xff, 0xd8]))).toBe(false);
  });

  it('is defensive on a truncated gif (never throws; counts what it can)', () => {
    const full = buildGif(3);
    const truncated = full.subarray(0, full.length - 10); // chop mid-last-frame
    expect(() => countGifFrames(truncated)).not.toThrow();
    expect(countGifFrames(truncated)).toBeGreaterThanOrEqual(2);
  });

  it('exposes the sync constants (gif mime + a bounded size cap)', () => {
    expect(GIF_MIME).toBe('image/gif');
    expect(MAX_GIF_BYTES).toBeGreaterThan(0);
    // Sanity: the cap is generous enough for a real animated gif but bounded so
    // one payload can't hammer the relay (well under an unreasonable 10MB).
    expect(MAX_GIF_BYTES).toBeLessThanOrEqual(10_000_000);
  });
});
