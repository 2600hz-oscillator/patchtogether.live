// packages/web/src/lib/video/modules/peakstate.test.ts
//
// PEAKSTATE's PER-PORT RENDER GATE — the factory-level suite. (The pure pen /
// mandala math lives in peakstate-draw.test.ts; this file owns the draw()
// scheduling decision.)
//
// WHY THIS EXISTS. PEAKSTATE used to rasterize all THREE of its outputs every
// frame — ~57,600 stroked segments plus three 360×360 texSubImage2D uploads —
// and a real patch consumes ONE of them. `mono_out` / `out_3d` are now gated on
// the engine's per-port consumed seam (VideoFrameContext.connectedOutputPorts).
//
// The two things that could go wrong, and the two things this file proves:
//
//   1. "The optimisation did nothing." A perf change is exactly the kind that
//      reads as done while changing no work at all, so the gate is asserted
//      with a NEGATIVE CONTROL: the same instrument (per-canvas stroke() counts
//      + drawFullscreenQuad calls) is read under three connectivity states and
//      must MOVE between them. A counter that reported "0 strokes" because the
//      fake canvas never recorded anything would fail the all-connected row.
//
//   2. "The image jumps." All three outputs share ONE pen ring, so the STATE
//      ADVANCE must stay unconditional and only the rasterize may be skipped.
//      The coherence test runs two instances through an identical time
//      sequence — one always fully patched, one with mono/3d gated off until
//      the very last frame — and requires the gated instance's first resumed
//      frame to emit the IDENTICAL geometry (every moveTo/lineTo coordinate,
//      and for out_3d the rotation-dependent arm angles too). If a future edit
//      moved advancePen or `rotation3d` inside the gate, the resumed trail
//      would lag by N frames and this diverges immediately.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { peakstateDef } from './peakstate';
import type { VideoEngineContext, VideoFrameContext, VideoNodeHandle } from '$lib/video/engine';

// ---------------------------------------------------------------------------
// Recording 2D context + a fake OffscreenCanvas so the real factory runs.
// ---------------------------------------------------------------------------

interface Rec {
  /** stroke() calls — the direct measure of rasterization work. */
  strokes: number;
  /** Every moveTo/lineTo coordinate, in order: the drawn GEOMETRY. */
  path: number[];
  /** fillRect calls tagged with the style+alpha in force (the decay overlay is
   *  `rgba(0,0,0,α)`; the gate's resume prime is opaque `rgb(0, 0, 0)`). */
  fills: Array<{ style: string; alpha: number }>;
  reset(): void;
}

function makeRecordingCtx2d(): { ctx: unknown; rec: Rec } {
  const rec: Rec = {
    strokes: 0,
    path: [],
    fills: [],
    reset() { this.strokes = 0; this.path.length = 0; this.fills.length = 0; },
  };
  const ctx = {
    fillStyle: '' as string,
    strokeStyle: '' as string,
    lineWidth: 0,
    lineCap: 'butt' as CanvasLineCap,
    lineJoin: 'miter' as CanvasLineJoin,
    globalAlpha: 1,
    fillRect() { rec.fills.push({ style: ctx.fillStyle, alpha: ctx.globalAlpha }); },
    beginPath() {},
    moveTo(x: number, y: number) { rec.path.push(x, y); },
    lineTo(x: number, y: number) { rec.path.push(x, y); },
    stroke() { rec.strokes++; },
    save() {},
    restore() {},
    translate() {},
    rotate(a: number) { rec.path.push(a); },
    scale() {},
  };
  return { ctx, rec };
}

/** Canvases the factory allocated this spawn, in creation order:
 *  [0] = cvMono, [1] = cvRgb, [2] = cv3d (see peakstate.ts makeCanvas order). */
let created: Rec[] = [];
let savedOffscreen: unknown;

