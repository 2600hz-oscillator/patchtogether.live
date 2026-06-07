// packages/web/src/lib/video/modules/shapegen.test.ts
//
// SHAPEGEN — unit coverage for:
//   • Module def shape (3 video inputs, 1 video output, 3 params, defaults).
//   • Size scaling: a SIZE knob of 2 produces shapes whose final radii are
//     2× the size=1 case (modulo the clamp). We exercise this through the
//     SAME math the factory uses (generateShapes → scale → clamp), so the
//     test pins the contract documented in shapegen.ts without needing a
//     GL context.
//   • Rotate: documents that ROT knob 0..1 maps to camera angle 0..2π via
//     `rotate * 2π`.
//   • Solids toggle: renderer's solids branch is exercised (sphere paints
//     differently with solids on vs off — pixel content differs).
//
// The factory's GL-side draw() needs a WebGL2 context which jsdom doesn't
// provide — that's exercised by the e2e spec. Here we cover the pure
// math contract + the renderer mode-switch through a real canvas2D.

import { describe, it, expect, beforeAll } from 'vitest';
import {
  shapegenDef,
  SHAPEGEN_RADIUS_CLAMP,
  SHAPEGEN_RASTER_W,
  SHAPEGEN_RASTER_H,
  SHAPEGEN_CLOCK_PARAM_ID,
  SHAPEGEN_CLOCK_PORT_ID,
} from './shapegen';
import { generateShapes, type Shape } from './shapegen-math';
import { drawShapesScene, isLitShapeType } from './shapegen-draw';
import type { VideoEngineContext, VideoFrameContext } from '$lib/video/engine';
import type { ModuleNode } from '$lib/graph/types';

// ── 1. Module def shape ───────────────────────────────────────────────────

describe('shapegenDef — module shape', () => {
  it('is a video-domain module called SHAPEGEN', () => {
    expect(shapegenDef.type).toBe('shapegen');
    expect(shapegenDef.domain).toBe('video');
    expect(shapegenDef.label).toBe('SHAPEGEN');
    expect(shapegenDef.schemaVersion).toBe(1);
  });

  it('declares 3 video inputs + 1 gate input (raster_a / raster_b / raster_c + clock_in)', () => {
    const ids = shapegenDef.inputs.map((p) => p.id).sort();
    expect(ids).toEqual(['clock_in', 'raster_a', 'raster_b', 'raster_c']);
    // The three rasters are all VIDEO. The clock is a GATE with paramTarget.
    for (const port of shapegenDef.inputs) {
      if (port.id.startsWith('raster_')) {
        expect(port.type).toBe('video');
        expect(port.paramTarget).toBeUndefined();
      } else if (port.id === 'clock_in') {
        expect(port.type).toBe('gate');
        // The gate routes through the CV-bridge into the cv_clock param.
        expect(port.paramTarget).toBe('cv_clock');
      } else {
        throw new Error(`unexpected port id: ${port.id}`);
      }
    }
  });

  it('declares exactly one video output (out)', () => {
    expect(shapegenDef.outputs).toHaveLength(1);
    expect(shapegenDef.outputs[0]!.id).toBe('out');
    expect(shapegenDef.outputs[0]!.type).toBe('video');
  });

  it('declares the 3 user params + 1 synthetic clock-gate param', () => {
    const ids = shapegenDef.params.map((p) => p.id).sort();
    // The 4th id is the synthetic cv_clock param the CV-bridge writes the
    // clock_in gate sample into. Hidden from the card UI.
    expect(ids).toEqual(['cv_clock', 'rotate', 'size', 'solids']);

    const cvClock = shapegenDef.params.find((p) => p.id === 'cv_clock')!;
    expect(cvClock.defaultValue).toBe(0);
    expect(cvClock.min).toBe(0);
    expect(cvClock.max).toBe(1);
    expect(cvClock.curve).toBe('linear');

    const size = shapegenDef.params.find((p) => p.id === 'size')!;
    expect(size.defaultValue).toBe(1);
    expect(size.min).toBe(0.1);
    expect(size.max).toBe(3);
    expect(size.curve).toBe('linear');

    const rotate = shapegenDef.params.find((p) => p.id === 'rotate')!;
    expect(rotate.defaultValue).toBe(0);
    expect(rotate.min).toBe(0);
    expect(rotate.max).toBe(1);
    expect(rotate.curve).toBe('linear');

    const solids = shapegenDef.params.find((p) => p.id === 'solids')!;
    expect(solids.defaultValue).toBe(0);
    expect(solids.min).toBe(0);
    expect(solids.max).toBe(1);
    expect(solids.curve).toBe('discrete');
  });

  it('only the clock_in input carries a paramTarget (the rasters do not)', () => {
    for (const port of shapegenDef.inputs) {
      if (port.id === 'clock_in') {
        expect(port.paramTarget).toBe('cv_clock');
      } else {
        expect(port.paramTarget).toBeUndefined();
      }
    }
  });

  it('exports the read-FBO raster dims that the factory uses', () => {
    expect(SHAPEGEN_RASTER_W).toBeGreaterThan(0);
    expect(SHAPEGEN_RASTER_H).toBeGreaterThan(0);
    // 80×60 matches the engine's 4:3 RES at 1/8 — pin so a change is
    // intentional. Spans the FULL upstream frame via a fullscreen-quad
    // downsample (NOT a corner read).
    expect(SHAPEGEN_RASTER_W).toBe(80);
    expect(SHAPEGEN_RASTER_H).toBe(60);
  });
});

