// packages/web/src/lib/video/recorderbox-cfr.test.ts
//
// Unit coverage for the CONSTANT-FRAME-RATE clock — the OSX slow-mo fix. The bug
// was VARIABLE video frame timing (PTS off wall clock + drop-on-backpressure
// cadence), which a player reads as slow-motion. The fix synthesizes an even grid
// of PTS; these tests are the regression net: even grid, constant duration, NO
// duplicate PTS, NO gaps, under jittery rAF input. PURE — CI-safe, no encoder.

import { describe, it, expect } from 'vitest';
import { CfrClock, planCfrEmit } from './recorderbox-cfr';

const FPS = 30;

describe('CfrClock — exact grid PTS', () => {
  it('ptsForFrame is exactly index/fps (evenly spaced)', () => {
    const c = new CfrClock(FPS);
    expect(c.ptsForFrame(0)).toBe(0);
    expect(c.ptsForFrame(1)).toBe(1 / 30);
    expect(c.ptsForFrame(2)).toBe(2 / 30);
    expect(c.ptsForFrame(30)).toBe(1);
    // Constant spacing: every successive delta is exactly 1/fps.
    for (let i = 1; i < 100; i++) {
      expect(c.ptsForFrame(i) - c.ptsForFrame(i - 1)).toBeCloseTo(1 / 30, 12);
    }
  });

  it('frameDuration is exactly 1/fps', () => {
    expect(new CfrClock(30).frameDuration).toBe(1 / 30);
    expect(new CfrClock(60).frameDuration).toBe(1 / 60);
  });

  it('framesDue floors elapsed to whole grid slots (monotonic)', () => {
    const c = new CfrClock(FPS);
    expect(c.framesDue(0)).toBe(0);
    expect(c.framesDue(1 / 30 - 0.0001)).toBe(0);
    expect(c.framesDue(1 / 30)).toBe(1);
    expect(c.framesDue(2 / 30)).toBe(2);
    expect(c.framesDue(1)).toBe(30);
    // Monotonic non-decreasing as elapsed grows.
    let prev = 0;
    for (let ms = 0; ms <= 2000; ms += 7) {
      const due = c.framesDue(ms / 1000);
      expect(due).toBeGreaterThanOrEqual(prev);
      prev = due;
    }
  });

  it('rejects a non-positive fps', () => {
    expect(() => new CfrClock(0)).toThrow();
    expect(() => new CfrClock(-5)).toThrow();
  });
});

describe('planCfrEmit — drop/duplicate to the grid', () => {
  it('emits exactly ONE frame when on pace', () => {
    const c = new CfrClock(FPS);
    // 1 frame emitted, elapsed at 2/30 → grid wants 2 → emit index 1.
    expect(planCfrEmit(c, 1, 2 / 30)).toEqual([1]);
  });

  it('emits NOTHING when ahead of the grid (fast machine — no collision)', () => {
    const c = new CfrClock(FPS);
    // Already emitted 3 frames but only 2 grid slots are due → skip.
    expect(planCfrEmit(c, 3, 2 / 30)).toEqual([]);
    // Exactly on the grid (due === emitted) → also skip (no second frame in slot).
    expect(planCfrEmit(c, 2, 2 / 30)).toEqual([]);
  });

  it('catches up (duplicates) when behind, BOUNDED by maxCatchup', () => {
    const c = new CfrClock(FPS);
    // 0 emitted, elapsed at 10/30 → grid wants 10. With default maxCatchup=2 we
    // emit at most 1+2 = 3 frames this tick (indices 0,1,2), not all 10.
    expect(planCfrEmit(c, 0, 10 / 30)).toEqual([0, 1, 2]);
    // A bigger bound emits more.
    expect(planCfrEmit(c, 0, 10 / 30, 4)).toEqual([0, 1, 2, 3, 4]);
    // maxCatchup=0 → at most one frame even when far behind.
    expect(planCfrEmit(c, 0, 10 / 30, 0)).toEqual([0]);
  });

  it('returns contiguous indices starting at `emitted`', () => {
    const c = new CfrClock(FPS);
    const out = planCfrEmit(c, 7, 9 / 30); // wants 9, behind by 2 → [7,8]
    expect(out).toEqual([7, 8]);
  });
});

describe('CFR regression net — jittery rAF input yields an EVEN grid', () => {
  it('produces strictly increasing, evenly-spaced PTS with NO dup + NO gap', () => {
    const c = new CfrClock(FPS);
    // Simulate a realistic rAF timestamp sequence: nominal ~33.3 ms steps with
    // heavy jitter — some ticks fast (>30 Hz), some slow (a hitch). This is the
    // exact input shape that produced wall-clock slow-mo before the fix.
    const jitterMs = [
      0, 10, 22, 33, 33, 40, 70, 80, 90, 130, 133, 140, 200, 205, 210, 215, 250,
      300, 340, 380, 400, 433, 470, 500, 800, 833, 870, 900, 933, 1000,
    ];
    const emittedPts: number[] = [];
    let emitted = 0;
    for (const ms of jitterMs) {
      const plan = planCfrEmit(c, emitted, ms / 1000);
      for (const idx of plan) {
        emittedPts.push(c.ptsForFrame(idx));
        emitted++;
      }
    }

    // (a) at least one frame landed.
    expect(emittedPts.length).toBeGreaterThan(0);
    // (b) strictly increasing — NO duplicate PTS (the collision/0-duration bug).
    for (let i = 1; i < emittedPts.length; i++) {
      expect(emittedPts[i]).toBeGreaterThan(emittedPts[i - 1]);
    }
    // (c) EVEN grid — every step is exactly 1/fps (NO sparse/slow-mo stretch).
    for (let i = 1; i < emittedPts.length; i++) {
      expect(emittedPts[i] - emittedPts[i - 1]).toBeCloseTo(1 / 30, 9);
    }
    // (d) the indices are 0,1,2,…,N-1 (a dense grid, no holes).
    emittedPts.forEach((pts, i) => expect(pts).toBeCloseTo(i / 30, 9));
  });

  it('never emits two frames in the same grid slot on a SUSTAINED fast machine', () => {
    const c = new CfrClock(FPS);
    // 120 Hz rAF (8.33 ms steps) for ~0.5 s → only ~15 grid frames should emit.
    let emitted = 0;
    const seen = new Set<number>();
    for (let ms = 0; ms <= 500; ms += 8.333) {
      const plan = planCfrEmit(c, emitted, ms / 1000);
      for (const idx of plan) {
        expect(seen.has(idx)).toBe(false); // no slot reused
        seen.add(idx);
        emitted++;
      }
    }
    // ~15 frames over 0.5 s @ 30 fps (not the ~60 a per-rAF emit would make).
    expect(emitted).toBeGreaterThanOrEqual(14);
    expect(emitted).toBeLessThanOrEqual(16);
  });
});
