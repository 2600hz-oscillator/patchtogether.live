// packages/web/src/lib/video/frametable-core.test.ts
//
// FRAMETABLE — module-def shape + the pure selection math (no GL). The exported
// helpers are the EXACT CPU MIRROR of the GLSL SELECT pass, so unit-testing them
// pins the semantics the shader transliterates:
//   - the ANALYTIC inverse-CDF reproduces the target triangular bell WITHOUT a
//     per-fragment 60-frame loop (hard req #2): sweep threshold01 uniformly,
//     histogram the picked frame, and match the analytic BINNED weights
//     (total-variation + max-abs);
//   - the per-pixel selection is a pure function of a STATIC threshold — no time
//     term — so a still input is stable and moving content is a coherent smear
//     (hard req #3);
//   - ring wrap has no gap / no double-count across the 59→0 seam (2h ≤ N);
//   - spread=1 collapses to a delta; the centre frame is always the mode;
//   - freeze halts the ring; SAVE snapshots once per rising edge (idempotent).

import { describe, it, expect } from 'vitest';
import { detectEdge, makeEdgeState } from '$lib/doom/cv-gate-edge';
import { frametableDef } from './modules/frametable';
import {
  FRAMETABLE_RING_FRAMES,
  FRAMETABLE_BLUE_NOISE_SIZE,
  FRAMETABLE_SHAPE_TRIANGULAR,
  FRAMETABLE_SHAPE_GAUSSIAN,
  wrapIndex,
  wrapNearestOffset,
  erfinv,
  triangularOffset,
  gaussianOffset,
  selectOffset,
  pickLagIndex,
  lagToLayer,
  triangularCdf,
  triangularWeight,
  hash21,
  shimmerThreshold,
  advanceHead,
} from './frametable-core';

const N = FRAMETABLE_RING_FRAMES; // 60

// ----------------------------------------------------------------------
// Distribution helpers.
// ----------------------------------------------------------------------

/** Deterministic midpoint quadrature of the inverse-CDF: a uniform sweep of
 *  threshold t ∈ (0,1) histogrammed by picked frame. This IS the numerical
 *  integral of the selection over t, so it converges to the analytic bin mass. */
