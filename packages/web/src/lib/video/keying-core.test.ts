// packages/web/src/lib/video/keying-core.test.ts
//
// Pure unit tests for the shared keying core (the TS mirrors ARE the source
// of truth; GLSL_KEY_HELPERS is a line-for-line port whose numeric constants
// are template-interpolated from the SAME exports, so lockstep holds by
// construction). Includes:
//   - 5-point range proofs per control path (threshold / softness / invert /
//     despill amount / composite alpha),
//   - bit-compatibility of kcLumaMask with LUMAKEY's historical inline
//     expression,
//   - the §11 DEFAULT-THRESHOLD CALIBRATION PROBES pinned against the
//     SHIPPED chromakey defaults (read from chromakeyDef, so a default
//     change re-runs the calibration):
//       pure key (0,1,0)                   d = 0.000  -> KEYED
//       realistic screen (0.2,0.8,0.3)     d = 0.454  -> KEYED
//       half-brightness key (0,0.5,0)      d = 0.500  -> KEYED
//       green-cast subject (0.6,0.75,0.55) d = 0.828  -> KEPT (F-C1)
//       neutral grays                      d = 1.000  -> KEPT

import { describe, it, expect } from 'vitest';
import {
  KEY_LUMA_WEIGHTS,
  KEY_CB_SCALE,
  KEY_CR_SCALE,
  KEY_SOFT_MIN,
  KEY_ACHROMATIC_FLOOR,
  GLSL_KEY_HELPERS,
  kcSmoothstep,
  kcLuma,
  kcChroma,
  kcLumaMask,
  kcChromaDistance,
  kcChromaMask,
  kcDespill,
  kcComposite,
  type KcVec3,
} from './keying-core';
import { chromakeyDef } from './modules/chromakey';
import { MAPPER_LUMA_WEIGHTS } from './modules/mapper';

const GREEN_KEY: KcVec3 = [0, 1, 0];
const BLUE_KEY: KcVec3 = [0, 0, 1];
const RED_KEY: KcVec3 = [1, 0, 0];

// The SHIPPED chromakey defaults (the calibration target).
const DEF_THR = chromakeyDef.params.find((p) => p.id === 'threshold')!.defaultValue;
const DEF_SOFT = chromakeyDef.params.find((p) => p.id === 'softness')!.defaultValue;

describe('constants + GLSL lockstep', () => {
  it('Rec. 601 weights sum to 1 and match the app-wide flavor (MAPPER)', () => {
    expect(KEY_LUMA_WEIGHTS[0] + KEY_LUMA_WEIGHTS[1] + KEY_LUMA_WEIGHTS[2]).toBeCloseTo(1, 12);
    expect([...KEY_LUMA_WEIGHTS]).toEqual([...MAPPER_LUMA_WEIGHTS]);
  });

  it('GLSL declares every kc* helper, with constants interpolated from the TS exports', () => {
    for (const fn of ['kcLuma', 'kcChroma', 'kcLumaMask', 'kcChromaMask', 'kcDespill', 'kcComposite']) {
      expect(GLSL_KEY_HELPERS, `missing GLSL fn ${fn}`).toContain(`${fn}(`);
    }
    // Lockstep holds BY CONSTRUCTION (template interpolation); these checks
    // only guard that the interpolation slots weren't replaced by literals.
    expect(GLSL_KEY_HELPERS).toContain(
      `vec3(${KEY_LUMA_WEIGHTS[0]}, ${KEY_LUMA_WEIGHTS[1]}, ${KEY_LUMA_WEIGHTS[2]})`,
    );
    expect(GLSL_KEY_HELPERS).toContain(`* ${KEY_CB_SCALE}`);
    expect(GLSL_KEY_HELPERS).toContain(`* ${KEY_CR_SCALE}`);
    expect(GLSL_KEY_HELPERS).toContain(`${KEY_SOFT_MIN}`);
    expect(GLSL_KEY_HELPERS).toContain(`${KEY_ACHROMATIC_FLOOR}`);
    // Every interpolated numeric must be a valid GLSL float literal (a bare
    // "1e-3" or integer-looking "1" would not compile as float in all slots).
    for (const n of [
      ...KEY_LUMA_WEIGHTS, KEY_CB_SCALE, KEY_CR_SCALE, KEY_SOFT_MIN, KEY_ACHROMATIC_FLOOR,
    ]) {
      expect(String(n), `${n} must interpolate with a decimal point`).toMatch(/^\d+\.\d+$/);
    }
  });
});

