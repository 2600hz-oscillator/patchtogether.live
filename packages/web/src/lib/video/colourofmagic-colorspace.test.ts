// packages/web/src/lib/video/colourofmagic-colorspace.test.ts
//
// Pure-core correctness gate for COLOUR OF MAGIC. Known-value + round-trip
// property tests over the colorspace math the GLSL mirrors. This — NOT the
// SwiftShader GPU — is where colorspace correctness is pinned.

import { describe, it, expect } from 'vitest';
import {
  W601,
  rgb2ydbdr,
  ydbdr2rgb,
  packYdbdr,
  unpackYdbdr,
  rgb2yiq,
  yiq2rgb,
  packYiq,
  unpackYiq,
  rgb2yccSs,
  yccSs2rgb,
  rgb2hsv,
  hsv2rgb,
  rgb2hsl,
  hsl2rgb,
  adj,
  adjHue,
  packColor01,
  unpackColor01,
  rgbChannels,
  applyPalette,
  rgbBlock,
  ydbdrBlock,
  ydbdrChannels,
  hsvBlock,
  hsvChannels,
  yiqBlock,
  yiqChannels,
  yccSsBlock,
  yccSsChannels,
  outputFor,
  type Vec3,
  type BlockParams,
} from './colourofmagic-colorspace';

const near = (a: number, b: number, tol = 1e-4): void => {
  expect(Math.abs(a - b), `${a} ≈ ${b} (±${tol})`).toBeLessThanOrEqual(tol);
};
const nearVec = (a: Vec3, b: Vec3, tol = 1e-4): void => {
  near(a[0], b[0], tol);
  near(a[1], b[1], tol);
  near(a[2], b[2], tol);
};

// A sampled RGB cube for round-trip properties.
const CUBE: Vec3[] = [];
for (const r of [0, 0.25, 0.5, 0.75, 1]) {
  for (const g of [0, 0.33, 0.66, 1]) {
    for (const b of [0, 0.5, 1]) CUBE.push([r, g, b]);
  }
}

/** Identity BlockParams (no adjustment, no override, CLAMP, HSV, no palette). */
function identityParams(over: Partial<BlockParams> = {}): BlockParams {
  return {
    biasR: 0, biasG: 0, biasB: 0,
    biasY: 0, biasDb: 0, biasDr: 0,
    biasH: 0, biasS: 0, biasV: 0,
    biasYiqY: 0, biasYiqI: 0, biasYiqQ: 0,
    biasYccY: 0, biasYccCb: 0, biasYccCr: 0,
    overR: false, overG: false, overB: false,
    overY: false, overDb: false, overDr: false,
    overS: false, overV: false,
    overYiqY: false, overYiqI: false, overYiqQ: false,
    overYccY: false, overYccCb: false, overYccCr: false,
    hsl: false,
    replace: false,
    palR: [1, 0, 0], palG: [0, 1, 0], palB: [0, 0, 1],
    monoR: null, monoG: null, monoB: null,
    monoY: null, monoDb: null, monoDr: null,
    monoH: null, monoS: null, monoV: null,
    monoYiqY: null, monoYiqI: null, monoYiqQ: null,
    monoYccY: null, monoYccCb: null, monoYccCr: null,
    ...over,
  };
}

describe('COLOUR OF MAGIC — YDbDr (SECAM)', () => {
  it('white → Y=1, Db=Dr=0', () => {
    nearVec(rgb2ydbdr([1, 1, 1]), [1, 0, 0]);
  });
  it('pure blue → Db ≈ +1.333 (blue-yellow axis extreme)', () => {
    const [y, db, dr] = rgb2ydbdr([0, 0, 1]);
    near(y, 0.114);
    near(db, 1.333);
    near(dr, 0.217);
  });
  it('pure red → Dr ≈ −1.333 (red-cyan axis extreme)', () => {
    const [y, db, dr] = rgb2ydbdr([1, 0, 0]);
    near(y, 0.299);
    near(db, -0.45);
    near(dr, -1.333);
  });
  it('ydbdr2rgb inverts rgb2ydbdr across the cube (no packing)', () => {
    // ~1.2e-4 residual is inherent to the ROUNDED SECAM constants (the GLSL
    // carries the identical constants, so this is the true fidelity, not a bug).
    for (const c of CUBE) nearVec(ydbdr2rgb(rgb2ydbdr(c)), c, 5e-4);
  });
  it('pack/unpack is an inverse with 0.5 pedestal + 0.375 scale', () => {
    expect(packYdbdr([1, 0, 0])).toEqual([1, 0.5, 0.5]); // Y identity, chroma → pedestal
    nearVec(unpackYdbdr(packYdbdr([0.5, 1.2, -0.9])), [0.5, 1.2, -0.9], 2e-4);
  });
  it('full RGB→YDbDr→pack→unpack→RGB round-trips across the cube', () => {
    for (const c of CUBE) {
      const rt = ydbdrBlock(c, identityParams());
      nearVec(rt, c, 1e-3);
    }
  });
});

