// packages/web/src/lib/video/modules/spirographs.test.ts
//
// SPIROGRAPHS — pure curve + motion math tests (GPU-free). This is the
// correctness core: the hypotrochoid / epitrochoid point functions, the
// revolutions-to-close derivation, and the bounding-box center
// constrain/reflect (roll/bounce). Deterministic — no canvas, no GL.

import { describe, it, expect } from 'vitest';
import {
  hypotrochoid,
  epitrochoid,
  spiroPoint,
  gcdInt,
  revolutionsToClose,
  curveMaxReach,
  reflectIntoBand,
  advanceCenter,
  sampleSpiro,
  REVS_MAX_DEFAULT,
  type CenterState,
  type SpiroParams,
} from './spirographs-math';

// Side-effect import: registers the def so the module-level metadata assertions
// below run against the real registry shape.
import '$lib/video/modules';
import { getVideoModuleDef } from '$lib/video/module-registry';
import {
  spiroParamId,
  SPIRO_PARAM_STEMS,
  SPIRO_COUNT_MAX,
} from './spirographs';
import {
  drawOverlapScene,
  OVERLAP_STROKE_GRAY,
  type ResolvedSpiro,
} from './spirographs-draw';

const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

describe('trochoid point functions', () => {
  it('hypotrochoid at t=0 sits on the +x axis at (R−r)+p', () => {
    // x = (R−r)cos0 + p cos0 = (R−r)+p ; y = (R−r)sin0 − p sin0 = 0
    const pt = hypotrochoid(5, 3, 2, 0);
    expect(close(pt.x, (5 - 3) + 2)).toBe(true);
    expect(close(pt.y, 0)).toBe(true);
  });

  it('epitrochoid at t=0 sits on the +x axis at (R+r)−p', () => {
    // x = (R+r)cos0 − p cos0 = (R+r)−p ; y = (R+r)sin0 − p sin0 = 0
    const pt = epitrochoid(5, 3, 2, 0);
    expect(close(pt.x, (5 + 3) - 2)).toBe(true);
    expect(close(pt.y, 0)).toBe(true);
  });

  it('hypotrochoid matches the closed-form formula at an arbitrary t', () => {
    const R = 7, r = 3, p = 2.5, t = 1.234;
    const d = R - r;
    const k = d / r;
    const expX = d * Math.cos(t) + p * Math.cos(k * t);
    const expY = d * Math.sin(t) - p * Math.sin(k * t);
    const pt = hypotrochoid(R, r, p, t);
    expect(close(pt.x, expX)).toBe(true);
    expect(close(pt.y, expY)).toBe(true);
  });

  it('epitrochoid matches the closed-form formula at an arbitrary t', () => {
    const R = 6, r = 2, p = 1.5, t = 2.345;
    const d = R + r;
    const k = d / r;
    const expX = d * Math.cos(t) - p * Math.cos(k * t);
    const expY = d * Math.sin(t) - p * Math.sin(k * t);
    const pt = epitrochoid(R, r, p, t);
    expect(close(pt.x, expX)).toBe(true);
    expect(close(pt.y, expY)).toBe(true);
  });

  it('spiroPoint dispatches kind correctly', () => {
    const inside = spiroPoint('inside', 5, 3, 2, 0.7);
    const outside = spiroPoint('outside', 5, 3, 2, 0.7);
    expect(inside).toEqual(hypotrochoid(5, 3, 2, 0.7));
    expect(outside).toEqual(epitrochoid(5, 3, 2, 0.7));
    // The two families differ for the same args.
    expect(close(inside.x, outside.x)).toBe(false);
  });

  it('r=0 is guarded (finite point, no NaN/Infinity)', () => {
    const a = hypotrochoid(5, 0, 2, 1.0);
    const b = epitrochoid(5, 0, 2, 1.0);
    expect(Number.isFinite(a.x) && Number.isFinite(a.y)).toBe(true);
    expect(Number.isFinite(b.x) && Number.isFinite(b.y)).toBe(true);
  });

  it('curve is periodic after revolutionsToClose × 2π (closes on itself)', () => {
    // For an integer ratio the figure returns exactly to its start after the
    // closing number of revolutions.
    const R = 10, r = 4, p = 2; // 10:4 = 5:2 → 2 revolutions
    const revs = revolutionsToClose(R, r);
    const start = hypotrochoid(R, r, p, 0);
    const end = hypotrochoid(R, r, p, revs * 2 * Math.PI);
    expect(close(start.x, end.x, 1e-6)).toBe(true);
    expect(close(start.y, end.y, 1e-6)).toBe(true);
  });
});