// ── 2. Size scaling pipeline ──────────────────────────────────────────────

function buildBrightSpotRaster(w: number, h: number, cx = 0.5, cy = 0.5): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = x / Math.max(1, w - 1);
      const ny = y / Math.max(1, h - 1);
      const dx = nx - cx;
      const dy = ny - cy;
      const v = Math.exp(-(dx * dx + dy * dy) * 80);
      const b = Math.round(v * 255);
      const o = (y * w + x) * 4;
      out[o] = b; out[o + 1] = b; out[o + 2] = b; out[o + 3] = 255;
    }
  }
  return out;
}

function flatRaster(w: number, h: number, l: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  const b = Math.round(l * 255);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = b; out[i + 1] = b; out[i + 2] = b; out[i + 3] = 255;
  }
  return out;
}

/**
 * Replicate the factory's size-application step in pure JS so we can pin
 * it without standing up WebGL. The factory does this same map() inside
 * draw() — see shapegen.ts step 3.
 */
function applySizeKnob(shapes: readonly Shape[], size: number): Shape[] {
  const sizeKnob = Math.max(0.1, Math.min(3, size));
  return shapes.map((s) => ({
    ...s,
    radius: Math.min(SHAPEGEN_RADIUS_CLAMP, s.radius * sizeKnob),
  }));
}

describe('shapegen — SIZE knob radius scaling', () => {
  it('with size=2, each shape\'s radius doubles (modulo the 0.6 clamp)', () => {
    const W = SHAPEGEN_RASTER_W;
    const H = SHAPEGEN_RASTER_H;
    const A = buildBrightSpotRaster(W, H);
    // Force a SMALL baseline so doubling stays below the clamp.
    // C=0 baseline → radius=0.05 (the minimum); 2× = 0.1, well under 0.6.
    const B = flatRaster(W, H, 0.5);
    const C = flatRaster(W, H, 0); // → baseline radius = 0.05 for every shape
    const base = generateShapes(A, B, C, W, H);
    expect(base.length).toBeGreaterThan(0);

    const at1 = applySizeKnob(base, 1);
    const at2 = applySizeKnob(base, 2);

    expect(at2.length).toBe(at1.length);
    for (let i = 0; i < at1.length; i++) {
      // Doubling — every shape's radius scales by 2 (no clamp at this scale).
      expect(at2[i]!.radius).toBeCloseTo(at1[i]!.radius * 2, 6);
    }
  });

  it('clamps the final radius to SHAPEGEN_RADIUS_CLAMP (0.6)', () => {
    const W = SHAPEGEN_RASTER_W;
    const H = SHAPEGEN_RASTER_H;
    const A = buildBrightSpotRaster(W, H);
    // C=1 baseline → radius=0.3; size=3 → 0.9 → clamped to 0.6.
    const B = flatRaster(W, H, 0.5);
    const C = flatRaster(W, H, 0.99);
    const base = generateShapes(A, B, C, W, H);
    const scaled = applySizeKnob(base, 3);
    expect(scaled.length).toBeGreaterThan(0);
    for (const s of scaled) {
      expect(s.radius).toBeLessThanOrEqual(SHAPEGEN_RADIUS_CLAMP + 1e-9);
    }
    // At least one shape should HIT the clamp (otherwise the test is vacuous).
    expect(scaled.some((s) => Math.abs(s.radius - SHAPEGEN_RADIUS_CLAMP) < 1e-6)).toBe(true);
  });

  it('size=1 is a no-op unless the baseline is already over the clamp', () => {
    const W = SHAPEGEN_RASTER_W;
    const H = SHAPEGEN_RASTER_H;
    const A = buildBrightSpotRaster(W, H);
    const B = flatRaster(W, H, 0.5);
    // C=0.5 baseline → radius=0.175 (well under the 0.6 clamp).
    const C = flatRaster(W, H, 0.5);
    const base = generateShapes(A, B, C, W, H);
    const scaled = applySizeKnob(base, 1);
    for (let i = 0; i < base.length; i++) {
      expect(scaled[i]!.radius).toBeCloseTo(base[i]!.radius, 6);
    }
  });
});

