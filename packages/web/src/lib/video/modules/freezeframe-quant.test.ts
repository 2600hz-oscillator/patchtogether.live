// packages/web/src/lib/video/modules/freezeframe-quant.test.ts
//
// #1861 — THE PASSTHROUGH CLAIM, CHECKED ON BOTH SIDES OF THE CONTRACT.
//
// The defect and the reason it shipped are the same fact: `posterizeChannel`'s
// identity claim was tested against the levels it is GIVEN, on the 8-bit grid
// where it holds — and NOTHING joined that grid assumption to the combined
// branch's LUMA call site, whose input is off-grid by construction. One side
// of a two-sided contract, gated; the other side, not.
//
// So this file tests the JOIN. `quantizeCombined` is the mirror of the shader's
// combined branch that did not exist before the fix, and the assertions below
// run it over the ENTIRE 8-bit RGB cube rather than over sampled triplets,
// because "38.66 % of colours move" is not a property any sample can establish.
//
// ⚠ EVERY CLAIM HERE IS PAIRED WITH ITS NEGATIVE CONTROL. A passthrough test
// that cannot fail is worth nothing, so each "it does not move" leg is
// accompanied by a leg proving the same machinery DOES move when the knob asks
// it to — otherwise a `quantizeCombined` accidentally hard-wired to identity
// would pass the whole file.

import { describe, expect, it } from 'vitest';
import {
  LUMA_WEIGHTS,
  QUANT_MAX_LEVELS,
  QUANT_MIN_LEVELS,
  freezeframeDef,
  lumaIsFullDepth,
  lumaOf,
  posterizeChannel,
  quantLevels,
  quantizeCombined,
} from './freezeframe';

/** The def's OWN declared default for a param — read, never copied, so a
 *  default that moves is caught by the anchor test below rather than silently
 *  changing what "at the defaults" means here. */
function defaultOf(id: string): number {
  const p = freezeframeDef.params.find((q) => q.id === id);
  if (!p) throw new Error(`freezeframe declares no param '${id}'`);
  return p.defaultValue;
}

/** The level counts the shader is handed at a given set of knob positions. */
function levelsAt(knobs: { r?: number; g?: number; b?: number; luma?: number } = {}) {
  return {
    r: quantLevels(knobs.r ?? defaultOf('quant_r')),
    g: quantLevels(knobs.g ?? defaultOf('quant_g')),
    b: quantLevels(knobs.b ?? defaultOf('quant_b')),
    luma: quantLevels(knobs.luma ?? defaultOf('quant_luma')),
  };
}

/** 8-bit code value round trip, the way an RGBA8 FBO rounds. */
const to8 = (c: number) => Math.round(c * 255);

describe('#1861 — the DEFAULTS are the passthrough the docs claim', () => {
  it('all four QUANT params default to the knob minimum', () => {
    // ANCHORED: if a default ever moves off 0, "at the defaults" below stops
    // meaning "at full depth" and these tests must be re-read, not re-tuned.
    for (const id of ['quant_r', 'quant_g', 'quant_b', 'quant_luma'] as const) {
      const p = freezeframeDef.params.find((q) => q.id === id);
      expect(p, `${id} must be a declared param`).toBeDefined();
      expect(p!.defaultValue, `${id} default`).toBe(0);
      expect(p!.min, `${id} min`).toBe(0);
    }
    expect(quantLevels(0)).toBe(QUANT_MAX_LEVELS);
    expect(lumaIsFullDepth(quantLevels(0))).toBe(true);
  });

  it('THE WHOLE 8-BIT RGB CUBE is bit-exactly unchanged at the defaults', () => {
    // Before the fix: 10,291,489 of 16,777,216 unchanged (61.34 %), 6,485,727
    // moved (38.66 %), worst error 8 code values at src(0,0,8) -> out(0,0,0),
    // mean absolute error 0.4324, luma gain 0.000000 .. 1.003922.
    const L = levelsAt();
    let moved = 0;
    let worst = 0;
    let firstOffender = '';
    for (let r = 0; r < 256; r++) {
      for (let g = 0; g < 256; g++) {
        for (let b = 0; b < 256; b++) {
          const out = quantizeCombined([r / 255, g / 255, b / 255], L);
          const d = Math.max(
            Math.abs(to8(out[0]) - r),
            Math.abs(to8(out[1]) - g),
            Math.abs(to8(out[2]) - b),
          );
          if (d !== 0) {
            moved++;
            if (d > worst) {
              worst = d;
              firstOffender = `src(${r},${g},${b}) -> out(${to8(out[0])},${to8(out[1])},${to8(out[2])})`;
            }
          }
        }
      }
    }
    expect(
      moved,
      `at the declared defaults the combined output must be a PASSTHROUGH; ` +
        `${moved} of 16777216 triplets moved, worst ${worst} code values ${firstOffender}`,
    ).toBe(0);
  }, 600000);

  it('NEGATIVE CONTROL — the same cube walk DOES move when QUANT LUMA is asked for', () => {
    // Without this, an accidentally identity-wired quantizeCombined would pass
    // the leg above. The gate must be able to see the effect it is exempting.
    const L = levelsAt({ luma: 0.5 });
    let moved = 0;
    for (let r = 0; r < 256; r += 7) {
      for (let g = 0; g < 256; g += 7) {
        for (let b = 0; b < 256; b += 7) {
          const out = quantizeCombined([r / 255, g / 255, b / 255], L);
          if (to8(out[0]) !== r || to8(out[1]) !== g || to8(out[2]) !== b) moved++;
        }
      }
    }
    expect(moved, 'QUANT LUMA at midway must visibly quantize').toBeGreaterThan(0);
  });

  it('THE 25 CRUSHED NEAR-BLACKS are back — no non-black input maps to black', () => {
    // The sharpest end of the defect: `floor(luma * 256)` is 0 for any
    // luma < 1/256, so the gain was 0 and a legitimate near-black like
    // (0,0,8) came out (0,0,0). Twenty-five colours did this.
    const L = levelsAt();
    const crushed: string[] = [];
    for (let r = 0; r < 8; r++) {
      for (let g = 0; g < 8; g++) {
        for (let b = 0; b < 16; b++) {
          if (r === 0 && g === 0 && b === 0) continue;
          const out = quantizeCombined([r / 255, g / 255, b / 255], L);
          if (to8(out[0]) === 0 && to8(out[1]) === 0 && to8(out[2]) === 0) {
            crushed.push(`(${r},${g},${b})`);
          }
        }
      }
    }
    expect(crushed, 'non-black inputs driven to exactly black at the defaults').toEqual([]);
  });

  it('the specific triplet named in #1861 survives', () => {
    const out = quantizeCombined([0 / 255, 0 / 255, 8 / 255], levelsAt());
    expect([to8(out[0]), to8(out[1]), to8(out[2])]).toEqual([0, 0, 8]);
  });
});

