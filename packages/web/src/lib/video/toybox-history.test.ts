// packages/web/src/lib/video/toybox-history.test.ts
//
// Pure-function coverage for the TOYBOX FRAME-HISTORY ops (the stateful batch
// ops: framedelay/channeldesync/flowsmear/dreammelt/datamosh). The SHADER is
// e2e/VRT-only (jsdom can't render); this covers the param→uniform clamp math +
// the reset-token decision + the HISTORY_OP_INDEX mapping + a content guard that
// the shared HISTORY program branches on all 5 op indices. Mirrors
// toybox-feedback.test.ts.

import { describe, it, expect } from 'vitest';
import {
  historyUniforms,
  historyResetState,
  clampDelay,
  HISTORY_OP_INDEX,
} from './toybox-history';
import { HISTORY_OP_KINDS, MAX_HISTORY_FRAMES, OP_PARAMS } from './toybox-combine-graph';
import {
  __HISTORY_FRAG_SRC_FOR_TEST,
  __EXQUISITE_FRAG_SRC_FOR_TEST,
} from './modules/toybox';

describe('clampDelay', () => {
  it('rounds + clamps to a valid ring tap (0..MAX-1)', () => {
    expect(clampDelay(4.6, 0)).toBe(5);
    expect(clampDelay(-3, 0)).toBe(0);
    expect(clampDelay(9999, 0)).toBe(MAX_HISTORY_FRAMES - 1);
    expect(clampDelay(NaN, 7)).toBe(7);
    expect(clampDelay(undefined, 7)).toBe(7);
  });
});

describe('HISTORY_OP_INDEX', () => {
  it('maps every history op kind to a distinct contiguous index 0..4', () => {
    const idx = HISTORY_OP_KINDS.map((k) => HISTORY_OP_INDEX[k]);
    expect([...idx].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    expect(HISTORY_OP_INDEX.framedelay).toBe(0);
    expect(HISTORY_OP_INDEX.channeldesync).toBe(1);
    expect(HISTORY_OP_INDEX.flowsmear).toBe(2);
    expect(HISTORY_OP_INDEX.dreammelt).toBe(3);
    expect(HISTORY_OP_INDEX.datamosh).toBe(4);
  });
});

describe('historyUniforms', () => {
  it('defaults every field when params are absent', () => {
    const u = historyUniforms('framedelay', undefined);
    expect(u.op).toBe(0);
    expect(u.delay).toBe(8);
    expect(u.mix).toBe(1);
    expect(u.persistence).toBe(0.85);
    expect(u.decay).toBe(0.9);
  });

  it('rounds delays + clamps floats to their OP_PARAMS ranges', () => {
    const u = historyUniforms('channeldesync', {
      rDelay: 2.4, gDelay: 99, bDelay: -1, offsetMag: 5,
    });
    expect(u.rDelay).toBe(2);
    expect(u.gDelay).toBe(MAX_HISTORY_FRAMES - 1);
    expect(u.bDelay).toBe(0);
    expect(u.offsetMag).toBe(1); // clamped to max
  });

  it('clamps flowsmear / dreammelt / datamosh ranges', () => {
    const fs = historyUniforms('flowsmear', { flowStrength: 9, noiseScale: 0.1, persistence: -1 });
    expect(fs.flowStrength).toBe(1);
    expect(fs.noiseScale).toBe(0.5); // clamped to min
    expect(fs.persistence).toBe(0);
    const dm = historyUniforms('datamosh', { flowScale: 2, holdGate: 2, decay: 2 });
    expect(dm.flowScale).toBe(1);
    expect(dm.holdGate).toBe(1);
    expect(dm.decay).toBe(1);
  });

  it('matches OP_PARAMS defaults exactly (CV write == manual knob)', () => {
    // framedelay
    const fd = historyUniforms('framedelay', undefined);
    const fdById = Object.fromEntries(OP_PARAMS.framedelay.map((p) => [p.id, p.default]));
    expect(fd.delay).toBe(fdById.delay);
    expect(fd.mix).toBe(fdById.mix);
    // dreammelt
    const dr = historyUniforms('dreammelt', undefined);
    const drById = Object.fromEntries(OP_PARAMS.dreammelt.map((p) => [p.id, p.default]));
    expect(dr.meltAmount).toBe(drById.meltAmount);
    expect(dr.dripSpeed).toBe(drById.dripSpeed);
    expect(dr.threshold).toBe(drById.threshold);
  });

  it('is deterministic (identical params → identical uniforms)', () => {
    const p = { delay: 5, mix: 0.4 };
    expect(historyUniforms('framedelay', p)).toEqual(historyUniforms('framedelay', { ...p }));
  });
});

describe('historyResetState (shared reset-token contract)', () => {
  it('arms a clear only when the token changes', () => {
    expect(historyResetState(0, {})).toEqual({ clear: false, token: 0 });
    expect(historyResetState(0, { _reset: 1 })).toEqual({ clear: true, token: 1 });
    expect(historyResetState(1, { _reset: 1 })).toEqual({ clear: false, token: 1 });
  });
  it('tolerates absent / NaN tokens (treated as 0)', () => {
    expect(historyResetState(0, undefined)).toEqual({ clear: false, token: 0 });
    expect(historyResetState(0, { _reset: NaN })).toEqual({ clear: false, token: 0 });
  });
});

describe('HISTORY_FRAG_SRC content (shader branches on all 5 op indices)', () => {
  it('branches on uOp 0..4 + declares the ring taps + dual inputs', () => {
    const src = __HISTORY_FRAG_SRC_FOR_TEST;
    for (const probe of ['uOp == 0', 'uOp == 1', 'uOp == 2', 'uOp == 3']) {
      expect(src).toContain(probe);
    }
    // datamosh is the trailing else.
    expect(src).toContain('uniform sampler2D uTapR;');
    expect(src).toContain('uniform sampler2D uTapG;');
    expect(src).toContain('uniform sampler2D uTapB;');
    expect(src).toContain('uniform sampler2D uInput1;'); // dreammelt's 2nd input
    expect(src).toContain('uniform float uMix;');
    expect(src).toContain('uniform float uHoldGate;');
  });
});

describe('EXQUISITE_FRAG_SRC content (4 input samplers)', () => {
  it('declares uIn0..uIn3 + their wired flags + the band uniforms', () => {
    const src = __EXQUISITE_FRAG_SRC_FOR_TEST;
    for (let i = 0; i < 4; i++) {
      expect(src).toContain(`uniform sampler2D uIn${i};`);
      expect(src).toContain(`uniform float uHas${i};`);
    }
    expect(src).toContain('uniform float uBands;');
    expect(src).toContain('uniform float uWarp;');
    expect(src).toContain('uniform float uSeam;');
  });
});
