// packages/web/src/lib/video/modules/peakstate-draw.test.ts
//
// Pure-TS tests for PEAKSTATE's algorithmic core: pen trajectory,
// ring buffer determinism, HSL hue-cycle ratios, and the per-arm
// segment-count formula that drives the kaleidoscope's mirror symmetry.

import { describe, it, expect } from 'vitest';
import {
  penAtTime,
  PenRing,
  makePenState,
  advancePen,
  hueAtTime,
  hslToRgb,
  expectedSegmentCount,
  drawMandalaFrame,
  PEN_TRAIL_CAPACITY,
  type Ctx2D,
} from './peakstate-draw';

describe('penAtTime — pen trajectory', () => {
  it('is deterministic for the same t', () => {
    const a = penAtTime(1.234);
    const b = penAtTime(1.234);
    expect(a).toEqual(b);
  });

  it('stays within the centred unit disc [-0.5, 0.5] for any t', () => {
    // Sample 200 points over a wide t range — the formula is bounded by
    // 0.5 by construction (sin/cos amplitudes capped at 0.5), so every
    // sample must land in [-0.5, 0.5].
    for (let i = 0; i < 200; i++) {
      const t = i * 0.137;
      const { x, y } = penAtTime(t);
      expect(x).toBeGreaterThanOrEqual(-0.5);
      expect(x).toBeLessThanOrEqual(0.5);
      expect(y).toBeGreaterThanOrEqual(-0.5);
      expect(y).toBeLessThanOrEqual(0.5);
    }
  });

  it('different t values give different positions (sampled)', () => {
    const a = penAtTime(0);
    const b = penAtTime(1);
    // Some difference somewhere — the trajectory isn't trivial.
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(0.05);
  });
});

describe('PenRing — fixed-capacity circular buffer', () => {
  it('starts empty', () => {
    const r = new PenRing(8);
    expect(r.length).toBe(0);
  });

  it('grows up to capacity then pins', () => {
    const r = new PenRing(4);
    for (let i = 0; i < 10; i++) r.push(i, i);
    expect(r.length).toBe(4);
  });

  it('forEachChronological yields oldest-first under wrap', () => {
    const r = new PenRing(3);
    r.push(1, 1); r.push(2, 2); r.push(3, 3); // [1,2,3]
    r.push(4, 4); // wrap: ring now holds 2,3,4
    const seen: number[] = [];
    r.forEachChronological((_i, x) => seen.push(x));
    expect(seen).toEqual([2, 3, 4]);
  });

  it('default capacity is the documented trail length', () => {
    const r = new PenRing();
    expect(r.capacity).toBe(PEN_TRAIL_CAPACITY);
  });

  it('reset returns to empty + zero cursor', () => {
    const r = new PenRing(4);
    r.push(7, 7); r.push(8, 8);
    r.reset();
    expect(r.length).toBe(0);
    expect(r.cursor).toBe(0);
  });
});

describe('advancePen — deterministic ring-buffer build', () => {
  it('advancing by the same (dt, speed) sequence produces the same ring contents', () => {
    const a = makePenState();
    const b = makePenState();
    const steps = [
      [1 / 60, 1.0],
      [1 / 60, 1.0],
      [1 / 60, 2.0],
      [1 / 60, 0.5],
      [1 / 60, 1.0],
    ] as const;
    for (const [dt, sp] of steps) {
      advancePen(a, dt, sp);
      advancePen(b, dt, sp);
    }
    expect(a.t).toBe(b.t);
    expect(a.ring.length).toBe(b.ring.length);
    for (let i = 0; i < a.ring.length; i++) {
      expect(a.ring.buf[i * 2]).toBe(b.ring.buf[i * 2]);
      expect(a.ring.buf[i * 2 + 1]).toBe(b.ring.buf[i * 2 + 1]);
    }
  });

  it('speed = 0 freezes the pen (ring grows but every sample equals penAtTime(0))', () => {
    const s = makePenState();
    for (let i = 0; i < 10; i++) advancePen(s, 1 / 60, 0);
    const expected = penAtTime(0);
    // Float32Array storage truncates ~7 digits; assert at f32 precision.
    s.ring.forEachChronological((_i, x, y) => {
      expect(x).toBeCloseTo(expected.x, 6);
      expect(y).toBeCloseTo(expected.y, 6);
    });
  });

  it('speed = 2 advances t twice as fast as speed = 1 over the same dt window', () => {
    const a = makePenState();
    const b = makePenState();
    for (let i = 0; i < 10; i++) {
      advancePen(a, 1 / 60, 1);
      advancePen(b, 1 / 60, 2);
    }
    expect(b.t).toBeCloseTo(a.t * 2, 10);
  });
});

