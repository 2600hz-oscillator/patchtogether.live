// packages/web/src/lib/video/modules/backdraft.test.ts
//
// Unit tests for BACKDRAFT's pure helpers + def shape. The GL-side draw
// is covered by the e2e + VRT suites; here we pin the delay-frame
// selection, the ring tap index, the mask-combine math, and the
// param defaults/ranges.

import { describe, it, expect } from 'vitest';
import {
  BACKDRAFT_BUFFER_FRAMES,
  BACKDRAFT_FPS,
  BACKDRAFT_MAX_DELAY_MS,
  BACKDRAFT_CLOCK_BPM_AT_MAX,
  BACKDRAFT_MAX_EFFECT_SCALE,
  BACKDRAFT_MAX_FEEDBACK,
  BACKDRAFT_HALL_LO,
  BACKDRAFT_ZOOM_MIN,
  BACKDRAFT_ZOOM_MAX,
  BACKDRAFT_ROTATE_MIN,
  BACKDRAFT_ROTATE_MAX,
  BACKDRAFT_OFFSET_MIN,
  BACKDRAFT_OFFSET_MAX,
  BACKDRAFT_SHAPES,
  BACKDRAFT_SHAPE_COUNT,
  BACKDRAFT_SHAPE_RADIUS,
  BACKDRAFT_FLICKER_OPTIONS,
  BACKDRAFT_FLICKER_COUNT,
  BACKDRAFT_FLICKER_HZ,
  BACKDRAFT_FLICKER_DEPTH,
  BACKDRAFT_FLICKER_SHUTTER,
  BACKDRAFT_FLICKER_READOUT,
  BACKDRAFT_FLICKER_KNEE,
  backdraftBeatHz,
  backdraftStorageResponse,
  backdraftShoulder,
  backdraftSinc,
  backdraftFlickerTerms,
  backdraftDef,
  backdraftNextShape,
  backdraftShapeMask,
  backdraftDelayFrames,
  backdraftEffectScale,
  backdraftHallComposite,
  backdraftEffectiveDelayMs,
  backdraftFeedbackUv,
  backdraftPixelateUv,
  backdraftClockTick,
  backdraftTapIndex,
  makeBackdraftClockState,
  backdraftMirrorUv,
  backdraftMirrorGateTick,
  makeBackdraftMirrorGateState,
} from './backdraft';

describe('backdraftDelayFrames — DELAY knob (ms) → nearest ring frame', () => {
  it('0ms still taps at least 1 frame back (feedback must lag)', () => {
    expect(backdraftDelayFrames(0, BACKDRAFT_BUFFER_FRAMES)).toBe(1);
  });

  it('rounds ms to nearest whole frame at 60fps', () => {
    // 1 frame = 1000/60 ≈ 16.67ms.
    expect(backdraftDelayFrames(16.67, BACKDRAFT_BUFFER_FRAMES)).toBe(1);
    // 50ms ≈ 3 frames (50 / 16.67 = 3.0).
    expect(backdraftDelayFrames(50, BACKDRAFT_BUFFER_FRAMES)).toBe(3);
    // 33.3ms ≈ 2 frames.
    expect(backdraftDelayFrames(33.3, BACKDRAFT_BUFFER_FRAMES)).toBe(2);
  });

  it('100ms maps to ~6 frames at 60fps and fits the ring', () => {
    const f = backdraftDelayFrames(100, BACKDRAFT_BUFFER_FRAMES);
    expect(f).toBe(6); // round(100/1000*60) = 6
    expect(f).toBeLessThan(BACKDRAFT_BUFFER_FRAMES); // never aliases the head
  });

  it('max DELAY (1000ms) maps to ~60 frames at 60fps and fits the ring', () => {
    const f = backdraftDelayFrames(BACKDRAFT_MAX_DELAY_MS, BACKDRAFT_BUFFER_FRAMES);
    expect(f).toBe(60); // round(1000/1000*60) = 60
    // taps the DEEPEST available frame yet stays < ring size (never the head).
    expect(f).toBe(BACKDRAFT_BUFFER_FRAMES - 1);
    expect(f).toBeLessThan(BACKDRAFT_BUFFER_FRAMES);
  });

  it('clamps to [1, ringSize-1]', () => {
    expect(backdraftDelayFrames(99999, 8)).toBe(7);
    expect(backdraftDelayFrames(-50, 8)).toBe(1);
  });

  it('honours a custom fps', () => {
    expect(backdraftDelayFrames(100, 64, 30)).toBe(3); // round(100/1000*30) = 3
  });
});

describe('backdraftTapIndex — ring slot N frames behind head', () => {
  it('reads the slot N frames back', () => {
    const size = 8;
    expect(backdraftTapIndex(5, 1, size)).toBe(4);
    expect(backdraftTapIndex(5, 3, size)).toBe(2);
  });

  it('wraps modulo ring size', () => {
    const size = 8;
    expect(backdraftTapIndex(0, 1, size)).toBe(7);
    expect(backdraftTapIndex(2, 5, size)).toBe(5); // (2-5+8)%8
  });

  it('clamps frames so the tap never aliases the head slot', () => {
    const size = 8;
    expect(backdraftTapIndex(3, 0, size)).toBe(2);    // floor to 1
    expect(backdraftTapIndex(3, 999, size)).toBe(((3 - 7) % 8 + 8) % 8); // = 4
  });
});

describe('backdraftEffectScale — additive, order-independent mask combine', () => {
  it('neutral (no masks lit) = 1.0', () => {
    expect(backdraftEffectScale(0, 0, 1, 1)).toBeCloseTo(1.0);
  });

  it('LIGHTEN boosts the feedback effect where its mask is bright', () => {
    // full lighten mask + full knob → 1 + 1 = 2.0
    expect(backdraftEffectScale(1, 0, 1, 0)).toBeCloseTo(2.0);
    // half mask, half knob → 1 + 0.25 = 1.25
    expect(backdraftEffectScale(0.5, 0, 0.5, 0)).toBeCloseTo(1.25);
  });

  it('DARKEN reduces the feedback effect where its mask is bright', () => {
    // full darken mask + full knob → 1 - 1 = 0.0
    expect(backdraftEffectScale(0, 1, 0, 1)).toBeCloseTo(0.0);
    // half mask, half knob → 1 - 0.25 = 0.75
    expect(backdraftEffectScale(0, 0.5, 0, 0.5)).toBeCloseTo(0.75);
  });

  it('a pixel in BOTH masks applies BOTH additively, independent of order', () => {
    // lighten 0.8 (knob 1) + darken 0.3 (knob 1) → 1 + 0.8 - 0.3 = 1.5
    const a = backdraftEffectScale(0.8, 0.3, 1, 1);
    expect(a).toBeCloseTo(1.5);
    // Order-independence: swapping the additive terms gives the same result.
    const lighten = 1 * 0.8;
    const darken = 1 * 0.3;
    const forward = 1 + lighten - darken;
    const swapped = 1 - darken + lighten;
    expect(forward).toBeCloseTo(swapped);
    expect(a).toBeCloseTo(forward);
  });

  it('clamps the effect scale to [0, MAX_EFFECT_SCALE]', () => {
    // huge lighten can't exceed the ceiling
    expect(backdraftEffectScale(1, 0, 1, 0, BACKDRAFT_MAX_EFFECT_SCALE)).toBeCloseTo(2.0);
    // beyond-1 inputs would overshoot; clamp protects the ceiling
    expect(backdraftEffectScale(10, 0, 1, 0)).toBe(BACKDRAFT_MAX_EFFECT_SCALE);
    // darken can't drive it negative
    expect(backdraftEffectScale(0, 10, 0, 1)).toBe(0);
  });
});

