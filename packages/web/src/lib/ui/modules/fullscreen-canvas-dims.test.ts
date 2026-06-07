import { describe, it, expect } from 'vitest';
import { fullscreenCanvasDims } from './fullscreen-canvas-dims';
import { VIDEO_RES } from '$lib/video/engine';

// Regression coverage for the fullscreen letterbox bug: when a canvas-based
// video card goes fullscreen, the drawing buffer must take the ENGINE aspect
// (so the source height-fills the screen with only the unavoidable side
// pillarbox) — NOT the card aspect (which produced double top/bottom bars).

describe('fullscreenCanvasDims', () => {
  const engine = (w: number, h: number) => ({ canvas: { width: w, height: h } });

  describe('in the rack (not fullscreen)', () => {
    it('passes the card inner dims through untouched (byte-identical preview)', () => {
      const d = fullscreenCanvasDims(false, engine(1024, 768), { width: 340, height: 184 });
      expect(d.width).toBe(340);
      expect(d.height).toBe(184);
      expect(d.aspectRatio).toBe('340 / 184');
    });

    it('ignores the engine entirely when not fullscreen', () => {
      const d = fullscreenCanvasDims(false, engine(1920, 1080), { width: 360, height: 240 });
      expect(d.width).toBe(360);
      expect(d.height).toBe(240);
    });

    it('floors a degenerate card dim at 2px without throwing', () => {
      const d = fullscreenCanvasDims(false, engine(1024, 768), { width: 0, height: -5 });
      expect(d.width).toBe(2);
      expect(d.height).toBe(2);
    });
  });

  describe('fullscreen — buffer follows the ENGINE aspect', () => {
    it('engine dims → mirrored buffer (object-fit:contain pillarboxes, no top/bottom bars)', () => {
      const d = fullscreenCanvasDims(true, engine(1024, 768), { width: 340, height: 184 });
      // Engine dims mirrored — buffer carries 4:3, NOT the ~1.85 card aspect.
      expect(d.width).toBe(1024);
      expect(d.height).toBe(768);
      expect(d.width / d.height).toBeCloseTo(4 / 3, 5);
      expect(d.aspectRatio).toBe('1024 / 768');
    });

    it('does NOT inherit the card aspect in fullscreen (the bug)', () => {
      const cardAspect = 340 / 184; // ~1.85, what the buggy buffer used
      const d = fullscreenCanvasDims(true, engine(1024, 768), { width: 340, height: 184 });
      expect(d.width / d.height).not.toBeCloseTo(cardAspect, 2);
    });

    it('mirrors a 16:9 engine → 16:9 buffer (full-screen fill on a 16:9 display)', () => {
      const d = fullscreenCanvasDims(true, engine(1920, 1080), { width: 340, height: 184 });
      expect(d.width).toBe(1920);
      expect(d.height).toBe(1080);
      expect(d.width / d.height).toBeCloseTo(16 / 9, 5);
    });

    it('mirrors a 4:3 engine at any size (side pillarbox on a wide screen)', () => {
      const d = fullscreenCanvasDims(true, engine(1440, 1080), { width: 340, height: 184 });
      expect(d.width).toBe(1440);
      expect(d.height).toBe(1080);
      expect(d.width / d.height).toBeCloseTo(4 / 3, 5);
    });

    it('rounds engine dims to even on both axes', () => {
      const d = fullscreenCanvasDims(true, engine(641, 481), { width: 340, height: 184 });
      expect(d.width % 2).toBe(0);
      expect(d.height % 2).toBe(0);
    });

    it('falls back to the VIDEO_RES 4:3 buffer when the engine canvas is not readable yet', () => {
      const d = fullscreenCanvasDims(true, engine(0, 0), { width: 340, height: 184 });
      expect(d.width).toBe(VIDEO_RES.width);
      expect(d.height).toBe(VIDEO_RES.height);
      expect(d.width / d.height).toBeCloseTo(4 / 3, 2);
    });

    it('falls back to VIDEO_RES (4:3) when the engine is null', () => {
      const d = fullscreenCanvasDims(true, null, { width: 340, height: 184 });
      expect(d.width / d.height).toBeCloseTo(4 / 3, 2);
      expect(d.width).toBe(VIDEO_RES.width);
      expect(d.height).toBe(VIDEO_RES.height);
    });
  });
});
