// packages/web/src/lib/audio/modules/vizvco.test.ts
//
// Unit tests for VIZVCO. The Vite asset URL imports + Faust runtime
// (instantiateFaustModule + AudioWorkletNode) only resolve in the
// browser, so we can't `import { vizvcoDef }` here without crashing
// the node test runner. Instead we test the pure helper buildFoldCurve
// + the def shape via the dynamic import safely guarded.

import { describe, expect, it } from 'vitest';
import { buildFoldCurve } from './vizvco';

describe('VIZVCO buildFoldCurve', () => {
  it('fold = 0 → identity (passthrough)', () => {
    const c = buildFoldCurve(0);
    expect(c.length).toBeGreaterThan(0);
    // Spot-check a few sample points; identity means c[i] ≈ 2*i/(N-1) - 1.
    const N = c.length;
    expect(c[0]).toBeCloseTo(-1, 6);
    expect(c[N - 1]).toBeCloseTo(1, 6);
    expect(c[Math.floor(N / 2)]).toBeCloseTo(0, 2);
  });

  it('fold > 0 produces oscillatory curve (foldback)', () => {
    const c = buildFoldCurve(1.0);
    // sin(x * π * 5) over [-1, 1] crosses zero many times. Count zero
    // crossings; identity has exactly 1 (at x = 0). A folded curve has
    // many.
    let crossings = 0;
    for (let i = 1; i < c.length; i++) {
      if (Math.sign(c[i - 1]!) !== Math.sign(c[i]!)) crossings++;
    }
    expect(crossings, 'fold=1 has many zero crossings').toBeGreaterThan(5);
  });

  it('curve values stay bounded in [-1, 1]', () => {
    for (const fold of [0, 0.25, 0.5, 1.0]) {
      const c = buildFoldCurve(fold);
      let mn = +Infinity, mx = -Infinity;
      for (const v of c) {
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      expect(mn, `fold=${fold} min ≥ -1.0001`).toBeGreaterThanOrEqual(-1.0001);
      expect(mx, `fold=${fold} max ≤ 1.0001`).toBeLessThanOrEqual(1.0001);
    }
  });

  it('higher fold yields more harmonic content (more zero crossings)', () => {
    const lowFolds = [0.1, 0.25];
    const highFolds = [0.75, 1.0];
    function crossings(c: Float32Array): number {
      let n = 0;
      for (let i = 1; i < c.length; i++) {
        if (Math.sign(c[i - 1]!) !== Math.sign(c[i]!)) n++;
      }
      return n;
    }
    const low = lowFolds.map((f) => crossings(buildFoldCurve(f)));
    const high = highFolds.map((f) => crossings(buildFoldCurve(f)));
    // Each high fold should outclass at least one low fold.
    expect(Math.min(...high)).toBeGreaterThan(Math.max(...low) - 1);
  });
});

describe('VIZVCO module def shape', () => {
  it('exports vizvcoDef with the right ports + params', async () => {
    // Use a dynamic import so this test file doesn't itself crash if
    // the Vite asset URLs fail to resolve in node — buildFoldCurve
    // tests above run regardless.
    const mod = await import('./vizvco');
    const def = mod.vizvcoDef;
    expect(def.type).toBe('vizvco');
    expect(def.domain).toBe('audio');
    expect(def.label).toBe('VIZVCO');

    const inputIds = def.inputs.map((p) => p.id).sort();
    expect(inputIds).toContain('pitch');
    expect(inputIds).toContain('fm');
    expect(inputIds).toContain('foldAmount');

    const outputIds = def.outputs.map((p) => p.id).sort();
    expect(outputIds).toContain('saw');
    expect(outputIds).toContain('square');
    expect(outputIds).toContain('triangle');
    expect(outputIds).toContain('sine');
    expect(outputIds).toContain('scope');

    const scope = def.outputs.find((p) => p.id === 'scope');
    expect(scope?.type).toBe('mono-video');

    const foldParam = def.params.find((p) => p.id === 'foldAmount');
    expect(foldParam, 'fold knob declared').toBeDefined();
    expect(foldParam?.min).toBe(0);
    expect(foldParam?.max).toBe(1);
  });
});
