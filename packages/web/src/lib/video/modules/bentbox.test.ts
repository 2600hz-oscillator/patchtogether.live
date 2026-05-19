// packages/web/src/lib/video/modules/bentbox.test.ts
//
// Pure-math + module-def-shape coverage for BENTBOX. The shader is the
// only renderer; the math helpers it ports to GLSL are mirrored here in
// TS so the encode/decode and waveshape behavior can be unit-tested
// without booting WebGL.

import { describe, expect, it } from 'vitest';
import { bentboxDef, rgbToYiq, softClip, wavefold, yiqToRgb } from './bentbox';

describe('BENTBOX pure helpers', () => {
  describe('rgbToYiq / yiqToRgb', () => {
    it('round-trips primary colors within float tolerance', () => {
      const primaries: Array<[number, number, number]> = [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
        [1, 1, 1],
        [0, 0, 0],
        [0.5, 0.5, 0.5],
        [0.2, 0.7, 0.3],
      ];
      for (const [r, g, b] of primaries) {
        const yiq = rgbToYiq(r, g, b);
        const back = yiqToRgb(yiq.y, yiq.i, yiq.q);
        expect(back.r).toBeCloseTo(r, 3);
        expect(back.g).toBeCloseTo(g, 3);
        expect(back.b).toBeCloseTo(b, 3);
      }
    });

    it('produces Y = luma (Rec 601-ish) for pure white', () => {
      const yiq = rgbToYiq(1, 1, 1);
      expect(yiq.y).toBeCloseTo(1, 3);
      expect(yiq.i).toBeCloseTo(0, 3);
      expect(yiq.q).toBeCloseTo(0, 3);
    });

    it('produces I > 0 for red (warm hues are +I)', () => {
      const yiq = rgbToYiq(1, 0, 0);
      expect(yiq.i).toBeGreaterThan(0);
    });

    it('produces Q > 0 for blue-violet (Q axis points toward magenta)', () => {
      const yiq = rgbToYiq(0.5, 0, 0.5);
      expect(yiq.q).toBeGreaterThan(0);
    });

    it('clamps output to [0, 1] for out-of-gamut YIQ inputs', () => {
      const rgb = yiqToRgb(2, 2, 2); // way out of any valid color
      expect(rgb.r).toBeGreaterThanOrEqual(0);
      expect(rgb.r).toBeLessThanOrEqual(1);
      expect(rgb.g).toBeGreaterThanOrEqual(0);
      expect(rgb.g).toBeLessThanOrEqual(1);
      expect(rgb.b).toBeGreaterThanOrEqual(0);
      expect(rgb.b).toBeLessThanOrEqual(1);
    });
  });

  describe('wavefold', () => {
    it('is identity at amount=0', () => {
      for (const v of [-1, -0.5, 0, 0.3, 0.7, 1]) {
        expect(wavefold(v, 0)).toBeCloseTo(v, 5);
      }
    });

    it('keeps in-range values monotonic for small amount', () => {
      // For amount=0.1, values still fit in linear region and should
      // remain monotonic with the input.
      const samples = [-1, -0.5, 0, 0.5, 1];
      const folded = samples.map((v) => wavefold(v, 0.1));
      for (let i = 1; i < folded.length; i++) {
        expect(folded[i]!).toBeGreaterThan(folded[i - 1]!);
      }
    });

    it('folds values that exceed unity back into [-1, 1]', () => {
      // amount=1 scales by 4. Input 0.5 -> scaled 2.0 -> folded back.
      const out = wavefold(0.5, 1);
      expect(out).toBeGreaterThanOrEqual(-1);
      expect(out).toBeLessThanOrEqual(1);
      // And it MUST be different from the identity behavior — otherwise
      // there's no fold happening.
      expect(Math.abs(out - 0.5)).toBeGreaterThan(0.05);
    });
  });

  describe('softClip', () => {
    it('is approximately identity for small inputs', () => {
      for (const v of [-0.1, 0, 0.1, 0.3]) {
        expect(softClip(v)).toBeCloseTo(v, 1);
      }
    });

    it('compresses large inputs (|out| < |in|)', () => {
      expect(Math.abs(softClip(2))).toBeLessThan(2);
      expect(Math.abs(softClip(-3))).toBeLessThan(3);
    });

    it('is monotonic', () => {
      const samples = [-3, -2, -1, -0.5, 0, 0.5, 1, 2, 3];
      const out = samples.map(softClip);
      for (let i = 1; i < out.length; i++) {
        expect(out[i]!).toBeGreaterThan(out[i - 1]!);
      }
    });

    it('is bounded (never exceeds about 1.1 in magnitude for any finite input)', () => {
      for (const v of [-100, -10, -3, 3, 10, 100]) {
        expect(Math.abs(softClip(v))).toBeLessThan(1.2);
      }
    });
  });
});

describe('BENTBOX module def shape', () => {
  it('declares the video-domain type', () => {
    expect(bentboxDef.type).toBe('bentbox');
    expect(bentboxDef.domain).toBe('video');
    expect(bentboxDef.category).toBe('output');
  });

  it('has the input video port + 12 CV inputs', () => {
    const ins = bentboxDef.inputs;
    expect(ins.find((p) => p.id === 'in' && p.type === 'video')).toBeTruthy();
    const cvCount = ins.filter((p) => p.type === 'cv').length;
    expect(cvCount).toBe(12);
  });

  it('every CV input has a matching paramTarget that exists in params', () => {
    const paramIds = new Set(bentboxDef.params.map((p) => p.id));
    for (const port of bentboxDef.inputs) {
      if (port.type === 'cv') {
        expect(port.paramTarget).toBeDefined();
        expect(paramIds.has(port.paramTarget!)).toBe(true);
      }
    }
  });

  it('exposes a single video output for chaining', () => {
    expect(bentboxDef.outputs).toHaveLength(1);
    expect(bentboxDef.outputs[0]!.id).toBe('out');
    expect(bentboxDef.outputs[0]!.type).toBe('video');
  });

  it('default params land in their declared ranges', () => {
    for (const p of bentboxDef.params) {
      const def = p.defaultValue;
      if (typeof p.min === 'number') expect(def).toBeGreaterThanOrEqual(p.min);
      if (typeof p.max === 'number') expect(def).toBeLessThanOrEqual(p.max);
    }
  });

  it('defaults bending params to 0 (pristine display) so users dial in', () => {
    const byId = new Map(bentboxDef.params.map((p) => [p.id, p]));
    for (const id of [
      'hsync_drift', 'hsync_loss', 'vsync_drift', 'scan_wobble',
      'chroma_phase', 'chroma_instability',
      'feedback_gain', 'feedback_delay', 'wavefold',
    ]) {
      expect(byId.get(id)?.defaultValue).toBe(0);
    }
  });
});