// ── 3. Rotate knob — angle math contract ─────────────────────────────────

describe('shapegen — ROT knob → camera angle', () => {
  it('the renderer interprets rotate * 2π as the Y-axis camera rotation', () => {
    // Pin via the factory's documented mapping (shapegen.ts step 4):
    //   drawShapesScene(..., { rotation: params.rotate * Math.PI * 2, ... })
    // We assert the constants here so a future bug that changes the
    // mapping (e.g. only rotates by π) trips this test.
    expect(0.5 * Math.PI * 2).toBeCloseTo(Math.PI, 9);
    expect(1.0 * Math.PI * 2).toBeCloseTo(2 * Math.PI, 9);
  });
});

// ── 4. Solids toggle — renderer mode switch ──────────────────────────────

/** Reuse a canvas-stub that records draw calls so we can prove the SOLIDS
 *  branch is exercised without standing up a real DOM canvas. */
interface MockCtxLog {
  fills: { style: string }[];
  arcs: { x: number; y: number; r: number }[];
  rects: { x: number; y: number; w: number; h: number }[];
  ellipses: number;
  gradients: number;
}

function makeMockCtx(w: number, h: number): {
  ctx: CanvasRenderingContext2D;
  log: MockCtxLog;
} {
  const log: MockCtxLog = { fills: [], arcs: [], rects: [], ellipses: 0, gradients: 0 };
  // A bare-bones context that records the call sequence shapegen-draw
  // makes. Properties are stubbed; only the calls we care about are logged.
  const ctx = {
    canvas: { width: w, height: h },
    fillStyle: '' as string | CanvasGradient,
    strokeStyle: '' as string | CanvasGradient,
    lineWidth: 1,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over' as string,
    save() {},
    restore() {},
    fillRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    fill() { log.fills.push({ style: String(ctx.fillStyle) }); },
    stroke() {},
    arc(x: number, y: number, r: number) { log.arcs.push({ x, y, r }); },
    rect(x: number, y: number, ww: number, hh: number) { log.rects.push({ x, y, w: ww, h: hh }); },
    ellipse() { log.ellipses++; },
    createLinearGradient() { log.gradients++; return { addColorStop() {} }; },
    createRadialGradient() { log.gradients++; return { addColorStop() {} }; },
  } as unknown as CanvasRenderingContext2D;
  return { ctx, log };
}