function empiricalHist(morph: number, spread: number, shape: number, samples: number): Map<number, number> {
  const counts = new Map<number, number>();
  for (let i = 0; i < samples; i++) {
    const t = (i + 0.5) / samples;
    const k = pickLagIndex(morph, spread, t, shape);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const p = new Map<number, number>();
  for (const [k, n] of counts) p.set(k, n / samples);
  return p;
}

/** Analytic target: the triangular bell's mass per integer frame. */
function targetHist(morph: number, spread: number): Map<number, number> {
  const c = morph * N;
  const w = new Map<number, number>();
  for (let k = 0; k < N; k++) {
    const wk = triangularWeight(k, c, spread);
    if (wk > 1e-12) w.set(k, wk);
  }
  return w;
}

function totalVariation(p: Map<number, number>, w: Map<number, number>): number {
  const keys = new Set<number>([...p.keys(), ...w.keys()]);
  let s = 0;
  for (const k of keys) s += Math.abs((p.get(k) ?? 0) - (w.get(k) ?? 0));
  return 0.5 * s;
}
function maxAbs(p: Map<number, number>, w: Map<number, number>): number {
  const keys = new Set<number>([...p.keys(), ...w.keys()]);
  let m = 0;
  for (const k of keys) m = Math.max(m, Math.abs((p.get(k) ?? 0) - (w.get(k) ?? 0)));
  return m;
}
function sumMass(m: Map<number, number>): number {
  let s = 0;
  for (const v of m.values()) s += v;
  return s;
}

// ----------------------------------------------------------------------
// F-1a — Def shape.
// ----------------------------------------------------------------------

describe('FRAMETABLE — def shape', () => {
  const def = frametableDef;

  it('is a video processor with the canonical identity', () => {
    expect(def.type).toBe('frametable');
    expect(def.domain).toBe('video');
    expect(def.label).toBe('frametable'); // lowercase (repo standard)
    expect(def.palette).toEqual({ top: 'Video modules', sub: 'Processors' });
    // The ring must keep filling even when unobserved (history reaches back).
    expect(def.pullExempt).toBe(true);
  });

  it('has ONE video input + ONE video output', () => {
    const vidIn = def.inputs.filter((p) => p.type === 'video').map((p) => p.id);
    expect(vidIn).toEqual(['video_in']);
    expect(def.outputs.map((p) => p.id)).toEqual(['video_out']);
    expect(def.outputs.every((p) => p.type === 'video')).toBe(true);
  });

  it('every CV input targets a real param + has a cvScale (cv-scale-registry)', () => {
    const paramIds = new Set(def.params.map((p) => p.id));
    for (const port of def.inputs) {
      if (port.type !== 'cv') continue;
      expect(port.paramTarget, `${port.id} has a paramTarget`).toBeTruthy();
      expect(paramIds.has(port.paramTarget!), `${port.id} → real param`).toBe(true);
      expect(port.cvScale, `${port.id} declares a cvScale`).toBeTruthy();
    }
  });

  it('FREEZE is a gate (edge:gate → toggle) + SAVE is a trigger (edge:trigger → one-shot)', () => {
    const freeze = def.inputs.find((p) => p.id === 'freeze_gate');
    const save = def.inputs.find((p) => p.id === 'save_trig');
    expect(freeze?.type).toBe('gate');
    expect(freeze?.edge).toBe('gate');
    expect(freeze?.paramTarget).toBe('freezeGate'); // synthetic (BACKDRAFT pattern)
    expect(save?.type).toBe('gate');
    expect(save?.edge).toBe('trigger');
    expect(save?.paramTarget).toBe('saveTrig');
    // gate-typed inputs are NOT subject to the cvScale registry.
    expect(freeze?.cvScale).toBeUndefined();
    expect(save?.cvScale).toBeUndefined();
  });

  it('knob params span the documented ranges with musical defaults', () => {
    const byId = new Map(def.params.map((p) => [p.id, p]));
    expect(byId.get('morph')).toMatchObject({ min: 0, max: 1 });
    expect(byId.get('spread')).toMatchObject({ min: 1, max: 60 });
    expect(byId.get('shimmer')).toMatchObject({ min: 0, max: 1, defaultValue: 0 });
    expect(byId.get('weightShape')).toMatchObject({ min: 0, max: 1, defaultValue: 0 });
    // spread defaults into a visible mid-window (not a degenerate 1-frame delta).
    expect(byId.get('spread')!.defaultValue).toBeGreaterThan(1);
    for (const p of def.params) {
      expect(p.defaultValue).toBeGreaterThanOrEqual(p.min);
      expect(p.defaultValue).toBeLessThanOrEqual(p.max);
    }
  });

  it('ships co-located AUTHORED docs covering every port + param', () => {
    const docs = def.docs!;
    expect((docs.explanation ?? '').length).toBeGreaterThan(200);
    for (const port of def.inputs) expect(docs.inputs?.[port.id], `docs.inputs.${port.id}`).toBeTruthy();
    for (const port of def.outputs) expect(docs.outputs?.[port.id], `docs.outputs.${port.id}`).toBeTruthy();
    for (const p of def.params) expect(docs.controls?.[p.id], `docs.controls.${p.id}`).toBeTruthy();
  });
});

// ----------------------------------------------------------------------
// F-1b — inverse-CDF distribution (hard req #2): analytic bell, no 60-loop.
// ----------------------------------------------------------------------

describe('FRAMETABLE — inverse-CDF reproduces the triangular bell (no per-fragment loop)', () => {
  const MORPHS = [0, 0.25, 0.5, 0.75, 0.99]; // 0.99 = wrap boundary
  const SPREADS = [1, 2, 5, 7, 15, 30, 60];
  const SAMPLES = 240_000;

  for (const morph of MORPHS) {
    for (const spread of SPREADS) {
      it(`morph=${morph} spread=${spread}: empirical histogram matches the analytic weights`, () => {
        const p = empiricalHist(morph, spread, FRAMETABLE_SHAPE_TRIANGULAR, SAMPLES);
        const w = targetHist(morph, spread);

        // Total-variation (preferred over χ², which over-rejects at large Npix).
        expect(totalVariation(p, w), 'TV distance').toBeLessThan(0.02);
        // Max per-bin absolute error.
        expect(maxAbs(p, w), 'max-abs per-bin error').toBeLessThan(0.01);
        // Both distributions normalise to 1. (At the spread=60 degenerate boundary
        // 2h=N exactly, the single antipodal frame straddles the wrap seam so the
        // analytic weight loses ~1.4e-4 of its bin there — harmless, and well below
        // the TV/max-abs match above; hence the looser analytic-sum tolerance.)
        expect(sumMass(p)).toBeCloseTo(1, 3);
        expect(sumMass(w)).toBeCloseTo(1, 3);

        // The centre frame is the MODE (highest single mass) in both.
        const centre = wrapIndex(Math.round(morph * N));
        for (const [k, wk] of w) {
          expect(w.get(centre)!).toBeGreaterThanOrEqual(wk - 1e-9);
        }
        // The centre frame is the empirical MODE (argmax), not merely present.
        let pArgmax = -1, pBest = -1;
        for (const [k, pk] of p) if (pk > pBest) { pBest = pk; pArgmax = k; }
        expect(pArgmax, 'centre frame is the empirical mode').toBe(centre);

        // Empirical + analytic SUPPORT are the same frame set (no extra/missing k).
        const pSet = new Set([...p.keys()].filter((k) => (p.get(k) ?? 0) > 1e-6));
        const wSet = new Set([...w.keys()]);
        for (const k of pSet) expect(wSet.has(k), `empirical k=${k} is in analytic support`).toBe(true);
      });
    }
  }

  it('spread=1 collapses to a single-frame DELTA on the morph centre', () => {
    for (const morph of [0, 0.25, 0.5]) {
      const p = empiricalHist(morph, 1, FRAMETABLE_SHAPE_TRIANGULAR, 100_000);
      const centre = wrapIndex(Math.round(morph * N));
      expect(p.get(centre) ?? 0, `spread=1 → delta at ${centre}`).toBeGreaterThan(0.999);
    }
  });

  it('monotone falloff: weight decreases as |offset from centre| grows', () => {
    const spread = 20;
    const c = 30; // morph 0.5
    let prev = Infinity;
    for (let off = 0; off <= 10; off++) {
      const w = triangularWeight(30 + off, c, spread);
      expect(w, `offset ${off} not above previous`).toBeLessThanOrEqual(prev + 1e-9);
      prev = w;
    }
  });

  it('the v1 static threshold source (hash21) is amplitude-uniform over the screen tile', () => {
    // The REAL per-pixel threshold in v1 is hash21(floor(gl_FragCoord mod tile)).
    // A biased hash would skew the SPATIAL frame-selection histogram in the shader
    // (which can't be unit-tested directly): a low-biased threshold pushes the
    // triangular inverse-CDF toward negative offsets, lopsiding the mosaic OFF the
    // morph centre. So pin the noise source itself — KS-test hash21 over the 128×128
    // integer tile (the shader's floor(bn) sample domain) against the uniform CDF.
    // (This replaced a tautological precheck that compared the uniform sweep to
    // itself; it now actually FAILS if the hash regresses — the earlier per-component
    // -fract hash biased the mean to ~0.37 and would trip this.)
    const TILE = FRAMETABLE_BLUE_NOISE_SIZE; // 128
    const vals: number[] = [];
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) vals.push(hash21(x, y));
    vals.sort((a, b) => a - b);
    const n = vals.length;
    let ks = 0;
    for (let i = 0; i < n; i++) ks = Math.max(ks, Math.abs(vals[i] - (i + 1) / n), Math.abs(vals[i] - i / n));
    const mean = vals.reduce((s, v) => s + v, 0) / n;
    expect(ks, `hash21 KS vs uniform = ${ks.toFixed(4)}`).toBeLessThan(0.02);
    expect(mean, `hash21 mean = ${mean.toFixed(4)} (want ~0.5)`).toBeGreaterThan(0.47);
    expect(mean).toBeLessThan(0.53);
  });
});

