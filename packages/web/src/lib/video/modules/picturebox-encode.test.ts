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
} from './picturebox-encode';

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
