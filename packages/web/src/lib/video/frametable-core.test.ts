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
  FRAMETABLE_MODE_SMOOTH,
  FRAMETABLE_MODE_MORPH,
  FRAMETABLE_MODE_CHAOS,
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
  wshape,
  smoothField,
  sampleRingLerp,
  smoothSample,
  morphKernel,
  frametableEffMode,
  frametableLagged,
  frametableReadCentre,
  fillOnFirstFrame,
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

// ======================================================================
// F-2 — 3-MODE REWORK: mode dispatch, SMOOTH field/blend, MORPH Hann kernel,
// lag + first-frame-fill reducers. Each pins the CPU mirror the shader
// transliterates 1:1 (the SMOOTH/MORPH analogue of the CHAOS histogram test).
// ======================================================================

// ----------------------------------------------------------------------
// F-2a — mode dispatch + lag truth table (§2.2) + read-centre bias (§2.3).
// ----------------------------------------------------------------------

describe('FRAMETABLE — mode / lag dispatch', () => {
  it('the 0/1/2 encoding is SMOOTH(default)=0, MORPH=1, CHAOS=2', () => {
    expect(FRAMETABLE_MODE_SMOOTH).toBe(0);
    expect(FRAMETABLE_MODE_MORPH).toBe(1);
    expect(FRAMETABLE_MODE_CHAOS).toBe(2);
    // The def default is SMOOTH.
    const modeParam = frametableDef.params.find((p) => p.id === 'mode')!;
    expect(modeParam.defaultValue).toBe(FRAMETABLE_MODE_SMOOTH);
    expect(modeParam.curve).toBe('discrete');
    expect(modeParam.min).toBe(0);
    expect(modeParam.max).toBe(2);
  });

  it('frametableEffMode: chaosActive OVERRIDES the selector; else the rounded selector wins', () => {
    for (const m of [0, 1, 2]) {
      expect(frametableEffMode(m, false)).toBe(m); // selector honoured
      expect(frametableEffMode(m, true)).toBe(FRAMETABLE_MODE_CHAOS); // momentary chaos overrides
    }
    // rounds fractional selector values (discrete param safety).
    expect(frametableEffMode(0.4, false)).toBe(0);
    expect(frametableEffMode(1.6, false)).toBe(2);
    // clamps out-of-range.
    expect(frametableEffMode(-1, false)).toBe(0);
    expect(frametableEffMode(5, false)).toBe(2);
  });

  it('frametableLagged: CHAOS never lags; SMOOTH/MORPH lag unless LIVE forces real-time', () => {
    // CHAOS is always real-time in any live state.
    expect(frametableLagged(FRAMETABLE_MODE_CHAOS, false)).toBe(false);
    expect(frametableLagged(FRAMETABLE_MODE_CHAOS, true)).toBe(false);
    // SMOOTH/MORPH auto-lag by default…
    expect(frametableLagged(FRAMETABLE_MODE_SMOOTH, false)).toBe(true);
    expect(frametableLagged(FRAMETABLE_MODE_MORPH, false)).toBe(true);
    // …but LIVE forces real-time (no lag) in every mode.
    expect(frametableLagged(FRAMETABLE_MODE_SMOOTH, true)).toBe(false);
    expect(frametableLagged(FRAMETABLE_MODE_MORPH, true)).toBe(false);
  });

  it('frametableReadCentre: lagged window stays in [h, N-h]; real-time is morph·N', () => {
    for (const spread of [1, 8, 12, 30, 59]) {
      const h = 0.5 * Math.min(spread, N - 1);
      for (const morph of [0, 0.25, 0.5, 0.75, 1]) {
        const cLag = frametableReadCentre(morph, spread, true);
        // trailing window: c ∈ [h, N-h] so c±h ∈ [0, N] (never wraps the seam).
        expect(cLag, `lagged c(morph=${morph},spread=${spread})`).toBeGreaterThanOrEqual(h - 1e-9);
        expect(cLag).toBeLessThanOrEqual(N - h + 1e-9);
        // real-time is the raw morph·N centre (today's behaviour).
        expect(frametableReadCentre(morph, spread, false)).toBeCloseTo(morph * N, 9);
      }
      // endpoints map to the window edges.
      expect(frametableReadCentre(0, spread, true)).toBeCloseTo(h, 9);
      expect(frametableReadCentre(1, spread, true)).toBeCloseTo(N - h, 9);
    }
  });
});

// ----------------------------------------------------------------------
// F-2b — the morphable waveform (§3.2): continuity, zero-crossing alignment.
// ----------------------------------------------------------------------

