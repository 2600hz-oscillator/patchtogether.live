// packages/web/src/lib/video/modules/mandleblot.test.ts
//
// Unit tests for the MANDLEBLOT module def + the pure JS-side
// log-zoom mapping. The actual GL pipeline is exercised by E2E
// (jsdom can't render shaders).

import { describe, it, expect } from 'vitest';
import { mandleblotDef, jsZoomFromKnob, MANDLEBLOT_DEFAULTS } from './mandleblot';
import type { VideoEngineContext } from '$lib/video/engine';
import type { ModuleNode } from '$lib/graph/types';

describe('mandleblotDef shape', () => {
  it('exported MANDLEBLOT_DEFAULTS matches the per-param defaults', () => {
    expect(MANDLEBLOT_DEFAULTS).toEqual({
      zoom: 0.2,
      rotation: 0,
      iterations: 150,
      color_cycle: 1,
      center_x: -0.7,
      center_y: 0,
    });
  });
});

describe('jsZoomFromKnob — log-mapped 1×..1e6×', () => {
  it('knob = 0 → 1× (no zoom; full set in view)', () => {
    expect(jsZoomFromKnob(0)).toBe(1);
  });

  it('knob = 0.5 → ~1000× (10^3)', () => {
    // 10^(6*0.5) == 10^3 == 1000.
    expect(jsZoomFromKnob(0.5)).toBeCloseTo(1000, 5);
  });

  it('knob = 0.8 → ~1e5×', () => {
    // 10^(6*0.8) == 10^4.8 ≈ 63,095.7 — the documented "around 1e5" point.
    // We assert on an order of magnitude window because 10^4.8 is the
    // exact value, not 1e5 sharp.
    const z = jsZoomFromKnob(0.8);
    expect(z).toBeGreaterThan(50_000);
    expect(z).toBeLessThan(200_000);
    // Pin the exact mapping value so any change to the log-mapping is
    // caught by this test (e.g. someone refactors to 5*k instead of 6*k).
    expect(z).toBeCloseTo(Math.pow(10, 4.8), 0);
  });

  it('knob = 1.0 → 1e6× (the practical highp-float ceiling)', () => {
    expect(jsZoomFromKnob(1.0)).toBeCloseTo(1_000_000, 0);
  });

  it('clamps below 0 and above 1', () => {
    expect(jsZoomFromKnob(-0.5)).toBe(1);   // clamped to 0 → 10^0 = 1
    expect(jsZoomFromKnob(2)).toBeCloseTo(1_000_000, 0);
  });

  it('is monotonic across the knob range', () => {
    let prev = jsZoomFromKnob(0);
    for (let k = 0.05; k <= 1.0; k += 0.05) {
      const z = jsZoomFromKnob(k);
      expect(z).toBeGreaterThan(prev);
      prev = z;
    }
  });
});

// ---------------------------------------------------------------------------
// PARAM-MUTATION WIRING — downgraded from mandleblot.spec.ts test 2 ("zoom
// param mutation propagates to the engine without errors"), webgl-suite-
// optimization §2/§7-3. The e2e only wrote node.params.zoom into the store and
// read it BACK from the store — it never touched the engine, so it was a pure
// store round-trip with no GL/engine assertion (a downgrade target). This drives
// the REAL mandleblotDef factory's setParam hot-path (what the CV bridge calls)
// and asserts the live param + the post-curve zoomFactor the card reads, with no
// render and no GPU boot — a regression in setParam / jsZoomFromKnob wiring fails
// this fast unit test. (The GL PIXEL backstop for this VRT-exempt module is the
// deterministic mandleblot-render-smoke.spec.ts — non-black + structured +
// frame-stable on the COLOUR output — per plan §6.)
// ---------------------------------------------------------------------------

function makeFakeGl(): WebGL2RenderingContext {
  return new Proxy(
    {},
    {
      get: (_t, prop) => {
        const p = String(prop);
        if (p.startsWith('create') || p === 'getUniformLocation') return () => ({});
        if (p === 'checkFramebufferStatus') return () => 0x8cd5;
        if (p === 'getProgramParameter' || p === 'getShaderParameter') return () => true;
        if (p === 'getExtension') return () => null;
        return () => 0;
      },
    },
  ) as unknown as WebGL2RenderingContext;
}

function makeCtx(): VideoEngineContext {
  return {
    gl: makeFakeGl(),
    res: { width: 1024, height: 768 },
    compileFragment: () => ({}) as WebGLProgram,
    createFbo: () => ({ fbo: {} as WebGLFramebuffer, texture: {} as WebGLTexture }),
    createFloatFbo: () => ({ fbo: {} as WebGLFramebuffer, texture: {} as WebGLTexture, isFloat: false, width: 1024, height: 768 }),
    drawFullscreenQuad: () => undefined,
  };
}

describe('MANDLEBLOT factory setParam propagates to the live engine param', () => {
  it('setParam(zoom/iterations/color_cycle) updates the readback + post-curve zoomFactor', () => {
    const node = {
      id: 'mb', type: 'mandleblot', domain: 'video', position: { x: 0, y: 0 }, params: {},
    } as unknown as ModuleNode;
    const handle = mandleblotDef.factory(makeCtx(), node);
    try {
      // Defaults before any drive (zoom default 0.2 → factor jsZoomFromKnob(0.2)).
      expect(handle.readParam?.('zoom')).toBe(0.2);
      expect(handle.read?.('zoomFactor')).toBeCloseTo(jsZoomFromKnob(0.2), 5);

      // Drive zoom 0.2 → 0.7 (the e2e's sweep), iterations + color_cycle too.
      handle.setParam?.('zoom', 0.7);
      handle.setParam?.('iterations', 250);
      handle.setParam?.('color_cycle', 2);

      expect(handle.readParam?.('zoom'), 'zoom propagated to engine param').toBe(0.7);
      expect(handle.readParam?.('iterations')).toBe(250);
      expect(handle.readParam?.('color_cycle')).toBe(2);
      // The post-curve zoomFactor the card reads moves with the knob.
      expect(handle.read?.('zoomFactor'), 'zoomFactor reflects jsZoomFromKnob(0.7)')
        .toBeCloseTo(jsZoomFromKnob(0.7), 5);
    } finally {
      handle.dispose();
    }
  });
});