describe('backdraftFeedbackUv — spatial feedback-tap transform', () => {
  // Helper: round-trip the centre point + a corner for clarity.
  it('identity (zoom=1, rotate=0, offset=0) returns the UV unchanged', () => {
    for (const [u, v] of [[0.5, 0.5], [0, 0], [1, 1], [0.25, 0.75]] as const) {
      const out = backdraftFeedbackUv(u, v, 1, 0, 0, 0);
      expect(out.u).toBeCloseTo(u, 6);
      expect(out.v).toBeCloseTo(v, 6);
    }
  });

  it('the centre is a FIXED POINT of zoom + rotate (no offset)', () => {
    // Zoom + rotate are "about centre", so (0.5,0.5) must map to itself.
    const z = backdraftFeedbackUv(0.5, 0.5, 1.2, 25, 0, 0);
    expect(z.u).toBeCloseTo(0.5, 6);
    expect(z.v).toBeCloseTo(0.5, 6);
  });

  it('zoom>1 samples a SMALLER region around centre (echo appears magnified)', () => {
    // We map output->source by the INVERSE; zoom>1 => source coord is
    // pulled toward centre, so the previous frame reads magnified next pass.
    const out = backdraftFeedbackUv(1, 0.5, 2, 0, 0, 0); // right edge
    // x offset from centre halves: 0.5 -> 0.25 => u = 0.75
    expect(out.u).toBeCloseTo(0.75, 6);
    expect(out.v).toBeCloseTo(0.5, 6);
  });

  it('zoom<1 samples a LARGER region around centre (echo recedes / expanding tunnel)', () => {
    const out = backdraftFeedbackUv(0.75, 0.5, 0.5, 0, 0, 0);
    // offset 0.25 from centre doubles -> 0.5 => u = 1.0
    expect(out.u).toBeCloseTo(1.0, 6);
  });

  it('rotate spins the tap about centre (90° maps +x axis to ±y)', () => {
    // Forward look rotates the image +90°; inverse un-rotates by -90°.
    // Point on +x from centre (u=1, v=0.5) -> rotates to the v axis.
    const out = backdraftFeedbackUv(1, 0.5, 1, 90, 0, 0);
    expect(out.u).toBeCloseTo(0.5, 6); // back on the centre x
    // moved 0.5 along v (sign depends on convention; magnitude is 0.5)
    expect(Math.abs(out.v - 0.5)).toBeCloseTo(0.5, 6);
  });

  it('offset translates the tap (directional trail/smear)', () => {
    // Pure offset, no zoom/rotate: source = uv - offset.
    const out = backdraftFeedbackUv(0.5, 0.5, 1, 0, 0.1, -0.05);
    expect(out.u).toBeCloseTo(0.4, 6);
    expect(out.v).toBeCloseTo(0.55, 6);
  });

  it('compounds: applying the transform N times moves the centre-relative point progressively (tunnel depth)', () => {
    // Track a point's distance-from-centre under repeated zoom<1 (inverse
    // map grows the offset each pass) — proves the geometry COMPOUNDS.
    let u = 0.6, v = 0.5; // 0.1 right of centre
    const dist0 = Math.abs(u - 0.5);
    for (let i = 0; i < 3; i++) {
      const r = backdraftFeedbackUv(u, v, 0.8, 0, 0, 0);
      u = r.u; v = r.v;
    }
    const dist3 = Math.abs(u - 0.5);
    expect(dist3).toBeGreaterThan(dist0); // grew each iteration => deepening tunnel
    expect(dist3).toBeCloseTo(dist0 / 0.8 ** 3, 6);
  });

  it('handles a zero zoom without dividing by zero (clamped)', () => {
    const out = backdraftFeedbackUv(0.6, 0.5, 0, 0, 0, 0);
    expect(Number.isFinite(out.u)).toBe(true);
    expect(Number.isFinite(out.v)).toBe(true);
  });
});

describe('backdraftPixelateUv — source-resolution reduction (grid snap)', () => {
  const RES = 512;

  it('pixelate=0 is IDENTITY (no snap → bit-identical source sampling)', () => {
    for (const [u, v] of [[0.123, 0.789], [0, 0], [1, 1], [0.5, 0.5]] as const) {
      const out = backdraftPixelateUv(u, v, 0, RES);
      // EXACTLY unchanged (===), not just close — the HARD INVARIANT.
      expect(out.u).toBe(u);
      expect(out.v).toBe(v);
    }
  });

  it('pixelate>0 snaps the UV to a coarse grid of cell centres', () => {
    // 4 cells across: centres at 0.125, 0.375, 0.625, 0.875.
    // cells = mix(res, 1, p) = 4 → solve p: 4 = res*(1-p)+p → p=(res-4)/(res-1).
    const cells = 4;
    const p = (RES - cells) / (RES - 1);
    const out = backdraftPixelateUv(0.3, 0.7, p, RES);
    // 0.3*4=1.2 → floor 1 → (1+0.5)/4 = 0.375; 0.7*4=2.8 → floor 2 → 0.625.
    expect(out.u).toBeCloseTo(0.375, 6);
    expect(out.v).toBeCloseTo(0.625, 6);
  });

  it('pixelate=1 collapses EVERY UV to the single centre cell (one colour)', () => {
    // Any UV in [0,1) → cells=1 → (floor(uv)+0.5)/1 = 0.5: the whole frame is
    // one cell. (The exact-1.0 frame boundary is measure-zero + reads the same
    // edge texel via CLAMP_TO_EDGE, so it's irrelevant to the "one colour" look.)
    for (const [u, v] of [[0.0, 0.0], [0.3, 0.7], [0.99, 0.01], [0.5, 0.5]] as const) {
      const out = backdraftPixelateUv(u, v, 1, RES);
      expect(out.u).toBeCloseTo(0.5, 6);
      expect(out.v).toBeCloseTo(0.5, 6);
    }
  });

  it('near-zero pixelate ≈ identity (cells ≈ res, sub-pixel snap)', () => {
    // A tiny pixelate snaps to a grid as fine as the source resolution, so the
    // sampled coordinate is within one source texel (1/res) of the original.
    const out = backdraftPixelateUv(0.5, 0.5, 1e-6, RES);
    expect(Math.abs(out.u - 0.5)).toBeLessThanOrEqual(1 / RES);
    expect(Math.abs(out.v - 0.5)).toBeLessThanOrEqual(1 / RES);
  });

  it('blockier as pixelate rises (cells coarsen → distant UVs share a cell)', () => {
    // The cell COUNT shrinks monotonically as pixelate rises, so two UVs that
    // land in different cells at low pixelate collapse into the SAME cell once
    // the grid is coarse enough. At p≈0.999 cells = mix(512,1,p) ≈ 1.5 → only
    // ~1 cell across, so 0.30 and 0.45 snap to the same representative colour.
    const coarse = 0.999;
    const hiA = backdraftPixelateUv(0.30, 0.30, coarse, RES);
    const hiB = backdraftPixelateUv(0.45, 0.45, coarse, RES);
    expect(hiA.u).toBeCloseTo(hiB.u, 6);
    expect(hiA.v).toBeCloseTo(hiB.v, 6);

    // Cell size grows with pixelate: the snap step (cell width) at a coarser
    // pixelate is strictly larger than at a finer one. Measure via two UVs
    // one source-texel apart and see how big the snapped jump becomes.
    const fineCells = RES * (1 - 0.2) + 0.2;      // mix(res,1,0.2)
    const coarseCells = RES * (1 - 0.9) + 0.9;    // mix(res,1,0.9)
    expect(coarseCells).toBeLessThan(fineCells);  // fewer cells = bigger blocks
  });
});

describe('backdraftClockTick — rising-edge → pulse-period measurement', () => {
  it('measures the interval between the last two rising edges', () => {
    const st = makeBackdraftClockState();
    // First rising edge at t=1.0s — no period yet (need two edges).
    expect(backdraftClockTick(st, 1, 1.0)).toBe(true);
    expect(st.periodSec).toBe(0);
    // Fall back below threshold (no edge).
    expect(backdraftClockTick(st, 0, 1.1)).toBe(false);
    // Second rising edge at t=1.25s → period = 0.25s (a 4 Hz clock).
    expect(backdraftClockTick(st, 1, 1.25)).toBe(true);
    expect(st.periodSec).toBeCloseTo(0.25, 6);
  });

  it('keeps the MOST RECENT interval on an irregular clock (stochastic)', () => {
    const st = makeBackdraftClockState();
    backdraftClockTick(st, 1, 0.0);     // edge 1
    backdraftClockTick(st, 0, 0.05);
    backdraftClockTick(st, 1, 0.10);    // edge 2 → period 0.10
    expect(st.periodSec).toBeCloseTo(0.10, 6);
    backdraftClockTick(st, 0, 0.15);
    backdraftClockTick(st, 1, 0.50);    // edge 3 → period 0.40 (latest wins)
    expect(st.periodSec).toBeCloseTo(0.40, 6);
  });

  it('uses hysteresis — a value in the dead band does not re-trigger', () => {
    const st = makeBackdraftClockState();
    backdraftClockTick(st, 1, 0.0);   // pressed
    expect(backdraftClockTick(st, 0.5, 0.1)).toBe(false); // dead band, sticky
    expect(backdraftClockTick(st, 0.5, 0.2)).toBe(false);
    expect(st.periodSec).toBe(0); // never saw a second distinct edge
  });
});

