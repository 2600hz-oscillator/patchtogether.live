// packages/web/src/lib/video/modules/quadralogical.test.ts
//
// QUADRALOGICAL unit spec. Pure (no GL).
//
// Covers:
//   * def shape (4 video-in, out+preview video-out, CV ports present,
//     paramTarget invariant, transition discrete 0..7)
//   * quadWeights parity: corners → one-hot; edges → 2-input; center → balanced
//     4-way; diamond zone → all-4 nonzero; sum==1 + all>=0 across a grid sweep;
//     GLSL-vs-TS shape parity (the documented out = Σ wi·ci cross-dissolve)
//   * normalizeInputs forward-fill
//
// HARD CONSTRAINT check: this module re-implements any shared algorithm; it
// never imports TOYBOX / chromakey / lumakey. The import below is only the
// module's own def + pure helpers.

import { describe, it, expect } from 'vitest';
import {
  quadralogicalDef,
  quadWeights,
  normalizeInputs,
  clampJoy,
  smoothstep,
  TRANSITIONS,
  EFFECT_PARAMS,
  QUADRALOGICAL_DEFAULT_MARGIN,
  QUADRALOGICAL_DEFAULT_SHARP,
} from './quadralogical';

const M = QUADRALOGICAL_DEFAULT_MARGIN;
const K = QUADRALOGICAL_DEFAULT_SHARP;

function sum(w: readonly number[]): number {
  return w.reduce((a, b) => a + b, 0);
}

// The renormalize adds a +1e-6 guard (so GLSL never divides 0/0 at an exact
// corner). That guard inflates the denominator by up to ~1e-6/S, which at a
// corner/edge (where S of the surviving weights is ~1) shows as a ~1e-6..1e-5
// shortfall below 1.0. So weight-sum / corner-mass assertions use precision 4
// (|diff| < 5e-5) — well inside the guard's known error budget, still tight
// enough to catch any real partition-of-unity break. (PREC = decimal digits.)
const PREC = 4;

describe('quadralogicalDef shape', () => {
  it('declares type "quadralogical" + video domain + utilities category', () => {
    expect(quadralogicalDef.type).toBe('quadralogical');
    expect(quadralogicalDef.domain).toBe('video');
    expect(quadralogicalDef.category).toBe('utilities');
    expect(quadralogicalDef.label).toBe('QUADRALOGICAL');
  });

  it('palette = Video modules / Utilities (firing unit gate for new video modules)', () => {
    expect(quadralogicalDef.palette).toEqual({ top: 'Video modules', sub: 'Utilities' });
  });

  it('declares exactly 4 video inputs in1..in4', () => {
    const videoInputs = quadralogicalDef.inputs.filter((p) => p.type === 'video');
    expect(videoInputs.map((p) => p.id)).toEqual(['in1', 'in2', 'in3', 'in4']);
  });

  it('declares TWO video outputs: out (canonical=MIX) + preview', () => {
    expect(quadralogicalDef.outputs.map((o) => o.id)).toEqual(['out', 'preview']);
    for (const o of quadralogicalDef.outputs) expect(o.type).toBe('video');
  });

  it('out is the FIRST output (canonical surface.texture convention)', () => {
    expect(quadralogicalDef.outputs[0]!.id).toBe('out');
  });

  it('exposes pos_x / pos_y / diamond_margin / blend_sharp params with the documented defaults', () => {
    const byId = new Map(quadralogicalDef.params.map((p) => [p.id, p]));
    expect(byId.get('pos_x')).toMatchObject({ min: -1, max: 1, curve: 'linear', defaultValue: 0 });
    expect(byId.get('pos_y')).toMatchObject({ min: -1, max: 1, curve: 'linear', defaultValue: 0 });
    expect(byId.get('diamond_margin')?.defaultValue).toBe(0.5);
    expect(byId.get('blend_sharp')?.defaultValue).toBe(3);
  });

  it('transition param is discrete and spans 0..7 (all 8 modes reachable)', () => {
    const t = quadralogicalDef.params.find((p) => p.id === 'transition');
    expect(t?.curve).toBe('discrete');
    expect(t?.min).toBe(0);
    expect(t?.max).toBe(7);
  });

  it('has a hidden freeze param (0..1) for VRT deterministic capture', () => {
    const f = quadralogicalDef.params.find((p) => p.id === 'freeze');
    expect(f).toMatchObject({ min: 0, max: 1, curve: 'linear', defaultValue: 0 });
  });

  it('every CV input whose id matches a param declares paramTarget == id (cv-paramtarget invariant)', () => {
    const paramIds = new Set(quadralogicalDef.params.map((p) => p.id));
    for (const port of quadralogicalDef.inputs.filter((i) => i.type === 'cv')) {
      if (!paramIds.has(port.id)) continue;
      expect(port.paramTarget, `cv input ${port.id} paramTarget`).toBe(port.id);
    }
  });

  it('joystick + tuning params are all CV-patchable', () => {
    const inputIds = new Set(quadralogicalDef.inputs.map((p) => p.id));
    for (const id of ['pos_x', 'pos_y', 'diamond_margin', 'blend_sharp'] as const) {
      expect(inputIds, `missing cv input for ${id}`).toContain(id);
    }
  });

  it('every CV input carries a cvScale hint', () => {
    for (const port of quadralogicalDef.inputs.filter((i) => i.type === 'cv')) {
      expect(port.cvScale, `cv input ${port.id} cvScale`).toBeDefined();
    }
  });
});