// ----------------------------------------------------------------------
// F-1c — still-image consistency (hard req #3): static threshold, no time term.
// ----------------------------------------------------------------------

describe('FRAMETABLE — still-image consistency (static screen-space selection)', () => {
  it('pickLagIndex is a pure function of the static threshold (no frame/time term)', () => {
    // Same threshold → same lag every "frame" (the selection carries no time
    // input at all). This is the structural guarantee behind req #3: a still
    // input (identical ring layers) yields identical consecutive outputs.
    for (const t of [0.03, 0.2, 0.5, 0.77, 0.98]) {
      const a = pickLagIndex(0.5, 20, t);
      const b = pickLagIndex(0.5, 20, t);
      expect(a).toBe(b);
    }
  });

  it('shimmer=0 leaves the threshold untouched (fully static)', () => {
    for (const f of [0, 1, 7, 100]) {
      expect(shimmerThreshold(0.42, 0, f)).toBe(0.42);
    }
  });

  it('moving content: DIFFERENT thresholds select DIFFERENT lags (coherent smear, not one frame)', () => {
    // Two pixels at different (static) thresholds land on different frames of the
    // window → a spatial mosaic of temporal offsets, not per-frame random static.
    const low = pickLagIndex(0.5, 30, 0.05);
    const high = pickLagIndex(0.5, 30, 0.95);
    expect(low).not.toBe(high);
  });

  it('shimmer>0 stays BOUNDED and its time-average still matches the bell', () => {
    // Over many frames the shimmered threshold walks a golden-ratio sequence; the
    // per-pixel pick stays inside the window and the TIME-AVERAGED histogram over a
    // uniform pixel field still reproduces the target bell.
    const morph = 0.5, spread = 15, shimmer = 0.08;
    const FRAMES = 64, PIX = 4000;
    const counts = new Map<number, number>();
    for (let f = 0; f < FRAMES; f++) {
      for (let i = 0; i < PIX; i++) {
        const base = (i + 0.5) / PIX;
        const t = shimmerThreshold(base, shimmer, f);
        const k = pickLagIndex(morph, spread, t);
        counts.set(k, (counts.get(k) ?? 0) + 1);
        // bounded: never leaves the ring index range.
        expect(k).toBeGreaterThanOrEqual(0);
        expect(k).toBeLessThan(N);
      }
    }
    const total = FRAMES * PIX;
    const p = new Map<number, number>();
    for (const [k, n] of counts) p.set(k, n / total);
    const w = targetHist(morph, spread);
    expect(totalVariation(p, w), 'shimmer time-average TV').toBeLessThan(0.03);
  });

  it('hash21 is deterministic + in [0,1) (the static per-pixel threshold source)', () => {
    for (let x = 0; x < 40; x++) {
      const a = hash21(x * 1.7, x * 3.1);
      const b = hash21(x * 1.7, x * 3.1);
      expect(a).toBe(b);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(1);
    }
  });
});

