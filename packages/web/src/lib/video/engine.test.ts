// packages/web/src/lib/video/engine.test.ts
//
// Phase 0 video-domain spike — unit-level checks that don't require a
// WebGL2 context. Vitest runs under node here (see vitest.config.ts);
// WebGL/OffscreenCanvas live in the browser, so the actual engine.step()
// + shader render is exercised by the e2e suite.
//
// Coverage in this file:
//   - canConnect type checks (cable upcast/downcast rules)
//   - module-registry separation: audio defs do NOT appear in video
//     registry and vice versa.
//   - module def shape sanity for both video modules (LINES + OUTPUT).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { canConnect, isVideoCableType } from '$lib/graph/types';
import {
  listVideoModuleDefs,
  getVideoModuleDef,
  registerVideoModule,
} from '$lib/video/module-registry';
import { VideoEngine, type VideoNodeHandle } from '$lib/video/engine';
import type { ModuleNode } from '$lib/graph/types';
// Side-effect import auto-registers the Phase-0 video defs.
import '$lib/video/modules';
// NOTE: We DON'T import '$lib/audio/modules' here — the audio module
// factories import Faust WASM/worklet assets via Vite-only `?url`
// loaders that vitest's node runner can't resolve (see vitest.config.ts
// header comment). The negative checks below use the audio registry
// directly without registering any audio defs; that gives us the same
// "video registry doesn't leak into the audio registry" assertion via
// the registry's own list() output.
import { listModuleDefs, registerModule, type AudioModuleDef } from '$lib/audio/module-registry';

describe('video — cable type rules (canConnect)', () => {
  it('equal types always pass', () => {
    expect(canConnect('video', 'video')).toBe(true);
    expect(canConnect('mono-video', 'mono-video')).toBe(true);
    expect(canConnect('keys', 'keys')).toBe(true);
    expect(canConnect('image', 'image')).toBe(true);
    expect(canConnect('audio', 'audio')).toBe(true);
    expect(canConnect('cv', 'cv')).toBe(true);
  });

  it('keys upcasts to mono-video and image', () => {
    expect(canConnect('keys', 'mono-video')).toBe(true);
    expect(canConnect('keys', 'image')).toBe(true);
  });

  it('image upcasts to video; mono-video upcasts to video', () => {
    expect(canConnect('image', 'video')).toBe(true);
    expect(canConnect('mono-video', 'video')).toBe(true);
  });

  it('downcasts (lossy) are rejected at the type level', () => {
    expect(canConnect('video', 'mono-video')).toBe(false);
    expect(canConnect('video', 'image')).toBe(false);
    expect(canConnect('mono-video', 'keys')).toBe(false);
    expect(canConnect('image', 'keys')).toBe(false);
  });

  it('audio-stream cables cannot terminate on video ports (and vice versa)', () => {
    expect(canConnect('audio', 'video')).toBe(false);
    expect(canConnect('pitch', 'video')).toBe(false);
    expect(canConnect('gate', 'mono-video')).toBe(false);
    expect(canConnect('video', 'audio')).toBe(false);
    expect(canConnect('mono-video', 'cv')).toBe(false);
  });

  it('cv → video param input is permitted (Phase 1 bridge will plumb it)', () => {
    expect(canConnect('cv', 'video')).toBe(true);
    expect(canConnect('cv', 'mono-video')).toBe(true);
    expect(canConnect('cv', 'keys')).toBe(true);
    expect(canConnect('cv', 'image')).toBe(true);
  });

  it('isVideoCableType identifies the four video-domain types', () => {
    expect(isVideoCableType('video')).toBe(true);
    expect(isVideoCableType('mono-video')).toBe(true);
    expect(isVideoCableType('image')).toBe(true);
    expect(isVideoCableType('keys')).toBe(true);
    expect(isVideoCableType('audio')).toBe(false);
    expect(isVideoCableType('cv')).toBe(false);
  });
});