describe('backdraftEffectiveDelayMs — DELAY knob vs DELAY CLOCK override', () => {
  it('unpatched: returns the DELAY knob value (clamped to [0,1000])', () => {
    expect(backdraftEffectiveDelayMs(120, false, 0.25)).toBe(120);
    expect(backdraftEffectiveDelayMs(9999, false, 0.25)).toBe(BACKDRAFT_MAX_DELAY_MS);
    expect(backdraftEffectiveDelayMs(-5, false, 0)).toBe(0);
  });

  it('patched but no measured period yet: HOLDS the last effective delay, not the knob', () => {
    // The owner ruling: a patched clock makes the fader inert ENTIRELY. Before
    // the first measured interval the effective delay holds where it was —
    // draw() passes the previous frame's effective value as `heldMs`.
    expect(backdraftEffectiveDelayMs(80, true, 0, 250)).toBe(250);
    // A fader write while patched-and-unmeasured changes NOTHING effective.
    expect(backdraftEffectiveDelayMs(999, true, 0, 250)).toBe(250);
    // Default heldMs = the knob (pure callers with no history).
    expect(backdraftEffectiveDelayMs(80, true, 0)).toBe(80);
  });

  it('patched with a measured period: the knob is ignored entirely', () => {
    // Same period, wildly different knob positions → same effective delay.
    expect(backdraftEffectiveDelayMs(0, true, 0.25, 40)).toBeCloseTo(250, 6);
    expect(backdraftEffectiveDelayMs(1000, true, 0.25, 40)).toBeCloseTo(250, 6);
  });

  it('patched: delay = one clock-pulse duration (period sec → ms)', () => {
    // 4 Hz clock → period 0.25s → 250ms feedback delay.
    expect(backdraftEffectiveDelayMs(80, true, 0.25)).toBeCloseTo(250, 6);
    // 8 Hz clock → 125ms.
    expect(backdraftEffectiveDelayMs(80, true, 0.125)).toBeCloseTo(125, 6);
  });

  it('caps at 1000ms — one beat at 60 BPM — for slow clocks', () => {
    // 0.5 Hz clock (period 2s = 30 BPM) would be 2000ms; capped to 1000.
    expect(backdraftEffectiveDelayMs(80, true, 2.0)).toBe(BACKDRAFT_MAX_DELAY_MS);
    // Exactly 60 BPM (period 1s) lands right at the cap, uncapped.
    expect(backdraftEffectiveDelayMs(80, true, 1.0)).toBeCloseTo(1000, 6);
  });

  it('overrides the knob entirely when the clock is driving', () => {
    // knob at 16ms, but a 2 Hz clock (period 0.5s) drives 500ms.
    expect(backdraftEffectiveDelayMs(16, true, 0.5)).toBeCloseTo(500, 6);
  });
});

describe('backdraftMirrorUv — kaleidoscope fold geometry', () => {
  it('identity (both off) returns the UV unchanged', () => {
    for (const [u, v] of [[0.1, 0.2], [0.9, 0.8], [0.5, 0.5]] as const) {
      const out = backdraftMirrorUv(u, v, false, false);
      expect(out.u).toBeCloseTo(u, 6);
      expect(out.v).toBeCloseTo(v, 6);
    }
  });

  it('MIRROR X: right half becomes a mirror of the left (left unchanged)', () => {
    expect(backdraftMirrorUv(0.2, 0.3, true, false).u).toBeCloseTo(0.2, 6);
    expect(backdraftMirrorUv(0.8, 0.3, true, false).u).toBeCloseTo(0.2, 6); // 1-0.8
    expect(backdraftMirrorUv(0.8, 0.3, true, false).v).toBeCloseTo(0.3, 6); // v untouched
  });

  it('MIRROR Y: low-uv.y half becomes a mirror of the high half (visual top→bottom)', () => {
    // The fold KEEPS uv.y>=0.5 (the visual TOP) and reflects the low half via
    // (1-uv.y). e2e verified this reads as the visual top mirrored downward.
    expect(backdraftMirrorUv(0.3, 0.8, false, true).v).toBeCloseTo(0.8, 6); // high half kept
    expect(backdraftMirrorUv(0.3, 0.2, false, true).v).toBeCloseTo(0.8, 6); // low half mirrors → 1-0.2
    expect(backdraftMirrorUv(0.3, 0.2, false, true).u).toBeCloseTo(0.3, 6);
  });

  it('both on = 4-way symmetric (all quadrants map to the same source coord)', () => {
    const ref = backdraftMirrorUv(0.2, 0.8, true, true);
    for (const [u, v] of [[0.8, 0.8], [0.2, 0.2], [0.8, 0.2]] as const) {
      const q = backdraftMirrorUv(u, v, true, true);
      expect(q.u).toBeCloseTo(ref.u, 6);
      expect(q.v).toBeCloseTo(ref.v, 6);
    }
  });

  it('is idempotent on the kept half (re-folding stored output is a no-op)', () => {
    const once = backdraftMirrorUv(0.8, 0.2, true, true);
    const twice = backdraftMirrorUv(once.u, once.v, true, true);
    expect(twice.u).toBeCloseTo(once.u, 6);
    expect(twice.v).toBeCloseTo(once.v, 6);
  });
});

describe('backdraftMirrorGateTick — rising edge flips the axis', () => {
  it('fires on the rising edge with hysteresis (rise>0.6 / fall<0.4)', () => {
    const st = makeBackdraftMirrorGateState();
    expect(backdraftMirrorGateTick(st.x, 0.0)).toBe(false);
    expect(backdraftMirrorGateTick(st.x, 0.7)).toBe(true);  // rising
    expect(backdraftMirrorGateTick(st.x, 0.95)).toBe(false); // still high
    expect(backdraftMirrorGateTick(st.x, 0.5)).toBe(false);  // dead band, sticky
    expect(backdraftMirrorGateTick(st.x, 0.2)).toBe(false);  // fall
    expect(backdraftMirrorGateTick(st.x, 0.7)).toBe(true);   // next rising
  });

  it('a rising edge toggles the mirror boolean (gate-driven kaleidoscope)', () => {
    const st = makeBackdraftMirrorGateState();
    let mirrorY = 0;
    const pulse = (v: number) => {
      if (backdraftMirrorGateTick(st.y, v)) mirrorY = mirrorY >= 0.5 ? 0 : 1;
    };
    pulse(0.8); expect(mirrorY).toBe(1);
    pulse(0.0);
    pulse(0.8); expect(mirrorY).toBe(0);
  });
});

describe('backdraftNextShape — SHAPE button / shape_gate cycle', () => {
  it('cycles square→circle→pentagon→triangle→octagon→square', () => {
    expect(BACKDRAFT_SHAPE_COUNT).toBe(5);
    expect(BACKDRAFT_SHAPES).toEqual(['square', 'circle', 'pentagon', 'triangle', 'octagon']);
    let s = 0;
    const seen: number[] = [s];
    for (let i = 0; i < BACKDRAFT_SHAPE_COUNT; i++) {
      s = backdraftNextShape(s);
      seen.push(s);
    }
    // 0→1→2→3→4→0 (wraps after the last).
    expect(seen).toEqual([0, 1, 2, 3, 4, 0]);
  });

  it('rounds a fractional / out-of-range stored value before advancing', () => {
    expect(backdraftNextShape(2.4)).toBe(3);
    expect(backdraftNextShape(4)).toBe(0);     // wrap
    expect(backdraftNextShape(-1)).toBe(0);    // normalised then +1 wraps
  });
});

describe('backdraftShapeMask — geometry mask (CPU mirror of the shader)', () => {
  // 16:9-ish aspect; corners sit well outside a R=0.5 inscribed shape.
  const ASPECT = 16 / 9;

  it('SQUARE (0) is the FULL-FRAME identity — 1.0 everywhere incl. the corners', () => {
    for (const [u, v] of [[0.5, 0.5], [0, 0], [1, 1], [1, 0], [0, 1]] as const) {
      expect(backdraftShapeMask(u, v, 0, ASPECT)).toBe(1);
    }
  });

  it('CIRCLE (1) keeps the centre and CUTS the corners', () => {
    expect(backdraftShapeMask(0.5, 0.5, 1, ASPECT)).toBe(1); // centre in
    for (const [u, v] of [[0, 0], [1, 1], [1, 0], [0, 1]] as const) {
      expect(backdraftShapeMask(u, v, 1, ASPECT), `corner ${u},${v}`).toBe(0);
    }
  });

  it('the circle radius reaches the top/bottom mid-edges but not the corners', () => {
    // A point at the inscribed radius straight up (aspect-corrected y) is the
    // boundary; the very top-centre (v small) is inside, the corner is outside.
    expect(backdraftShapeMask(0.5, 0.5 - (BACKDRAFT_SHAPE_RADIUS - 0.02), 1, ASPECT)).toBe(1);
    expect(backdraftShapeMask(0.5, 0.5 - (BACKDRAFT_SHAPE_RADIUS + 0.02), 1, ASPECT)).toBe(0);
  });

  it('POLYGONS (pentagon/triangle/octagon) keep the centre + cut the far corners', () => {
    for (const shp of [2, 3, 4]) {
      expect(backdraftShapeMask(0.5, 0.5, shp, ASPECT), `centre shape ${shp}`).toBe(1);
      for (const [u, v] of [[0, 0], [1, 1], [1, 0], [0, 1]] as const) {
        expect(backdraftShapeMask(u, v, shp, ASPECT), `corner ${u},${v} shape ${shp}`).toBe(0);
      }
    }
  });

  it('cuts corners independent of aspect (square frame too)', () => {
    // Even on a 1:1 frame the corner distance (0.707) exceeds R=0.5 → cut.
    expect(backdraftShapeMask(0.5, 0.5, 1, 1)).toBe(1);
    expect(backdraftShapeMask(1, 1, 1, 1)).toBe(0);
  });
});

