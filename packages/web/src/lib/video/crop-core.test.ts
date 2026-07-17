// packages/web/src/lib/video/crop-core.test.ts
//
// Pure unit tests for the reusable crop model + math. GL-free + deterministic
// (mirrors loopback-crop.test.ts / mappy-hit style). Covers: aspect-derived
// height in both output modes AND a decoupled frame/region aspect, edge
// clamping, mode-flip re-fit (center preserved), garbage coercion, the y-flip
// sample window, and the aspect-locked corner resize / translate.

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CROP_W,
  MIN_CROP,
  deriveCropHeight,
  widthForCropHeight,
  fitCrop,
  defaultCropRect,
  refitCrop,
  coerceCrop,
  resolveCrop,
  cropIsPassthrough,
  cropSampleWindow,
  resizeCropCorner,
  translateCrop,
  type CropRect,
} from './crop-core';

// The two live output aspects (engine res: 4:3 = 1024×768, 16:9 = 1366×768).
const A_43 = 1024 / 768; // 1.3333
const A_169 = 1366 / 768; // 1.77864

describe('deriveCropHeight', () => {
  it('frameAspect === regionAspect ⇒ h = w (a normalized square) in BOTH modes', () => {
    for (const a of [A_43, A_169, 16 / 9, 4 / 3, 2.35]) {
      for (const w of [0.1, 0.3, 0.5, 0.87, 1]) {
        expect(deriveCropHeight(w, a, a)).toBeCloseTo(w, 12);
      }
    }
  });

  it('decoupled frame/region aspects scale height by frameAspect/regionAspect', () => {
    // A rect in a 16:9 editing frame whose region must be 4:3 is TALLER than wide.
    expect(deriveCropHeight(0.5, 16 / 9, 4 / 3)).toBeCloseTo(0.5 * (16 / 9) / (4 / 3), 12);
    expect(deriveCropHeight(0.5, 16 / 9, 4 / 3)).toBeGreaterThan(0.5);
  });

  it('degrades to h = w on a non-positive/garbage aspect', () => {
    expect(deriveCropHeight(0.4, 0, 1)).toBeCloseTo(0.4, 12);
    expect(deriveCropHeight(0.4, 1, -1)).toBeCloseTo(0.4, 12);
    expect(deriveCropHeight(0.4, NaN, 1)).toBeCloseTo(0.4, 12);
  });

  it('widthForCropHeight is the exact inverse', () => {
    for (const [fa, ra] of [[16 / 9, 4 / 3], [A_169, A_43], [1, 1]]) {
      const h = deriveCropHeight(0.42, fa!, ra!);
      expect(widthForCropHeight(h, fa!, ra!)).toBeCloseTo(0.42, 12);
    }
  });
});