describe('COLOUR OF MAGIC — HSV', () => {
  it('pure red → HSV(0, 1, 1)', () => nearVec(rgb2hsv([1, 0, 0]), [0, 1, 1]));
  it('pure green → HSV(1/3, 1, 1)', () => nearVec(rgb2hsv([0, 1, 0]), [1 / 3, 1, 1]));
  it('pure blue → HSV(2/3, 1, 1)', () => nearVec(rgb2hsv([0, 0, 1]), [2 / 3, 1, 1]));
  it('grey → S=0, V=level', () => {
    const [h, s, v] = rgb2hsv([0.5, 0.5, 0.5]);
    near(s, 0);
    near(v, 0.5);
    void h;
  });
  it('hsv2rgb inverts rgb2hsv across the cube', () => {
    for (const c of CUBE) nearVec(hsv2rgb(rgb2hsv(c)), c, 1e-4);
  });
});

describe('COLOUR OF MAGIC — HSL', () => {
  it('pure red → HSL(0, 1, 0.5)', () => nearVec(rgb2hsl([1, 0, 0]), [0, 1, 0.5]));
  it('white → L=1, S=0', () => {
    const [, s, l] = rgb2hsl([1, 1, 1]);
    near(s, 0);
    near(l, 1);
  });
  it('50% grey → L=0.5, S=0', () => {
    const [, s, l] = rgb2hsl([0.5, 0.5, 0.5]);
    near(s, 0);
    near(l, 0.5);
  });
  it('same HUE as HSV but different L vs V (V=max, L=(max+min)/2)', () => {
    const c: Vec3 = [0.8, 0.2, 0.2];
    const hsv = rgb2hsv(c);
    const hsl = rgb2hsl(c);
    near(hsv[0], hsl[0]); // hue matches
    near(hsv[2], 0.8); // V = max
    near(hsl[2], 0.5); // L = (0.8+0.2)/2
    expect(hsl[2]).not.toBeCloseTo(hsv[2], 3);
  });
  it('hsl2rgb inverts rgb2hsl across the cube', () => {
    for (const c of CUBE) nearVec(hsl2rgb(rgb2hsl(c)), c, 1e-4);
  });
});

describe('COLOUR OF MAGIC — adj / adjHue', () => {
  it('identity at bias=0, no mono, clamp', () => {
    for (const v of [0, 0.25, 0.5, 0.75, 1]) near(adj(v, 0, false, null), v);
  });
  it('CLAMP clips below 0 and above 1', () => {
    near(adj(0.1, -0.5, false, null), 0); // 0.1-0.5 = -0.4 → 0
    near(adj(0.8, 0.5, false, null), 1); // 0.8+0.5 = 1.3 → 1
  });
  it('OVER wraps via fract (1.2→0.2, −0.1→0.9)', () => {
    near(adj(0.9, 0.3, true, null), 0.2); // 1.2 → 0.2
    near(adj(0.1, -0.2, true, null), 0.9); // -0.1 → 0.9
  });
  it('mono override replaces the channel (bias still adds after)', () => {
    // base 0.9 is ignored; mono 0.2 is used, +0.1 bias → 0.3
    near(adj(0.9, 0.1, false, 0.2), 0.3);
  });
  it('adjHue ALWAYS wraps even in "clamp" mode', () => {
    near(adjHue(0.9, 360 * 0.3, null), 0.2); // 0.9 + 0.3 = 1.2 → 0.2
    near(adjHue(0.1, -360 * 0.2, null), 0.9); // 0.1 - 0.2 = -0.1 → 0.9
    near(adjHue(0.5, 180, 0.5), 0.0); // mono 0.5 + 0.5 = 1.0 → 0.0
  });
});