describe('FRAMETABLE — morphable waveform wshape', () => {
  it('stays in [-1, 1] for every shape / position', () => {
    for (let s = 0; s <= 1.0001; s += 0.1) {
      for (let u = 0; u <= 2; u += 0.037) {
        const w = wshape(u, 1, 0, s);
        expect(w).toBeGreaterThanOrEqual(-1.0000001);
        expect(w).toBeLessThanOrEqual(1.0000001);
      }
    }
  });

  it('all four anchors cross ZERO at p=0 ⇒ any blend is ≈0 there (no phase cancellation)', () => {
    // freq=1, phase=0, u=0 ⇒ p=0. Sine/tri/saw/square all pass through 0 rising,
    // so wshape(0, …, shape) ≈ 0 for ALL shape values → blending never notches.
    for (let s = 0; s <= 1.0001; s += 0.05) {
      expect(Math.abs(wshape(0, 1, 0, s)), `wshape(0) at shape=${s}`).toBeLessThan(1e-6);
    }
  });

  it('is POSITIVE (rising into the first quarter) at p=0.25 for every shape', () => {
    // At p=0.25 all four anchors are > 0 (sine/tri/square peak at 1; saw at 0.5),
    // so any blend is strictly positive — the waveform rises coherently, no notch.
    for (let s = 0; s <= 1.0001; s += 0.05) {
      expect(wshape(0.25, 1, 0, s), `wshape(0.25) at shape=${s}`).toBeGreaterThan(0.1);
    }
  });

  it('is CONTINUOUS across the shape sweep (bounded finite difference, no anchor step)', () => {
    // Sweeping shape 0→1 crossfades sine→tri→saw→square; the crossfade is
    // smoothstep-blended so there is no jump at the anchor seams (S=1,2).
    const ds = 0.005;
    for (const u of [0.1, 0.37, 0.62, 0.88]) {
      let prev = wshape(u, 2, 0.1, 0);
      for (let s = ds; s <= 1.0001; s += ds) {
        const w = wshape(u, 2, 0.1, s);
        expect(Math.abs(w - prev), `Δwshape at u=${u}, shape≈${s.toFixed(3)}`).toBeLessThan(0.06);
        prev = w;
      }
    }
  });
});

// ----------------------------------------------------------------------
// F-2c — the 2D temporal field (§3.3): smooth (sine default) + MORPH-flatten.
// ----------------------------------------------------------------------

describe('FRAMETABLE — smoothField', () => {
  it('at the default SINE shape the field is spatially smooth (bounded ∂/∂uv)', () => {
    // The DEFAULT (shape=0, sine) field is C¹ — assert a bounded finite
    // difference across the screen. (saw/square anchors add deliberate kinks;
    // this pins the default liquid look.)
    const du = 1 / 128;
    const fld = (ux: number, uy: number) =>
      smoothField(ux, uy, 1.5, 10, 0, 0, 2, 8, 0, 0, 0.4);
    for (let uy = 0.1; uy < 0.9; uy += 0.2) {
      let prev = fld(0, uy);
      for (let ux = du; ux <= 1; ux += du) {
        const v = fld(ux, uy);
        // per-step change bounded by amp·freq·2π·du plus the cross-term slope.
        expect(Math.abs(v - prev), `∂field/∂x at (${ux.toFixed(3)},${uy})`).toBeLessThan(1.5);
        prev = v;
      }
    }
  });

  it('MORPH-flatten (fieldGain=0) ⇒ a spatially CONSTANT (zero) field', () => {
    for (let ux = 0; ux <= 1; ux += 0.13) {
      for (let uy = 0; uy <= 1; uy += 0.17) {
        // fieldGain=0 → exactly 0 (Math.abs normalises the JS -0 that 0·-x yields).
        expect(Math.abs(smoothField(ux, uy, 3, 20, 0.2, 0.5, 5, 15, 0.7, 0.3, 0.4, 0))).toBe(0);
      }
    }
  });

  it('is bounded in magnitude for any shape/amp within its span', () => {
    // |field| ≤ ampX + ampY + |cross|·0.5·(ampX+ampY) — pin it never blows up.
    const ampX = 20, ampY = 20, cross = 0.4;
    const bound = ampX + ampY + Math.abs(cross) * 0.5 * (ampX + ampY) + 1e-6;
    for (const sh of [0, 0.5, 1]) {
      for (let ux = 0; ux <= 1; ux += 0.05) {
        for (let uy = 0; uy <= 1; uy += 0.13) {
          const f = smoothField(ux, uy, 4, ampX, 0, sh, 4, ampY, 0, sh, cross);
          expect(Math.abs(f)).toBeLessThanOrEqual(bound);
        }
      }
    }
  });
});

// ----------------------------------------------------------------------
// F-2d — BLEND-not-pick (§3.4/§3.5): sampleRingLerp + the weighted average.
// ----------------------------------------------------------------------