describe('quadWeights — corner one-hot map', () => {
  // Corner → input: (-1,+1)=in1 TL, (+1,+1)=in2 TR, (-1,-1)=in3 BL, (+1,-1)=in4 BR.
  it('(-1,+1) → 100% in1 (TL)', () => {
    const w = quadWeights(-1, 1, M, K);
    expect(w[0]).toBeCloseTo(1, 5);
    expect(w[1]).toBeCloseTo(0, 5);
    expect(w[2]).toBeCloseTo(0, 5);
    expect(w[3]).toBeCloseTo(0, 5);
  });
  it('(+1,+1) → 100% in2 (TR)', () => {
    const w = quadWeights(1, 1, M, K);
    expect(w[1]).toBeCloseTo(1, 5);
    expect(w[0] + w[2] + w[3]).toBeCloseTo(0, 5);
  });
  it('(-1,-1) → 100% in3 (BL)', () => {
    const w = quadWeights(-1, -1, M, K);
    expect(w[2]).toBeCloseTo(1, 5);
    expect(w[0] + w[1] + w[3]).toBeCloseTo(0, 5);
  });
  it('(+1,-1) → 100% in4 (BR)', () => {
    const w = quadWeights(1, -1, M, K);
    expect(w[3]).toBeCloseTo(1, 5);
    expect(w[0] + w[1] + w[2]).toBeCloseTo(0, 5);
  });
});

describe('quadWeights — edge → exactly 2 inputs', () => {
  it('left edge x=-1 → only in1 + in3 (w2=w4=0)', () => {
    for (const y of [-0.9, -0.3, 0, 0.3, 0.9]) {
      const w = quadWeights(-1, y, M, K);
      expect(w[1]).toBeCloseTo(0, 5); // in2
      expect(w[3]).toBeCloseTo(0, 5); // in4
      expect(w[0] + w[2]).toBeCloseTo(1, PREC);
    }
  });
  it('right edge x=+1 → only in2 + in4 (w1=w3=0)', () => {
    for (const y of [-0.9, 0, 0.9]) {
      const w = quadWeights(1, y, M, K);
      expect(w[0]).toBeCloseTo(0, 5);
      expect(w[2]).toBeCloseTo(0, 5);
      expect(w[1] + w[3]).toBeCloseTo(1, PREC);
    }
  });
  it('top edge y=+1 → only in1 + in2 (w3=w4=0)', () => {
    for (const x of [-0.9, 0, 0.9]) {
      const w = quadWeights(x, 1, M, K);
      expect(w[2]).toBeCloseTo(0, 5);
      expect(w[3]).toBeCloseTo(0, 5);
      expect(w[0] + w[1]).toBeCloseTo(1, PREC);
    }
  });
  it('bottom edge y=-1 → only in3 + in4 (w1=w2=0)', () => {
    for (const x of [-0.9, 0, 0.9]) {
      const w = quadWeights(x, -1, M, K);
      expect(w[0]).toBeCloseTo(0, 5);
      expect(w[1]).toBeCloseTo(0, 5);
      expect(w[2] + w[3]).toBeCloseTo(1, PREC);
    }
  });
});