describe('COLOUR OF MAGIC — palette pack/unpack', () => {
  it('packColor01 → 0xRRGGBB, unpack inverts', () => {
    expect(packColor01(1, 0, 0)).toBe(0xff0000);
    expect(packColor01(0, 1, 0)).toBe(0x00ff00);
    expect(packColor01(0, 0, 1)).toBe(0x0000ff);
    nearVec(unpackColor01(0xff0000), [1, 0, 0], 1 / 255 + 1e-6);
    nearVec(unpackColor01(0x336699), [0x33 / 255, 0x66 / 255, 0x99 / 255], 1e-9);
  });
  it('unpack is NaN-safe → black', () => {
    expect(unpackColor01(Number.NaN)).toEqual([0, 0, 0]);
  });
});

describe('COLOUR OF MAGIC — palette REPLACE', () => {
  it('identity picks (pure R/G/B) → passthrough of the RGB block', () => {
    const p = identityParams();
    for (const c of CUBE) nearVec(rgbBlock(c, p), rgbChannels(c, p));
  });
  it('REPLACE off → identity regardless of picks', () => {
    const p = identityParams();
    p.palR = [0, 1, 1]; // cyan
    p.palG = [1, 0, 1]; // magenta
    p.palB = [1, 1, 0]; // yellow
    p.replace = false;
    nearVec(applyPalette([1, 0, 0], p), [1, 0, 0]);
  });
  it('REPLACE remaps a pure channel to its picked colour (duotone/tritone)', () => {
    const p = identityParams();
    p.replace = true;
    p.palR = [0, 1, 1]; // R channel → cyan
    p.palG = [1, 0, 1]; // G channel → magenta
    p.palB = [1, 1, 0]; // B channel → yellow
    // pure-red image (channel a = [1,0,0]) → palR = cyan
    nearVec(applyPalette([1, 0, 0], p), [0, 1, 1]);
    // pure-green channel → magenta
    nearVec(applyPalette([0, 1, 0], p), [1, 0, 1]);
    // white channel → sum of picks, clamped conceptually (raw weighted sum)
    nearVec(applyPalette([1, 1, 1], p), [2, 2, 2]);
  });
  it('composes with a channel override (override feeds the remap)', () => {
    const p = identityParams();
    p.replace = true;
    p.palR = [0, 1, 1];
    p.monoR = 1; // force R channel to 1 via override, G/B = 0 for a black src
    const out = rgbBlock([0, 0, 0], p);
    nearVec(out, [0, 1, 1]); // overridden R=1 → cyan
  });
});

describe('COLOUR OF MAGIC — YIQ (NTSC composite)', () => {
  it('white → Y=1, I=Q=0 (packed 1, 0.5, 0.5)', () => {
    nearVec(rgb2yiq([1, 1, 1]), [1, 0, 0]);
    nearVec(packYiq(rgb2yiq([1, 1, 1])), [1, 0.5, 0.5]);
  });
  it('pure red → I ≈ +0.5959 (flesh/warmth axis extreme), packs ≈ 1.0', () => {
    const [y, i, q] = rgb2yiq([1, 0, 0]);
    near(y, 0.299);
    near(i, 0.5959);
    near(q, 0.2115);
    near(packYiq([y, i, q])[1], 1.0, 2e-4); // I fills 0..1: 0.5959*0.8391+0.5
  });
  it('grey → I=Q neutral (0.5 pedestal)', () => {
    nearVec(packYiq(rgb2yiq([0.5, 0.5, 0.5])), [0.5, 0.5, 0.5], 1e-6);
  });
  it('pack/unpack is an inverse within epsilon (truncated reciprocals)', () => {
    nearVec(unpackYiq(packYiq([0.5, 0.4, -0.3])), [0.5, 0.4, -0.3], 2e-4);
  });
  it('yiq2rgb inverts rgb2yiq across the cube (no packing)', () => {
    for (const c of CUBE) nearVec(yiq2rgb(rgb2yiq(c)), c, 1e-3);
  });
  it('full RGB→YIQ→pack→unpack→RGB round-trips across the cube (tol 1e-3)', () => {
    // Research verified worst 2.0e-4; the tolerance is the spec-mandated 1e-3.
    for (const c of CUBE) nearVec(yiqBlock(c, identityParams()), c, 1e-3);
  });
  it('I bias warms the picture (moves the orange↔cyan axis; grey no longer neutral)', () => {
    const p = identityParams();
    const grey: Vec3 = [0.5, 0.5, 0.5];
    nearVec(yiqBlock(grey, p), grey, 1e-3); // identity
    p.biasYiqI = 0.2; // push toward orange/warm
    const shifted = yiqBlock(grey, p);
    expect(Math.abs(shifted[0] - shifted[2]), 'R and B diverge on the warmth axis').toBeGreaterThan(0.05);
  });
});