describe('kcLuma — Rec. 601 luma', () => {
  it('5-point gray ramp: luma of (l,l,l) is l', () => {
    for (const l of [0, 0.25, 0.5, 0.75, 1]) {
      expect(kcLuma([l, l, l])).toBeCloseTo(l, 12);
    }
  });
  it('weights green > red > blue', () => {
    expect(kcLuma([0, 1, 0])).toBeGreaterThan(kcLuma([1, 0, 0]));
    expect(kcLuma([1, 0, 0])).toBeGreaterThan(kcLuma([0, 0, 1]));
  });
});

describe('kcChroma — full-swing Rec. 601 chroma plane', () => {
  it('neutral grays have ZERO chroma (5 points)', () => {
    for (const l of [0, 0.25, 0.5, 0.75, 1]) {
      const [cb, cr] = kcChroma([l, l, l]);
      expect(cb).toBeCloseTo(0, 12);
      expect(cr).toBeCloseTo(0, 12);
    }
  });
  it('pure key green matches the hand-computed coordinates', () => {
    const [cb, cr] = kcChroma(GREEN_KEY);
    // Y = 0.587; Cb = -0.587*0.564; Cr = -0.587*0.713.
    expect(cb).toBeCloseTo(-0.587 * KEY_CB_SCALE, 12);
    expect(cr).toBeCloseTo(-0.587 * KEY_CR_SCALE, 12);
  });
  it('chroma scales LINEARLY with brightness for a pure hue', () => {
    const [cb1, cr1] = kcChroma(GREEN_KEY);
    const [cbH, crH] = kcChroma([0, 0.5, 0]);
    expect(cbH).toBeCloseTo(cb1 * 0.5, 12);
    expect(crH).toBeCloseTo(cr1 * 0.5, 12);
  });
});

describe('kcLumaMask — bit-compatible with LUMAKEY’s historical expression', () => {
  // The exact inline expression lumakey.ts carried before the core swap.
  const legacy = (luma: number, thr: number, soft: number, invert: number): number => {
    const tol = Math.min(Math.max(thr, 0), 1);
    const s = Math.max(Math.min(Math.max(soft, 0), 0.5), 0.001);
    const a = kcSmoothstep(tol - s, tol + s, luma);
    return invert > 0.5 ? 1 - a : a;
  };

  it('EQUALS the legacy expression across the full control grid', () => {
    for (const thr of [0, 0.25, 0.5, 0.75, 1]) {
      for (const soft of [0, 0.05, 0.1, 0.25, 0.5]) {
        for (const luma of [0, 0.25, 0.5, 0.75, 1]) {
          for (const invert of [0, 1]) {
            expect(kcLumaMask(luma, thr, soft, invert)).toBe(legacy(luma, thr, soft, invert));
          }
        }
      }
    }
  });

  it('threshold path (5 points, luma 0.5, soft 0.05): monotone non-increasing', () => {
    const vals = [0, 0.25, 0.5, 0.75, 1].map((thr) => kcLumaMask(0.5, thr, 0.05, 0));
    expect(vals[0]).toBe(1);          // thr well below luma -> opaque
    expect(vals[2]).toBeCloseTo(0.5); // centered window at luma
    expect(vals[4]).toBe(0);          // thr well above luma -> matted
    for (let i = 1; i < vals.length; i++) expect(vals[i]!).toBeLessThanOrEqual(vals[i - 1]!);
  });

  it('softness path (5 points): the window widens around thr 0.5', () => {
    // Just above the threshold: wider soft pulls alpha from 1 toward 0.5.
    const x = 0.55;
    const vals = [0, 0.05, 0.1, 0.25, 0.5].map((soft) => kcLumaMask(x, 0.5, soft, 0));
    expect(vals[0]).toBe(1); // soft 0 (floored 0.001) -> hard cut, x above thr
    for (let i = 1; i < vals.length; i++) expect(vals[i]!).toBeLessThanOrEqual(vals[i - 1]!);
    expect(vals[4]!).toBeGreaterThan(0.5); // still above the midpoint
  });

  it('invert flips exactly (5 points)', () => {
    for (const luma of [0, 0.25, 0.5, 0.75, 1]) {
      expect(kcLumaMask(luma, 0.5, 0.1, 1)).toBeCloseTo(1 - kcLumaMask(luma, 0.5, 0.1, 0), 12);
    }
  });

  it('defensive clamps: out-of-range thr/soft behave as the range edges', () => {
    expect(kcLumaMask(0.5, -5, 0.1, 0)).toBe(kcLumaMask(0.5, 0, 0.1, 0));
    expect(kcLumaMask(0.5, 7, 0.1, 0)).toBe(kcLumaMask(0.5, 1, 0.1, 0));
    expect(kcLumaMask(0.5, 0.5, -1, 0)).toBe(kcLumaMask(0.5, 0.5, 0, 0));
    expect(kcLumaMask(0.5, 0.5, 3, 0)).toBe(kcLumaMask(0.5, 0.5, 0.5, 0));
  });
});