describe('backdraft module def — params + ports', () => {
  it('declares the expected param ranges + neutral defaults', () => {
    const byId = Object.fromEntries(backdraftDef.params.map((p) => [p.id, p]));

    expect(byId.mix).toMatchObject({ min: 0, max: 1, defaultValue: 0.5 });
    expect(byId.feedback).toMatchObject({ min: 0, max: BACKDRAFT_MAX_FEEDBACK });
    expect(byId.delay).toMatchObject({ min: 0, max: BACKDRAFT_MAX_DELAY_MS });

    // LUMA / CHROMA / R / G / B span -100%..+200% with neutral = 100% (1.0).
    for (const id of ['luma', 'chroma', 'r', 'g', 'b']) {
      expect(byId[id], id).toMatchObject({ min: -1, max: 2, defaultValue: 1.0 });
    }

    // LIGHTEN / DARKEN knobs are 0..1.
    expect(byId.lighten).toMatchObject({ min: 0, max: 1 });
    expect(byId.darken).toMatchObject({ min: 0, max: 1 });

    // PIXELATE — source-resolution reduction; 0 = identity (HARD INVARIANT).
    expect(byId.pixelate).toMatchObject({ min: 0, max: 1, defaultValue: 0 });

    // Spatial feedback transform — identity defaults so existing behaviour
    // is unchanged out of the box (no tunnel/spiral/trail at defaults).
    expect(byId.zoom).toMatchObject({ min: BACKDRAFT_ZOOM_MIN, max: BACKDRAFT_ZOOM_MAX, defaultValue: 1.0 });
    expect(byId.rotate).toMatchObject({ min: BACKDRAFT_ROTATE_MIN, max: BACKDRAFT_ROTATE_MAX, defaultValue: 0 });
    expect(byId.offsetX).toMatchObject({ min: BACKDRAFT_OFFSET_MIN, max: BACKDRAFT_OFFSET_MAX, defaultValue: 0 });
    expect(byId.offsetY).toMatchObject({ min: BACKDRAFT_OFFSET_MIN, max: BACKDRAFT_OFFSET_MAX, defaultValue: 0 });
  });

  it('exposes shape_gate / pure_geo_gate as raw (no cvScale) gate inputs + SHAPE/PURE GEO params', () => {
    for (const [port, target] of [
      ['shape_gate', 'shapeGate'],
      ['pure_geo_gate', 'pureGeoGate'],
    ] as const) {
      const g = backdraftDef.inputs.find((p) => p.id === port);
      expect(g, port).toBeDefined();
      expect(g?.type).toBe('cv');
      expect(g?.cvScale).toBeUndefined(); // gate semantics — raw passthrough
      expect(g?.paramTarget).toBe(target);
    }
    const byId = Object.fromEntries(backdraftDef.params.map((p) => [p.id, p]));
    // SHAPE is a DISCRETE selector spanning all BACKDRAFT_SHAPES; default square.
    expect(byId.shape).toMatchObject({
      min: 0,
      max: BACKDRAFT_SHAPE_COUNT - 1,
      defaultValue: 0,
      curve: 'discrete',
    });
    // PURE GEO + the synthetic gate params are 0/1, default off.
    expect(byId.pureGeo).toMatchObject({ min: 0, max: 1, defaultValue: 0 });
    expect(byId.shapeGate).toMatchObject({ min: 0, max: 1, defaultValue: 0 });
    expect(byId.pureGeoGate).toMatchObject({ min: 0, max: 1, defaultValue: 0 });
  });

  it('ring cap holds 1000ms — one beat at 60 BPM — the clock cap follows the knob', () => {
    // One beat at BACKDRAFT_CLOCK_BPM_AT_MAX IS the knob max — the identity
    // the clock override documents ("the same cap the DELAY knob uses"), so
    // the ring cap always covers what the clock can ask for. Both halves
    // doubled together on 2026-08-29 (500ms/120BPM -> 1000ms/60BPM).
    expect(BACKDRAFT_MAX_DELAY_MS).toBe(1000);
    expect(60000 / BACKDRAFT_CLOCK_BPM_AT_MAX).toBe(BACKDRAFT_MAX_DELAY_MS);
    const f = backdraftDelayFrames(BACKDRAFT_MAX_DELAY_MS, BACKDRAFT_BUFFER_FRAMES);
    expect(f).toBe(BACKDRAFT_BUFFER_FRAMES - 1);
  });

  it('ring buffer covers the max delay at the assumed frame rate', () => {
    const neededFrames = Math.round((BACKDRAFT_MAX_DELAY_MS / 1000) * BACKDRAFT_FPS);
    expect(BACKDRAFT_BUFFER_FRAMES).toBeGreaterThan(neededFrames);
  });
});

describe('backdraftHallComposite — additive ↔ ring-gated hall of mirrors', () => {
  // An interior (in-frame tap) and a ring (out-of-frame tap) sample point.
  const interiorUv = { u: 0.5, v: 0.5 };
  const ringUv = { u: -0.2, v: 0.5 };
  const src: [number, number, number] = [0.8, 0.2, 0.1]; // the live source
  const prev: [number, number, number] = [0.3, 0.6, 0.9]; // the fed-back frame

  it('HALL_LO sits in the top of the FB range, above the default feedback', () => {
    expect(BACKDRAFT_HALL_LO).toBeGreaterThan(0.5);
    expect(BACKDRAFT_HALL_LO).toBeLessThan(1);
    // default feedback 0.85 → norm 0.425, comfortably below the ramp start.
    expect(0.85 / BACKDRAFT_MAX_FEEDBACK).toBeLessThan(BACKDRAFT_HALL_LO);
  });

  it('below the ramp (default feedback) → pure additive accumulator', () => {
    const out = backdraftHallComposite({
      source: src,
      fb: prev,
      fbUv: interiorUv,
      feedback: 0.85,
      effectScale: 1,
      hasTransform: true,
    });
    // out = clamp(source + prev * feedback * 1)
    for (let i = 0; i < 3; i++) {
      expect(out[i]).toBeCloseTo(Math.min(1, src[i] + prev[i] * 0.85), 5);
    }
  });

  it('MAX feedback + transform + INTERIOR → pure feedback, ZERO source bleed', () => {
    const out = backdraftHallComposite({
      source: src,
      fb: prev,
      fbUv: interiorUv,
      feedback: BACKDRAFT_MAX_FEEDBACK,
      effectScale: 1,
      hasTransform: true,
    });
    // hallAmt = 1, interior → fb * hallGain (hallGain = clamp(0.985*1) = 0.985).
    // The flat source must NOT appear: out is a scalar multiple of prev only.
    for (let i = 0; i < 3; i++) {
      expect(out[i]).toBeCloseTo(Math.min(1, prev[i] * 0.985), 5);
    }
    // And it is provably independent of the source colour: swapping the source
    // leaves the interior pixel unchanged (the hall-of-mirrors guarantee).
    const out2 = backdraftHallComposite({
      source: [0.05, 0.95, 0.55],
      fb: prev,
      fbUv: interiorUv,
      feedback: BACKDRAFT_MAX_FEEDBACK,
      effectScale: 1,
      hasTransform: true,
    });
    for (let i = 0; i < 3; i++) expect(out2[i]).toBeCloseTo(out[i], 6);
  });

  it('MAX feedback + transform + RING → the live source enters here', () => {
    const out = backdraftHallComposite({
      source: src,
      fb: prev,
      fbUv: ringUv,
      feedback: BACKDRAFT_MAX_FEEDBACK,
      effectScale: 1,
      hasTransform: true,
    });
    // hallAmt = 1, ring → source (clamped).
    for (let i = 0; i < 3; i++) expect(out[i]).toBeCloseTo(Math.min(1, src[i]), 5);
  });

  it('IDENTITY transform at MAX feedback stays additive (no black-out)', () => {
    const out = backdraftHallComposite({
      source: src,
      fb: prev,
      fbUv: interiorUv,
      feedback: BACKDRAFT_MAX_FEEDBACK,
      effectScale: 1,
      hasTransform: false, // identity → hallAmt forced to 0
    });
    for (let i = 0; i < 3; i++) {
      expect(out[i]).toBeCloseTo(Math.min(1, src[i] + prev[i] * BACKDRAFT_MAX_FEEDBACK), 5);
    }
  });

  it('hall persistence never blows out (interior ≤ prev, < 1) even at max mask', () => {
    const out = backdraftHallComposite({
      source: src,
      fb: [1, 1, 1], // a fully bright fed-back frame
      fbUv: interiorUv,
      feedback: BACKDRAFT_MAX_FEEDBACK,
      effectScale: BACKDRAFT_MAX_EFFECT_SCALE, // lighten mask wide open
      hasTransform: true,
    });
    // hallGain is clamped to < 1 so a bright nest recedes (decays) rather than
    // saturating to a frozen white frame.
    for (let i = 0; i < 3; i++) {
      expect(out[i]).toBeLessThan(1);
      expect(out[i]).toBeCloseTo(0.985, 5);
    }
  });

  it('darken mask (effectScale=0) blanks the hall interior', () => {
    const out = backdraftHallComposite({
      source: src,
      fb: prev,
      fbUv: interiorUv,
      feedback: BACKDRAFT_MAX_FEEDBACK,
      effectScale: 0, // darken fully closed → hallGain 0
      hasTransform: true,
    });
    for (let i = 0; i < 3; i++) expect(out[i]).toBeCloseTo(0, 6);
  });
});
// ── FLICKER ─────────────────────────────────────────────────────────────
// The display's pulsed emission as the virtual camera captures it, AND what
// the camera does to it downstream. Model + sources:
// .myrobots/plans/backdraft-flicker-research-2026-07-26.md.
//
//   g(t, v) = A * [ 1 + m*sinc(f*T_e)*|H| * cos(2*pi*f*(t_n + T_e/2) + argH
//                                              + 2*pi*f*T_ro*v) ]
//   captured = shoulder(fb * g)
//
// v1 shipped only the first line, applied linearly at full depth, and read as a
// photic strobe. The two terms v2 adds — the camera's multi-frame STORAGE
// low-pass |H| and the saturating capture SHOULDER — are what make it breathe.
// Everything below pins a property the FEATURE depends on, not just a number.