describe('COLOUR OF MAGIC — YCbCr studio-swing (broadcast-legal)', () => {
  it('white luma ≈ 0.922 (235/255 headroom cap), chroma neutral 0.502', () => {
    const [y, cb, cr] = rgb2yccSs([1, 1, 1]);
    near(y, 235 / 255, 1e-4);
    near(cb, 128 / 255, 1e-4);
    near(cr, 128 / 255, 1e-4);
  });
  it('black luma ≈ 0.063 (16/255 footroom floor)', () => {
    near(rgb2yccSs([0, 0, 0])[0], 16 / 255, 1e-4);
  });
  it('neutral chroma pedestal is 128/255 = 0.502 (NOT 0.5)', () => {
    const [, cb, cr] = rgb2yccSs([0.5, 0.5, 0.5]);
    near(cb, 0.5019607, 1e-6);
    near(cr, 0.5019607, 1e-6);
  });
  it('yccSs2rgb inverts rgb2yccSs across the cube (tol 1e-4, verified 5.8e-7)', () => {
    for (const c of CUBE) nearVec(yccSs2rgb(rgb2yccSs(c)), c, 1e-4);
  });
  it('full studio-swing block round-trips across the cube (tol 1e-4)', () => {
    for (const c of CUBE) nearVec(yccSsBlock(c, identityParams()), c, 1e-4);
  });
  it('the ~1.16× legal-range CRUSH: a luma bias is AMPLIFIED on decode', () => {
    const p = identityParams();
    const grey: Vec3 = [0.5, 0.5, 0.5];
    const base = yccSsBlock(grey, p);
    p.biasYccY = 0.1; // +0.1 in the compressed legal space
    const crushed = yccSsBlock(grey, p);
    // decode expands ×255/219 ≈ 1.164, so the luma lifts by MORE than the bias.
    const lift = crushed[0] - base[0];
    expect(lift, 'studio→full expand amplifies the bias (>0.1)').toBeGreaterThan(0.11);
    near(lift, 0.1 * (255 / 219), 1e-3);
  });
});

describe('COLOUR OF MAGIC — mono channel taps (adjusted packed channel)', () => {
  const p = identityParams();
  it('YDbDr taps: Y of white = 1; Db/Dr of white = 0.5 (pedestal)', () => {
    nearVec(outputFor(8, [1, 1, 1], p), [1, 1, 1], 1e-4);
    nearVec(outputFor(9, [1, 1, 1], p), [0.5, 0.5, 0.5], 1e-4);
    nearVec(outputFor(10, [1, 1, 1], p), [0.5, 0.5, 0.5], 1e-4);
  });
  it('HSV taps: H of pure red ≈ 0; S of grey ≈ 0; V of grey = level', () => {
    nearVec(outputFor(11, [1, 0, 0], p), [0, 0, 0], 1e-4); // hue 0 (red also ≡1 at the wrap seam)
    near(outputFor(12, [0.5, 0.5, 0.5], p)[0], 0, 1e-4); // saturation of grey
    near(outputFor(13, [0.5, 0.5, 0.5], p)[0], 0.5, 1e-4); // value = level
  });
  it('YIQ taps: Y of white = 1; I of pure red ≈ 1.0; I/Q of grey = 0.5', () => {
    near(outputFor(15, [1, 1, 1], p)[0], 1, 1e-4);
    near(outputFor(16, [1, 0, 0], p)[0], 1, 2e-4); // I flesh-axis extreme
    near(outputFor(16, [0.5, 0.5, 0.5], p)[0], 0.5, 1e-6);
    near(outputFor(17, [0.5, 0.5, 0.5], p)[0], 0.5, 1e-6);
  });
  it('YCC taps: Y of white ≈ 0.922; Cb/Cr of grey = 0.502', () => {
    near(outputFor(19, [1, 1, 1], p)[0], 235 / 255, 1e-4);
    near(outputFor(20, [0.5, 0.5, 0.5], p)[0], 128 / 255, 1e-4);
    near(outputFor(21, [0.5, 0.5, 0.5], p)[0], 128 / 255, 1e-4);
  });
  it('every tap is grayscale (R=G=B)', () => {
    const c: Vec3 = [0.3, 0.6, 0.8];
    for (const mode of [8, 9, 10, 11, 12, 13, 15, 16, 17, 19, 20, 21]) {
      const [r, g, b] = outputFor(mode, c, p);
      near(r, g, 1e-9);
      near(g, b, 1e-9);
    }
  });
  it('a mono override CLOBBERS the tapped channel (bias adds after)', () => {
    const clob = identityParams({ monoYiqI: 0.75 });
    near(outputFor(16, [0.5, 0.5, 0.5], clob)[0], 0.75, 1e-9); // I tap driven by the override
  });
});