describe('quadWeights — center + diamond = balanced 4-way zone', () => {
  it('(0,0) → all four present and ~balanced (0.25 each)', () => {
    const w = quadWeights(0, 0, M, K);
    for (const wi of w) expect(wi).toBeCloseTo(0.25, 5);
  });

  it('|x|+|y| <= margin → all four weights strictly nonzero (the all-4 composite zone)', () => {
    // Sample points strictly inside the diamond.
    const pts: Array<[number, number]> = [
      [0, 0],
      [0.2, 0.1],
      [-0.2, 0.15],
      [0.1, -0.3],
      [-0.25, -0.2],
      [0.49, 0], // close to the diamond edge along an axis
    ];
    for (const [x, y] of pts) {
      expect(Math.abs(x) + Math.abs(y)).toBeLessThanOrEqual(M + 1e-9);
      const w = quadWeights(x, y, M, K);
      for (let i = 0; i < 4; i++) {
        expect(w[i], `w[${i}] at (${x},${y}) should be > 0 inside diamond`).toBeGreaterThan(0);
      }
    }
  });

  it('inside the diamond the blend stays pure bilinear (t=0 → unsharpened)', () => {
    // At a point well inside the diamond, the power p == 1 so weights equal the
    // raw bilinear products. Cross-check one point against the bilinear formula.
    const x = 0.2, y = 0.1;
    const u = (x + 1) / 2, v = (y + 1) / 2;
    const bil = [
      (1 - u) * v,
      u * v,
      (1 - u) * (1 - v),
      u * (1 - v),
    ];
    const w = quadWeights(x, y, M, K);
    for (let i = 0; i < 4; i++) expect(w[i]).toBeCloseTo(bil[i]!, 6);
  });

  it('pushing PAST the diamond toward an edge collapses toward 2 inputs (sharpening)', () => {
    // Near the right edge but off-axis: w2+w4 should dominate vs the bilinear
    // baseline (the two near-zero left-column weights get crushed faster).
    const x = 0.85, y = 0.2;
    const w = quadWeights(x, y, M, K);
    const u = (x + 1) / 2, v = (y + 1) / 2;
    const bilLeftCol = (1 - u) * v + (1 - u) * (1 - v); // b1+b3 (left column)
    const sharpLeftCol = w[0] + w[2];
    expect(sharpLeftCol, 'left-column weight is suppressed past the diamond').toBeLessThan(bilLeftCol);
    expect(w[1] + w[3], 'right column dominates').toBeGreaterThan(0.5);
  });
});