describe('gcdInt', () => {
  it('computes the gcd of integers', () => {
    expect(gcdInt(12, 8)).toBe(4);
    expect(gcdInt(10, 4)).toBe(2);
    expect(gcdInt(7, 3)).toBe(1);
    expect(gcdInt(9, 0)).toBe(9);
    expect(gcdInt(0, 0)).toBe(0);
  });
  it('is sign- and order-insensitive', () => {
    expect(gcdInt(-12, 8)).toBe(4);
    expect(gcdInt(8, 12)).toBe(4);
  });
});

describe('revolutionsToClose', () => {
  it('reduces R:r and returns the reduced rolling-radius denominator', () => {
    expect(revolutionsToClose(10, 4)).toBe(2);  // 5:2 → 2
    expect(revolutionsToClose(7, 3)).toBe(3);   // already lowest → 3
    expect(revolutionsToClose(6, 2)).toBe(1);   // 3:1 → 1
    expect(revolutionsToClose(8, 6)).toBe(3);   // 4:3 → 3
    expect(revolutionsToClose(9, 3)).toBe(1);   // 3:1 → 1
  });

  it('handles fractional radii by quantising onto a fine grid', () => {
    // 2.5:1.0 reduces like 5:2 → 2 revolutions.
    expect(revolutionsToClose(2.5, 1.0)).toBe(2);
    // 5.0:2.5 = 2:1 → 1 revolution.
    expect(revolutionsToClose(5.0, 2.5)).toBe(1);
  });

  it('caps irrational-ish ratios at maxRevs (dense fill, bounded)', () => {
    // An irrational-looking ratio rationalises to a huge denominator → capped.
    const revs = revolutionsToClose(Math.PI, 1, REVS_MAX_DEFAULT);
    expect(revs).toBeGreaterThan(1);
    expect(revs).toBeLessThanOrEqual(REVS_MAX_DEFAULT);
  });

  it('never returns less than 1 (degenerate inputs)', () => {
    expect(revolutionsToClose(0, 0)).toBeGreaterThanOrEqual(1);
    expect(revolutionsToClose(1, 1)).toBe(1);
    expect(revolutionsToClose(5, 0)).toBeGreaterThanOrEqual(1);
  });

  it('respects a custom maxRevs cap', () => {
    const revs = revolutionsToClose(Math.E, 1, 7);
    expect(revs).toBeLessThanOrEqual(7);
  });
});

describe('curveMaxReach', () => {
  it('hypotrochoid reach is |R−r|+|p|', () => {
    expect(close(curveMaxReach('inside', 5, 3, 2), Math.abs(5 - 3) + 2)).toBe(true);
  });
  it('epitrochoid reach is |R+r|+|p|', () => {
    expect(close(curveMaxReach('outside', 5, 3, 2), Math.abs(5 + 3) + 2)).toBe(true);
  });
});

describe('reflectIntoBand (elastic bounce fold)', () => {
  it('leaves a value already inside the band unchanged, no flip', () => {
    const { pos, flipped } = reflectIntoBand(5, 0, 10);
    expect(close(pos, 5)).toBe(true);
    expect(flipped).toBe(false);
  });

  it('reflects a value past the high wall back into the band, flipping heading', () => {
    // band [0,10], v=12 → reflect: 12 → 8, one wall hit → flipped.
    const { pos, flipped } = reflectIntoBand(12, 0, 10);
    expect(close(pos, 8)).toBe(true);
    expect(flipped).toBe(true);
  });

  it('reflects a value past the low wall back into the band, flipping heading', () => {
    // band [0,10], v=-3 → reflect across lo: -3 → 3, one wall hit → flipped.
    const { pos, flipped } = reflectIntoBand(-3, 0, 10);
    expect(close(pos, 3)).toBe(true);
    expect(flipped).toBe(true);
  });

  it('two wall hits bring the heading back to original (even reflections)', () => {
    // band [0,10], v=22: 22 → past hi (10) by 12 → 8 (1 hit) → still past? no.
    // span 10, period 20, phase = 22 % 20 = 2 (rising leg) → pos 2, reflections=floor(22/10)=2 (even) → no flip.
    const { pos, flipped } = reflectIntoBand(22, 0, 10);
    expect(close(pos, 2)).toBe(true);
    expect(flipped).toBe(false);
  });

  it('result always lands inside [lo, hi] for a wide range of inputs', () => {
    for (let v = -50; v <= 50; v += 0.37) {
      const { pos } = reflectIntoBand(v, 2, 9);
      expect(pos).toBeGreaterThanOrEqual(2 - 1e-9);
      expect(pos).toBeLessThanOrEqual(9 + 1e-9);
    }
  });

  it('degenerate band (hi ≤ lo) pins to lo', () => {
    const { pos, flipped } = reflectIntoBand(7, 5, 5);
    expect(close(pos, 5)).toBe(true);
    expect(flipped).toBe(false);
  });

  it('non-zero lo: the inset band reflects correctly', () => {
    // band [3, 7] (span 4). v=9 → 9-3=6 rel; period 8; phase 6 (>span 4) → falling
    // leg: pos = 3 + (8-6) = 5; reflections floor(6/4)=1 → odd → falling leg flip rule => flipped true.
    const { pos, flipped } = reflectIntoBand(9, 3, 7);
    expect(close(pos, 5)).toBe(true);
    expect(flipped).toBe(true);
  });
});