describe('backdraftSinc — the boxcar response both FLICKER windows share', () => {
  it('sinc(0) = 1 (a zero-width window sees the instantaneous emission)', () => {
    expect(backdraftSinc(0)).toBe(1);
    expect(backdraftSinc(1e-12)).toBe(1);
  });

  it('sinc(n) = 0 for every nonzero integer — THE flicker-free shutter rule', () => {
    // An exposure that is a whole number of flicker periods integrates the same
    // energy every time, so it sees NO flicker at all. This is why you shoot
    // 1/50s under 50Hz mains, and it is also why v1's 180-degree shutter made
    // the 120 position perfectly dead (1/120s is exactly one 120Hz period).
    for (const n of [1, 2, 3, -1, -4]) {
      expect(backdraftSinc(n), `sinc(${n})`).toBeCloseTo(0, 12);
    }
  });

  it('is even, and decays monotonically over the first lobe', () => {
    expect(backdraftSinc(0.37)).toBeCloseTo(backdraftSinc(-0.37), 12);
    let prev = 1;
    for (let x = 0.05; x <= 0.95; x += 0.05) {
      const cur = backdraftSinc(x);
      expect(cur).toBeLessThan(prev);
      prev = cur;
    }
  });

  it('matches sin(pi x)/(pi x) at a hand-checked point', () => {
    expect(backdraftSinc(0.5)).toBeCloseTo(2 / Math.PI, 12);
  });
});

describe('backdraftBeatHz — the frequency the LOOP actually sees', () => {
  it('is zero when there is no flicker', () => {
    expect(backdraftBeatHz(0)).toBe(0);
    expect(backdraftBeatHz(50, 0)).toBe(0);
  });

  it('BELOW the camera rate there is no aliasing — the beat IS the rate', () => {
    // The 6 position: 10 virtual frames per cycle, seen directly.
    expect(backdraftBeatHz(6)).toBeCloseTo(6, 9);
    expect(backdraftBeatHz(24)).toBeCloseTo(24, 9);
  });

  it('above it, the emission ALIASES down to |f - k*f_cam|', () => {
    expect(backdraftBeatHz(50)).toBeCloseTo(10, 9);
    expect(backdraftBeatHz(60000 / 1001)).toBeCloseTo(0.06, 3);
    expect(backdraftBeatHz((2 * 60000) / 1001)).toBeCloseTo(0.12, 3);
  });

  it('an EXACT multiple of the camera rate genlocks to zero beat', () => {
    // Which is precisely the degeneracy the NTSC rates exist to avoid: a zero
    // beat means the camera samples one identical phase forever, the gain is a
    // constant, and the knob position is a dumb attenuator that never moves.
    expect(backdraftBeatHz(60)).toBeCloseTo(0, 9);
    expect(backdraftBeatHz(120)).toBeCloseTo(0, 9);
    expect(backdraftBeatHz(BACKDRAFT_FLICKER_HZ[4]!)).toBeGreaterThan(0);
    expect(backdraftBeatHz(BACKDRAFT_FLICKER_HZ[5]!)).toBeGreaterThan(0);
  });
});

describe('backdraftStorageResponse — the camera integrator v1 was missing', () => {
  // Crutchfield 1984, Appendix A p.244: the sensor's charge storage integrates
  // ~10 raster times, so "the system's frequency response should always be
  // slower than 3 Hz. And this is what is observed experimentally." A real
  // camera-into-monitor loop is bandwidth-limited by the CAMERA, which is why
  // it breathes rather than strobes. Modern CMOS deletes this, and v1 deleted
  // it too and then added a full-depth gain LFO on top.

  it('passes DC perfectly (a static image is not attenuated)', () => {
    const h = backdraftStorageResponse(0);
    expect(h.mag).toBeCloseTo(1, 12);
    expect(h.arg).toBeCloseTo(0, 12);
  });

  it('is a LOW-PASS: |H| decreases monotonically with beat frequency', () => {
    // THE load-bearing property. It is what makes the fast-beat positions
    // shimmer and the slow-beat ones breathe, using one mechanism.
    let prev = Infinity;
    for (let f = 0; f <= 30; f += 0.5) {
      const m = backdraftStorageResponse(f).mag;
      expect(m, `f=${f}`).toBeLessThanOrEqual(prev + 1e-12);
      expect(m).toBeGreaterThan(0);
      expect(m).toBeLessThanOrEqual(1 + 1e-12);
      prev = m;
    }
  });

  it('lags (never leads) — it is an integrator, not a predictor', () => {
    for (const f of [1, 6, 10, 24]) {
      expect(backdraftStorageResponse(f).arg, `f=${f}`).toBeLessThanOrEqual(0);
    }
  });

  it('reproduces Crutchfield’s few-Hz ceiling', () => {
    // -3dB (|H| = 1/sqrt2) must land low single-digit Hz, not tens of Hz.
    let cutoff = 0;
    for (let f = 0; f <= 30; f += 0.01) {
      if (backdraftStorageResponse(f).mag < Math.SQRT1_2) { cutoff = f; break; }
    }
    expect(cutoff).toBeGreaterThan(0);
    expect(cutoff, 'the loop is bandwidth-limited to a few Hz').toBeLessThan(3);
  });

  it('a non-positive tau is the identity (the term can be switched off)', () => {
    expect(backdraftStorageResponse(10, 0).mag).toBe(1);
    expect(backdraftStorageResponse(10, -1).mag).toBe(1);
  });

  it('CUTS the fast beats hard and PASSES the slow ones', () => {
    // This split is the entire v2 character design, in one assertion.
    for (const idx of [1, 2, 3]) {
      const f = backdraftFlickerTerms(idx, 0);
      expect(f.storage, `idx=${idx} fast beat is cut`).toBeLessThan(0.2);
    }
    for (const idx of [4, 5]) {
      const f = backdraftFlickerTerms(idx, 0);
      expect(f.storage, `idx=${idx} slow beat passes`).toBeGreaterThan(0.99);
    }
  });
});

describe('backdraftShoulder — the saturating capture curve', () => {
  const K = BACKDRAFT_FLICKER_KNEE;

  it('is EXACTLY the identity below the knee (midtones are untouched)', () => {
    for (const x of [0, 0.1, K / 2, K]) {
      expect(backdraftShoulder(x, K), `x=${x}`).toBe(x);
    }
  });

  it('is continuous and has unit slope AT the knee (no visible crease)', () => {
    const e = 1e-6;
    expect(backdraftShoulder(K + e, K)).toBeCloseTo(K + e, 9);
    const slope = (backdraftShoulder(K + e, K) - backdraftShoulder(K - e, K)) / (2 * e);
    expect(slope).toBeCloseTo(1, 4);
  });

  it('is monotone increasing and never reaches the ceiling', () => {
    let prev = -1;
    for (let x = 0; x <= 3; x += 0.02) {
      const y = backdraftShoulder(x, K);
      expect(y).toBeGreaterThan(prev);
      expect(y).toBeLessThan(1);
      prev = y;
    }
  });

  it('COMPRESSES: incremental gain falls as the image gets hotter', () => {
    // The anti-strobe property. A gain modulation stops moving the output where
    // the loop is already hot, so a full-field pulse becomes contour shimmer.
    // (A bare gamma/power law would NOT do this — it is scale-free.)
    const slope = (x: number): number =>
      (backdraftShoulder(x + 1e-5, K) - backdraftShoulder(x - 1e-5, K)) / 2e-5;
    let prev = Infinity;
    for (let x = K; x <= 2.5; x += 0.05) {
      const s = slope(x);
      expect(s, `x=${x}`).toBeLessThanOrEqual(prev + 1e-6);
      prev = s;
    }
    expect(slope(2.0), 'nearly saturated up top').toBeLessThan(0.1);
  });

  it('knee >= 1 is the EXACT identity — which is how OFF stays bit-identical', () => {
    for (const x of [0, 0.3, 0.9, 1.0]) expect(backdraftShoulder(x, 1)).toBe(x);
  });
});

