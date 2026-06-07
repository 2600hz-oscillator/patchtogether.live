// packages/web/src/lib/video/buffer-res.test.ts
//
// Per-module heavy-buffer res math (hd-toggle §4.5). Pure + GL-free.

import { describe, it, expect } from 'vitest';
import {
  effectiveBufferDims,
  clampBufferResValue,
  BUFFER_RES_SD,
  BUFFER_RES_720,
  BUFFER_RES_1080,
} from './buffer-res';

const SD = { width: 640, height: 480 }; // VIDEO_RES (HD off → engine is here)
const HD_169 = { width: 1920, height: 1080 };
const HD_43 = { width: 1440, height: 1080 };

describe('clampBufferResValue', () => {
  it('passes through valid values', () => {
    expect(clampBufferResValue(0)).toBe(BUFFER_RES_SD);
    expect(clampBufferResValue(1)).toBe(BUFFER_RES_720);
    expect(clampBufferResValue(2)).toBe(BUFFER_RES_1080);
  });
  it('rounds + clamps out-of-range / junk to SD', () => {
    expect(clampBufferResValue(0.4)).toBe(BUFFER_RES_SD);
    expect(clampBufferResValue(3)).toBe(BUFFER_RES_SD);
    expect(clampBufferResValue(-1)).toBe(BUFFER_RES_SD);
    expect(clampBufferResValue(undefined)).toBe(BUFFER_RES_SD);
    expect(clampBufferResValue('720p' as unknown)).toBe(BUFFER_RES_SD);
  });
  it('rounds 1.0/2.0 floats to 720/1080', () => {
    expect(clampBufferResValue(1.0)).toBe(BUFFER_RES_720);
    expect(clampBufferResValue(2.0)).toBe(BUFFER_RES_1080);
  });
});

describe('effectiveBufferDims — HD OFF clamps everything to SD', () => {
  it('SD dropdown + HD off → SD engine dims', () => {
    expect(effectiveBufferDims(BUFFER_RES_SD, false, SD)).toEqual({ width: 640, height: 480 });
  });
  it('1080p dropdown + HD off → STILL SD (the key safety rule)', () => {
    // A saved 1080p node rendered by an HD-off peer must NOT allocate 1080p.
    expect(effectiveBufferDims(BUFFER_RES_1080, false, SD)).toEqual({ width: 640, height: 480 });
  });
  it('720p dropdown + HD off → SD', () => {
    expect(effectiveBufferDims(BUFFER_RES_720, false, SD)).toEqual({ width: 640, height: 480 });
  });
});

describe('effectiveBufferDims — HD ON honors the dropdown at the engine aspect', () => {
  it('SD dropdown + HD on (16:9 engine) → SD lines (480) at 16:9', () => {
    // 480 short edge, 16:9 → round(480*16/9)=853 → even-floored to 852.
    const d = effectiveBufferDims(BUFFER_RES_SD, true, HD_169);
    expect(d.height).toBe(480);
    expect(d.width).toBe(852);
  });

  it('720p dropdown + HD on (16:9) → 1280×720', () => {
    expect(effectiveBufferDims(BUFFER_RES_720, true, HD_169)).toEqual({ width: 1280, height: 720 });
  });

  it('1080p dropdown + HD on (16:9) → 1920×1080 (== engine res)', () => {
    expect(effectiveBufferDims(BUFFER_RES_1080, true, HD_169)).toEqual({ width: 1920, height: 1080 });
  });

  it('720p dropdown + HD on (4:3 engine) → 960×720', () => {
    expect(effectiveBufferDims(BUFFER_RES_720, true, HD_43)).toEqual({ width: 960, height: 720 });
  });

  it('1080p dropdown + HD on (4:3 engine) → 1440×1080 (== engine res)', () => {
    expect(effectiveBufferDims(BUFFER_RES_1080, true, HD_43)).toEqual({ width: 1440, height: 1080 });
  });
});

describe('effectiveBufferDims — never exceeds the engine res + always even', () => {
  it('1080p dropdown is capped to the engine res when engine < 1080p', () => {
    // Engine is at SD (HD on but a small viewport gave 854×480) — a 1080p ring
    // would be bigger than the output → clamp down to engine res.
    const smallEngine = { width: 854, height: 480 };
    const d = effectiveBufferDims(BUFFER_RES_1080, true, smallEngine);
    expect(d.width).toBeLessThanOrEqual(854);
    expect(d.height).toBeLessThanOrEqual(480);
  });

  it('all outputs are even on both axes', () => {
    for (const res of [SD, HD_169, HD_43, { width: 2560, height: 1080 }]) {
      for (const v of [BUFFER_RES_SD, BUFFER_RES_720, BUFFER_RES_1080] as const) {
        const d = effectiveBufferDims(v, true, res);
        expect(d.width % 2, `w even for ${v}@${res.width}x${res.height}`).toBe(0);
        expect(d.height % 2, `h even for ${v}@${res.width}x${res.height}`).toBe(0);
      }
    }
  });
});