describe('advanceCenter (fixed circle stays in frame + bounces)', () => {
  const W = 640, H = 480;

  it('keeps the fixed circle fully inside the frame for all times', () => {
    const radius = 60;
    const base: CenterState = { x: 100, y: 90, vx: 220, vy: 170 };
    for (let t = 0; t < 30; t += 0.05) {
      const c = advanceCenter(base, radius, W, H, t);
      // The center must stay inset by `radius` on every side → the circle
      // (center±radius) never leaves [0,W]×[0,H].
      expect(c.x).toBeGreaterThanOrEqual(radius - 1e-6);
      expect(c.x).toBeLessThanOrEqual(W - radius + 1e-6);
      expect(c.y).toBeGreaterThanOrEqual(radius - 1e-6);
      expect(c.y).toBeLessThanOrEqual(H - radius + 1e-6);
    }
  });

  it('is deterministic: same inputs → same output (closed-form, no state)', () => {
    const base: CenterState = { x: 200, y: 150, vx: 90, vy: -120 };
    const a = advanceCenter(base, 40, W, H, 3.21);
    const b = advanceCenter(base, 40, W, H, 3.21);
    expect(a).toEqual(b);
  });

  it('at t=0 the center is the (constrained) home position', () => {
    const base: CenterState = { x: 300, y: 200, vx: 50, vy: 50 };
    const c = advanceCenter(base, 30, W, H, 0);
    expect(close(c.x, 300)).toBe(true);
    expect(close(c.y, 200)).toBe(true);
    // No wall hit at t=0 → velocity preserved.
    expect(c.vx).toBe(50);
    expect(c.vy).toBe(50);
  });

  it('flips an axis velocity sign after that axis bounces', () => {
    // Move right fast enough to hit the right wall before t=1.
    const base: CenterState = { x: W - 60 - 1, y: 100, vx: 200, vy: 0 };
    const c = advanceCenter(base, 60, W, H, 1.0);
    // After bouncing off the right wall, vx should be negative.
    expect(c.vx).toBeLessThan(0);
    // y axis never moved → vy unchanged.
    expect(c.vy).toBe(0);
  });

  it('a circle larger than the box on an axis pins to the box centre', () => {
    // radius 400 > W/2 → x can never satisfy [radius, W-radius]; pin to W/2.
    const base: CenterState = { x: 10, y: 100, vx: 100, vy: 100 };
    const c = advanceCenter(base, 400, W, H, 2.0);
    expect(close(c.x, W / 2)).toBe(true);
  });
});

describe('sampleSpiro', () => {
  const sp: SpiroParams = {
    kind: 'inside', R: 5, r: 3, p: 2,
    rotation: 0, scale: 10, cx: 320, cy: 240,
  };

  it('returns a closed polyline (first ≈ last point) for an integer ratio', () => {
    const pts = sampleSpiro(sp, 120);
    expect(pts.length).toBeGreaterThan(2);
    const a = pts[0]!;
    const b = pts[pts.length - 1]!;
    expect(close(a.x, b.x, 1e-3)).toBe(true);
    expect(close(a.y, b.y, 1e-3)).toBe(true);
  });

  it('bakes in center + scale (points are around cx,cy)', () => {
    const pts = sampleSpiro(sp, 60);
    // Mean of points should be near the center (a symmetric closed figure).
    let mx = 0, my = 0;
    for (const pt of pts) { mx += pt.x; my += pt.y; }
    mx /= pts.length; my /= pts.length;
    expect(Math.abs(mx - sp.cx)).toBeLessThan(20);
    expect(Math.abs(my - sp.cy)).toBeLessThan(20);
  });

  it('rotation rotates the whole figure (first point moves off the +x axis)', () => {
    const noRot = sampleSpiro({ ...sp, rotation: 0 }, 60)[0]!;
    const rot = sampleSpiro({ ...sp, rotation: Math.PI / 2 }, 60)[0]!;
    // The t=0 point is on the +x axis (relative to center) with no rotation;
    // a 90° rotation moves it onto the +y axis.
    expect(close(noRot.y, sp.cy, 1e-6)).toBe(true);   // on x-axis
    expect(close(rot.x, sp.cx, 1e-6)).toBe(true);     // rotated onto y-axis
  });
});