describe('quadWeights — invariants across a grid sweep', () => {
  it('weights always sum to 1 and are all >= 0', () => {
    for (let xi = -10; xi <= 10; xi++) {
      for (let yi = -10; yi <= 10; yi++) {
        const x = xi / 10, y = yi / 10;
        const w = quadWeights(x, y, M, K);
        expect(sum(w), `sum at (${x},${y})`).toBeCloseTo(1, PREC);
        for (let i = 0; i < 4; i++) {
          expect(w[i], `w[${i}] at (${x},${y}) >= 0`).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('out-of-range input is clamped (no NaN, still sums to 1)', () => {
    const w = quadWeights(5, -9, M, K); // clamps to (1,-1) = in4 corner
    expect(sum(w)).toBeCloseTo(1, 5);
    expect(w[3]).toBeCloseTo(1, 5);
  });

  it('NaN input → treated as 0 (center), balanced 4-way', () => {
    const w = quadWeights(NaN, NaN, M, K);
    for (const wi of w) expect(wi).toBeCloseTo(0.25, 5);
  });
});

describe('cross-dissolve reference parity (JS vs documented shader formula)', () => {
  // The MIX shader computes out = Σ wi·ci with the SAME quadWeights. Verify the
  // JS reference reproduces that for a representative composite.
  function dissolve(
    x: number, y: number,
    colors: Array<[number, number, number]>,
  ): [number, number, number] {
    const w = quadWeights(x, y, M, K);
    const out: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < 4; i++) {
      for (let c = 0; c < 3; c++) out[c] += w[i] * colors[i]![c]!;
    }
    return out;
  }

  const COLORS: Array<[number, number, number]> = [
    [1, 0, 0], // in1 red
    [0, 1, 0], // in2 green
    [0, 0, 1], // in3 blue
    [1, 1, 0], // in4 yellow
  ];

  it('TL corner → pure in1 (red)', () => {
    const out = dissolve(-1, 1, COLORS);
    expect(out[0]).toBeCloseTo(1, PREC); // ~1 (the +1e-6 renorm guard)
    expect(out[1]).toBeCloseTo(0, PREC);
    expect(out[2]).toBeCloseTo(0, PREC);
  });
  it('center → average of all four', () => {
    const out = dissolve(0, 0, COLORS);
    expect(out[0]).toBeCloseTo(0.5, 5); // (1+0+0+1)/4
    expect(out[1]).toBeCloseTo(0.5, 5); // (0+1+0+1)/4
    expect(out[2]).toBeCloseTo(0.25, 5); // (0+0+1+0)/4
  });
  it('output channels never exceed the convex hull of the inputs (weights are a partition of unity)', () => {
    for (let xi = -4; xi <= 4; xi++) {
      for (let yi = -4; yi <= 4; yi++) {
        const out = dissolve(xi / 4, yi / 4, COLORS);
        for (const c of out) {
          expect(c).toBeGreaterThanOrEqual(-1e-6);
          expect(c).toBeLessThanOrEqual(1 + 1e-6);
        }
      }
    }
  });
});

describe('normalizeInputs — Eurorack forward-fill', () => {
  it('[F,F,F,F] → all unpatched (-1 = emptyTex sentinel)', () => {
    expect(normalizeInputs([false, false, false, false])).toEqual([-1, -1, -1, -1]);
  });
  it('[T,F,F,F] → every channel reads in1', () => {
    expect(normalizeInputs([true, false, false, false])).toEqual([0, 0, 0, 0]);
  });
  it('[T,T,F,F] → [0,1,1,1] (in3/in4 normal to in2)', () => {
    expect(normalizeInputs([true, true, false, false])).toEqual([0, 1, 1, 1]);
  });
  it('[T,T,T,F] → [0,1,2,2] (in4 normals to in3)', () => {
    expect(normalizeInputs([true, true, true, false])).toEqual([0, 1, 2, 2]);
  });
  it('[T,T,T,T] → identity', () => {
    expect(normalizeInputs([true, true, true, true])).toEqual([0, 1, 2, 3]);
  });
  it('a GAP fills from the nearest LOWER-indexed patched input', () => {
    // in1 patched, in2 unpatched → in2 reads in1; in3 patched → in3 reads in3;
    // in4 unpatched → in4 reads in3.
    expect(normalizeInputs([true, false, true, false])).toEqual([0, 0, 2, 2]);
  });
  it('leading gap stays unpatched until the first patched input', () => {
    // in1 unpatched, in2 patched → in1 has no lower-indexed source (-1).
    expect(normalizeInputs([false, true, false, false])).toEqual([-1, 1, 1, 1]);
  });
});

describe('transition framework scaffolding', () => {
  it('declares all 8 transitions with DISSOLVE first (the live Phase-1 mode)', () => {
    expect(TRANSITIONS.length).toBe(8);
    expect(TRANSITIONS[0]).toBe('DISSOLVE');
  });
  it('EFFECT_PARAMS has an entry for every transition index 0..7', () => {
    for (let i = 0; i < 8; i++) {
      expect(EFFECT_PARAMS[i], `EFFECT_PARAMS[${i}]`).toBeDefined();
    }
  });
  it('DISSOLVE (Phase-1 live) needs no extra controls (pure joystick)', () => {
    expect(EFFECT_PARAMS[0]).toEqual([]);
  });
  it('every EFFECT_PARAMS entry references a real param id', () => {
    const paramIds = new Set(quadralogicalDef.params.map((p) => p.id));
    for (const list of Object.values(EFFECT_PARAMS)) {
      for (const p of list) {
        expect(paramIds, `EFFECT_PARAMS references ${p.id}`).toContain(p.id);
      }
    }
  });
});

describe('pure scalar helpers', () => {
  it('clampJoy clamps to [-1,1] and maps NaN→0', () => {
    expect(clampJoy(2)).toBe(1);
    expect(clampJoy(-2)).toBe(-1);
    expect(clampJoy(0.3)).toBe(0.3);
    expect(clampJoy(NaN)).toBe(0);
  });
  it('smoothstep matches the GLSL builtin at the edges + midpoint', () => {
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 2)).toBe(1);
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5, 6);
    expect(smoothstep(0.5, 1, 0.5)).toBe(0);
  });
});