describe('video — module registry separation', () => {
  it('lines + videoOut are registered in the video registry only', () => {
    const videoDefs = listVideoModuleDefs();
    const types = videoDefs.map((d) => d.type);
    expect(types).toContain('lines');
    expect(types).toContain('videoOut');
    // No accidental audio-domain leakage.
    for (const def of videoDefs) {
      expect(def.domain).toBe('video');
    }
  });

  it('audio module names do NOT appear in the video registry', () => {
    const videoTypes = new Set(listVideoModuleDefs().map((d) => d.type));
    expect(videoTypes.has('analogVco')).toBe(false);
    expect(videoTypes.has('audioOut')).toBe(false);
    expect(videoTypes.has('lfo')).toBe(false);
  });

  it('video modules do NOT appear in the audio registry', () => {
    // The audio module barrel is intentionally NOT imported here (Vite-
    // only WASM/worklet asset URLs would crash vitest's node runner).
    // Register a stub audio def directly so listModuleDefs() has at
    // least one entry, then assert no video types leaked in.
    const stubAudio: AudioModuleDef = {
      type: 'audio-test-stub-' + Math.random().toString(36).slice(2),
      domain: 'audio',
      label: 'stub',
      category: 'utilities',
      inputs: [{ id: 'in', type: 'audio' }],
      outputs: [{ id: 'out', type: 'audio' }],
      params: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      factory: (() => undefined) as any,
    };
    registerModule(stubAudio);
    const audioTypes = new Set(listModuleDefs().map((d) => d.type));
    expect(audioTypes.has('lines')).toBe(false);
    expect(audioTypes.has('videoOut')).toBe(false);
    // Cross-direction: the stub we just added is NOT in the video
    // registry. (Important: the registries are separate Maps; a write
    // to one mustn't show up in the other.)
    expect(listVideoModuleDefs().some((d) => d.type === stubAudio.type)).toBe(false);
  });

  it('cross-registration of a video def into the audio registry would be additive — they are separate Maps', () => {
    // Sanity: registerVideoModule + registerModule write to different
    // Maps. We exercise both paths and assert no spillover.
    const before = listVideoModuleDefs().length;
    registerVideoModule({
      type: 'video-test-stub-' + Math.random().toString(36).slice(2),
      domain: 'video',
      label: 'stub',
      category: 'utilities',
      inputs: [{ id: 'in', type: 'video' }],
      outputs: [{ id: 'out', type: 'video' }],
      params: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      factory: (() => ({} as any)) as any,
    });
    expect(listVideoModuleDefs().length).toBe(before + 1);
  });
});

describe('video — e2e render-suppression freeze (step() short-circuit)', () => {
  // The per-module-per-port e2e sweeps set globalThis.__videoEngineFreezeRender
  // to skip the (expensive, SwiftShader-bound) per-frame GL draw while keeping
  // the graph consistent. This proves the seam: a frozen step() advances the
  // frame counter but does NOT invoke any module's draw(); unfreezing resumes
  // draws. No WebGL is needed — we feed a fake canvas + spy handle.

  afterEach(() => {
    delete (globalThis as unknown as { __videoEngineFreezeRender?: boolean })
      .__videoEngineFreezeRender;
  });

  // Minimal canvas whose getContext('webgl2') returns a stub the constructor
  // accepts. step()'s freeze branch never touches gl, and the non-frozen path
  // here only reaches our spy handle's draw() (we don't exercise real GL).
  function makeEngineWithSpyNode(): { engine: VideoEngine; draw: ReturnType<typeof vi.fn> } {
    const glStub = {} as unknown as WebGL2RenderingContext;
    const canvas = {
      width: 1,
      height: 1,
      getContext: () => glStub,
    } as unknown as HTMLCanvasElement;

    const engine = new VideoEngine({ canvas });

    const draw = vi.fn();
    const handle: VideoNodeHandle = {
      domain: 'video',
      surface: { fbo: null, texture: null, draw, dispose: () => {} },
      setParam: () => {},
      readParam: () => undefined,
      dispose: () => {},
    };

    // A UNIQUE stub type so we don't clobber a real def in the shared registry.
    const stubType = ('freeze-spy-' + Math.random().toString(36).slice(2)) as
      ModuleNode['type'];
    const node = {
      id: 'spy',
      type: stubType,
      domain: 'video',
      position: { x: 0, y: 0 },
      params: {},
    } as ModuleNode;

    // Register the spy handle directly via a temporary def so addNode wires it
    // into the engine's node map + topo (the path the real factory takes).
    registerVideoModule({
      type: stubType,
      domain: 'video',
      label: 'spy',
      category: 'utilities',
      inputs: [],
      outputs: [{ id: 'out', type: 'video' }],
      params: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      factory: (() => handle) as any,
    });
    void engine.addNode(node);

    return { engine, draw };
  }

  it('does NOT call any module draw() while frozen, but DOES when unfrozen', () => {
    const { engine, draw } = makeEngineWithSpyNode();

    // Frozen: step() must short-circuit before the per-module draw loop.
    (globalThis as unknown as { __videoEngineFreezeRender?: boolean })
      .__videoEngineFreezeRender = true;
    engine.step();
    engine.step();
    expect(draw, 'frozen step() must not invoke module draw()').not.toHaveBeenCalled();

    // Unfrozen: normal per-frame draw resumes (proves freeze is opt-in only).
    delete (globalThis as unknown as { __videoEngineFreezeRender?: boolean })
      .__videoEngineFreezeRender;
    engine.step();
    expect(draw, 'unfrozen step() must invoke module draw()').toHaveBeenCalledTimes(1);

    engine.dispose();
  });

  it('an absent / non-true flag never freezes (default = render)', () => {
    const { engine, draw } = makeEngineWithSpyNode();

    // Wrong-type / falsy values are ignored — only strict `true` freezes.
    (globalThis as unknown as { __videoEngineFreezeRender?: unknown })
      .__videoEngineFreezeRender = 1 as unknown as boolean;
    engine.step();
    expect(draw, 'truthy-but-not-true must NOT freeze').toHaveBeenCalledTimes(1);

    engine.dispose();
  });
});

