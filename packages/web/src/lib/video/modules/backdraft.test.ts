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
  backdraftDef,
  backdraftDelayFrames,
  backdraftEffectScale,
  backdraftTapIndex,
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
    const f = backdraftDelayFrames(BACKDRAFT_MAX_DELAY_MS, BACKDRAFT_BUFFER_FRAMES);
    expect(f).toBe(6); // round(100/1000*60) = 6
    expect(f).toBeLessThan(BACKDRAFT_BUFFER_FRAMES); // never aliases the head
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
    for (const id of ['mix', 'feedback', 'delay', 'luma', 'chroma', 'r', 'g', 'b', 'lighten', 'darken']) {
      expect(cvTargets, `cv for ${id}`).toContain(id);
    }
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