// Minimal Canvas2D recorder — node has no real 2D context, so we count the
// stroke ops + capture the compositing/style to assert drawOverlapScene's
// per-revolution ADDITIVE structure (what makes the overlap output count
// crossings) without a GPU/canvas.
function makeRecorderCtx() {
  const rec = { strokes: 0, composite: 'source-over', styles: [] as string[] };
  const ctx = {
    fillStyle: '', strokeStyle: '', lineJoin: '', lineCap: '', lineWidth: 0,
    globalCompositeOperation: 'source-over',
    fillRect() {}, save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {},
    stroke() {
      rec.strokes++;
      rec.composite = (ctx as { globalCompositeOperation: string }).globalCompositeOperation;
      rec.styles.push(String((ctx as { strokeStyle: string }).strokeStyle));
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, rec };
}

describe('drawOverlapScene (overlap-density accumulation)', () => {
  // 7:3 closes after 3 revolutions.
  const sp: ResolvedSpiro = {
    kind: 'inside', R: 7, r: 3, p: 2, rotation: 0, scale: 20,
    cx: 320, cy: 240, thickness: 2, hue: 0,
  };

  it('strokes each revolution as its own ADDITIVE sub-path (so crossings sum)', () => {
    const { ctx, rec } = makeRecorderCtx();
    drawOverlapScene(ctx, [sp], 640, 480, 120);
    // 3 revolutions → 3 separate additive sub-paths (a single union stroke would
    // NOT let self-crossings accumulate).
    expect(rec.strokes).toBe(3);
    expect(rec.composite).toBe('lighter');
    // Uniform low gray so N overlapping strokes sum toward white.
    const g = OVERLAP_STROKE_GRAY;
    expect(rec.styles.every((s) => s === `rgb(${g},${g},${g})`)).toBe(true);
  });

  it('accumulates proportionally more sub-paths as the spiro count grows', () => {
    const one = makeRecorderCtx();
    drawOverlapScene(one.ctx, [sp], 640, 480, 120);
    const two = makeRecorderCtx();
    drawOverlapScene(two.ctx, [sp, sp], 640, 480, 120);
    expect(two.rec.strokes).toBe(one.rec.strokes * 2);
  });
});

describe('module def metadata (registry shape + per-spiro CV wiring)', () => {
  const def = getVideoModuleDef('spirographs');

  it('is registered as a video source with a lowercase label', () => {
    expect(def).toBeDefined();
    if (!def) return;
    expect(def.domain).toBe('video');
    expect(def.label).toBe('spirographs');
    // Label must be lowercase (repo guard).
    expect(def.label).toBe(def.label.toLowerCase());
  });

  it('declares a colour OUT + a mono OUT + the cascading-rainbow OVERLAP out', () => {
    if (!def) return;
    const outIds = def.outputs.map((o) => o.id);
    expect(outIds).toEqual(expect.arrayContaining(['out', 'mono_out', 'overlap']));
    const out = def.outputs.find((o) => o.id === 'out');
    const mono = def.outputs.find((o) => o.id === 'mono_out');
    const overlap = def.outputs.find((o) => o.id === 'overlap');
    expect(out?.type).toBe('video');
    expect(mono?.type).toBe('mono-video');
    expect(overlap?.type).toBe('video');
  });

  it('has a global count param + CV', () => {
    if (!def) return;
    expect(def.params.find((p) => p.id === 'count')?.curve).toBe('discrete');
    const cv = def.inputs.find((i) => i.id === 'count');
    expect(cv?.type).toBe('cv');
    expect(cv?.paramTarget).toBe('count');
  });

  it('declares EVERY per-spiro param with a matching CV input (knob + CV each)', () => {
    if (!def) return;
    const paramIds = new Set(def.params.map((p) => p.id));
    const inputIds = new Set(def.inputs.map((i) => i.id));
    for (let i = 1; i <= SPIRO_COUNT_MAX; i++) {
      for (const stem of SPIRO_PARAM_STEMS) {
        const id = spiroParamId(i, stem);
        expect(paramIds.has(id), `param ${id}`).toBe(true);
        expect(inputIds.has(id), `cv input ${id}`).toBe(true);
        const cv = def.inputs.find((x) => x.id === id);
        expect(cv?.type).toBe('cv');
        expect(cv?.paramTarget).toBe(id);
      }
    }
  });

  it('every cv input targets a real param (no dangling paramTarget)', () => {
    if (!def) return;
    const paramIds = new Set(def.params.map((p) => p.id));
    for (const input of def.inputs) {
      if (input.type === 'cv' && input.paramTarget) {
        expect(paramIds.has(input.paramTarget), `paramTarget ${input.paramTarget}`).toBe(true);
      }
    }
  });
});