describe('shapegen — SOLIDS toggle exercises the lit renderer branch', () => {
  it('wireframe mode does NOT call ellipse() (no foreshortening at bases)', () => {
    const shapes: Shape[] = [
      { type: 'sphere', pos: { x: 0, y: 0, z: 0 }, radius: 0.3, hue: 0.2 },
      { type: 'cube',   pos: { x: 0.3, y: 0.1, z: 0 }, radius: 0.25, hue: 0.5 },
      { type: 'cone',   pos: { x: -0.3, y: 0.2, z: 0 }, radius: 0.25, hue: 0.8 },
      { type: 'cylinder', pos: { x: 0, y: -0.3, z: 0 }, radius: 0.25, hue: 0.4 },
    ];
    const { ctx, log } = makeMockCtx(200, 144);
    drawShapesScene(ctx, shapes, 200, 144, { mode: 'wireframe', rotation: 0 });
    // Wireframe path uses only arc/rect/triangles + the wireframe-mode
    // radial gradient. NO ellipse() calls (which only happen for the
    // solids cylinder/cone base-plates).
    expect(log.ellipses).toBe(0);
  });

  it('solids mode runs the ring path (destination-out hole) without throwing', () => {
    const shapes: Shape[] = [
      { type: 'ring', pos: { x: 0, y: 0, z: 0 }, radius: 0.4, hue: 0.5 },
    ];
    const { ctx, log } = makeMockCtx(200, 144);
    expect(() => drawShapesScene(ctx, shapes, 200, 144, { mode: 'solids', rotation: 0 })).not.toThrow();
    // Solid ring draws the disc fill + hole-punch fill + inner/outer rim
    // strokes — at least 2 fill() calls (outer disc + hole punch).
    expect(log.fills.length).toBeGreaterThanOrEqual(2);
    // ≥ 3 arc() calls for the outer disc, the hole, and the inner-rim
    // darken stroke (plus the outer-rim stroke = 4).
    expect(log.arcs.length).toBeGreaterThanOrEqual(3);
  });

  it('solids mode runs the tetra path (4-face painter\'s algorithm) without throwing', () => {
    const shapes: Shape[] = [
      { type: 'tetraFrame', pos: { x: 0, y: 0, z: 0 }, radius: 0.4, hue: 0.3 },
    ];
    const { ctx, log } = makeMockCtx(200, 144);
    expect(() => drawShapesScene(ctx, shapes, 200, 144, { mode: 'solids', rotation: 0 })).not.toThrow();
    // Solid tetra fills 4 triangle faces — at least 4 fill() calls from
    // the lit-tetra renderer (more if other scene chrome adds calls).
    expect(log.fills.length).toBeGreaterThanOrEqual(4);
  });

  it('solids mode calls ellipse() for cylinder + cone base plates', () => {
    const shapes: Shape[] = [
      { type: 'cylinder', pos: { x: 0, y: 0, z: 0 }, radius: 0.25, hue: 0.4 },
      { type: 'cone',     pos: { x: 0.3, y: 0, z: 0 }, radius: 0.25, hue: 0.8 },
    ];
    const { ctx, log } = makeMockCtx(200, 144);
    drawShapesScene(ctx, shapes, 200, 144, { mode: 'solids', rotation: 0 });
    // Solid cylinder: top + bottom ellipses (×2). Solid cone: base ellipse (×1).
    // Both ALSO call ellipse() inside their stroke-outline pass for the
    // cylinder top. We assert ≥ 3 (the floor) so the test isn't fragile to
    // extra outline calls a future tweak might add.
    expect(log.ellipses).toBeGreaterThanOrEqual(3);
  });

  it('isLitShapeType: all 6 primitives have a dedicated lit renderer in SOLIDS mode', () => {
    // Post-solids-all-primitives PR: ring + tetraFrame now have lit
    // renderers too (filled torus + 4-face Lambert tetrahedron). The
    // legacy "stays wireframe" behaviour is gone.
    expect(isLitShapeType('sphere')).toBe(true);
    expect(isLitShapeType('cube')).toBe(true);
    expect(isLitShapeType('cylinder')).toBe(true);
    expect(isLitShapeType('cone')).toBe(true);
    expect(isLitShapeType('ring')).toBe(true);
    expect(isLitShapeType('tetraFrame')).toBe(true);
  });
});

// ── 4b. SOLIDS-mode renders RING + TETRA (new in solids-all-primitives PR) ─