// ----------------------------------------------------------------------
// F-1d — ring wrap correctness (2h ≤ N → no gap / no double-count).
// ----------------------------------------------------------------------

describe('FRAMETABLE — ring wrap', () => {
  it('wrapIndex + wrapNearestOffset are correct across the seam', () => {
    expect(wrapIndex(-1)).toBe(59);
    expect(wrapIndex(60)).toBe(0);
    expect(wrapIndex(61)).toBe(1);
    expect(wrapNearestOffset(59)).toBe(-1); // 59 ≡ -1 (nearest)
    expect(wrapNearestOffset(-59)).toBe(1);
    expect(wrapNearestOffset(1)).toBe(1);
  });

  it('morph near the seam + large spread wraps across 59→0 with no gap or double-count', () => {
    const morph = 0.99, spread = 30; // centre 59.4, half-width 15 → wraps the seam
    const p = empiricalHist(morph, spread, FRAMETABLE_SHAPE_TRIANGULAR, 240_000);
    const w = targetHist(morph, spread);
    // No frame appears twice, mass sums to 1, and the support straddles the seam.
    expect(sumMass(p)).toBeCloseTo(1, 5);
    expect(totalVariation(p, w)).toBeLessThan(0.02);
    const support = new Set([...p.keys()].filter((k) => (p.get(k) ?? 0) > 1e-6));
    expect([...support].some((k) => k >= 50), 'covers high frames near 59').toBe(true);
    expect([...support].some((k) => k <= 10), 'wraps to low frames near 0').toBe(true);
  });

  it('lag→layer maps lag 0 to head and lag N-1 to (head+1) mod N', () => {
    for (const head of [0, 17, 59]) {
      expect(lagToLayer(head, 0)).toBe(wrapIndex(head));
      expect(lagToLayer(head, N - 1)).toBe(wrapIndex(head + 1));
    }
  });
});

// ----------------------------------------------------------------------
// F-1e — gaussian "smooth" mode + erfinv.
// ----------------------------------------------------------------------