describe('video — Fix E render-worker install decision (engine seam)', () => {
  // The engine installs a WorkerProxyHandle for a worker-eligible module ONLY
  // when workerLocusEligible(def.renderLocus, workerFlagState()) AND the
  // runtime supports a worker (OffscreenCanvas+Worker+createImageBitmap).
  // Since PR V2 the flag DEFAULTS ON for parity-complete `renderLocus:
  // 'worker'` modules ('worker-experimental' still needs the explicit flag).
  // vitest runs under node with none of the worker primitives, so the worker
  // path is unreachable here — which is exactly the FALLBACK we assert: in
  // every flag state, the engine renders the node on the main thread via the
  // real factory (no WorkerProxyHandle, no blank node). The real worker
  // round-trip is covered by the e2e.

  afterEach(() => {
    delete (globalThis as unknown as { __videoWorkerEnabled?: boolean }).__videoWorkerEnabled;
  });

  function makeEngineWithWorkerLocusNode(): { engine: VideoEngine; mainDraw: ReturnType<typeof vi.fn>; nodeId: string } {
    const glStub = {} as unknown as WebGL2RenderingContext;
    const canvas = { width: 1, height: 1, getContext: () => glStub } as unknown as HTMLCanvasElement;
    const engine = new VideoEngine({ canvas });

    const mainDraw = vi.fn();
    const handle: VideoNodeHandle = {
      domain: 'video',
      surface: { fbo: null, texture: null, draw: mainDraw, dispose: () => {} },
      setParam: () => {},
      readParam: () => undefined,
      dispose: () => {},
    };
    const stubType = ('worker-locus-' + Math.random().toString(36).slice(2)) as ModuleNode['type'];
    registerVideoModule({
      type: stubType,
      domain: 'video',
      label: 'worker-locus-spy',
      category: 'sources',
      inputs: [],
      outputs: [{ id: 'out', type: 'video' }],
      params: [],
      renderLocus: 'worker',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      factory: (() => handle) as any,
    });
    const nodeId = 'wl';
    void engine.addNode({ id: nodeId, type: stubType, domain: 'video', position: { x: 0, y: 0 }, params: {} } as ModuleNode);
    return { engine, mainDraw, nodeId };
  }

  it('DEFAULT flag state (worker ON since PR V2) in a worker-incapable runtime: main factory handle', () => {
    const { engine, mainDraw, nodeId } = makeEngineWithWorkerLocusNode();
    // Default state now attempts the worker for renderLocus:'worker' — but
    // node has no Worker/OffscreenCanvas, so the bridge reports unsupported
    // and the engine installs the real factory handle (the clean fallback).
    engine.step();
    expect(mainDraw, 'main-thread factory draw runs (worker-incapable runtime)').toHaveBeenCalledTimes(1);
    expect(engine.getNodeHandle(nodeId)?.constructor.name).not.toBe('WorkerProxyHandle');
    engine.dispose();
  });

  it('kill switch (__videoWorkerEnabled=false): main factory handle, no worker attempt', () => {
    (globalThis as unknown as { __videoWorkerEnabled?: boolean }).__videoWorkerEnabled = false;
    const { engine, mainDraw, nodeId } = makeEngineWithWorkerLocusNode();
    engine.step();
    expect(mainDraw, 'main-thread factory draw runs with the kill switch').toHaveBeenCalledTimes(1);
    expect(engine.getNodeHandle(nodeId)?.constructor.name).not.toBe('WorkerProxyHandle');
    engine.dispose();
  });

  it('flag ON but worker-unsupported runtime: falls back to the main factory handle', () => {
    (globalThis as unknown as { __videoWorkerEnabled?: boolean }).__videoWorkerEnabled = true;
    const { engine, mainDraw, nodeId } = makeEngineWithWorkerLocusNode();
    // node has no OffscreenCanvas/Worker → maybeWorkerBridge returns null → main.
    engine.step();
    expect(mainDraw, 'fallback to main-thread factory when worker unsupported').toHaveBeenCalledTimes(1);
    expect(engine.getNodeHandle(nodeId)?.constructor.name).not.toBe('WorkerProxyHandle');
    engine.dispose();
  });

  it("'worker-experimental' locus stays on the main thread in the DEFAULT flag state", () => {
    // The experimental tier (TOYBOX / VFPGA-RUNNER) must never engage from
    // the default state — only the explicit flag opts it in. In node the
    // observable is identical (main handle), but this pins the engine seam
    // against a future 'default'-tier widening; the pure decision matrix is
    // worker-bridge.test.ts's workerLocusEligible suite.
    const glStub = {} as unknown as WebGL2RenderingContext;
    const canvas = { width: 1, height: 1, getContext: () => glStub } as unknown as HTMLCanvasElement;
    const engine = new VideoEngine({ canvas });
    const mainDraw = vi.fn();
    const handle: VideoNodeHandle = {
      domain: 'video',
      surface: { fbo: null, texture: null, draw: mainDraw, dispose: () => {} },
      setParam: () => {},
      readParam: () => undefined,
      dispose: () => {},
    };
    const stubType = ('worker-exp-' + Math.random().toString(36).slice(2)) as ModuleNode['type'];
    registerVideoModule({
      type: stubType,
      domain: 'video',
      label: 'worker-exp-spy',
      category: 'sources',
      inputs: [],
      outputs: [{ id: 'out', type: 'video' }],
      params: [],
      renderLocus: 'worker-experimental',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      factory: (() => handle) as any,
    });
    void engine.addNode({ id: 'we', type: stubType, domain: 'video', position: { x: 0, y: 0 }, params: {} } as ModuleNode);
    engine.step();
    expect(mainDraw, 'experimental locus renders on main by default').toHaveBeenCalledTimes(1);
    expect(engine.getNodeHandle('we')?.constructor.name).not.toBe('WorkerProxyHandle');
    engine.dispose();
  });
});

