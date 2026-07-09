// packages/web/src/lib/video/modules/bentbox.test.ts
//
// Pure-math + module-def-shape coverage for BENTBOX. The shader is the
// only renderer; the math helpers it ports to GLSL are mirrored here in
// TS so the encode/decode and waveshape behavior can be unit-tested
// without booting WebGL.

import { describe, expect, it } from 'vitest';
import {
  bentboxMirrorUv,
  bentboxMirrorGateTick,
  makeBentboxMirrorGateState,
  rgbToYiq,
  softClip,
  wavefold,
  yiqToRgb,
} from './bentbox';

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

    it('compresses (|out| < |in|) for any in with |in| > ~0.6 — the working range', () => {
      // softClip is a Padé approximation that asymptotes to v/3 as |v|→∞
      // (not a hard clip like tanh). It IS compressive: |softClip(v)| < |v|
      // for any |v| > ~0.6. The shader feeds it the composite-voltage path
      // where the wavefolder already keeps values in [-1, 1] * master_gain,
      // so it never sees the extreme tail. We assert the compression
      // property, which is what the shader actually depends on.
      for (const v of [-3, -1.5, 1.5, 3, 10]) {
        expect(Math.abs(softClip(v))).toBeLessThan(Math.abs(v));
      }
    });

    it('compresses even at extreme values (Padé asymptote ≈ v/9, never escapes |v|)', () => {
      // The Padé form v(27+v²)/(27+9v²) asymptotes to v/9 as |v|→∞ — not
      // a hard bound like tanh, but always compressive: |softClip(v)| < |v|.
      // The shader feeds it [-1, 1]*master_gain (post-wavefold) so the
      // tail is academic; we just document the property here.
      expect(Math.abs(softClip(1000))).toBeLessThan(1000);
      expect(Math.abs(softClip(-1000))).toBeLessThan(1000);
    });
  });
});

describe('bentboxMirrorUv — kaleidoscope fold geometry', () => {
  it('identity (both off) returns the UV unchanged', () => {
    for (const [u, v] of [[0.1, 0.2], [0.9, 0.8], [0.5, 0.5]] as const) {
      const out = bentboxMirrorUv(u, v, false, false);
      expect(out.u).toBeCloseTo(u, 6);
      expect(out.v).toBeCloseTo(v, 6);
    }
  });

  it('MIRROR X folds the LEFT half over the right (right = mirror of left)', () => {
    // Left half (u<0.5) unchanged.
    expect(bentboxMirrorUv(0.2, 0.3, true, false).u).toBeCloseTo(0.2, 6);
    // Right half mirrors the left: u -> 1-u. u=0.8 reads from u=0.2.
    expect(bentboxMirrorUv(0.8, 0.3, true, false).u).toBeCloseTo(0.2, 6);
    // Symmetric pair maps to the SAME source coord (right == mirrored left).
    expect(bentboxMirrorUv(0.8, 0.3, true, false).u)
      .toBeCloseTo(bentboxMirrorUv(0.2, 0.3, true, false).u, 6);
    // v untouched.
    expect(bentboxMirrorUv(0.8, 0.3, true, false).v).toBeCloseTo(0.3, 6);
  });

  it('MIRROR Y folds the visual TOP half into the bottom (keeps uv.y>=0.5)', () => {
    // The fold KEEPS the high-uv.y half (the visual TOP) and reflects the low
    // half via (1-uv.y) — verified via BACKDRAFT e2e to read as top→bottom.
    expect(bentboxMirrorUv(0.3, 0.8, false, true).v).toBeCloseTo(0.8, 6); // high half kept
    expect(bentboxMirrorUv(0.3, 0.2, false, true).v).toBeCloseTo(0.8, 6); // low half → 1-0.2
    expect(bentboxMirrorUv(0.3, 0.2, false, true).v)
      .toBeCloseTo(bentboxMirrorUv(0.3, 0.8, false, true).v, 6);
    expect(bentboxMirrorUv(0.3, 0.2, false, true).u).toBeCloseTo(0.3, 6);
  });

  it('both on = 4-way symmetric (quadrant fold = kaleidoscope)', () => {
    // All four quadrant-corners map to the SAME (kept) source coord.
    const ref = bentboxMirrorUv(0.2, 0.8, true, true);
    const a = bentboxMirrorUv(0.8, 0.8, true, true);
    const b = bentboxMirrorUv(0.2, 0.2, true, true);
    const c = bentboxMirrorUv(0.8, 0.2, true, true);
    for (const q of [a, b, c]) {
      expect(q.u).toBeCloseTo(ref.u, 6);
      expect(q.v).toBeCloseTo(ref.v, 6);
    }
    expect(ref.u).toBeCloseTo(0.2, 6);
    expect(ref.v).toBeCloseTo(0.8, 6);
  });

  it('is idempotent on the kept half (folding the output again is a no-op)', () => {
    const once = bentboxMirrorUv(0.8, 0.2, true, true);
    const twice = bentboxMirrorUv(once.u, once.v, true, true);
    expect(twice.u).toBeCloseTo(once.u, 6);
    expect(twice.v).toBeCloseTo(once.v, 6);
  });
});

describe('bentboxMirrorGateTick — rising edge flips the axis', () => {
  it('returns true exactly on the rising edge (hysteresis rise>0.6)', () => {
    const st = makeBentboxMirrorGateState();
    expect(bentboxMirrorGateTick(st.x, 0.0)).toBe(false);
    expect(bentboxMirrorGateTick(st.x, 0.7)).toBe(true);   // rising edge
    expect(bentboxMirrorGateTick(st.x, 0.9)).toBe(false);  // still high, no new edge
    expect(bentboxMirrorGateTick(st.x, 0.3)).toBe(false);  // falling (no flip)
    expect(bentboxMirrorGateTick(st.x, 0.7)).toBe(true);   // next rising edge
  });

  it('a value in the dead band (0.4..0.6) does not re-trigger', () => {
    const st = makeBentboxMirrorGateState();
    expect(bentboxMirrorGateTick(st.y, 0.7)).toBe(true);
    expect(bentboxMirrorGateTick(st.y, 0.5)).toBe(false); // sticky in dead band
    expect(bentboxMirrorGateTick(st.y, 0.55)).toBe(false);
  });

  it('toggling a boolean on each rising edge flips it (gate-driven kaleidoscope)', () => {
    const st = makeBentboxMirrorGateState();
    let mirrorX = 0;
    const pulse = (v: number) => {
      if (bentboxMirrorGateTick(st.x, v)) mirrorX = mirrorX >= 0.5 ? 0 : 1;
    };
    pulse(0.8); expect(mirrorX).toBe(1); // first edge → on
    pulse(0.0);
    pulse(0.8); expect(mirrorX).toBe(0); // second edge → off
    pulse(0.0);
    pulse(0.8); expect(mirrorX).toBe(1); // third edge → on
  });
});