describe('hueAtTime — colour-cycle rate', () => {
  it('returns 0 at t = 0 regardless of color_speed', () => {
    expect(hueAtTime(0, 0)).toBe(0);
    expect(hueAtTime(0, 1)).toBe(0);
    expect(hueAtTime(0, 4)).toBe(0);
  });

  it('color_speed = 2 produces twice the hue rotation of color_speed = 1 over the same window (mod 360)', () => {
    // Choose a t small enough that 2t * 60 stays under 360 — the
    // wraparound would muddy the comparison otherwise.
    const t = 1.5;
    const h1 = hueAtTime(t, 1); // = 90
    const h2 = hueAtTime(t, 2); // = 180
    expect(h1).toBeCloseTo(90, 5);
    expect(h2).toBeCloseTo(180, 5);
    expect(h2 / h1).toBeCloseTo(2, 5);
  });

  it('wraps modulo 360', () => {
    // t * 60 = 600 → mod 360 = 240
    expect(hueAtTime(10, 1)).toBeCloseTo(240, 5);
  });
});

describe('hslToRgb — sanity', () => {
  it('hue 0, sat 1, lum 0.5 → pure red', () => {
    const c = hslToRgb(0, 1, 0.5);
    expect(c).toEqual({ r: 255, g: 0, b: 0 });
  });

  it('hue 120, sat 1, lum 0.5 → pure green', () => {
    const c = hslToRgb(120, 1, 0.5);
    expect(c).toEqual({ r: 0, g: 255, b: 0 });
  });

  it('hue 240, sat 1, lum 0.5 → pure blue', () => {
    const c = hslToRgb(240, 1, 0.5);
    expect(c).toEqual({ r: 0, g: 0, b: 255 });
  });
});

describe('expectedSegmentCount — kaleidoscope mirror symmetry', () => {
  it('returns 0 when fewer than 2 ring samples exist', () => {
    expect(expectedSegmentCount(0, 8)).toBe(0);
    expect(expectedSegmentCount(1, 8)).toBe(0);
  });

  it('complexity = 4 produces 4× the segment count of complexity = 1', () => {
    // Same ring length, same mirror-twin behaviour → segments scale
    // linearly with the arm count.
    const ringLen = 100;
    const c1 = expectedSegmentCount(ringLen, 1);
    const c4 = expectedSegmentCount(ringLen, 4);
    expect(c4).toBe(c1 * 4);
  });

  it('complexity = 4 specifically: 2 polylines × 4 arms × (N-1) segments', () => {
    expect(expectedSegmentCount(100, 4)).toBe(2 * 4 * 99);
  });
});

// ---------- Mock 2D context for drawMandalaFrame ----------
//
// Recording-only Ctx2D so we can verify drawMandalaFrame's segment emission
// matches the kaleidoscope geometry without a real canvas.
interface RecordedCall { op: string; args: number[]; }
function makeRecordingCtx(): { ctx: Ctx2D; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const ctx: Ctx2D = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineCap: 'butt',
    lineJoin: 'miter',
    globalAlpha: 1,
    fillRect(x, y, w, h)    { calls.push({ op: 'fillRect',   args: [x, y, w, h] }); },
    beginPath()             { calls.push({ op: 'beginPath',  args: [] }); },
    moveTo(x, y)            { calls.push({ op: 'moveTo',     args: [x, y] }); },
    lineTo(x, y)            { calls.push({ op: 'lineTo',     args: [x, y] }); },
    stroke()                { calls.push({ op: 'stroke',     args: [] }); },
    save()                  { calls.push({ op: 'save',       args: [] }); },
    restore()               { calls.push({ op: 'restore',    args: [] }); },
    translate(x, y)         { calls.push({ op: 'translate',  args: [x, y] }); },
    rotate(a)               { calls.push({ op: 'rotate',     args: [a] }); },
    scale(x, y)             { calls.push({ op: 'scale',      args: [x, y] }); },
  };
  return { ctx, calls };
}