describe('backdraftFlickerTerms — OFF is the EXACT identity', () => {
  it('index 0 disables with gain exactly 1 and depth exactly 0 (no float slop)', () => {
    // The default must be bit-identical to the pre-FLICKER path, and the shader
    // branch-gates on `enabled`. knee exactly 1 means the shoulder is the
    // identity too, so nothing downstream moves either.
    const f = backdraftFlickerTerms(0, 12.345);
    expect(f.enabled).toBe(false);
    expect(f.gain).toBe(1);
    expect(f.depth).toBe(0);
    expect(f.meanGain).toBe(1);
    expect(f.hz).toBe(0);
    expect(f.beatHz).toBe(0);
    expect(f.storage).toBe(1);
    expect(f.knee).toBe(1);
  });

  it('rounds + clamps a fractional / out-of-range index (CV or a stale patch)', () => {
    expect(backdraftFlickerTerms(0.4, 1).enabled).toBe(false);
    expect(backdraftFlickerTerms(-3, 1).enabled).toBe(false);
    expect(backdraftFlickerTerms(0.6, 1).hz).toBe(BACKDRAFT_FLICKER_HZ[1]);
    expect(backdraftFlickerTerms(99, 1).hz).toBe(
      BACKDRAFT_FLICKER_HZ[BACKDRAFT_FLICKER_COUNT - 1],
    );
  });

  it('a degenerate fps disables rather than dividing by zero', () => {
    expect(backdraftFlickerTerms(2, 1, 0).enabled).toBe(false);
    expect(backdraftFlickerTerms(2, 1, -60).enabled).toBe(false);
  });
});

describe('backdraftFlickerTerms — the BEAT against the virtual camera', () => {
  it('50Hz beats at 10Hz against the 60fps camera = a 6-frame gain cycle', () => {
    expect(backdraftBeatHz(BACKDRAFT_FLICKER_HZ[3]!)).toBeCloseTo(10, 9);
    const g = (n: number): number =>
      backdraftFlickerTerms(3, n / BACKDRAFT_FPS).meanGain;
    for (let n = 0; n < 6; n++) {
      expect(g(n + 6), `frame ${n}`).toBeCloseTo(g(n), 9);
    }
    const cycle = [0, 1, 2, 3, 4, 5].map(g);
    expect(Math.max(...cycle) - Math.min(...cycle)).toBeGreaterThan(0.01);
  });

  it('the 6 position is BELOW the camera rate — 10 frames per cycle, direct', () => {
    expect(BACKDRAFT_FLICKER_HZ[1]).toBe(6);
    expect(backdraftBeatHz(6)).toBeCloseTo(6, 9);
    const g = (n: number): number =>
      backdraftFlickerTerms(1, n / BACKDRAFT_FPS).meanGain;
    for (let n = 0; n < 10; n++) expect(g(n + 10), `frame ${n}`).toBeCloseTo(g(n), 9);
  });

  it('24Hz beats at 24Hz = a 5-frame repeat (2.5 frames/cycle)', () => {
    expect(backdraftBeatHz(BACKDRAFT_FLICKER_HZ[2]!)).toBeCloseTo(24, 9);
    const g = (n: number): number =>
      backdraftFlickerTerms(2, n / BACKDRAFT_FPS).meanGain;
    for (let n = 0; n < 5; n++) expect(g(n + 5)).toBeCloseTo(g(n), 9);
  });

  it('the 60 and 120 positions are the NTSC rates, NOT exact multiples of 60', () => {
    // Exactly 60.000 / 120.000 would genlock to a constant gain and never move.
    expect(BACKDRAFT_FLICKER_HZ[4]).toBeCloseTo(60000 / 1001, 9);
    expect(BACKDRAFT_FLICKER_HZ[4]).not.toBe(60);
    expect(BACKDRAFT_FLICKER_HZ[5]).toBeCloseTo((2 * 60000) / 1001, 9);
    expect(BACKDRAFT_FLICKER_HZ[5]).not.toBe(120);
    expect(backdraftBeatHz(BACKDRAFT_FLICKER_HZ[4]!)).toBeCloseTo(0.06, 3);
    expect(backdraftBeatHz(BACKDRAFT_FLICKER_HZ[5]!)).toBeCloseTo(0.12, 3);

    // Over a few frames the 60 position barely moves; over half a beat cycle it
    // fully swings — the slowly crawling hum bar you see filming a television.
    // (v2 gives this position a LARGER amplitude than v1 did — the storage
    // low-pass passes its 0.06Hz beat essentially untouched and the 90-degree
    // shutter keeps more of the pulse — so the bar is the RATIO: a few frames
    // move it by a percent or so, half a beat cycle swings it fully.)
    const g = (t: number): number => backdraftFlickerTerms(4, t).meanGain;
    const overFiveFrames = Math.abs(g(0) - g(5 / BACKDRAFT_FPS));
    const half = 0.5 / backdraftBeatHz(BACKDRAFT_FLICKER_HZ[4]!);
    const overHalfCycle = Math.abs(g(0) - g(half));
    expect(overFiveFrames, 'barely moves frame to frame').toBeLessThan(0.05);
    expect(overHalfCycle, 'but fully swings over half a beat').toBeGreaterThan(0.5);
    expect(overHalfCycle / overFiveFrames, 'it is a SLOW swell').toBeGreaterThan(20);
  });
});

describe('backdraftFlickerTerms — frame-rate independence + determinism', () => {
  it('QUANTISES to the virtual-camera grid: sub-frame times share one gain', () => {
    // Without this a 120Hz ProMotion display would sample the 50Hz emission at
    // 120Hz and see a 50Hz beat instead of a 10Hz one: same knob, different
    // look, and the tests would diverge from what users get.
    const base = backdraftFlickerTerms(3, 1.0);
    for (const dt of [0, 0.004, 0.008, 0.0166]) {
      const f = backdraftFlickerTerms(3, 1.0 + dt);
      if (dt < 1 / BACKDRAFT_FPS) {
        expect(f.phase, `dt=${dt}`).toBeCloseTo(base.phase, 12);
      }
    }
    expect(backdraftFlickerTerms(3, 1.0 + 1 / BACKDRAFT_FPS).phase).not.toBeCloseTo(
      base.phase,
      6,
    );
  });

  it('is a pure function of (index, time): identical inputs, identical output', () => {
    const a = backdraftFlickerTerms(3, 7.25);
    const b = backdraftFlickerTerms(3, 7.25);
    expect(a).toEqual(b);
  });

  it('wraps phase into [0, 2pi) so a long-running clock keeps float32 precision', () => {
    for (const t of [0, 1, 100, 10_000, 1e6]) {
      for (let idx = 1; idx < BACKDRAFT_FLICKER_COUNT; idx++) {
        const f = backdraftFlickerTerms(idx, t);
        expect(f.phase, `idx=${idx} t=${t}`).toBeGreaterThanOrEqual(0);
        expect(f.phase, `idx=${idx} t=${t}`).toBeLessThan(2 * Math.PI);
      }
    }
  });

  it('negative / zero time is handled without NaN', () => {
    for (const t of [-5, -1e-9, 0]) {
      const f = backdraftFlickerTerms(3, t);
      expect(Number.isFinite(f.gain)).toBe(true);
      expect(Number.isFinite(f.depth)).toBe(true);
      expect(Number.isFinite(f.phase)).toBe(true);
      expect(Number.isFinite(f.meanGain)).toBe(true);
    }
  });
});