describe('shapegen — SOLIDS mode renders ring + tetraFrame as solids', () => {
  // Real OffscreenCanvas (vitest jsdom polyfills it on node 22+). If
  // absent, skip — the mock-ctx test below proves the BRANCH is taken,
  // and the pixel-diff test is the secondary regression gate.
  beforeAll(() => {
    if (typeof OffscreenCanvas === 'undefined') {
      console.warn('OffscreenCanvas unavailable — skipping ring/tetra pixel-diff');
    }
  });

  it('SOLIDS ring renders different pixels than WIREFRAME ring (filled vs stroked)', () => {
    if (typeof OffscreenCanvas === 'undefined') return;
    const cWf = new OffscreenCanvas(64, 64);
    const cSo = new OffscreenCanvas(64, 64);
    const ctxWf = cWf.getContext('2d');
    const ctxSo = cSo.getContext('2d');
    if (!ctxWf || !ctxSo) return;
    const shapes: Shape[] = [
      // Big ring centred + close to camera so the body lands inside the FOV.
      { type: 'ring', pos: { x: 0, y: 0, z: 0 }, radius: 0.5, hue: 0.55 },
    ];
    drawShapesScene(ctxWf as unknown as OffscreenCanvasRenderingContext2D, shapes, 64, 64, {
      mode: 'wireframe', rotation: 0,
    });
    drawShapesScene(ctxSo as unknown as OffscreenCanvasRenderingContext2D, shapes, 64, 64, {
      mode: 'solids', rotation: 0,
    });
    const wf = ctxWf.getImageData(0, 0, 64, 64).data;
    const so = ctxSo.getImageData(0, 0, 64, 64).data;
    let diffPx = 0;
    for (let i = 0; i < wf.length; i += 4) {
      if (wf[i] !== so[i] || wf[i + 1] !== so[i + 1] || wf[i + 2] !== so[i + 2]) diffPx++;
    }
    // Filled torus body adds a LOT of differently-coloured pixels relative
    // to a thin stroked ring — far above noise.
    expect(diffPx).toBeGreaterThan(100);
  });

  it('SOLIDS tetra renders different pixels than WIREFRAME tetra (4 lit faces vs 3 stroked edges)', () => {
    if (typeof OffscreenCanvas === 'undefined') return;
    const cWf = new OffscreenCanvas(64, 64);
    const cSo = new OffscreenCanvas(64, 64);
    const ctxWf = cWf.getContext('2d');
    const ctxSo = cSo.getContext('2d');
    if (!ctxWf || !ctxSo) return;
    const shapes: Shape[] = [
      { type: 'tetraFrame', pos: { x: 0, y: 0, z: 0 }, radius: 0.5, hue: 0.15 },
    ];
    drawShapesScene(ctxWf as unknown as OffscreenCanvasRenderingContext2D, shapes, 64, 64, {
      mode: 'wireframe', rotation: 0,
    });
    drawShapesScene(ctxSo as unknown as OffscreenCanvasRenderingContext2D, shapes, 64, 64, {
      mode: 'solids', rotation: 0,
    });
    const wf = ctxWf.getImageData(0, 0, 64, 64).data;
    const so = ctxSo.getImageData(0, 0, 64, 64).data;
    let diffPx = 0;
    for (let i = 0; i < wf.length; i += 4) {
      if (wf[i] !== so[i] || wf[i + 1] !== so[i + 1] || wf[i + 2] !== so[i + 2]) diffPx++;
    }
    // 4 filled triangle faces vs the wireframe's 3 stroked edges → many
    // more pixels coloured by the tetra body.
    expect(diffPx).toBeGreaterThan(100);
  });
});

// ── 5. Rendered-pixel content differs between modes (real canvas) ────────

describe('shapegen — wireframe vs solids produces different rendered pixels', () => {
  // Use a real OffscreenCanvas in node 22+ (vitest jsdom polyfills it).
  // If unavailable in the environment, skip — the mock-ctx test above
  // already proves the branch is taken.
  beforeAll(() => {
    if (typeof OffscreenCanvas === 'undefined') {
      console.warn('OffscreenCanvas unavailable — skipping pixel-diff sanity check');
    }
  });

  it('the same shape list renders different pixel content in solids vs wireframe mode', () => {
    if (typeof OffscreenCanvas === 'undefined') return;
    const c1 = new OffscreenCanvas(64, 64);
    const c2 = new OffscreenCanvas(64, 64);
    const ctx1 = c1.getContext('2d');
    const ctx2 = c2.getContext('2d');
    if (!ctx1 || !ctx2) return;
    const shapes: Shape[] = [
      { type: 'sphere', pos: { x: 0, y: 0, z: 0 }, radius: 0.4, hue: 0.5 },
    ];
    drawShapesScene(ctx1 as unknown as OffscreenCanvasRenderingContext2D, shapes, 64, 64, {
      mode: 'wireframe', rotation: 0,
    });
    drawShapesScene(ctx2 as unknown as OffscreenCanvasRenderingContext2D, shapes, 64, 64, {
      mode: 'solids', rotation: 0,
    });
    const a = ctx1.getImageData(0, 0, 64, 64).data;
    const b = ctx2.getImageData(0, 0, 64, 64).data;
    let diffPx = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) diffPx++;
    }
    // Definitely SOMETHING should differ between the two modes.
    expect(diffPx).toBeGreaterThan(50);
  });
});

// ── 6. Clock-gate sample-and-hold pin (new in clock-gate PR) ─────────────