describe('kcChromaDistance — the normalized key-relative metric', () => {
  it('is 0 at the key colour (green AND blue keys — symmetric)', () => {
    expect(kcChromaDistance(GREEN_KEY, GREEN_KEY)).toBe(0);
    expect(kcChromaDistance(BLUE_KEY, BLUE_KEY)).toBe(0);
    expect(kcChromaDistance(RED_KEY, RED_KEY)).toBe(0);
  });

  it('is EXACTLY 1.0 for any neutral gray vs any saturated key', () => {
    for (const l of [0, 0.25, 0.5, 0.75, 1]) {
      expect(kcChromaDistance([l, l, l], GREEN_KEY)).toBeCloseTo(1, 12);
      expect(kcChromaDistance([l, l, l], BLUE_KEY)).toBeCloseTo(1, 12);
    }
  });

  it('matches the §11 hand-computed probe distances', () => {
    expect(kcChromaDistance([0.2, 0.8, 0.3], GREEN_KEY)).toBeCloseTo(0.4538, 3);
    expect(kcChromaDistance([0, 0.5, 0], GREEN_KEY)).toBeCloseTo(0.5, 12);
    expect(kcChromaDistance([0.6, 0.75, 0.55], GREEN_KEY)).toBeCloseTo(0.828, 3);
    // red / blue are chromatically FAR from a green key (d > 1).
    expect(kcChromaDistance(RED_KEY, GREEN_KEY)).toBeGreaterThan(1.5);
    expect(kcChromaDistance(BLUE_KEY, GREEN_KEY)).toBeGreaterThan(1.5);
  });

  it('half-brightness of a pure key sits at exactly d = 1 - brightness', () => {
    for (const g of [0.25, 0.5, 0.75]) {
      expect(kcChromaDistance([0, g, 0], GREEN_KEY)).toBeCloseTo(1 - g, 12);
    }
  });
});