describe('fitCrop — keeps the rect inside the frame at the locked aspect', () => {
  it('clamps width to [MIN_CROP, 1]', () => {
    expect(fitCrop({ x: 0.4, y: 0.4, w: 5 }, A_43, A_43).w).toBeLessThanOrEqual(1);
    expect(fitCrop({ x: 0.4, y: 0.4, w: 0 }, A_43, A_43).w).toBeGreaterThanOrEqual(MIN_CROP);
  });

  it('a rect wider/taller than the frame is shrunk to fit (h ≤ 1, w ≤ 1)', () => {
    // frame 16:9, region 4:3 ⇒ h = 1.333·w; w=1 would give h>1, so it shrinks.
    const r = fitCrop({ x: 0, y: 0, w: 1 }, 16 / 9, 4 / 3);
    const h = deriveCropHeight(r.w, 16 / 9, 4 / 3);
    expect(h).toBeLessThanOrEqual(1 + 1e-9);
    expect(r.w).toBeLessThanOrEqual(1);
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.x + r.w).toBeLessThanOrEqual(1 + 1e-9);
    expect(r.y + h).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('clamps a rect pushed off the right/bottom edge back fully inside', () => {
    const r = fitCrop({ x: 0.8, y: 0.8, w: 0.5 }, A_43, A_43);
    const h = deriveCropHeight(r.w, A_43, A_43);
    expect(r.x + r.w).toBeLessThanOrEqual(1 + 1e-9);
    expect(r.y + h).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('preserves the CENTER when the rect already fits', () => {
    const req: CropRect = { x: 0.25, y: 0.3, w: 0.4 };
    const r = fitCrop(req, A_43, A_43);
    const h = deriveCropHeight(0.4, A_43, A_43);
    // fits fully → returned unchanged (center preserved)
    expect(r.x).toBeCloseTo(0.25, 9);
    expect(r.y).toBeCloseTo(0.3, 9);
    expect(r.w).toBeCloseTo(0.4, 9);
    expect(r.y + h).toBeLessThanOrEqual(1 + 1e-9);
  });
});

describe('defaultCropRect', () => {
  it('is a centered rect of ~50% width, fully inside the frame', () => {
    for (const a of [A_43, A_169]) {
      const r = defaultCropRect(a, a);
      expect(r.w).toBeCloseTo(DEFAULT_CROP_W, 9);
      const h = deriveCropHeight(r.w, a, a);
      expect(r.x + r.w / 2).toBeCloseTo(0.5, 6);
      expect(r.y + h / 2).toBeCloseTo(0.5, 6);
    }
  });
});

describe('refitCrop — output-mode flip (16:9 ↔ 4:3)', () => {
  it('videovarispeed (frame === region): flip preserves center + width (h stays = w)', () => {
    const start = defaultCropRect(A_169, A_169, 0.5);
    // move it off-center a bit, still inside
    const moved: CropRect = fitCrop({ x: 0.1, y: 0.1, w: 0.5 }, A_169, A_169);
    const flipped = refitCrop(moved, A_43, A_43);
    expect(flipped.w).toBeCloseTo(moved.w, 9); // width preserved
    // center preserved (h = w in both modes)
    const hBefore = deriveCropHeight(moved.w, A_169, A_169);
    const hAfter = deriveCropHeight(flipped.w, A_43, A_43);
    expect(moved.x + moved.w / 2).toBeCloseTo(flipped.x + flipped.w / 2, 6);
    expect(moved.y + hBefore / 2).toBeCloseTo(flipped.y + hAfter / 2, 6);
    void start;
  });

  it('decoupled module: flip RECOMPUTES height, preserves x-center + top edge, clamps', () => {
    // region aspect flips 16:9→4:3 while the editing frame stays 16:9. From a
    // stored (x,y,w) — with no memory of the OLD aspect — refit preserves the
    // top edge + x-center and recomputes the (now taller) height, staying in
    // frame. (The exact-center case is the frame===region path above, which is
    // what videovarispeed uses.)
    const r0: CropRect = { x: 0.3, y: 0.3, w: 0.4 };
    const h0 = deriveCropHeight(r0.w, 16 / 9, 16 / 9); // 0.4
    const r1 = refitCrop(r0, 16 / 9, 4 / 3);
    const h1 = deriveCropHeight(r1.w, 16 / 9, 4 / 3);
    expect(h1).toBeGreaterThan(h0); // taller region after flip
    expect(r0.x + r0.w / 2).toBeCloseTo(r1.x + r1.w / 2, 6); // x-center preserved
    expect(r1.y).toBeCloseTo(r0.y, 6); // top edge preserved (still fits)
    expect(r1.y + h1).toBeLessThanOrEqual(1 + 1e-9); // stays in frame
  });
});

describe('coerceCrop', () => {
  it('undefined / garbage → a valid, fitted, inactive passthrough state', () => {
    for (const raw of [undefined, null, 42, 'x', {}, { x: 'a', y: null, w: NaN }]) {
      const s = coerceCrop(raw, A_43, A_43);
      expect(s.active).toBe(false);
      expect(s.rect.w).toBeGreaterThanOrEqual(MIN_CROP);
      expect(s.rect.w).toBeLessThanOrEqual(1);
      expect(s.rect.x).toBeGreaterThanOrEqual(0);
      expect(s.rect.y).toBeGreaterThanOrEqual(0);
    }
  });

  it('reads active + clamps an out-of-range rect fully inside', () => {
    const s = coerceCrop({ active: true, x: 1.5, y: -0.2, w: 0.6 }, A_43, A_43);
    expect(s.active).toBe(true);
    const h = deriveCropHeight(s.rect.w, A_43, A_43);
    expect(s.rect.x + s.rect.w).toBeLessThanOrEqual(1 + 1e-9);
    expect(s.rect.y).toBeGreaterThanOrEqual(0);
    expect(s.rect.y + h).toBeLessThanOrEqual(1 + 1e-9);
  });
});

describe('cropSampleWindow — GL y-flip', () => {
  it('passthrough (full frame) maps to the whole texture', () => {
    const w = cropSampleWindow({ x: 0, y: 0, w: 1, h: 1 });
    expect(w).toEqual({ u0: 0, v0: 0, w: 1, h: 1 });
  });

  it('flips the y-down rect into y-up sample space', () => {
    // A rect at screen-top (y=0, h=0.25) samples the TOP band → high v.
    const top = cropSampleWindow({ x: 0.1, y: 0, w: 0.5, h: 0.25 });
    expect(top.u0).toBeCloseTo(0.1, 9);
    expect(top.v0).toBeCloseTo(0.75, 9); // 1 - (0 + 0.25)
    expect(top.h).toBeCloseTo(0.25, 9);
    // A rect at screen-bottom samples the BOTTOM band → v0 = 0.
    const bot = cropSampleWindow({ x: 0, y: 0.75, w: 1, h: 0.25 });
    expect(bot.v0).toBeCloseTo(0, 9);
  });
});

describe('cropIsPassthrough', () => {
  it('inactive is passthrough; a real sub-rect is not', () => {
    expect(cropIsPassthrough({ active: false, rect: { x: 0, y: 0, w: 1 } }, A_43, A_43)).toBe(true);
    expect(cropIsPassthrough({ active: true, rect: { x: 0.1, y: 0.1, w: 0.4 } }, A_43, A_43)).toBe(false);
  });
});

describe('resizeCropCorner — aspect-locked', () => {
  it('dragging BR keeps TL pinned + derives height from the new width', () => {
    const rect: CropRect = { x: 0.2, y: 0.2, w: 0.3 };
    const h0 = deriveCropHeight(rect.w, A_43, A_43);
    // pointer to the right → wider box; TL stays at (0.2,0.2)
    const r = resizeCropCorner(rect, h0, 2, 0.7, A_43, A_43);
    expect(r.x).toBeCloseTo(0.2, 6);
    expect(r.y).toBeCloseTo(0.2, 6);
    expect(r.w).toBeCloseTo(0.5, 6); // 0.7 - 0.2
    // height follows aspect (square in frame==region)
    expect(deriveCropHeight(r.w, A_43, A_43)).toBeCloseTo(0.5, 6);
  });

  it('dragging TL keeps BR pinned', () => {
    const rect: CropRect = { x: 0.2, y: 0.2, w: 0.4 };
    const h0 = deriveCropHeight(rect.w, A_43, A_43); // 0.4 → BR at (0.6,0.6)
    const r = resizeCropCorner(rect, h0, 0, 0.3, A_43, A_43); // pointer x=0.3
    const h1 = deriveCropHeight(r.w, A_43, A_43);
    expect(r.x + r.w).toBeCloseTo(0.6, 6); // right edge pinned
    expect(r.y + h1).toBeCloseTo(0.6, 6);  // bottom edge pinned
    expect(r.w).toBeCloseTo(0.3, 6);        // 0.6 - 0.3
  });

  it('never leaves the frame + respects MIN_CROP', () => {
    const rect: CropRect = { x: 0.2, y: 0.2, w: 0.3 };
    const h0 = deriveCropHeight(rect.w, A_43, A_43);
    const huge = resizeCropCorner(rect, h0, 2, 5, A_43, A_43);
    expect(huge.x + huge.w).toBeLessThanOrEqual(1 + 1e-9);
    const tiny = resizeCropCorner(rect, h0, 2, 0.2001, A_43, A_43);
    expect(tiny.w).toBeGreaterThanOrEqual(MIN_CROP);
  });
});

describe('translateCrop', () => {
  it('moves the rect + clamps it inside the frame', () => {
    const rect: CropRect = { x: 0.3, y: 0.3, w: 0.4 };
    const moved = translateCrop(rect, 0.1, -0.1, A_43, A_43);
    expect(moved.x).toBeCloseTo(0.4, 6);
    expect(moved.y).toBeCloseTo(0.2, 6);
    expect(moved.w).toBeCloseTo(0.4, 6);
    // a big move is clamped so the rect stays fully inside
    const far = translateCrop(rect, 9, 9, A_43, A_43);
    const h = deriveCropHeight(far.w, A_43, A_43);
    expect(far.x + far.w).toBeLessThanOrEqual(1 + 1e-9);
    expect(far.y + h).toBeLessThanOrEqual(1 + 1e-9);
  });
});

describe('resolveCrop', () => {
  it('adds the derived height to the stored rect (what the overlay draws)', () => {
    const r = resolveCrop({ x: 0.1, y: 0.2, w: 0.5 }, A_169, A_169);
    expect(r).toEqual({ x: 0.1, y: 0.2, w: 0.5, h: 0.5 });
  });
});