function installFakeOffscreenCanvas(): void {
  savedOffscreen = (globalThis as unknown as { OffscreenCanvas?: unknown }).OffscreenCanvas;
  class FakeOffscreenCanvas {
    width: number; height: number;
    ctx2d: unknown;
    constructor(w: number, h: number) {
      this.width = w; this.height = h;
      const { ctx, rec } = makeRecordingCtx2d();
      this.ctx2d = ctx;
      created.push(rec);
    }
    getContext() { return this.ctx2d; }
  }
  (globalThis as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas = FakeOffscreenCanvas;
}

function makeFakeGl(): WebGL2RenderingContext {
  return {
    getUniformLocation: () => ({}),
    createTexture: () => ({}),
    bindTexture: () => undefined,
    texParameteri: () => undefined,
    texImage2D: () => undefined,
    texSubImage2D: () => undefined,
    pixelStorei: () => undefined,
    deleteTexture: () => undefined,
    deleteFramebuffer: () => undefined,
    deleteProgram: () => undefined,
    activeTexture: () => undefined,
    bindFramebuffer: () => undefined,
    viewport: () => undefined,
    useProgram: () => undefined,
    uniform1i: () => undefined,
    TEXTURE_2D: 0, RGBA: 0, RGBA8: 0, UNSIGNED_BYTE: 0,
    TEXTURE_MIN_FILTER: 0, TEXTURE_MAG_FILTER: 0,
    TEXTURE_WRAP_S: 0, TEXTURE_WRAP_T: 0,
    LINEAR: 0, CLAMP_TO_EDGE: 0, UNPACK_FLIP_Y_WEBGL: 0,
    TEXTURE0: 0, FRAMEBUFFER: 0,
  } as unknown as WebGL2RenderingContext;
}

interface Spawned {
  handle: VideoNodeHandle;
  mono: Rec; rgb: Rec; tube: Rec;
  /** ctx.drawFullscreenQuad() calls — one per output that uploaded+blitted. */
  blits: () => number;
  resetBlits: () => void;
}

function spawn(): Spawned {
  created = [];
  let blits = 0;
  const ctx: VideoEngineContext = {
    gl: makeFakeGl(),
    res: { width: 640, height: 480 },
    compileFragment: () => ({}) as WebGLProgram,
    createFbo: () => ({ fbo: {} as WebGLFramebuffer, texture: {} as WebGLTexture }),
    drawFullscreenQuad: () => { blits++; },
  } as unknown as VideoEngineContext;
  const node = {
    id: 'ps-1', type: 'peakstate', domain: 'video', params: {}, position: { x: 0, y: 0 },
  } as never;
  const handle = peakstateDef.factory(ctx, node);
  const [mono, rgb, tube] = created;
  return {
    handle,
    mono: mono!, rgb: rgb!, tube: tube!,
    blits: () => blits,
    resetBlits: () => { blits = 0; },
  };
}

/** A frame at engine time `t` seconds. `ports === null` OMITS the optional
 *  connectedOutputPorts hook entirely — the "engine can't report it" path. */
function frameAt(t: number, ports: string[] | null): VideoFrameContext {
  const base = {
    gl: makeFakeGl(), time: t, frame: Math.round(t * 60), timeDelta: 1 / 60, frameRate: 60,
    getInputTexture: () => null,
    isOutputConnected: () => true,
  };
  if (ports === null) return base as unknown as VideoFrameContext;
  return { ...base, connectedOutputPorts: () => new Set(ports) } as unknown as VideoFrameContext;
}

/** Drive `frames` frames at a fixed 1/60 s cadence starting at t = 1/60. */
function run(s: Spawned, frames: number, ports: string[] | null, fromFrame = 1): void {
  for (let i = 0; i < frames; i++) s.handle.surface.draw(frameAt((fromFrame + i) / 60, ports));
}

function resetAll(s: Spawned): void {
  s.mono.reset(); s.rgb.reset(); s.tube.reset(); s.resetBlits();
}

beforeEach(() => { installFakeOffscreenCanvas(); });
afterEach(() => {
  (globalThis as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas = savedOffscreen;
  delete (globalThis as unknown as { __peakstateVrtSeed?: boolean }).__peakstateVrtSeed;
});

// ---------------------------------------------------------------------------

describe('peakstate — per-port render gate', () => {
  it('renders ONLY the consumed outputs; rgb_out is never gated (negative control across 3 states)', () => {
    const s = spawn();
    // Warm the ring so every output has real geometry to draw when enabled.
    run(s, 30, ['mono_out', 'rgb_out', 'out_3d']);

    // (a) ALL THREE patched → all three rasterize + upload. This is the row
    //     that proves the instrument can read work at all: if the fake canvas
    //     recorded nothing, this fails rather than silently "passing" (b).
    resetAll(s);
    run(s, 1, ['mono_out', 'rgb_out', 'out_3d'], 31);
    const all = { mono: s.mono.strokes, rgb: s.rgb.strokes, tube: s.tube.strokes, blits: s.blits() };
    expect(all.mono, 'mono_out patched → it rasterizes').toBeGreaterThan(0);
    expect(all.rgb, 'rgb_out patched → it rasterizes').toBeGreaterThan(0);
    expect(all.tube, 'out_3d patched → it rasterizes').toBeGreaterThan(0);
    expect(all.blits, 'three rendered outputs → three upload+blit passes').toBe(3);
    // out_3d draws the mandala TWICE (upright + bowl twin) — it is the single
    // most expensive output, which is why gating it matters most.
    expect(all.tube, 'out_3d is a 2-pass rasterization').toBe(all.mono * 2);

    // (b) The owner's patch shape: ONLY rgb_out consumed → the other two do
    //     ZERO work. Same instrument, same instance, one frame later.
    resetAll(s);
    run(s, 1, ['rgb_out'], 32);
    expect(s.mono.strokes, 'mono_out unpatched → ZERO rasterization').toBe(0);
    expect(s.tube.strokes, 'out_3d unpatched → ZERO rasterization').toBe(0);
    expect(s.mono.fills, 'mono_out unpatched → not even the decay overlay').toEqual([]);
    expect(s.tube.fills, 'out_3d unpatched → not even the decay overlay').toEqual([]);
    expect(s.rgb.strokes, 'rgb_out still rasterizes (primary surface + card preview)').toBeGreaterThan(0);
    expect(s.blits(), 'one rendered output → one upload+blit pass').toBe(1);

    // The saving, stated in the unit the module actually pays: stroked segments.
    expect(all.mono + all.rgb + all.tube, 'gating mono+3d removes 3/4 of the stroke work')
      .toBe(s.rgb.strokes * 4);

    // (c) NOTHING patched (a freshly dropped module) → still only rgb, because
    //     the card preview reads rgb's canvas and that poll is invisible here.
    resetAll(s);
    run(s, 1, [], 33);
    expect(s.rgb.strokes, 'unpatched module still feeds its on-card preview').toBeGreaterThan(0);
    expect(s.mono.strokes + s.tube.strokes, 'unpatched module rasterizes nothing else').toBe(0);

    s.handle.dispose();
  });

  it('falls back to rendering ALL outputs when the engine cannot report connectivity', () => {
    const s = spawn();
    run(s, 30, null);
    resetAll(s);
    run(s, 1, null, 31);
    // An engine/mock without the optional hook must never make an output dark.
    expect(s.mono.strokes, 'no connectivity info → mono renders').toBeGreaterThan(0);
    expect(s.rgb.strokes, 'no connectivity info → rgb renders').toBeGreaterThan(0);
    expect(s.tube.strokes, 'no connectivity info → 3d renders').toBeGreaterThan(0);
    expect(s.blits(), 'render-all fallback → three blits').toBe(3);
    s.handle.dispose();
  });

  it('the SHARED pen advances while an output is gated off — a re-patched output does not jump', () => {
    // A: fully patched for the whole run (the pre-gate behaviour).
    const a = spawn();
    run(a, 40, ['mono_out', 'rgb_out', 'out_3d']);
    a.mono.reset(); a.tube.reset();
    run(a, 1, ['mono_out', 'rgb_out', 'out_3d'], 41);

    // B: identical time sequence, but mono/3d gated OFF for the first 40
    // frames and re-patched on frame 41 — the mid-performance re-patch.
    const b = spawn();
    run(b, 40, ['rgb_out']);
    b.mono.reset(); b.tube.reset();
    run(b, 1, ['mono_out', 'rgb_out', 'out_3d'], 41);

    expect(b.mono.strokes, 'the re-patched output rasterizes immediately').toBe(a.mono.strokes);
    expect(b.tube.strokes, 'the re-patched 3D output rasterizes immediately').toBe(a.tube.strokes);
    // The geometry itself must match: same ring contents (advancePen ran while
    // gated) and, for out_3d, the same per-arm angles (rotation3d advanced too).
    expect(b.mono.path, 'mono geometry resumes at the CORRECT phase, not N frames behind')
      .toEqual(a.mono.path);
    expect(b.tube.path, '3D geometry + rotation resume at the CORRECT phase')
      .toEqual(a.tube.path);

    // Guard the guard: the coordinate stream must be a real, non-trivial signal
    // — otherwise `toEqual` would pass on two empty arrays.
    expect(a.mono.path.length, 'the compared geometry is non-trivial').toBeGreaterThan(100);

    a.handle.dispose(); b.handle.dispose();
  });

  it('a resumed output starts from an OPAQUE-BLACK prime, not a stale ghost frame', () => {
    const s = spawn();
    run(s, 20, ['rgb_out']);        // mono gated off, canvas holds nothing new
    resetAll(s);
    run(s, 1, ['mono_out', 'rgb_out'], 21);

    // First fill on the resumed frame is the opaque prime; the second is the
    // usual translucent decay overlay from drawMandalaFrame.
    expect(s.mono.fills[0], 'resume primes to opaque black').toEqual({ style: 'rgb(0, 0, 0)', alpha: 1 });
    expect(s.mono.fills[1]?.style, 'then the normal decay overlay').toMatch(/^rgba\(0, 0, 0, /);

    // rgb was never gated, so it is NEVER primed — only the decay overlay.
    expect(s.rgb.fills[0]?.style, 'ungated output is never primed mid-run').toMatch(/^rgba\(0, 0, 0, /);

    // …and a STEADY-STATE frame (already on) primes nothing.
    resetAll(s);
    run(s, 1, ['mono_out', 'rgb_out'], 22);
    expect(s.mono.fills[0]?.style, 'steady-state frame is not primed').toMatch(/^rgba\(0, 0, 0, /);

    s.handle.dispose();
  });

  it('the VRT determinism seed still primes all three canvases', () => {
    (globalThis as unknown as { __peakstateVrtSeed?: boolean }).__peakstateVrtSeed = true;
    const s = spawn();
    run(s, 1, ['rgb_out']);
    // The one-shot seed prime is unconditional — it clears mono/3d even though
    // they are gated off, so a later VRT/DRS capture of those ports starts from
    // the same deterministic base it always did.
    expect(s.mono.fills[0], 'seed primes mono').toEqual({ style: 'rgb(0, 0, 0)', alpha: 1 });
    expect(s.tube.fills[0], 'seed primes 3d').toEqual({ style: 'rgb(0, 0, 0)', alpha: 1 });
    expect(s.rgb.fills[0], 'seed primes rgb').toEqual({ style: 'rgb(0, 0, 0)', alpha: 1 });
    s.handle.dispose();
  });

  it('per-port output textures are unchanged by the gate (contract intact)', () => {
    const s = spawn();
    for (const key of ['outputTexture:mono_out', 'outputTexture:rgb_out', 'outputTexture:out_3d', 'previewCanvas']) {
      expect(s.handle.read?.(key), key).toBeDefined();
    }
    expect(peakstateDef.outputs.map((o) => o.id)).toEqual(['mono_out', 'rgb_out', 'out_3d']);
    s.handle.dispose();
  });
});