describe('FRAMETABLE — SMOOTH is a weighted AVERAGE, not a pick', () => {
  it('sampleRingLerp truly blends adjacent layers (a fractional lag → an interpolated value)', () => {
    // ring layer 10 = 0.0, layer 11 = 1.0, else 0. A fractional lag lands
    // BETWEEN them — neither frame's value (manual inter-layer lerp).
    const ring = (layer: number) => (layer === 11 ? 1 : layer === 10 ? 0 : 0);
    // head=11: larger lag reads OLDER layers. lag=0 → layer 11 (=1), lag=1 → layer 10 (=0),
    // lag=0.5 → layerF=10.5 → mix(ring[10], ring[11], 0.5) = 0.5.
    expect(sampleRingLerp(ring, 11, 0.5)).toBeCloseTo(0.5, 9);
    expect(sampleRingLerp(ring, 11, 0.25)).toBeCloseTo(0.75, 9); // layerF=10.75, f=0.75
    expect(sampleRingLerp(ring, 11, 0.0)).toBeCloseTo(1, 9); // exactly on layer 11
    expect(sampleRingLerp(ring, 11, 1.0)).toBeCloseTo(0, 9); // exactly on layer 10
  });

  it('a STILL ring ⇒ output == the still value (a blend of a constant is the constant)', () => {
    const still = () => 0.42;
    for (const morph of [0, 0.3, 0.7, 1]) {
      for (const lagged of [true, false]) {
        expect(smoothSample(still, morph, 12, 8, lagged), `still, morph=${morph}`).toBeCloseTo(0.42, 9);
      }
    }
  });

  it('an IMPULSE ring ⇒ a value STRICTLY between 0 and 1 (an average, never a single-frame pick)', () => {
    // One bright layer among dark. CHAOS would return exactly 0 or 1 per pixel;
    // SMOOTH returns ONE deterministic intermediate value (the weighted mass).
    const L = 30;
    const impulse = (layer: number) => (layer === L ? 1 : 0);
    // Real-time centre morph=0.5 → c=30; head=59 so the window sits on L.
    const out = smoothSample(impulse, 0.5, 20, 8, false, 0, N - 1);
    expect(out, 'blend, not a pick').toBeGreaterThan(0);
    expect(out).toBeLessThan(1);
    // deterministic — no per-pixel threshold (still-image consistency analogue).
    expect(smoothSample(impulse, 0.5, 20, 8, false, 0, N - 1)).toBe(out);
  });

  it('equals the explicit Σ gaussian-strata reconstruction (pins the exact math)', () => {
    // Independent re-implementation of §3.4 — the SMOOTH analogue of the CHAOS
    // histogram certification.
    const ring = (layer: number) => Math.sin(layer * 0.3) * 0.5 + 0.5; // arbitrary smooth ring
    const morph = 0.4, spread = 16, taps = 8, head = N - 1, field = 3.2;
    const c = frametableReadCentre(morph, spread, true);
    const lagCentre = c + field;
    let acc = 0;
    for (let i = 0; i < taps; i++) {
      const t = (i + 0.5) / taps;
      const d = selectOffset(t, spread, FRAMETABLE_SHAPE_GAUSSIAN);
      // inline sampleRingLerp reference.
      const layerF = head - (lagCentre + d);
      const l0 = Math.floor(layerF);
      const f = layerF - l0;
      const c0 = ring(wrapIndex(l0));
      const c1 = ring(wrapIndex(l0 + 1));
      acc += c0 + (c1 - c0) * f;
    }
    const ref = acc / taps;
    expect(smoothSample(ring, morph, spread, taps, true, field, head)).toBeCloseTo(ref, 9);
  });
});

// ----------------------------------------------------------------------
// F-2e — MORPH Hann kernel (§4.1): Σ=1, C¹, seam periodicity, spread + cap.
// ----------------------------------------------------------------------