describe('backdraftFlickerTerms — the physics of the windows', () => {
  it('depth carries the exposure sinc AND the storage low-pass', () => {
    const fps = BACKDRAFT_FPS;
    for (let idx = 1; idx < BACKDRAFT_FLICKER_COUNT; idx++) {
      const hz = BACKDRAFT_FLICKER_HZ[idx]!;
      const sE = backdraftSinc(hz * (BACKDRAFT_FLICKER_SHUTTER / fps));
      const sR = backdraftSinc(hz * (BACKDRAFT_FLICKER_READOUT / fps));
      const H = backdraftStorageResponse(backdraftBeatHz(hz, fps));
      const f = backdraftFlickerTerms(idx, 0, fps);
      // depth = A * m * sinc(f*T_e) * |H|
      expect(f.depth, `idx=${idx}`).toBeCloseTo(
        f.gain * BACKDRAFT_FLICKER_DEPTH * sE * H.mag,
        12,
      );
      // meanGain = A * (1 + m*sinc(f*T_e)*|H|*sinc(f*T_ro)*cos(phase + rowPhase/2))
      expect(f.meanGain, `idx=${idx}`).toBeCloseTo(
        f.gain *
          (1 +
            BACKDRAFT_FLICKER_DEPTH * sE * H.mag * sR *
              Math.cos(f.phase + f.rowPhase / 2)),
        12,
      );
      expect(Math.abs(sR)).toBeLessThanOrEqual(1);
      expect(f.storage).toBeCloseTo(H.mag, 12);
    }
  });

  it('the 90-degree shutter keeps EVERY position alive (v1’s 180 killed 120)', () => {
    // v1 used T_e = 1/120s, exactly one period of 120Hz, so sinc(f*T_e) = 0 and
    // the 120 position was perfectly dead. The regression guard for that bug.
    for (let idx = 1; idx < BACKDRAFT_FLICKER_COUNT; idx++) {
      const hz = BACKDRAFT_FLICKER_HZ[idx]!;
      const sE = backdraftSinc(hz * (BACKDRAFT_FLICKER_SHUTTER / BACKDRAFT_FPS));
      expect(Math.abs(sE), `idx=${idx} exposure sinc`).toBeGreaterThan(0.5);
    }
    // ...and the specific v1 failure, pinned so nobody re-introduces it.
    const v1Exposure = 0.5 / BACKDRAFT_FPS;
    expect(Math.abs(backdraftSinc(BACKDRAFT_FLICKER_HZ[5]! * v1Exposure))).toBeLessThan(0.01);
  });

  it('every ON position has a real per-row modulation (nothing is dead)', () => {
    for (let idx = 1; idx < BACKDRAFT_FLICKER_COUNT; idx++) {
      const f = backdraftFlickerTerms(idx, 0);
      expect(f.depth / f.gain, `idx=${idx} rowDepth`).toBeGreaterThan(0.04);
    }
  });

  it('the 120 position is a PURE crawling band — no whole-frame pulsing', () => {
    // f*T_ro is ~1 there, so the rolling shutter fits one full band cycle down
    // the frame and its row-average sinc cancels the full-field component
    // essentially completely. Strong local band, flat global luminance.
    const hz = BACKDRAFT_FLICKER_HZ[5]!;
    const sR = backdraftSinc(hz * (BACKDRAFT_FLICKER_READOUT / BACKDRAFT_FPS));
    expect(Math.abs(sR), 'full-field component cancelled').toBeLessThan(0.01);
    const f = backdraftFlickerTerms(5, 0);
    expect(f.depth / f.gain, 'but the BAND is strong').toBeGreaterThan(0.4);
    expect(f.rowPhase / (2 * Math.PI), 'one full band cycle down the frame')
      .toBeCloseTo(1, 2);
  });

  it('rowPhase is the band spread, and grows with frequency', () => {
    // A SLOW flicker is spatially uniform across one frame (6Hz spreads only
    // 0.05 of a cycle top-to-bottom) — which is exactly why a slow full-field
    // flicker is the dangerous one and why the storage low-pass has to carry it.
    let prev = 0;
    for (let idx = 1; idx < BACKDRAFT_FLICKER_COUNT; idx++) {
      const bands = BACKDRAFT_FLICKER_HZ[idx]! * (BACKDRAFT_FLICKER_READOUT / BACKDRAFT_FPS);
      expect(bands, `idx=${idx}`).toBeGreaterThan(prev);
      expect(bands, `idx=${idx}`).toBeLessThanOrEqual(1.0);
      expect(backdraftFlickerTerms(idx, 0).rowPhase).toBeCloseTo(2 * Math.PI * bands, 12);
      prev = bands;
    }
  });

  it('the per-row gain never goes NEGATIVE (light cannot be un-emitted)', () => {
    for (let idx = 1; idx < BACKDRAFT_FLICKER_COUNT; idx++) {
      const f = backdraftFlickerTerms(idx, 0);
      expect(f.gain - Math.abs(f.depth), `idx=${idx}`).toBeGreaterThan(0);
    }
  });
});

describe('backdraftFlickerTerms — the operating point is preserved', () => {
  it('the frame-mean gain has GEOMETRIC mean ~1 over a beat cycle', () => {
    // A multiplicative loop compounds gains, so it is the geometric mean that
    // decides growth vs decay. An arithmetic-mean-1 gain has geometric mean < 1
    // (AM-GM) and would silently damp the loop when FLICKER is switched on,
    // forcing the user to re-hunt their FEEDBACK setting. `A` cancels that.
    for (let idx = 1; idx < BACKDRAFT_FLICKER_COUNT; idx++) {
      const beat = backdraftFlickerTerms(idx, 0).beatHz;
      // average over an INTEGER number of beat cycles
      const frames = Math.max(60, Math.round((BACKDRAFT_FPS / beat) * 3));
      let logSum = 0;
      for (let n = 0; n < frames; n++) {
        logSum += Math.log(backdraftFlickerTerms(idx, n / BACKDRAFT_FPS).meanGain);
      }
      expect(Math.exp(logSum / frames), `idx=${idx}`).toBeCloseTo(1, 2);
    }
  });

  it('the gain genuinely CROSSES unity in both directions (build AND fade)', () => {
    // The single property the whole feature rests on: a constant gain can only
    // decay or pin, so the model is only useful if the gain spends real time
    // both above and below 1.
    for (let idx = 1; idx < BACKDRAFT_FLICKER_COUNT; idx++) {
      let above = 0;
      let below = 0;
      for (let n = 0; n < 60 * BACKDRAFT_FPS; n += 7) {
        const g = backdraftFlickerTerms(idx, n / BACKDRAFT_FPS).meanGain;
        if (g > 1) above++;
        else below++;
      }
      expect(above, `idx=${idx} frames with gain>1`).toBeGreaterThan(0);
      expect(below, `idx=${idx} frames with gain<1`).toBeGreaterThan(0);
    }
  });
});

// ── the loop mirrors ────────────────────────────────────────────────────
// A row-aware CPU mirror of the shader recursion:
//   I[n+1](v) = clamp(source + shoulder(g(t_n, v) * I[n-d](v)) * FEEDBACK, 0, 1)
// The FULL-FIELD luminance is the row average, which is the quantity the
// photosensitivity bound is stated over.
const MIRROR_ROWS = 32;

function backdraftLoopMirror(opts: {
  gainAt: (n: number, v: number) => number;
  steps: number;
  delayFrames?: number;
  feedback?: number;
  source?: number;
  shoulderKnee?: number;
}): number[] {
  const { gainAt, steps, delayFrames = 1, feedback = 1.0, source = 0.06 } = opts;
  const knee = opts.shoulderKnee ?? BACKDRAFT_FLICKER_KNEE;
  const hist: number[][] = [];
  const fieldMean: number[] = [];
  for (let n = 0; n < steps; n++) {
    const prev =
      n - delayFrames >= 0 ? hist[n - delayFrames]! : new Array<number>(MIRROR_ROWS).fill(0);
    const row: number[] = [];
    let acc = 0;
    for (let r = 0; r < MIRROR_ROWS; r++) {
      const v = (r + 0.5) / MIRROR_ROWS;
      const captured = backdraftShoulder(prev[r]! * Math.max(0, gainAt(n, v)), knee);
      const val = Math.min(1, Math.max(0, source + captured * feedback));
      row.push(val);
      acc += val;
    }
    hist.push(row);
    fieldMean.push(acc / MIRROR_ROWS);
  }
  return fieldMean;
}

/** The v2 per-row capture gain, exactly as the shader evaluates it. */
const v2GainAt = (idx: number) => (n: number, v: number): number => {
  const f = backdraftFlickerTerms(idx, n / BACKDRAFT_FPS);
  return f.gain + f.depth * Math.cos(f.phase + v * f.rowPhase);
};

/**
 * The v1 model, reconstructed here as a NEGATIVE CONTROL: a 180-degree shutter,
 * NO storage low-pass and NO shoulder. Its job is to fail the swing bound, so
 * that the bound is proven to have teeth rather than passing vacuously.
 */
const v1GainAt = (hz: number) => (n: number, v: number): number => {
  if (hz <= 0) return 1;
  const Te = 0.5 / BACKDRAFT_FPS;
  const Tro = 0.5 / BACKDRAFT_FPS;
  const sE = backdraftSinc(hz * Te);
  const sR = backdraftSinc(hz * Tro);
  const rowDepth = BACKDRAFT_FLICKER_DEPTH * sE;
  const a = Math.min(0.999999, Math.abs(rowDepth * sR));
  const A = 2 / (1 + Math.sqrt(1 - a * a));
  const tn = Math.floor((n / BACKDRAFT_FPS) * BACKDRAFT_FPS) / BACKDRAFT_FPS;
  const raw = 2 * Math.PI * hz * (tn + Te / 2);
  const phase = raw - 2 * Math.PI * Math.floor(raw / (2 * Math.PI));
  return A + A * rowDepth * Math.cos(phase + v * 2 * Math.PI * hz * Tro);
};