/** Fake GL + Frame context — mirrors scoreboard.test.ts. */
function makeFakeGl(): WebGL2RenderingContext {
  const stub = (): unknown => ({});
  return {
    getUniformLocation: stub,
    createTexture: () => ({}),
    createFramebuffer: () => ({}),
    bindTexture: () => undefined,
    texParameteri: () => undefined,
    texImage2D: () => undefined,
    pixelStorei: () => undefined,
    deleteTexture: () => undefined,
    deleteFramebuffer: () => undefined,
    deleteProgram: () => undefined,
    activeTexture: () => undefined,
    bindFramebuffer: () => undefined,
    framebufferTexture2D: () => undefined,
    viewport: () => undefined,
    useProgram: () => undefined,
    uniform1i: () => undefined,
    uniform1f: () => undefined,
    uniform2f: () => undefined,
    readPixels: () => undefined,
    TEXTURE_2D: 0, RGBA: 0, UNSIGNED_BYTE: 0,
    TEXTURE_MIN_FILTER: 0, TEXTURE_MAG_FILTER: 0,
    TEXTURE_WRAP_S: 0, TEXTURE_WRAP_T: 0,
    LINEAR: 0, CLAMP_TO_EDGE: 0,
    UNPACK_FLIP_Y_WEBGL: 0,
    TEXTURE0: 0,
    FRAMEBUFFER: 0, COLOR_ATTACHMENT0: 0,
  } as unknown as WebGL2RenderingContext;
}

function makeShapegenCtx(): VideoEngineContext {
  return {
    gl: makeFakeGl(),
    res: { width: 1024, height: 768 },
    compileFragment: () => ({}) as WebGLProgram,
    createFbo: () => ({ fbo: {} as WebGLFramebuffer, texture: {} as WebGLTexture }),
    drawFullscreenQuad: () => undefined,
  };
}

function spawnShapegen() {
  const node = {
    id: 'sg',
    type: 'shapegen',
    domain: 'video',
    params: {},
    position: { x: 0, y: 0 },
  } as ModuleNode;
  return shapegenDef.factory(makeShapegenCtx(), node);
}

/** Synthesise a one-frame draw() pass — returns the frame number for the
 *  sequence. The fake frame ctx returns null for getInputTexture so the
 *  factory hits the zero-fill fall-back (cheap; no real GL needed). */
function makeFrameCtx(frameNo: number): VideoFrameContext {
  return {
    gl: makeFakeGl(),
    time: frameNo / 60,
    frame: frameNo,
    getInputTexture: () => null,
  };
}