describe('FRAMETABLE — MORPH periodic Hann kernel', () => {
  it('weights sum to 1 across the window (a normalised reconstruction)', () => {
    for (const spread of [1, 2, 8, 12, 30, 59]) {
      for (const morph of [0, 0.25, 0.5, 0.9]) {
        const k = morphKernel(morph, spread, 40, true);
        const s = k.weights.reduce((a, b) => a + b, 0);
        expect(s, `Σw spread=${spread} morph=${morph}`).toBeCloseTo(1, 9);
        expect(k.count).toBe(k.weights.length);
        expect(k.count).toBe(k.layers.length);
      }
    }
  });

  it('spread=1 ⇒ ONE dominant weight (a crisp single moment / near-delta)', () => {
    // c = h + morph·(N-2h) with h=0.5 → most morphs land the window on one integer.
    const k = morphKernel(0.31, 1, 40, true);
    expect(k.count).toBeLessThanOrEqual(2);
    expect(Math.max(...k.weights)).toBeGreaterThan(0.9);
  });

  it('is C¹ in the scan position (weight-vector Δ bounded, no step as a frame enters)', () => {
    // Map weights → their LAYER, sweep morph by a tiny step, and assert the
    // per-layer weight change is bounded: a newly-entering frame joins at g(±h)=0
    // (zero weight AND zero slope), so the weight vector changes with no jump.
    const spread = 14, head = 40;
    const asMap = (m: number): Map<number, number> => {
      const k = morphKernel(m, spread, head, true);
      const map = new Map<number, number>();
      for (let i = 0; i < k.count; i++) map.set(k.layers[i]!, k.weights[i]!);
      return map;
    };
    const dm = 0.002;
    let prev = asMap(0.1);
    for (let m = 0.1 + dm; m <= 0.9; m += dm) {
      const cur = asMap(m);
      const keys = new Set<number>([...prev.keys(), ...cur.keys()]);
      let maxD = 0;
      for (const key of keys) maxD = Math.max(maxD, Math.abs((cur.get(key) ?? 0) - (prev.get(key) ?? 0)));
      // A jump (a frame entering with finite weight) would be O(weight) ~ 0.1+;
      // the Hann zero-edge keeps every per-step change ≪ that.
      expect(maxD, `weight-vector Δ at morph≈${m.toFixed(3)}`).toBeLessThan(0.02);
      prev = cur;
    }
  });

  it('is N-PERIODIC across the 59→0 seam (morph 0 and morph 1 give the same layer→weight map)', () => {
    // In the full-range (real-time) scan, layer_k = mod(round(head−k), N) makes
    // the kernel N-periodic: c=0 (morph 0) and c=N (morph 1) map to the SAME ring
    // layers with the SAME weights → scanning morph 0→1 loops seamlessly (value).
    const spread = 12, head = 40;
    const map0 = new Map<number, number>();
    const k0 = morphKernel(0, spread, head, false);
    for (let i = 0; i < k0.count; i++) map0.set(k0.layers[i]!, (map0.get(k0.layers[i]!) ?? 0) + k0.weights[i]!);
    const map1 = new Map<number, number>();
    const k1 = morphKernel(1, spread, head, false);
    for (let i = 0; i < k1.count; i++) map1.set(k1.layers[i]!, (map1.get(k1.layers[i]!) ?? 0) + k1.weights[i]!);
    const keys = new Set<number>([...map0.keys(), ...map1.keys()]);
    for (const key of keys) {
      expect(map1.get(key) ?? 0, `seam periodicity at layer ${key}`).toBeCloseTo(map0.get(key) ?? 0, 9);
    }
  });

  it('STRIDE-subsamples beyond the cap and still normalises to Σ=1', () => {
    // spread 60 → ~60 in-window frames > cap 32 → stride-subsample; Σw stays 1.
    const cap = 32;
    const k = morphKernel(0.5, 60, 40, false, cap);
    expect(k.count).toBeLessThanOrEqual(cap);
    expect(k.weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    // all layers are valid ring indices.
    for (const layer of k.layers) {
      expect(layer).toBeGreaterThanOrEqual(0);
      expect(layer).toBeLessThan(N);
    }
  });
});

// ----------------------------------------------------------------------
// F-2f — first-frame-fill reducer (§2.4).
// ----------------------------------------------------------------------

describe('FRAMETABLE — first-frame-fill reducer', () => {
  it('signals FILL on the first real input frame, then never re-fills', () => {
    // Before any input: black warmup, no fill.
    const noInput = fillOnFirstFrame({ head: 0, capturedAny: false, framesElapsed: 0 }, false);
    expect(noInput.filled).toBe(false);
    expect(noInput.capturedAny).toBe(false);
    expect(noInput.head).toBe(1); // head still advances (capture always records)

    // First REAL input frame → fill ALL N layers (buffer instantly full).
    const first = fillOnFirstFrame({ head: 3, capturedAny: false, framesElapsed: 3 }, true);
    expect(first.filled).toBe(true);
    expect(first.capturedAny).toBe(true);
    expect(first.head).toBe(4);

    // Subsequent real frames wash in one layer at a time — NEVER re-fill.
    const later = fillOnFirstFrame({ head: 4, capturedAny: true, framesElapsed: 4 }, true);
    expect(later.filled).toBe(false);
    expect(later.capturedAny).toBe(true);
  });

  it('head wraps at the ring boundary during fill/wash-in', () => {
    const wrap = fillOnFirstFrame({ head: N - 1, capturedAny: true, framesElapsed: 100 }, true);
    expect(wrap.head).toBe(0);
    expect(wrap.filled).toBe(false);
  });
});