function maxFrameStep(series: number[], settle: number): number {
  const tail = series.slice(settle);
  let m = 0;
  for (let i = 1; i < tail.length; i++) m = Math.max(m, Math.abs(tail[i]! - tail[i - 1]!));
  return m;
}

describe('backdraft FLICKER — the loop builds and fades (CPU mirror)', () => {
  const BASE = { steps: 400, delayFrames: 1, feedback: 1.0, source: 0.06 };

  it('FLICKER OFF saturates to the ceiling and STAYS (today’s behaviour, pinned)', () => {
    // Every coefficient is non-negative and the clamp is monotone, so the map
    // is monotone-positive: with gain >= 1 it can only climb and pin. DELAY
    // cannot break that. This is the control the feature is measured against.
    // knee=1 makes the shoulder the identity, matching the OFF shader branch.
    const tail = backdraftLoopMirror({
      ...BASE, gainAt: () => 1, shoulderKnee: 1,
    }).slice(200);
    expect(Math.min(...tail)).toBeCloseTo(1, 6);
    expect(Math.max(...tail)).toBeCloseTo(1, 6);
  });

  it('every ON position genuinely oscillates — it never pins, and never dies', () => {
    for (let idx = 1; idx < BACKDRAFT_FLICKER_COUNT; idx++) {
      // the 60/120 positions need a long window to complete a ~0.06Hz cycle
      const steps = idx >= 4 ? 90 * BACKDRAFT_FPS : 400;
      const series = backdraftLoopMirror({ ...BASE, gainAt: v2GainAt(idx), steps });
      const tail = series.slice(Math.floor(steps / 2));
      const hi = Math.max(...tail);
      const lo = Math.min(...tail);
      const pinned = tail.filter((x) => x > 0.995).length / tail.length;
      expect(pinned, `idx=${idx} not pinned at the ceiling`).toBeLessThan(0.9);
      // The 120 position's life is entirely in the BAND (its full-field
      // component is cancelled by the rolling shutter), so its whole-frame
      // range is legitimately tiny — that case is covered by the pure-band test.
      if (idx !== 5) {
        expect(hi - lo, `idx=${idx} builds and fades`).toBeGreaterThan(0.02);
      }
    }
  });

  it('the excursion survives a longer DELAY (flicker composes through the tap)', () => {
    // g is a function of ABSOLUTE simulation time, so a tap d frames back
    // composes the gain that really occurred then — the delayed path stays
    // phase-coherent instead of re-running one arbitrary sequence.
    for (const delayFrames of [1, 3, 6, 12]) {
      const series = backdraftLoopMirror({
        ...BASE, gainAt: v2GainAt(3), delayFrames, steps: 480,
      });
      const tail = series.slice(240);
      expect(Math.max(...tail) - Math.min(...tail), `delay=${delayFrames}`)
        .toBeGreaterThan(0.02);
    }
  });
});

describe('backdraft FLICKER — the PHOTOSENSITIVITY swing bound', () => {
  // THE acceptance property, and the reason v2 exists. WCAG 2.3.1's general
  // flash threshold treats a pair of opposing changes of >= 0.10 relative
  // luminance (with the darker state below 0.80) as a "flash", and more than
  // three per second as a seizure risk. We hold the FULL-FIELD frame-to-frame
  // luminance step under that at EVERY position, so no position can flash at
  // all regardless of rate. The 6 position matters most: 6 full-field flashes
  // per second sits squarely in the photic-sensitivity band.
  const FLASH_THRESHOLD = 0.1;

  it('EVERY position stays under the flash threshold at high feedback', () => {
    for (let idx = 1; idx < BACKDRAFT_FLICKER_COUNT; idx++) {
      const steps = idx >= 4 ? 90 * BACKDRAFT_FPS : 400;
      const step = maxFrameStep(
        backdraftLoopMirror({ gainAt: v2GainAt(idx), steps, feedback: 1.0 }),
        Math.floor(steps / 2),
      );
      expect(step, `idx=${idx} (${BACKDRAFT_FLICKER_HZ[idx]}Hz) full-field step`)
        .toBeLessThan(FLASH_THRESHOLD);
    }
  });

  it('holds across the whole FEEDBACK range, not just at the top', () => {
    for (const feedback of [0.5, 0.8, 1.0, 1.2]) {
      for (let idx = 1; idx < BACKDRAFT_FLICKER_COUNT; idx++) {
        const steps = idx >= 4 ? 60 * BACKDRAFT_FPS : 400;
        const step = maxFrameStep(
          backdraftLoopMirror({ gainAt: v2GainAt(idx), steps, feedback }),
          Math.floor(steps / 2),
        );
        expect(step, `idx=${idx} fb=${feedback}`).toBeLessThan(FLASH_THRESHOLD);
      }
    }
  });

  it('the 6 Hz position specifically — the one in the photic band', () => {
    const step = maxFrameStep(
      backdraftLoopMirror({ gainAt: v2GainAt(1), steps: 600, feedback: 1.0 }), 300,
    );
    expect(step, '6Hz full-field step').toBeLessThan(FLASH_THRESHOLD);
  });

  it('NEGATIVE CONTROL: the v1 model VIOLATES the bound (the test has teeth)', () => {
    // Without the storage low-pass and the shoulder, the same loop flashes.
    // If this ever stops failing the bound, the bound has gone vacuous.
    for (const idx of [1, 2, 3]) {
      const step = maxFrameStep(
        backdraftLoopMirror({
          gainAt: v1GainAt(BACKDRAFT_FLICKER_HZ[idx]!),
          steps: 400, feedback: 1.0, shoulderKnee: 1,
        }),
        200,
      );
      expect(step, `v1 idx=${idx} strobes`).toBeGreaterThan(2 * FLASH_THRESHOLD);
    }
  });

  it('the softening is a >5x reduction on the worst positions', () => {
    for (const idx of [1, 2, 3]) {
      const steps = 400;
      const v2 = maxFrameStep(
        backdraftLoopMirror({ gainAt: v2GainAt(idx), steps, feedback: 1.0 }), 200);
      const v1 = maxFrameStep(
        backdraftLoopMirror({
          gainAt: v1GainAt(BACKDRAFT_FLICKER_HZ[idx]!), steps, feedback: 1.0, shoulderKnee: 1,
        }), 200);
      expect(v1 / v2, `idx=${idx} improvement`).toBeGreaterThan(5);
    }
  });
});

describe('backdraft module def — FLICKER param', () => {
  it('is a DISCRETE 6-position selector defaulting to OFF', () => {
    const byId = Object.fromEntries(backdraftDef.params.map((p) => [p.id, p]));
    expect(byId.flicker).toMatchObject({
      min: 0,
      max: BACKDRAFT_FLICKER_COUNT - 1,
      defaultValue: 0, // OFF — the bit-identical no-op
      curve: 'discrete',
    });
  });

  it('the option list, the Hz table and the count agree', () => {
    expect(BACKDRAFT_FLICKER_OPTIONS).toEqual(['off', '6', '24', '50', '60', '120']);
    expect(BACKDRAFT_FLICKER_COUNT).toBe(6);
    expect(BACKDRAFT_FLICKER_HZ).toHaveLength(BACKDRAFT_FLICKER_COUNT);
    expect(BACKDRAFT_FLICKER_HZ[0]).toBe(0); // OFF
    expect(BACKDRAFT_FLICKER_HZ[1]).toBe(6);
    expect(BACKDRAFT_FLICKER_HZ[2]).toBe(24);
    expect(BACKDRAFT_FLICKER_HZ[3]).toBe(50);
    // the labels are the NOMINAL rates; the Hz table carries the real ones
    expect(BACKDRAFT_FLICKER_HZ[4]).toBeCloseTo(59.94, 2);
    expect(BACKDRAFT_FLICKER_HZ[5]).toBeCloseTo(119.88, 2);
  });

  it('the Hz table is strictly increasing (the knob reads left to right)', () => {
    for (let i = 1; i < BACKDRAFT_FLICKER_COUNT; i++) {
      expect(BACKDRAFT_FLICKER_HZ[i]!).toBeGreaterThan(BACKDRAFT_FLICKER_HZ[i - 1]!);
    }
  });

  it('is documented (backdraft is in STRICT_DOCS)', () => {
    expect(backdraftDef.docs?.controls?.flicker).toBeTruthy();
  });

  it('has NO cv/gate port — it is a knob-only control (contract stays minimal)', () => {
    expect(backdraftDef.inputs.some((p) => p.paramTarget === 'flicker')).toBe(false);
  });
});
