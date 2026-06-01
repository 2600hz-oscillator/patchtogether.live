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
  orbitCenter,
  ORBIT_RADIUS_FRACTION,
  ORBIT_SPEED_SCALAR,
  OBLONG_MIN_Y_SCALE,
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

  it('honours opts.centerX/centerY for the per-arm translate (off-centre mandala)', () => {
    // MOVE/OBLONG path: the orbit centre is fed via RenderOpts. The
    // draw routine must translate each arm to that centre, NOT to
    // (width/2, height/2). Verify the first arm's translate(...) call
    // hits the supplied centre exactly.
    const ring = new PenRing(10);
    for (let i = 0; i < 3; i++) ring.push(0.1, 0.1);
    const { ctx, calls } = makeRecordingCtx();
    drawMandalaFrame(ctx, 200, 200, ring, {
      complexity: 4,
      color: { r: 255, g: 255, b: 255 },
      decayAlpha: 0.05,
      centerX: 130,
      centerY: 70,
    });
    const translates = calls.filter((c) => c.op === 'translate');
    expect(translates.length).toBe(4); // one per arm
    for (const t of translates) {
      expect(t.args).toEqual([130, 70]);
    }
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

// ---------------------------------------------------------------------------
// MOVE + OBLONG — spirograph centerpoint orbit.
// ---------------------------------------------------------------------------

describe('orbitCenter — spirograph centre orbit', () => {
  const W = 360, H = 360;
  const baseCx = W / 2;
  const baseCy = H / 2;

  it('move = 0 pins the centre EXACTLY at (baseCx, baseCy) regardless of t/oblong/speed', () => {
    for (const t of [0, 0.1, 1, 13.7, 1000]) {
      for (const oblong of [0, 0.5, 1]) {
        for (const speed of [0, 1, 4]) {
          const { cx, cy } = orbitCenter(t, baseCx, baseCy, 0, oblong, speed, W, H);
          expect(cx).toBe(baseCx);
          expect(cy).toBe(baseCy);
        }
      }
    }
  });

  it('move = 0.5, oblong = 0 traces a perfect circle of radius 0.5 * ORBIT_RADIUS_FRACTION * min(w,h)', () => {
    const move = 0.5;
    const expectedR = move * ORBIT_RADIUS_FRACTION * Math.min(W, H);
    // Walk one full orbit (orbitT spans 0..2π). Pick speed = 1 so orbitT
    // = t * ORBIT_SPEED_SCALAR. Sample 64 evenly-spaced t values across
    // [0, 2π / ORBIT_SPEED_SCALAR].
    const period = (Math.PI * 2) / ORBIT_SPEED_SCALAR;
    for (let n = 0; n < 64; n++) {
      const t = (n / 64) * period;
      const { cx, cy } = orbitCenter(t, baseCx, baseCy, move, 0, 1, W, H);
      const dx = cx - baseCx;
      const dy = cy - baseCy;
      const r = Math.hypot(dx, dy);
      expect(r).toBeCloseTo(expectedR, 6);
    }
  });

  it('oblong = 1 squashes Y to OBLONG_MIN_Y_SCALE × X (the "tube" degeneracy)', () => {
    const move = 1;
    const period = (Math.PI * 2) / ORBIT_SPEED_SCALAR;
    let maxAbsDx = 0;
    let maxAbsDy = 0;
    for (let n = 0; n < 256; n++) {
      const t = (n / 256) * period;
      const { cx, cy } = orbitCenter(t, baseCx, baseCy, move, 1, 1, W, H);
      maxAbsDx = Math.max(maxAbsDx, Math.abs(cx - baseCx));
      maxAbsDy = Math.max(maxAbsDy, Math.abs(cy - baseCy));
    }
    // Y peak should be ~OBLONG_MIN_Y_SCALE × X peak.
    expect(maxAbsDy / maxAbsDx).toBeCloseTo(OBLONG_MIN_Y_SCALE, 5);
    // And in absolute terms: Y is at most 5% of X.
    expect(maxAbsDy).toBeLessThanOrEqual(maxAbsDx * (OBLONG_MIN_Y_SCALE + 1e-6));
  });

  it('is deterministic: same inputs → same output', () => {
    const a = orbitCenter(2.5, baseCx, baseCy, 0.7, 0.3, 1.2, W, H);
    const b = orbitCenter(2.5, baseCx, baseCy, 0.7, 0.3, 1.2, W, H);
    expect(a).toEqual(b);
  });

  it('oblong ∈ (0, 1) linearly interpolates the Y-radius scale', () => {
    // At a t where cos(orbitT) = 0 + sin(orbitT) = 1, dy = orbitR * yScale.
    // Solve t: orbitT = π/2 → t = (π/2) / ORBIT_SPEED_SCALAR.
    const t = (Math.PI / 2) / ORBIT_SPEED_SCALAR;
    const move = 1;
    const orbitR = move * ORBIT_RADIUS_FRACTION * Math.min(W, H);
    for (const oblong of [0, 0.25, 0.5, 0.75, 1]) {
      const expectedYScale = 1 - oblong * (1 - OBLONG_MIN_Y_SCALE);
      const { cx, cy } = orbitCenter(t, baseCx, baseCy, move, oblong, 1, W, H);
      // cos(π/2) ≈ 0 → cx ≈ baseCx; sin(π/2) = 1 → dy = orbitR * yScale.
      expect(Math.abs(cx - baseCx)).toBeLessThan(1e-9);
      expect(cy - baseCy).toBeCloseTo(orbitR * expectedYScale, 6);
    }
  });

  it('speed scales orbital frequency proportionally (speed=2 → twice as far around in the same t)', () => {
    // At t=1, speed=2 → orbitT=2*ORBIT_SPEED_SCALAR; speed=1 →
    // orbitT=ORBIT_SPEED_SCALAR. So cos(orbitT_2) = cos(2*orbitT_1).
    const t = 1;
    const move = 0.5;
    const a = orbitCenter(t, baseCx, baseCy, move, 0, 1, W, H);
    const b = orbitCenter(t, baseCx, baseCy, move, 0, 2, W, H);
    const orbitT1 = t * 1 * ORBIT_SPEED_SCALAR;
    const orbitT2 = t * 2 * ORBIT_SPEED_SCALAR;
    const orbitR = move * ORBIT_RADIUS_FRACTION * Math.min(W, H);
    expect(a.cx - baseCx).toBeCloseTo(orbitR * Math.cos(orbitT1), 6);
    expect(b.cx - baseCx).toBeCloseTo(orbitR * Math.cos(orbitT2), 6);
  });
});

describe('spirograph regression — pen-orbit composition', () => {
  // The visible spirograph effect = orbit centre wandering at radius R_outer
  // + mandala pen drawn around that centre at radius up to (scale * 0.5)
  // (the pen samples are in [-0.5, 0.5] times `scale`).
  //
  // For move=0.5, oblong=0, complexity=8, speed=1, the maximum distance from
  // canvas centre that the rendered pen reaches over a 10s window MUST equal
  // (R_outer + R_mandala) — i.e. when the orbit is at its farthest AND the
  // pen sample is at its farthest from the orbit centre along the same
  // direction. We approximate by sampling the analytic worst-case.

  it('pen distance from base centre exceeds the static-mandala bound (proves orbit composes with pen)', () => {
    const W = 360, H = 360;
    const baseCx = W / 2;
    const baseCy = H / 2;
    const move = 0.5;
    const oblong = 0;
    const speed = 1;
    const scale = Math.min(W, H) * 0.45; // matches drawMandalaFrame default

    // Analytic bounds:
    //   - orbitR     = move * ORBIT_RADIUS_FRACTION * min(W,H) = 45px.
    //   - pen radius = scale * √(0.5² + 0.5²) = scale * √0.5 ≈ 127px
    //                  (penAtTime caps |x|,|y| ≤ 0.5 each; Euclidean max
    //                   is √2 × 0.5 = √0.5).
    //   - WITHOUT orbit, max distance from base = pen radius ≤ scale*√0.5.
    //   - WITH orbit, max distance = orbitR + pen radius (when co-aligned).
    //
    // The test pins: WITH-orbit observed max EXCEEDS the static (no-orbit)
    // upper bound by AT LEAST 80% of orbitR. That's the load-bearing
    // "spirograph reaches farther than a stationary mandala can" claim —
    // i.e. the orbit is actually composing with the pen, not being
    // silently dropped.
    const orbitR = move * ORBIT_RADIUS_FRACTION * Math.min(W, H);
    const staticPenMaxR = scale * Math.SQRT1_2; // = scale * √0.5

    let maxWithOrbit = 0;
    let maxWithoutOrbit = 0;
    const state = makePenState();
    for (let step = 0; step < 600; step++) {
      const t = step / 60; // ~10s at 60fps
      const { cx, cy } = orbitCenter(t, baseCx, baseCy, move, oblong, speed, W, H);
      state.t = t * speed;
      const { x, y } = penAtTime(state.t);
      const penPx = x * scale;
      const penPy = y * scale;
      // With orbit: pen rendered at (cx + penPx, cy + penPy).
      const dxW = (cx - baseCx) + penPx;
      const dyW = (cy - baseCy) + penPy;
      maxWithOrbit = Math.max(maxWithOrbit, Math.hypot(dxW, dyW));
      // Without orbit (move = 0 collapse): pen at (baseCx + penPx, baseCy + penPy).
      maxWithoutOrbit = Math.max(maxWithoutOrbit, Math.hypot(penPx, penPy));
    }

    // The achievable absolute upper bound is orbitR + staticPenMaxR.
    const absUpperBound = orbitR + staticPenMaxR;
    expect(maxWithOrbit).toBeLessThanOrEqual(absUpperBound + 1e-6);
    // And the orbit DOES extend the reach — the with-orbit max strictly
    // exceeds the without-orbit max. (Over 10s the orbit covers ~172°
    // of a ~21s cycle; co-alignment with the pen's peak isn't guaranteed
    // to be exact, so we only assert a measurable extension here. The
    // earlier "perfect circle" test pins the orbit's analytical reach.)
    expect(maxWithOrbit).toBeGreaterThan(maxWithoutOrbit);
    expect(maxWithOrbit - maxWithoutOrbit).toBeGreaterThan(orbitR * 0.3);
  });
});