describe('COLOUR OF MAGIC — new-block colour outs (identity → source)', () => {
  it('mode 14 yiq / mode 18 ycc are ≈ source at identity (round-trip)', () => {
    const p = identityParams();
    for (const c of CUBE) {
      nearVec(outputFor(14, c, p), c, 1e-3);
      nearVec(outputFor(18, c, p), c, 1e-4);
    }
  });
});

describe('COLOUR OF MAGIC — outputFor dispatch', () => {
  const p = identityParams();
  it('mode 0 = source passthrough', () => {
    for (const c of CUBE) nearVec(outputFor(0, c, p), c);
  });
  it('mode 1 = RGB block (identity → source at defaults)', () => {
    for (const c of CUBE) nearVec(outputFor(1, c, p), c, 1e-6);
  });
  it('mode 4/5/6 = mono r/g/b of the adjusted channels', () => {
    const c: Vec3 = [0.2, 0.6, 0.9];
    nearVec(outputFor(4, c, p), [0.2, 0.2, 0.2]);
    nearVec(outputFor(5, c, p), [0.6, 0.6, 0.6]);
    nearVec(outputFor(6, c, p), [0.9, 0.9, 0.9]);
  });
  it('mode 7 luma = dot(adjusted rgb, W601), greyscale', () => {
    const c: Vec3 = [0.2, 0.6, 0.9];
    const l = 0.2 * W601[0] + 0.6 * W601[1] + 0.9 * W601[2];
    nearVec(outputFor(7, c, p), [l, l, l]);
  });
  it('mode 2 ydbdr / mode 3 hsv are ≈ source at identity (round-trip)', () => {
    for (const c of CUBE) {
      nearVec(outputFor(2, c, p), c, 1e-3);
      nearVec(outputFor(3, c, p), c, 1e-4);
    }
  });
  it('mode 3 uses HSL when hsl=true (still ≈ source at identity)', () => {
    const ph = identityParams({ hsl: true });
    for (const c of CUBE) nearVec(outputFor(3, c, ph), c, 1e-4);
  });
});

describe('COLOUR OF MAGIC — bias moves the right axis', () => {
  it('rgb bias_r raises red only', () => {
    const p = identityParams();
    p.biasR = 0.4;
    const out = rgbChannels([0.3, 0.3, 0.3], p);
    near(out[0], 0.7);
    near(out[1], 0.3);
    near(out[2], 0.3);
  });
  it('ydbdr Db bias shifts the blue-yellow axis (grey stays grey only at 0)', () => {
    const p = identityParams();
    const grey: Vec3 = [0.5, 0.5, 0.5];
    nearVec(ydbdrBlock(grey, p), grey, 1e-3); // identity
    p.biasDb = 0.2; // push blue-yellow
    const shifted = ydbdrBlock(grey, p);
    // no longer neutral grey — channels diverge
    expect(Math.abs(shifted[2] - shifted[0])).toBeGreaterThan(0.05);
  });
  it('hsv hue bias rotates hue (red → toward green/blue)', () => {
    const p = identityParams();
    p.biasH = 120; // +120° hue
    const out = hsvBlock([1, 0, 0], p);
    // red rotated +120° → green
    nearVec(out, [0, 1, 0], 1e-3);
  });
});