describe('kcChromaMask — §11 calibration probes at the SHIPPED defaults', () => {
  it(`shipped defaults are thr=0.5 soft=0.08 (probe target)`, () => {
    expect(DEF_THR).toBe(0.5);
    expect(DEF_SOFT).toBe(0.08);
  });

  it('KEYED at defaults: pure key, realistic screen, half-brightness key', () => {
    expect(kcChromaMask(GREEN_KEY, GREEN_KEY, DEF_THR, DEF_SOFT, 0)).toBe(0);
    expect(kcChromaMask([0.2, 0.8, 0.3], GREEN_KEY, DEF_THR, DEF_SOFT, 0)).toBe(0); // d=0.454
    expect(kcChromaMask([0, 0.5, 0], GREEN_KEY, DEF_THR, DEF_SOFT, 0)).toBeCloseTo(0, 6); // d=0.500
  });

  it('KEPT at defaults: the F-C1 green-cast subject, neutral grays, red, blue', () => {
    expect(kcChromaMask([0.6, 0.75, 0.55], GREEN_KEY, DEF_THR, DEF_SOFT, 0)).toBeCloseTo(1, 12); // d=0.828
    for (const l of [0.25, 0.5, 0.75]) {
      expect(kcChromaMask([l, l, l], GREEN_KEY, DEF_THR, DEF_SOFT, 0)).toBeCloseTo(1, 12); // d=1.0
    }
    expect(kcChromaMask(RED_KEY, GREEN_KEY, DEF_THR, DEF_SOFT, 0)).toBe(1);
    expect(kcChromaMask(BLUE_KEY, GREEN_KEY, DEF_THR, DEF_SOFT, 0)).toBe(1);
  });

  it('threshold path (5 points, realistic screen pixel): keyed above d, kept below', () => {
    // d = 0.454 for (0.2,0.8,0.3): thr sweeps across it.
    const vals = [0, 0.25, 0.5, 0.75, 1].map((thr) =>
      kcChromaMask([0.2, 0.8, 0.3], GREEN_KEY, thr, DEF_SOFT, 0),
    );
    expect(vals[0]).toBe(1); // thr 0: everything except the key survives
    expect(vals[1]).toBe(1); // 0.25 + soft < 0.454 -> kept
    expect(vals[2]).toBe(0); // 0.5 > 0.454 -> keyed
    expect(vals[3]).toBe(0);
    expect(vals[4]).toBe(0);
    for (let i = 1; i < vals.length; i++) expect(vals[i]!).toBeLessThanOrEqual(vals[i - 1]!);
  });

  it('softness path (5 points): feathers the band edge above thr', () => {
    // Pixel just above the default threshold: d = 0.5 exactly at thr 0.46.
    const c: KcVec3 = [0, 0.5, 0];
    const vals = [0, 0.05, 0.1, 0.25, 0.5].map((soft) => kcChromaMask(c, GREEN_KEY, 0.46, soft, 0));
    expect(vals[0]).toBe(1); // hard cut: d 0.5 > thr 0.46
    for (let i = 1; i < vals.length; i++) expect(vals[i]!).toBeLessThanOrEqual(vals[i - 1]!);
    expect(vals[4]!).toBeLessThan(0.2); // wide feather swallows it
  });

  it('invert flips exactly (5 probe colors)', () => {
    const probes: KcVec3[] = [GREEN_KEY, [0.2, 0.8, 0.3], [0, 0.5, 0], [0.6, 0.75, 0.55], [0.5, 0.5, 0.5]];
    for (const c of probes) {
      expect(kcChromaMask(c, GREEN_KEY, DEF_THR, DEF_SOFT, 1)).toBeCloseTo(
        1 - kcChromaMask(c, GREEN_KEY, DEF_THR, DEF_SOFT, 0),
        12,
      );
    }
  });

  it('blue-screen symmetry: the same calibration story holds for a blue key', () => {
    expect(kcChromaMask(BLUE_KEY, BLUE_KEY, DEF_THR, DEF_SOFT, 0)).toBe(0);
    expect(kcChromaMask([0, 0, 0.5], BLUE_KEY, DEF_THR, DEF_SOFT, 0)).toBeCloseTo(0, 6);
    expect(kcChromaMask([0.5, 0.5, 0.5], BLUE_KEY, DEF_THR, DEF_SOFT, 0)).toBeCloseTo(1, 12);
    expect(kcChromaMask(GREEN_KEY, BLUE_KEY, DEF_THR, DEF_SOFT, 0)).toBe(1);
  });

  it('ACHROMATIC KEY (documented): all neutrals key out together', () => {
    // A gray key has ~zero chroma; the floored normalizer means every neutral
    // measures as "at the key" — black cannot be separated from white.
    const grayKey: KcVec3 = [0.5, 0.5, 0.5];
    for (const l of [0, 0.5, 1]) {
      expect(kcChromaMask([l, l, l], grayKey, DEF_THR, DEF_SOFT, 0)).toBe(0);
    }
    // …while saturated pixels still survive (their chroma is far from zero).
    expect(kcChromaMask(GREEN_KEY, grayKey, DEF_THR, DEF_SOFT, 0)).toBe(1);
  });

  it('defensive clamps: out-of-range thr/soft behave as the range edges', () => {
    const c: KcVec3 = [0.2, 0.8, 0.3];
    expect(kcChromaMask(c, GREEN_KEY, -5, 0.08, 0)).toBe(kcChromaMask(c, GREEN_KEY, 0, 0.08, 0));
    expect(kcChromaMask(c, GREEN_KEY, 7, 0.08, 0)).toBe(kcChromaMask(c, GREEN_KEY, 1, 0.08, 0));
    expect(kcChromaMask(c, GREEN_KEY, 0.5, -1, 0)).toBe(kcChromaMask(c, GREEN_KEY, 0.5, 0, 0));
    expect(kcChromaMask(c, GREEN_KEY, 0.5, 3, 0)).toBe(kcChromaMask(c, GREEN_KEY, 0.5, 0.5, 0));
  });
});