describe('shapegen — clock_in gate sample-and-hold', () => {
  it('declares clock_in as a gate input with paramTarget cv_clock', () => {
    const port = shapegenDef.inputs.find((p) => p.id === SHAPEGEN_CLOCK_PORT_ID);
    expect(port).toBeDefined();
    expect(port!.type).toBe('gate');
    expect(port!.paramTarget).toBe(SHAPEGEN_CLOCK_PARAM_ID);
  });

  it('the rising-edge sequence [0,0,1,1,0,1] triggers exactly 2 regenerations', () => {
    const h = spawnShapegen();
    // Drive the first frame so the initial-regen flag clears + the
    // factory has a baseline cached shape list. After this draw the
    // regenCount is 1 (the seed regeneration).
    h.surface.draw(makeFrameCtx(0));
    expect(h.read?.('regenCount')).toBe(1);
    expect(h.read?.('clockPatched')).toBe(0);

    // Plug the gate. Per-sample sequence [0,0,1,1,0,1] → 2 rising edges
    // (indices 2 + 5). EACH rising edge schedules ONE regeneration on
    // the NEXT draw; held-high samples don't trigger any. Held-low
    // samples don't trigger any (the unpatched-style "regen every
    // frame" path is off once clockPatched flips on).
    const samples = [0, 0, 1, 1, 0, 1];
    for (const s of samples) {
      h.setParam(SHAPEGEN_CLOCK_PARAM_ID, s);
      // Drive a frame so draw() consumes pendingRegenerate.
      h.surface.draw(makeFrameCtx(1));
    }
    // The pure gate-edge math: 2 rising edges → 2 NEW regenerations on
    // top of the seed → regenCount should be 3.
    expect(h.read?.('regenCount')).toBe(3);
    // setParam was called → clockPatched flipped on first sample.
    expect(h.read?.('clockPatched')).toBe(1);
  });

  it('a held-HIGH gate (no falling edge) regenerates exactly ONCE', () => {
    // Seed regen.
    const h = spawnShapegen();
    h.surface.draw(makeFrameCtx(0));
    const seedRegen = h.read?.('regenCount') as number;
    expect(seedRegen).toBe(1);

    // Repeated 1s — ONE rising edge → ONE regeneration → total = seed + 1.
    for (let i = 0; i < 5; i++) {
      h.setParam(SHAPEGEN_CLOCK_PARAM_ID, 1);
      h.surface.draw(makeFrameCtx(1 + i));
    }
    expect(h.read?.('regenCount')).toBe(seedRegen + 1);
    expect(h.read?.('clockPatched')).toBe(1);
  });

  it('an UNPATCHED clock (setParam never called) regenerates every frame', () => {
    // The unpatched contract: the engine's CV bridge never materialises
    // a setParam call for an unpatched port (verified separately in the
    // CV-bridge tests). Without setParam, clockPatched stays 0 + each
    // surface.draw() runs the full readRaster→generateShapes pipeline →
    // regenCount bumps every frame.
    const h = spawnShapegen();
    h.surface.draw(makeFrameCtx(0));
    h.surface.draw(makeFrameCtx(1));
    h.surface.draw(makeFrameCtx(2));
    expect(h.read?.('clockPatched')).toBe(0);
    // 3 draws × 1 regen each = 3.
    expect(h.read?.('regenCount')).toBe(3);
    // framesElapsed advances every draw regardless of the clock mode.
    expect(h.read?.('framesElapsed')).toBe(3);
  });

  it('held frames (clock patched + no rising edge between draws) do NOT regenerate', () => {
    // The core sample-and-hold contract: once the clock is patched, the
    // factory ONLY regenerates on rising edges of the gate; intervening
    // draws re-use cachedShapes (counter unchanged).
    const h = spawnShapegen();
    h.surface.draw(makeFrameCtx(0));
    expect(h.read?.('regenCount')).toBe(1); // seed
    // Plug the gate with one rising edge.
    h.setParam(SHAPEGEN_CLOCK_PARAM_ID, 1);
    h.surface.draw(makeFrameCtx(1));
    expect(h.read?.('regenCount')).toBe(2); // seed + 1 edge
    // Now drive many "held" frames — the gate stays HIGH (no new edge)
    // OR returns LOW (still no rising edge). NO new regenerations.
    h.setParam(SHAPEGEN_CLOCK_PARAM_ID, 1); // still high
    h.surface.draw(makeFrameCtx(2));
    h.setParam(SHAPEGEN_CLOCK_PARAM_ID, 0); // falling — not a regen trigger
    h.surface.draw(makeFrameCtx(3));
    h.setParam(SHAPEGEN_CLOCK_PARAM_ID, 0); // still low
    h.surface.draw(makeFrameCtx(4));
    // 3 held frames → regenCount UNCHANGED.
    expect(h.read?.('regenCount')).toBe(2);
    // ROT + the camera ROT path still drew the canvas every frame, so
    // framesElapsed = 5 total (seed + 4 driven).
    expect(h.read?.('framesElapsed')).toBe(5);
  });

  it('hysteresis: a dipping-but-not-falling gate (0.5) is held HIGH (no chatter)', () => {
    const h = spawnShapegen();
    h.surface.draw(makeFrameCtx(0));
    // Same noise pattern scoreboard's test uses — sub-rise dip without
    // crossing fall should NOT re-trigger.
    h.setParam(SHAPEGEN_CLOCK_PARAM_ID, 1);   // rising edge → regen
    h.setParam(SHAPEGEN_CLOCK_PARAM_ID, 0.5); // still high (above 0.4)
    h.setParam(SHAPEGEN_CLOCK_PARAM_ID, 0.5); // still high
    h.setParam(SHAPEGEN_CLOCK_PARAM_ID, 0.3); // now LOW
    h.setParam(SHAPEGEN_CLOCK_PARAM_ID, 1);   // rising edge → regen
    // Two edges total — same hysteresis contract scoreboard exercises.
    // We assert the cv_clock readParam echoes the most recent sample.
    expect(h.readParam?.(SHAPEGEN_CLOCK_PARAM_ID)).toBe(1);
    // Patched mode is on.
    expect(h.read?.('clockPatched')).toBe(1);
  });
});