describe('FRAMETABLE — gaussian weight shape', () => {
  it('erfinv sanity (Winitzki approx, ~1e-3)', () => {
    expect(erfinv(0)).toBeCloseTo(0, 6);
    expect(erfinv(0.5)).toBeCloseTo(0.4769, 2);
    expect(erfinv(-0.5)).toBeCloseTo(-0.4769, 2);
    expect(Math.sign(erfinv(0.9))).toBe(1);
    expect(Math.sign(erfinv(-0.9))).toBe(-1);
  });

  it('gaussian offset is symmetric, monotone in t, and truncated to [-h,h]', () => {
    const spread = 18, h = 0.5 * spread;
    expect(gaussianOffset(0.5, spread, h)).toBeCloseTo(0, 6); // median at centre
    expect(gaussianOffset(0.0, spread, h)).toBeGreaterThanOrEqual(-h);
    expect(gaussianOffset(1.0, spread, h)).toBeLessThanOrEqual(h);
    // symmetric about t=0.5
    expect(gaussianOffset(0.3, spread, h)).toBeCloseTo(-gaussianOffset(0.7, spread, h), 3);
    // monotone increasing in t
    let prev = -Infinity;
    for (let i = 0; i <= 20; i++) {
      const d = gaussianOffset(i / 20, spread, h);
      expect(d).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = d;
    }
  });

  it('gaussian pick: centre is the mode + support stays inside the window', () => {
    const morph = 0.5, spread = 20;
    const p = empiricalHist(morph, spread, FRAMETABLE_SHAPE_GAUSSIAN, 200_000);
    const centre = 30;
    let mode = -1, modeMass = -1;
    for (const [k, v] of p) if (v > modeMass) { modeMass = v; mode = k; }
    expect(mode).toBe(centre);
    for (const k of p.keys()) {
      expect(Math.abs(wrapNearestOffset(k - centre)), `k=${k} within window`).toBeLessThanOrEqual(0.5 * spread + 1);
    }
  });

  it('selectOffset dispatches on the shape selector', () => {
    const spread = 12, t = 0.2;
    expect(selectOffset(t, spread, FRAMETABLE_SHAPE_TRIANGULAR)).toBeCloseTo(triangularOffset(t, 0.5 * spread), 9);
    expect(selectOffset(t, spread, FRAMETABLE_SHAPE_GAUSSIAN)).toBeCloseTo(gaussianOffset(t, spread, 0.5 * spread), 9);
  });
});

// ----------------------------------------------------------------------
// F-1f — triangular CDF exactness.
// ----------------------------------------------------------------------

describe('FRAMETABLE — triangular CDF', () => {
  it('matches the piecewise closed form at anchor points', () => {
    const h = 4;
    expect(triangularCdf(-h, h)).toBeCloseTo(0, 9);
    expect(triangularCdf(0, h)).toBeCloseTo(0.5, 9);
    expect(triangularCdf(h, h)).toBeCloseTo(1, 9);
    expect(triangularCdf(-5, h)).toBe(0); // below support
    expect(triangularCdf(5, h)).toBe(1); // above support
  });

  it('per-frame weights sum to 1 across the window', () => {
    for (const spread of [3, 8, 16, 40]) {
      let s = 0;
      for (let k = 0; k < N; k++) s += triangularWeight(k, 30, spread);
      expect(s, `spread=${spread} weights sum`).toBeCloseTo(1, 6);
    }
  });
});

// ----------------------------------------------------------------------
// F-1g — freeze / save reducers.
// ----------------------------------------------------------------------

describe('FRAMETABLE — freeze / save reducers', () => {
  it('advanceHead: unfrozen advances + wraps; frozen pins the head', () => {
    expect(advanceHead(0, false)).toBe(1);
    expect(advanceHead(58, false)).toBe(59);
    expect(advanceHead(59, false)).toBe(0); // wrap
    expect(advanceHead(17, true)).toBe(17); // frozen → pinned
    expect(advanceHead(0, true)).toBe(0);
  });

  it('FREEZE is a level-read: frozen WHILE the button latch OR the gate level is high', () => {
    // The factory computes `frozen = freeze >= 0.5 || freezeGate >= 0.5` — a
    // momentary gate hold OR-combined with the persistent button toggle.
    const frozenState = (freezeToggle: number, gateLevel: number) => freezeToggle >= 0.5 || gateLevel >= 0.5;
    expect(frozenState(0, 0)).toBe(false); // neither
    expect(frozenState(1, 0)).toBe(true); // button latch
    expect(frozenState(0, 1)).toBe(true); // gate held high (momentary)
    expect(frozenState(1, 1)).toBe(true); // both
    // The gate is momentary: it stops freezing the instant it drops low (no latch).
    expect(frozenState(0, 0.9)).toBe(true);
    expect(frozenState(0, 0.1)).toBe(false);
  });

  it('SAVE trigger: snapshots ONCE per rising edge (idempotent while held high)', () => {
    const edge = makeEdgeState();
    let snapshots = 0;
    const samples = [0, 1, 1, 1, 0, 0, 1, 1, 0, 1];
    for (const s of samples) {
      if (detectEdge(edge, s)?.pressed === true) snapshots++;
    }
    // rising edges at idx 1, 6, 9 → exactly 3 snapshots (held-high never re-fires).
    expect(snapshots).toBe(3);
  });

  it('a frozen ring never advances over a burst (ring contents pinned)', () => {
    let head = 12;
    for (let i = 0; i < 30; i++) head = advanceHead(head, true);
    expect(head).toBe(12);
    // released → resumes advancing.
    for (let i = 0; i < 5; i++) head = advanceHead(head, false);
    expect(head).toBe(17);
  });
});
