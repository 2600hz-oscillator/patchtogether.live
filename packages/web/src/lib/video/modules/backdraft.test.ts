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
  BACKDRAFT_MAX_EFFECT_SCALE,
  BACKDRAFT_MAX_FEEDBACK,
  BACKDRAFT_ZOOM_MIN,
  BACKDRAFT_ZOOM_MAX,
  BACKDRAFT_ROTATE_MIN,
  BACKDRAFT_ROTATE_MAX,
  BACKDRAFT_OFFSET_MIN,
  BACKDRAFT_OFFSET_MAX,
  backdraftDef,
  backdraftDelayFrames,
  backdraftEffectScale,
  backdraftEffectiveDelayMs,
  backdraftFeedbackUv,
  backdraftClockTick,
  backdraftTapIndex,
  makeBackdraftClockState,
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

  it('max DELAY (500ms) maps to ~30 frames at 60fps and fits the ring', () => {
    const f = backdraftDelayFrames(BACKDRAFT_MAX_DELAY_MS, BACKDRAFT_BUFFER_FRAMES);
    expect(f).toBe(30); // round(500/1000*60) = 30
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
  it('unpatched: returns the DELAY knob value (clamped to [0,500])', () => {
    expect(backdraftEffectiveDelayMs(120, false, 0.25)).toBe(120);
    expect(backdraftEffectiveDelayMs(9999, false, 0.25)).toBe(BACKDRAFT_MAX_DELAY_MS);
    expect(backdraftEffectiveDelayMs(-5, false, 0)).toBe(0);
  });

  it('patched but no measured period yet: falls back to the knob', () => {
    expect(backdraftEffectiveDelayMs(80, true, 0)).toBe(80);
  });

  it('patched: delay = one clock-pulse duration (period sec → ms)', () => {
    // 4 Hz clock → period 0.25s → 250ms feedback delay.
    expect(backdraftEffectiveDelayMs(80, true, 0.25)).toBeCloseTo(250, 6);
    // 8 Hz clock → 125ms.
    expect(backdraftEffectiveDelayMs(80, true, 0.125)).toBeCloseTo(125, 6);
  });

  it('caps at 500ms — one beat at 120 BPM — for slow clocks', () => {
    // 1 Hz clock (period 1s = 60 BPM) would be 1000ms; capped to 500.
    expect(backdraftEffectiveDelayMs(80, true, 1.0)).toBe(BACKDRAFT_MAX_DELAY_MS);
    // Exactly 120 BPM (period 0.5s) lands right at the cap, uncapped.
    expect(backdraftEffectiveDelayMs(80, true, 0.5)).toBeCloseTo(500, 6);
  });

  it('overrides the knob entirely when the clock is driving', () => {
    // knob at 16ms, but a 2 Hz clock (period 0.5s) drives 500ms.
    expect(backdraftEffectiveDelayMs(16, true, 0.5)).toBeCloseTo(500, 6);
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

    // Spatial feedback transform — identity defaults so existing behaviour
    // is unchanged out of the box (no tunnel/spiral/trail at defaults).
    expect(byId.zoom).toMatchObject({ min: BACKDRAFT_ZOOM_MIN, max: BACKDRAFT_ZOOM_MAX, defaultValue: 1.0 });
    expect(byId.rotate).toMatchObject({ min: BACKDRAFT_ROTATE_MIN, max: BACKDRAFT_ROTATE_MAX, defaultValue: 0 });
    expect(byId.offsetX).toMatchObject({ min: BACKDRAFT_OFFSET_MIN, max: BACKDRAFT_OFFSET_MAX, defaultValue: 0 });
    expect(byId.offsetY).toMatchObject({ min: BACKDRAFT_OFFSET_MIN, max: BACKDRAFT_OFFSET_MAX, defaultValue: 0 });
  });

  it('exposes two video inputs, two key masks, and the out port', () => {
    const inIds = backdraftDef.inputs.filter((p) => p.type === 'video').map((p) => p.id);
    expect(inIds).toEqual(expect.arrayContaining(['in_a', 'in_b', 'lighten', 'darken']));
    expect(backdraftDef.outputs.map((p) => p.id)).toEqual(['out']);
  });

  it('every modulatable param has a matching CV input (port id == param id, or _cv)', () => {
    const cvTargets = backdraftDef.inputs
      .filter((p) => p.type === 'cv')
      .map((p) => p.paramTarget);
    for (const id of [
      'mix', 'feedback', 'delay', 'luma', 'chroma', 'r', 'g', 'b', 'lighten', 'darken',
      // spatial feedback transform is CV-wired too
      'zoom', 'rotate', 'offsetX', 'offsetY',
    ]) {
      expect(cvTargets, `cv for ${id}`).toContain(id);
    }
  });

  it('exposes a DELAY CLOCK gate input (raw passthrough, no cvScale)', () => {
    const clk = backdraftDef.inputs.find((p) => p.id === 'delay_clock');
    expect(clk, 'delay_clock port').toBeDefined();
    expect(clk?.type).toBe('cv');
    // Gate-style: NO cvScale hint => the bridge passes the raw swing through
    // so the module edge-detects rising edges (vs scaling across a range).
    expect(clk?.cvScale).toBeUndefined();
    expect(clk?.paramTarget).toBe('delayClock');
    // The synthetic gate param exists (hidden — no card knob).
    const byId = Object.fromEntries(backdraftDef.params.map((p) => [p.id, p]));
    expect(byId.delayClock).toMatchObject({ min: 0, max: 1, defaultValue: 0 });
  });

  it('ring buffer holds 500ms — one beat at 120 BPM — the clock cap', () => {
    // 120 BPM beat = 60000/120 = 500ms = BACKDRAFT_MAX_DELAY_MS, and the
    // ring already covers that (the clock never asks for more than the knob).
    expect(BACKDRAFT_MAX_DELAY_MS).toBe(500);
    const f = backdraftDelayFrames(BACKDRAFT_MAX_DELAY_MS, BACKDRAFT_BUFFER_FRAMES);
    expect(f).toBe(BACKDRAFT_BUFFER_FRAMES - 1);
  });

  it('bipolar CV params use linear cvScale', () => {
    const lumaCv = backdraftDef.inputs.find((p) => p.type === 'cv' && p.paramTarget === 'luma');
    expect(lumaCv?.cvScale).toMatchObject({ mode: 'linear' });
  });

  it('ring buffer covers the max delay at the assumed frame rate', () => {
    const neededFrames = Math.round((BACKDRAFT_MAX_DELAY_MS / 1000) * BACKDRAFT_FPS);
    expect(BACKDRAFT_BUFFER_FRAMES).toBeGreaterThan(neededFrames);
  });
});
