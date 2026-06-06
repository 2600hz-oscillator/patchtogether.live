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
  edgeWeights,
  EDGE_PAIRS,
  blend2,
  rgbToHsv,
  hueDistance,
  normalizeInputs,
  clampJoy,
  smoothstep,
  TRANSITIONS,
  EFFECTS,
  EFFECT_PARAMS,
  EDGES,
  QUADRALOGICAL_DEFAULT_MARGIN,
  QUADRALOGICAL_DEFAULT_SHARP,
  type RGB,
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

  it('every edge has its own discrete fx selector spanning 0..7 (all 8 modes reachable)', () => {
    for (const edge of EDGES) {
      const t = quadralogicalDef.params.find((p) => p.id === `${edge.id}_fx`);
      expect(t, `${edge.id}_fx exists`).toBeDefined();
      expect(t?.curve).toBe('discrete');
      expect(t?.min).toBe(0);
      expect(t?.max).toBe(7);
    }
  });

  it('declares exactly 4 per-edge effect slots (1–2 / 2–3 / 3–4 / 4–1) with a global transition GONE', () => {
    expect(EDGES.map((e) => e.id)).toEqual(['edge1', 'edge2', 'edge3', 'edge4']);
    // The single global `transition` param is replaced by per-edge fx slots.
    expect(quadralogicalDef.params.find((p) => p.id === 'transition')).toBeUndefined();
  });

  it('each edge exposes amount + param controls (0..1)', () => {
    for (const edge of EDGES) {
      for (const suffix of ['amount', 'param'] as const) {
        const p = quadralogicalDef.params.find((x) => x.id === `${edge.id}_${suffix}`);
        expect(p, `${edge.id}_${suffix} param`).toBeDefined();
        expect(p?.min).toBe(0);
        expect(p?.max).toBe(1);
      }
    }
  });

  it('exposes a shared chroma key colour (keyR/keyG/keyB) + global invert', () => {
    for (const id of ['keyR', 'keyG', 'keyB', 'invert'] as const) {
      const p = quadralogicalDef.params.find((x) => x.id === id);
      expect(p, `${id} param`).toBeDefined();
      expect(p?.min).toBe(0);
      expect(p?.max).toBe(1);
    }
  });

  it('per-edge amount/param + chroma key are all CV-targetable', () => {
    const inputIds = new Set(quadralogicalDef.inputs.map((p) => p.id));
    for (const edge of EDGES) {
      expect(inputIds, `${edge.id}_amount cv input`).toContain(`${edge.id}_amount`);
      expect(inputIds, `${edge.id}_param cv input`).toContain(`${edge.id}_param`);
    }
    for (const id of ['keyR', 'keyG', 'keyB']) {
      expect(inputIds, `${id} cv input`).toContain(id);
    }
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

// ───────────────────────── Phase-2 edge-composite model ─────────────────────

describe('edgeWeights — the per-edge (mass, ratio) terms', () => {
  it('EDGE_PAIRS is the diamond cycle 1→2→3→4→1', () => {
    expect(EDGE_PAIRS).toEqual([
      [0, 1], // 1↔2
      [1, 2], // 2↔3
      [2, 3], // 3↔4
      [3, 0], // 4↔1
    ]);
  });

  it('center (0,0) → every edge mass = 0.5 and ratio = 0.5 (balanced)', () => {
    const terms = edgeWeights(0, 0, M, K);
    for (const t of terms) {
      expect(t.mass).toBeCloseTo(0.5, PREC);
      expect(t.ratio).toBeCloseTo(0.5, PREC);
    }
  });

  it('edge masses always sum to 2 (each corner weight is in exactly two edges)', () => {
    for (let xi = -10; xi <= 10; xi += 2) {
      for (let yi = -10; yi <= 10; yi += 2) {
        const terms = edgeWeights(xi / 10, yi / 10, M, K);
        const total = terms.reduce((a, t) => a + t.mass, 0);
        expect(total, `Σmass at (${xi / 10},${yi / 10})`).toBeCloseTo(2, PREC);
      }
    }
  });

  it('each ratio stays in [0,1] (a valid within-edge mix position)', () => {
    for (let xi = -10; xi <= 10; xi++) {
      for (let yi = -10; yi <= 10; yi++) {
        const terms = edgeWeights(xi / 10, yi / 10, M, K);
        for (const t of terms) {
          expect(t.ratio).toBeGreaterThanOrEqual(0);
          expect(t.ratio).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  // The composite resolves to the pure corner input — derive the composite the
  // way the shader does (Σ mass·blend / Σ mass) with plain dissolve, since at a
  // corner the dissolve ratio collapses each touching edge to that input.
  function compositeDissolve(x: number, y: number, colors: RGB[]): RGB {
    const terms = edgeWeights(x, y, M, K);
    const acc: RGB = [0, 0, 0];
    let massSum = 0;
    terms.forEach((t, e) => {
      const [a, b] = EDGE_PAIRS[e]!;
      const blended = blend2(0, colors[a]!, colors[b]!, t.ratio, {
        amount: 1, param: 0.1, key: [0, 1, 0], invert: 0, uv: [0.5, 0.5],
      });
      acc[0] += t.mass * blended[0];
      acc[1] += t.mass * blended[1];
      acc[2] += t.mass * blended[2];
      massSum += t.mass;
    });
    return [acc[0] / massSum, acc[1] / massSum, acc[2] / massSum];
  }

  const COLORS: RGB[] = [
    [1, 0, 0], // in1 red
    [0, 1, 0], // in2 green
    [0, 0, 1], // in3 blue
    [1, 1, 0], // in4 yellow
  ];

  it('each corner resolves to its PURE input under the edge composite', () => {
    expect(compositeDissolve(-1, 1, COLORS)[0]).toBeCloseTo(1, PREC); // TL → in1 red
    expect(compositeDissolve(-1, 1, COLORS)[1]).toBeCloseTo(0, PREC);
    expect(compositeDissolve(1, 1, COLORS)[1]).toBeCloseTo(1, PREC);  // TR → in2 green
    expect(compositeDissolve(-1, -1, COLORS)[2]).toBeCloseTo(1, PREC); // BL → in3 blue
    const br = compositeDissolve(1, -1, COLORS);                       // BR → in4 yellow
    expect(br[0]).toBeCloseTo(1, PREC);
    expect(br[1]).toBeCloseTo(1, PREC);
    expect(br[2]).toBeCloseTo(0, PREC);
  });

  it('center → average of all four inputs (balanced composite)', () => {
    const c = compositeDissolve(0, 0, COLORS);
    expect(c[0]).toBeCloseTo(0.5, 5);  // (1+0+0+1)/4
    expect(c[1]).toBeCloseTo(0.5, 5);  // (0+1+0+1)/4
    expect(c[2]).toBeCloseTo(0.25, 5); // (0+0+1+0)/4
  });

  it('continuity: a small joystick step → a small composite step (no jumps)', () => {
    let prev = compositeDissolve(-1, -1, COLORS);
    for (let i = -49; i <= 50; i++) {
      const x = i / 50;
      const cur = compositeDissolve(x, x, COLORS); // sweep the BL→TR diagonal
      const d = Math.max(
        Math.abs(cur[0] - prev[0]),
        Math.abs(cur[1] - prev[1]),
        Math.abs(cur[2] - prev[2]),
      );
      expect(d, `composite jump at x=${x}`).toBeLessThan(0.1);
      prev = cur;
    }
  });
});

describe('blend2 — the eight 2-input effects (TS reference = the GLSL truth)', () => {
  const A: RGB = [1, 0, 0];   // red
  const B: RGB = [0, 0, 1];   // blue
  const base = { amount: 1, param: 0.1, key: [0, 1, 0] as RGB, invert: 0, uv: [0.5, 0.5] as [number, number] };

  it('ratio endpoint: the NON-spatial effects return ~a at t=0 (within-edge floor)', () => {
    // DISSOLVE/ADD/MULTIPLY/CHROMA/LUMA/DIFF collapse to `a` at t=0 regardless
    // of pixel. WIPE/IRIS are positional — their t=0 output depends on the UV
    // (the wipe/iris line sweeps across the frame), so they're excluded here and
    // covered by their own spatial assertions below.
    for (const fx of [0, 1, 2, 4, 5, 6]) {
      const out = blend2(fx, A, B, 0, base);
      expect(out[0], `fx ${fx} @t=0 R`).toBeCloseTo(A[0], 4);
      expect(out[2], `fx ${fx} @t=0 B`).toBeCloseTo(A[2], 4);
    }
  });

  it('DISSOLVE (0) is a linear cross-fade a→b', () => {
    expect(blend2(0, A, B, 0.5, base)).toEqual([0.5, 0, 0.5]);
    expect(blend2(0, A, B, 1, base)).toEqual([0, 0, 1]);
  });

  it('ADD (1) adds b·t scaled by amount (clamped)', () => {
    // a=red, b=blue, t=1, amount=1 → red+blue = magenta.
    expect(blend2(1, A, B, 1, base)).toEqual([1, 0, 1]);
    // amount 0 → no add → pure a.
    expect(blend2(1, A, B, 1, { ...base, amount: 0 })).toEqual([1, 0, 0]);
  });

  it('MULTIPLY (2) darkens toward a·b', () => {
    // red·blue = black; at t=1 → black.
    const out = blend2(2, A, B, 1, base);
    expect(out[0]).toBeCloseTo(0, 6);
    expect(out[2]).toBeCloseTo(0, 6);
    // white·anything = anything; white·red = red.
    expect(blend2(2, [1, 1, 1], A, 1, base)).toEqual([1, 0, 0]);
  });

  it('DIFF (6) is the absolute difference at full ratio', () => {
    // |red - blue| = (1,0,1) magenta.
    expect(blend2(6, A, B, 1, base)).toEqual([1, 0, 1]);
    // |x - x| = 0.
    const out = blend2(6, A, A, 1, base);
    expect(out).toEqual([0, 0, 0]);
  });

  it('WIPE (3) is spatial: opposite UV ends pick opposite inputs at t=0.5', () => {
    // angle = amount·2π; amount=0 → dir=(1,0) → horizontal wipe along x.
    const p = { ...base, amount: 0, param: 0.001 };
    const left = blend2(3, A, B, 0.5, { ...p, uv: [0.0, 0.5] });
    const right = blend2(3, A, B, 0.5, { ...p, uv: [1.0, 0.5] });
    // One side is ~a (red), the other ~b (blue) — a real positional split.
    expect(left[0]).not.toBeCloseTo(right[0], 1);
  });

  it('IRIS (7) is radial: center vs corner pick different inputs', () => {
    const p = { ...base, amount: 0, param: 0.001 };
    const center = blend2(7, A, B, 0.5, { ...p, uv: [0.5, 0.5] });
    const corner = blend2(7, A, B, 0.5, { ...p, uv: [0.0, 0.0] });
    expect(center[2]).not.toBeCloseTo(corner[2], 1);
  });

  it('CHROMA (4) keys the key-colour OUT of a, revealing b', () => {
    // a = pure GREEN (the key colour), b = red. With t=1 the keyed (green) FG
    // is removed → reveal b (red).
    const green: RGB = [0, 1, 0];
    const red: RGB = [1, 0, 0];
    const out = blend2(4, green, red, 1, { ...base, key: [0, 1, 0], amount: 0.4, param: 0.1 });
    // Green should be keyed → output trends toward red (b).
    expect(out[0]).toBeGreaterThan(out[1]);
  });

  it('LUMA (5) keys bright a → reveals b; dark a → keeps a', () => {
    const white: RGB = [1, 1, 1];
    const black: RGB = [0, 0, 0];
    const red: RGB = [1, 0, 0];
    // bright a (white, luma=1) above threshold → keep a (white kept).
    const keep = blend2(5, white, red, 1, { ...base, amount: 0.5, param: 0.1 });
    expect(keep[1]).toBeGreaterThan(0.5);
    // dark a (black, luma=0) below threshold → reveal b (red).
    const reveal = blend2(5, black, red, 1, { ...base, amount: 0.5, param: 0.1 });
    expect(reveal[0]).toBeGreaterThan(0.5);
  });

  it('invert flips the LUMA key alpha', () => {
    const white: RGB = [1, 1, 1];
    const red: RGB = [1, 0, 0];
    const normal = blend2(5, white, red, 1, { ...base, amount: 0.5, param: 0.1, invert: 0 });
    const inv = blend2(5, white, red, 1, { ...base, amount: 0.5, param: 0.1, invert: 1 });
    // Inversion changes which layer survives → different output.
    expect(Math.abs(normal[1] - inv[1])).toBeGreaterThan(0.3);
  });

  it('all branches stay within [0,1] across a ratio sweep', () => {
    for (let fx = 0; fx < 8; fx++) {
      for (let i = 0; i <= 10; i++) {
        const out = blend2(fx, [0.8, 0.3, 0.1], [0.1, 0.9, 0.4], i / 10, base);
        for (const c of out) {
          expect(c, `fx ${fx} out of range`).toBeGreaterThanOrEqual(-1e-6);
          expect(c).toBeLessThanOrEqual(1 + 1e-6);
        }
      }
    }
  });
});

describe('HSV helpers (chroma-key math, re-implemented not imported)', () => {
  it('rgbToHsv: pure red → hue 0, sat 1, val 1', () => {
    const [h, s, v] = rgbToHsv(1, 0, 0);
    expect(h).toBeCloseTo(0, 5);
    expect(s).toBeCloseTo(1, 5);
    expect(v).toBeCloseTo(1, 5);
  });
  it('rgbToHsv: pure green → hue 1/3', () => {
    expect(rgbToHsv(0, 1, 0)[0]).toBeCloseTo(1 / 3, 5);
  });
  it('rgbToHsv: gray → sat 0', () => {
    expect(rgbToHsv(0.5, 0.5, 0.5)[1]).toBeCloseTo(0, 5);
  });
  it('hueDistance wraps the circle (0 and ~1 are close)', () => {
    expect(hueDistance(0.0, 0.95)).toBeCloseTo(0.05, 5);
    expect(hueDistance(0.0, 0.5)).toBeCloseTo(0.5, 5);
    expect(hueDistance(0.25, 0.25)).toBeCloseTo(0, 5);
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

describe('effect framework scaffolding', () => {
  it('declares all 8 effects with DISSOLVE first', () => {
    expect(TRANSITIONS.length).toBe(8);
    expect(TRANSITIONS[0]).toBe('DISSOLVE');
    expect(TRANSITIONS).toContain('CHROMA');
    expect(TRANSITIONS).toContain('IRIS');
  });
  it('EFFECTS describes the two control slots for every index 0..7', () => {
    for (let i = 0; i < 8; i++) {
      expect(EFFECTS[i], `EFFECTS[${i}]`).toBeDefined();
      // amount/param are either a string label or null (hidden for that fx).
      expect(['string', 'object']).toContain(typeof EFFECTS[i]!.amount);
    }
  });
  it('DISSOLVE has no extra controls (pure within-edge ratio)', () => {
    expect(EFFECTS[0]).toEqual({ amount: null, param: null });
    expect(EFFECT_PARAMS[0]).toEqual([]);
  });
  it('EFFECT_PARAMS uses only the per-edge suffixes amount/param', () => {
    for (const list of Object.values(EFFECT_PARAMS)) {
      for (const p of list) {
        expect(['amount', 'param']).toContain(p.id);
        expect(p.label.length).toBeGreaterThan(0);
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
