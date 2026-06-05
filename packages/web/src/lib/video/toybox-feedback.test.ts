// packages/web/src/lib/video/toybox-feedback.test.ts
//
// Pure-function coverage for the TOYBOX FEEDBACK node model: the 12-mode
// catalogue (FEEDBACK_MODES) + the param→uniform mapping (feedbackUniforms,
// clampFeedbackMode). The shader + ping-pong buffers are exercised by E2E/VRT
// (jsdom can't render); here we pin the data shape + clamp math so a regression
// (a dropped mode, an off-by-one id, a range that drifts from OP_PARAMS) fails a
// fast unit test.

import { describe, it, expect } from 'vitest';
import {
  FEEDBACK_MODES,
  FEEDBACK_MODE_COUNT,
  clampFeedbackMode,
  feedbackModeById,
  feedbackUniforms,
} from './toybox-feedback';
import { OP_PARAMS } from './toybox-combine-graph';

describe('FEEDBACK_MODES', () => {
  it('lists exactly 12 modes', () => {
    expect(FEEDBACK_MODES).toHaveLength(12);
    expect(FEEDBACK_MODE_COUNT).toBe(12);
  });
  it('ids are contiguous 0..11 and equal the array index (append-only contract)', () => {
    FEEDBACK_MODES.forEach((m, i) => expect(m.id).toBe(i));
  });
  it('every mode has a non-empty unique label', () => {
    const labels = FEEDBACK_MODES.map((m) => m.label);
    for (const l of labels) expect(l.length).toBeGreaterThan(0);
    expect(new Set(labels).size).toBe(labels.length);
  });
  it('includes the headline modes from the spec', () => {
    const byId = Object.fromEntries(FEEDBACK_MODES.map((m) => [m.id, m.label]));
    expect(byId[0]).toBe('TUNNEL');
    expect(byId[3]).toBe('ADDITIVE');
    expect(byId[9]).toBe('REACTION');
    expect(byId[11]).toBe('VECTOR');
  });
});

describe('clampFeedbackMode', () => {
  it('rounds + clamps into 0..11', () => {
    expect(clampFeedbackMode(0)).toBe(0);
    expect(clampFeedbackMode(11)).toBe(11);
    expect(clampFeedbackMode(11.4)).toBe(11);
    expect(clampFeedbackMode(2.6)).toBe(3);
    expect(clampFeedbackMode(-5)).toBe(0);
    expect(clampFeedbackMode(99)).toBe(11);
  });
  it('degrades non-finite / non-number to mode 0 (safe default, never NaN)', () => {
    expect(clampFeedbackMode(NaN)).toBe(0);
    expect(clampFeedbackMode(Infinity)).toBe(0); // non-finite → default 0 (not garbage)
    expect(clampFeedbackMode(undefined)).toBe(0);
    expect(clampFeedbackMode('3' as unknown)).toBe(0);
  });
  it('feedbackModeById returns the clamped mode def', () => {
    expect(feedbackModeById(3).label).toBe('ADDITIVE');
    expect(feedbackModeById(-1).id).toBe(0);
    expect(feedbackModeById(50).id).toBe(11);
  });
});

describe('feedbackUniforms', () => {
  it('fills every uniform from defaults when params are absent', () => {
    const u = feedbackUniforms(undefined);
    expect(u).toMatchObject({
      mode: 0,
      zoom: 0.95,
      rotate: 0,
      scaleP: 1,
      tx: 0,
      ty: 0,
      decay: 0.9,
      gain: 1,
      thresh: 0.5,
      hue: 0,
      blur: 1,
      slitPos: 0.5,
      slitWidth: 0.1,
      flow: 0,
    });
  });
  it('passes through in-range values unchanged', () => {
    const u = feedbackUniforms({ mode: 5, zoom: 0.7, decay: 1.2, gain: 1.5, blur: 3, flow: 0.4 });
    expect(u.mode).toBe(5);
    expect(u.zoom).toBeCloseTo(0.7);
    expect(u.decay).toBeCloseTo(1.2);
    expect(u.gain).toBeCloseTo(1.5);
    expect(u.blur).toBeCloseTo(3);
    expect(u.flow).toBeCloseTo(0.4);
  });
  it('clamps out-of-range floats to the OP_PARAMS bounds', () => {
    const u = feedbackUniforms({ zoom: 2, decay: -1, gain: 99, thresh: 5, slitWidth: -3, blur: 100 });
    expect(u.zoom).toBe(1); // max .5..1
    expect(u.decay).toBe(0); // min 0..1.5
    expect(u.gain).toBe(2); // max 0..2
    expect(u.thresh).toBe(1); // max 0..1
    expect(u.slitWidth).toBe(0); // min 0..1
    expect(u.blur).toBe(4); // max 0..4
  });
  it('rounds + clamps mode (CV writes land as floats)', () => {
    expect(feedbackUniforms({ mode: 3.7 }).mode).toBe(4);
    expect(feedbackUniforms({ mode: -2 }).mode).toBe(0);
    expect(feedbackUniforms({ mode: 200 }).mode).toBe(11);
  });
  it('degrades non-finite floats to the default (never propagates NaN/Inf to GLSL)', () => {
    const u = feedbackUniforms({ zoom: NaN, gain: Infinity, rotate: NaN });
    expect(u.zoom).toBe(0.95);
    expect(u.gain).toBe(1); // non-finite → default (NOT clamped to max — Inf is unsafe)
    expect(u.rotate).toBe(0);
  });

  // The uniform ranges/defaults MUST stay in lock-step with OP_PARAMS['feedback']
  // so a CV write (range-mapped against OP_PARAMS) and a manual knob land
  // identically. This guards the two sources of truth from drifting apart.
  it('default uniforms match OP_PARAMS["feedback"] defaults exactly', () => {
    const u = feedbackUniforms(undefined) as unknown as Record<string, number>;
    for (const def of OP_PARAMS.feedback) {
      expect(u[def.id], `default for ${def.id}`).toBe(def.default);
    }
  });
  it('clamp bounds match OP_PARAMS["feedback"] min/max for each float', () => {
    for (const def of OP_PARAMS.feedback) {
      if (def.id === 'mode') continue; // discrete — covered by clampFeedbackMode
      const lo = feedbackUniforms({ [def.id]: def.min - 1000 }) as unknown as Record<string, number>;
      const hi = feedbackUniforms({ [def.id]: def.max + 1000 }) as unknown as Record<string, number>;
      expect(lo[def.id], `${def.id} clamps to min`).toBe(def.min);
      expect(hi[def.id], `${def.id} clamps to max`).toBe(def.max);
    }
  });
});