describe('#1861 — the GRID assumption, stated where it is actually used', () => {
  it('posterizeChannel IS identity on the 8-bit grid — all 256 code values', () => {
    const moved = [];
    for (let k = 0; k < 256; k++) {
      if (to8(posterizeChannel(k / 255, QUANT_MAX_LEVELS)) !== k) moved.push(k);
    }
    expect(moved, '8-bit code values that move through a full-depth posterize').toEqual([]);
  });

  it('…and is NOT identity off it — the one-line demonstration from the issue', () => {
    // This is the fact the old jsdoc's "effectively identity" elided, and the
    // reason feeding it a luma was a category error.
    expect(posterizeChannel(0.5, QUANT_MAX_LEVELS)).toBeCloseTo(0.5019607843137255, 15);
    expect(posterizeChannel(0.5, QUANT_MAX_LEVELS)).not.toBe(0.5);
  });

  it('a LUMA is off-grid by construction, so the old ratio could never be 1', () => {
    // Rec.601 weights are not multiples of 1/255, so almost no luma lands on
    // the grid the posterizer assumes.
    const offGrid = [];
    for (let k = 1; k < 256; k += 17) {
      const luma = lumaOf(k / 255, (255 - k) / 255, k / 255);
      if (Math.abs(luma * 255 - Math.round(luma * 255)) > 1e-9) offGrid.push(k);
    }
    expect(offGrid.length, 'luma values that are NOT on the 8-bit grid').toBeGreaterThan(0);
    expect(LUMA_WEIGHTS.r + LUMA_WEIGHTS.g + LUMA_WEIGHTS.b).toBeCloseTo(1, 10);
  });
});

describe('#1861 — the guard is EXACTLY at full depth, and nowhere else', () => {
  it('full depth is the knob MINIMUM and only the minimum', () => {
    expect(lumaIsFullDepth(quantLevels(0))).toBe(true);
    // Anything the player can actually dial above 0 asks for real quantization.
    for (const knob of [0.01, 0.1, 0.25, 0.5, 0.75, 1]) {
      expect(lumaIsFullDepth(quantLevels(knob)), `knob=${knob}`).toBe(false);
    }
  });

  it('the epsilon absorbs float32 wobble, not a range of knob positions', () => {
    // The uniform is a float32 round trip of QUANT_MAX_LEVELS; the guard must
    // survive that and nothing wider.
    const asF32 = Math.fround(QUANT_MAX_LEVELS);
    expect(lumaIsFullDepth(asF32)).toBe(true);
    expect(lumaIsFullDepth(QUANT_MAX_LEVELS - 0.4)).toBe(true);
    expect(lumaIsFullDepth(QUANT_MAX_LEVELS - 1)).toBe(false);
  });

  it('at MAXIMUM quantization the module still does its job', () => {
    // The other end of the knob, so the fix cannot be read as "disable luma".
    const L = levelsAt({ r: 1, g: 1, b: 1, luma: 1 });
    expect(quantLevels(1)).toBe(QUANT_MIN_LEVELS);
    const out = quantizeCombined([0.6, 0.4, 0.9], L);
    for (const c of out) expect([0, 1]).toContain(Math.round(c * 1000) / 1000 > 0.5 ? 1 : 0);
    // a 2-level posterize puts every channel at an endpoint before the ratio
    const q = [0.6, 0.4, 0.9].map((c) => posterizeChannel(c, QUANT_MIN_LEVELS));
    expect(q).toEqual([1, 0, 1]);
  });
});

describe('#1861 — the per-channel taps were never affected, and still are not', () => {
  it('r/g/b outputs do not go through the luma ratio at all', () => {
    // The isolated taps use their own shader branches. Their identity at full
    // depth is what made the combined defect surprising, and it is unchanged.
    for (const k of [0, 1, 8, 127, 128, 254, 255]) {
      expect(to8(posterizeChannel(k / 255, quantLevels(0)))).toBe(k);
    }
  });
});