describe('drawMandalaFrame — kaleidoscope render', () => {
  it('clears with one translucent fillRect even on empty ring', () => {
    const { ctx, calls } = makeRecordingCtx();
    const ring = new PenRing(4);
    drawMandalaFrame(ctx, 200, 200, ring, {
      complexity: 8, color: { r: 255, g: 255, b: 255 }, decayAlpha: 0.05,
    });
    const fills = calls.filter((c) => c.op === 'fillRect');
    expect(fills.length).toBe(1);
    expect(fills[0]!.args).toEqual([0, 0, 200, 200]);
  });

  it('emits 2× complexity polylines (one per arm + mirror) when ring has samples', () => {
    const ring = new PenRing(10);
    for (let i = 0; i < 5; i++) ring.push(0.1 * i, 0.1 * i);
    const { ctx, calls } = makeRecordingCtx();
    drawMandalaFrame(ctx, 200, 200, ring, {
      complexity: 4, color: { r: 255, g: 255, b: 255 }, decayAlpha: 0.05,
    });
    const strokes = calls.filter((c) => c.op === 'stroke').length;
    // 4 arms × 2 polylines (arm + mirror).
    expect(strokes).toBe(8);
  });

  it('emits expectedSegmentCount lineTo calls (1 fewer than ring samples per polyline)', () => {
    const ring = new PenRing(10);
    for (let i = 0; i < 5; i++) ring.push(0.1 * i, 0.05 * i);
    const { ctx, calls } = makeRecordingCtx();
    drawMandalaFrame(ctx, 200, 200, ring, {
      complexity: 4, color: { r: 255, g: 255, b: 255 }, decayAlpha: 0.05,
    });
    const lineTos = calls.filter((c) => c.op === 'lineTo').length;
    expect(lineTos).toBe(expectedSegmentCount(5, 4));
  });

  it('emits one save/translate/rotate/restore TRIPLET per arm', () => {
    const ring = new PenRing(10);
    for (let i = 0; i < 3; i++) ring.push(0.1, 0.1);
    const { ctx, calls } = makeRecordingCtx();
    drawMandalaFrame(ctx, 200, 200, ring, {
      complexity: 6, color: { r: 255, g: 255, b: 255 }, decayAlpha: 0.05,
    });
    const saves    = calls.filter((c) => c.op === 'save').length;
    const restores = calls.filter((c) => c.op === 'restore').length;
    const rotates  = calls.filter((c) => c.op === 'rotate').length;
    expect(saves).toBe(6);
    expect(restores).toBe(6);
    expect(rotates).toBe(6);
  });

  it('higher complexity → MORE arms (proven by save/restore count)', () => {
    const ring = new PenRing(10);
    for (let i = 0; i < 3; i++) ring.push(0.1, 0.1);
    const c4 = makeRecordingCtx();
    drawMandalaFrame(c4.ctx, 200, 200, ring, {
      complexity: 4, color: { r: 255, g: 255, b: 255 }, decayAlpha: 0.05,
    });
    const c16 = makeRecordingCtx();
    drawMandalaFrame(c16.ctx, 200, 200, ring, {
      complexity: 16, color: { r: 255, g: 255, b: 255 }, decayAlpha: 0.05,
    });
    expect(c4.calls.filter((c) => c.op === 'save').length).toBe(4);
    expect(c16.calls.filter((c) => c.op === 'save').length).toBe(16);
  });
});
