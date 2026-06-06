// packages/web/src/lib/video/hd-res.test.ts
//
// Pure aspect → HD render-resolution math. Deterministic, GL-free table.

import { describe, it, expect } from 'vitest';
import {
  computeHdRes,
  computeHdResFromViewport,
  HD_TARGET_LINES,
  HD_LONG_EDGE_CAP,
} from './hd-res';

describe('computeHdRes — aspect → ~1080-line target', () => {
  it('16:9 → 1920×1080', () => {
    expect(computeHdRes(16 / 9)).toEqual({ width: 1920, height: 1080 });
  });

  it('4:3 → 1440×1080', () => {
    expect(computeHdRes(4 / 3)).toEqual({ width: 1440, height: 1080 });
  });

  it('1:1 (square) → 1080×1080', () => {
    expect(computeHdRes(1)).toEqual({ width: 1080, height: 1080 });
  });

  it('21:9 ultra-wide → long edge capped at 1920 (height < 1080)', () => {
    const r = computeHdRes(21 / 9);
    // Long edge (width) must be capped at 1920, NOT 1080·(21/9)=2520.
    expect(r.width).toBe(HD_LONG_EDGE_CAP);
    expect(r.width).toBeLessThanOrEqual(HD_LONG_EDGE_CAP);
    // Height recomputed to preserve aspect → 1920/(21/9) ≈ 822.8 → even 822.
    expect(r.height).toBe(822);
    // Aspect preserved within rounding.
    expect(r.width / r.height).toBeCloseTo(21 / 9, 1);
  });

  it('32:9 super-ultra-wide → still capped at 1920 long edge', () => {
    const r = computeHdRes(32 / 9);
    expect(r.width).toBe(1920);
    expect(r.width).toBeLessThanOrEqual(HD_LONG_EDGE_CAP);
  });

  it('9:16 portrait → 1080×1920 (width is the short edge, capped long edge)', () => {
    const r = computeHdRes(9 / 16);
    expect(r.width).toBe(HD_TARGET_LINES); // short edge = width = 1080
    expect(r.height).toBe(HD_LONG_EDGE_CAP); // long edge capped at 1920
  });

  it('3:4 portrait → 1080×1440', () => {
    expect(computeHdRes(3 / 4)).toEqual({ width: 1080, height: 1440 });
  });

  it('always returns EVEN width and height', () => {
    const aspects = [16 / 9, 4 / 3, 1, 21 / 9, 9 / 16, 1.777, 0.5625, 2.35, 1.43];
    for (const a of aspects) {
      const r = computeHdRes(a);
      expect(r.width % 2, `width even for aspect ${a}`).toBe(0);
      expect(r.height % 2, `height even for aspect ${a}`).toBe(0);
    }
  });

  it('even-rounds a fractional result down (2.35:1 cinemascope)', () => {
    // 2.35 ≥ 1 → h=1080, w=round(1080·2.35)=2538 > 1920 cap → w=1920,
    // h=round(1920/2.35)=round(817.02)=817 → even → 816.
    const r = computeHdRes(2.35);
    expect(r.width).toBe(1920);
    expect(r.height).toBe(816);
    expect(r.height % 2).toBe(0);
  });

  it('falls back to 16:9 for degenerate aspects (0, negative, NaN, Infinity)', () => {
    const expected = { width: 1920, height: 1080 };
    expect(computeHdRes(0)).toEqual(expected);
    expect(computeHdRes(-2)).toEqual(expected);
    expect(computeHdRes(NaN)).toEqual(expected);
    expect(computeHdRes(Infinity)).toEqual(expected);
  });
});

describe('computeHdResFromViewport — SSR + degenerate guards', () => {
  const origWindow = (globalThis as { window?: unknown }).window;
  function setViewport(w: number | undefined, h: number | undefined): void {
    (globalThis as { window?: unknown }).window = { innerWidth: w, innerHeight: h };
  }
  function restore(): void {
    if (origWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = origWindow;
  }

  it('derives from window.innerWidth/innerHeight (16:9 viewport)', () => {
    setViewport(2560, 1440);
    try {
      expect(computeHdResFromViewport()).toEqual({ width: 1920, height: 1080 });
    } finally {
      restore();
    }
  });

  it('falls back to 16:9 when viewport is 0-height', () => {
    setViewport(1920, 0);
    try {
      expect(computeHdResFromViewport()).toEqual({ width: 1920, height: 1080 });
    } finally {
      restore();
    }
  });

  it('falls back to 16:9 with no window (SSR)', () => {
    delete (globalThis as { window?: unknown }).window;
    try {
      expect(computeHdResFromViewport()).toEqual({ width: 1920, height: 1080 });
    } finally {
      restore();
    }
  });
});