describe('video — VideoEngine constructor surfaces the right error in headless node', () => {
  it('refuses to start without a canvas/OffscreenCanvas surface', async () => {
    // We DON'T instantiate VideoEngine here in the happy path because
    // vitest runs under `node` (vitest.config.ts says so) and node
    // 20 has no OffscreenCanvas/WebGL2. The constructor's fallback
    // path tries `document.createElement('canvas')` which also doesn't
    // exist in node, so the import is the smoke check. The e2e suite
    // (real browser) covers the actual GL init path.
    const mod = await import('./engine');
    expect(typeof mod.VideoEngine).toBe('function');
    expect(mod.VIDEO_RES.width).toBeGreaterThan(0);
    expect(mod.VIDEO_RES.height).toBeGreaterThan(0);
  });
});

describe('video — VideoEngine API surface for multi-OUTPUT routing', () => {
  it('exposes blitOutputToDrawingBuffer on the prototype', async () => {
    // Per-OUTPUT visible-canvas blit lives on VideoEngine so each
    // OUTPUT card can render its own FBO into the engine's drawing
    // buffer right before reading via drawImage. The shape check here
    // keeps the prototype contract from drifting silently — actual GL
    // behavior is covered by the e2e multi-output suite.
    const { VideoEngine } = await import('./engine');
    const proto = VideoEngine.prototype as unknown as Record<string, unknown>;
    expect(typeof proto.blitOutputToDrawingBuffer).toBe('function');
    // One arg: the OUTPUT node id.
    const fn = proto.blitOutputToDrawingBuffer as (...args: unknown[]) => unknown;
    expect(fn.length).toBe(1);
  });
});

describe('video — module def shape sanity', () => {
  it('LINES def: ports + params shape', () => {
    const def = getVideoModuleDef('lines');
    expect(def).toBeDefined();
    if (!def) return;
    expect(def.label).toBe('lines');
    expect(def.category).toBe('sources');
    // FM input is mono-video (per spec §3.7); this assertion will
    // catch port-type drift between def and shader expectations.
    const fm = def.inputs.find((p) => p.id === 'fm');
    expect(fm?.type).toBe('mono-video');
    const out = def.outputs.find((p) => p.id === 'out');
    expect(out?.type).toBe('mono-video');
    const orient = def.params.find((p) => p.id === 'orient');
    expect(orient?.min).toBe(0);
    expect(orient?.max).toBe(1);
  });

  it('OUTPUT def: single video input + chainable video output, no CV params', () => {
    const def = getVideoModuleDef('videoOut');
    expect(def).toBeDefined();
    if (!def) return;
    expect(def.label).toBe('output');
    expect(def.category).toBe('output');
    expect(def.inputs).toHaveLength(1);
    expect(def.inputs[0]?.id).toBe('in');
    expect(def.inputs[0]?.type).toBe('video');
    expect(def.outputs).toHaveLength(1);
    expect(def.outputs[0]?.id).toBe('out');
    expect(def.outputs[0]?.type).toBe('video');
    expect(def.params).toHaveLength(0);
  });
});