describe('kcDespill — dominant-channel min-limit', () => {
  it('EXACT identity at amount = 0 (no (0.5+0.5*alpha) fudge — §11 7b)', () => {
    const colors: KcVec3[] = [[0.8, 0.9, 0.3], [0.6, 0.75, 0.55], [0, 1, 0], [1, 1, 1], [0.2, 0.1, 0.9]];
    for (const c of colors) {
      const out = kcDespill(c, GREEN_KEY, 0);
      expect(out[0]).toBe(c[0]);
      expect(out[1]).toBe(c[1]);
      expect(out[2]).toBe(c[2]);
    }
  });

  it('green key: g -> mix(g, min(g, max(r, b)), amount) — 5-point amount lerp', () => {
    // (0.8, 0.9, 0.3): lim = max(0.8, 0.3) = 0.8.
    const expected = [0.9, 0.875, 0.85, 0.825, 0.8];
    [0, 0.25, 0.5, 0.75, 1].forEach((amt, i) => {
      const [r, g, b] = kcDespill([0.8, 0.9, 0.3], GREEN_KEY, amt);
      expect(r).toBe(0.8);
      expect(g).toBeCloseTo(expected[i]!, 12);
      expect(b).toBe(0.3);
    });
  });

  it('the F-C1 subject despills to the e2e-expected color at amount 0.5', () => {
    // (0.6, 0.75, 0.55): lim = 0.6 -> g' = mix(0.75, 0.6, 0.5) = 0.675
    // = (153, 172, 140) on 0..255 — the band the e2e asserts.
    const [r, g, b] = kcDespill([0.6, 0.75, 0.55], GREEN_KEY, 0.5);
    expect(r).toBeCloseTo(0.6, 12);
    expect(g).toBeCloseTo(0.675, 12);
    expect(b).toBeCloseTo(0.55, 12);
  });

  it('a non-spilled color is untouched at ANY amount (min-limit, not desat)', () => {
    for (const amt of [0, 0.25, 0.5, 0.75, 1]) {
      expect(kcDespill([1, 1, 0], GREEN_KEY, amt)).toEqual([1, 1, 0]); // yellow: g <= max(r,b)
      expect(kcDespill([1, 0, 0], GREEN_KEY, amt)).toEqual([1, 0, 0]); // red: g already 0…
    }
  });

  it('key dominance picks the limited channel: blue key limits b, red key limits r', () => {
    expect(kcDespill([0.3, 0.4, 0.9], BLUE_KEY, 1)).toEqual([0.3, 0.4, 0.4]);
    expect(kcDespill([0.9, 0.4, 0.3], RED_KEY, 1)).toEqual([0.4, 0.4, 0.3]);
    // ties resolve green > blue > red: a white key behaves as a green key.
    expect(kcDespill([0.8, 0.9, 0.3], [1, 1, 1], 1)).toEqual([0.8, 0.8, 0.3]);
  });

  it('defensive clamp: amount outside 0..1 behaves as the range edges', () => {
    expect(kcDespill([0.8, 0.9, 0.3], GREEN_KEY, -1)).toEqual(kcDespill([0.8, 0.9, 0.3], GREEN_KEY, 0));
    expect(kcDespill([0.8, 0.9, 0.3], GREEN_KEY, 2)).toEqual(kcDespill([0.8, 0.9, 0.3], GREEN_KEY, 1));
  });
});

describe('kcComposite — mix(bg, fg, alpha)', () => {
  const bg: KcVec3 = [0, 0, 1];
  const fg: KcVec3 = [1, 0.5, 0];
  it('alpha endpoints are exact; 5-point lerp', () => {
    expect(kcComposite(bg, fg, 0)).toEqual([0, 0, 1]);
    expect(kcComposite(bg, fg, 1)).toEqual([1, 0.5, 0]);
    [0.25, 0.5, 0.75].forEach((a) => {
      const out = kcComposite(bg, fg, a);
      expect(out[0]).toBeCloseTo(a, 12);
      expect(out[1]).toBeCloseTo(0.5 * a, 12);
      expect(out[2]).toBeCloseTo(1 - a, 12);
    });
  });
});
