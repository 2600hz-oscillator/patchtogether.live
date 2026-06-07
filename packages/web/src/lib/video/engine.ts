// packages/web/src/lib/video/engine.ts
//
// Video-domain runtime engine — Phase 0 spike.
//
// Sibling to AudioEngine (packages/web/src/lib/audio/engine.ts). Implements
// the same domain-agnostic DomainEngine contract; PatchEngine dispatches to
// us when a node's `domain` field is `'video'`.
//
// Scope of this round:
//   - WebGL2 + OffscreenCanvas. Each module owns one FBO (fullscreen-quad
//     fragment shader pipeline). Topologically sorted; one rAF loop drives
//     all nodes. Worker hoist is deferred to Phase 5 polish per
//     .myrobots/plans/video-modules-mvp.md §1.
//   - Two demo modules: `lines` (procedural mono-video source) and
//     `videoOut` (visible-canvas sink). Module defs live at
//     packages/web/src/lib/video/modules/*.
//   - Cross-domain CV bridges, FEEDBACK ping-pong, MIXER composites: all
//     deferred to Phase 1+. The interface is shaped so they can land
//     without retrofits.
//
// Design notes:
//   - VIDEO_RES is fixed at instantiate time. We render at 1024×768 (4:3,
//     "768p" — same NTSC/PAL CRT 4:3 aspect, higher backing resolution).
//     The 4:3 ratio matches the LZX analog-video heritage and DOOM's native
//     viewport ratio above the status bar; lower-res native sources (SM64's
//     320×240, DOOM's 640×400) aspect-fit/letterbox into it via ctx.res, so
//     the axis math is res-adaptive; widescreen sources letterbox left/right.
//   - We share ONE WebGL2 context + OffscreenCanvas across all video
//     nodes. Each node has its own FBO + texture. OUTPUT modules
//     subscribe to a downstream visible <canvas> by exposing a
//     `pullFrame(targetCanvas)` hook on their handle; the card UI drives
//     that pull each rAF tick (so card-removal doesn't leak callbacks).

import type { Edge, ModuleNode } from '$lib/graph/types';
import type { DomainEngine } from '$lib/audio/engine';
import { getVideoModuleDef, type VideoModuleDef } from './module-registry';
import { createWaveformRenderer, type WaveformRenderer } from './waveform-video';
import { buildCvBridgeMapping, mapCvBridgeValue, type CvBridgeMapping } from './cv-bridge-map';
import {
  followEnvelope,
  makeEnvelopeFollower,
  type EnvelopeFollower,
} from './toybox-cv-math';

/** Resolution of every per-module FBO. 1024×768 (4:3, "768p") keeps the LZX
 *  analog-video 4:3 aspect while rendering the whole pipeline at a sharper
 *  backing resolution (640×480 previously). The 4:3 ratio is unchanged, so
 *  every aspect-fit/letterbox path (DOOM, SM64, widescreen sources) is
 *  identical. Module thumbnails keep their on-card CSS display size — only the
 *  drawing-buffer resolution goes up (the card <canvas> CSS px is pinned). */
export const VIDEO_RES = { width: 1024, height: 768 } as const;

/** Per-module surface — FBO + texture. Output modules can leave `fbo` null
 *  and consume their input textures directly. */
export interface VideoNodeSurface {
  /** The framebuffer this module renders into. Null for sinks (OUTPUT). */
  fbo: WebGLFramebuffer | null;
  /** The colour-attachment texture. Downstream modules sample from this.
   *  Null for sinks. */
  texture: WebGLTexture | null;
  /** Per-frame draw — invoked by the engine loop in topological order.
   *  Modules read uniforms + bind any input textures (looked up from the
   *  edge graph) and render a fullscreen quad into `fbo`. */
  draw(ctx: VideoFrameContext): void;
  /** Tear-down hook. Should release GL resources (textures, framebuffers,
   *  programs the module owns) and any non-GL resources (e.g. `<video>`
   *  elements for INWARDS, `Image` decode buffers for PICTUREBOX). */
  dispose(): void;
}

export interface VideoFrameContext {
  /** Shared WebGL2 context. */
  gl: WebGL2RenderingContext;
  /** Wall-clock seconds since engine init. Modules use this for time-domain
   *  pattern generation (LINES phase scroll, FEEDBACK ping-pong phase). */
  time: number;
  /** Current frame index (0, 1, 2, ...). Useful for "first-frame" guards. */
  frame: number;
  /** Seconds since the PREVIOUS frame (Shadertoy iTimeDelta). ~1/60 typically;
   *  0 on the first frame. OPTIONAL so hand-built test-mock contexts don't have
   *  to stub it — Shadertoy-uniform modules default an absent value to 1/60. */
  timeDelta?: number;
  /** Estimated frames-per-second (Shadertoy iFrameRate), derived from the EMA
   *  of recent frame deltas. ~60 in steady state. OPTIONAL (defaults to 60 in
   *  consumers) so existing test mocks stay valid. */
  frameRate?: number;
  /**
   * The latest pointer/iMouse vec4 for `thisNodeId`, in ENGINE pixel space
   * (x left→right 0..resW, y BOTTOM→top 0..resH) with Shadertoy .z/.w press
   * semantics. Returns [0,0,0,0] when no pointer has touched the node's preview
   * (Shadertoy's untouched-iMouse convention). Modules that route iMouse into a
   * shader read it once per frame; the card feeds it via `VideoEngine.setMouse`.
   *
   * OPTIONAL so existing module test mocks (which never thread iMouse) stay
   * valid — consumers default an absent helper to the all-zero vec4.
   */
  getMouse?(thisNodeId: string): [number, number, number, number];
  /**
   * Look up the colour-attachment texture for the source side of an edge
   * terminating at this module's `inputId`. Returns null if no edge is
   * connected, or if the source module has no texture (e.g. another sink).
   * Modules treat null as "input is unpatched" — they MUST tolerate that
   * and render a sensible default (typically: skip drawing, or write zeros).
   */
  getInputTexture(thisNodeId: string, inputId: string): WebGLTexture | null;
  /**
   * Optional: does this node's output drive at least one downstream edge
   * (intra-domain video edge OR a cross-domain video→audio/texture bridge)?
   *
   * A perf-gated SOURCE module (e.g. MANDELBULB's screen-off gate) reads
   * this in draw() to decide whether it can skip its (expensive) render
   * when its on-card screen is also off — there is then nobody to see the
   * frame, so the work is pure waste. Modules MUST treat an absent helper
   * (older engine builds / test mocks) as "connected" so they never wrongly
   * go dark.
   */
  isOutputConnected?(thisNodeId: string): boolean;
}

export interface VideoNodeHandle {
  domain: 'video';
  /** The module's runtime surface — engine reads this every frame. */
  surface: VideoNodeSurface;
  /**
   * Optional: per-port AudioNode taps that surface this video module's
   * audio output as an audio-domain source (cross-domain handoff, video → audio).
   *
   * The mirror of AudioDomainNodeHandle.videoSources. A video module
   * that emits PCM audio (DOOM's `audio_l` / `audio_r`, future video
   * modules with a soundtrack, etc.) populates this map with one entry
   * per declared `audio`-typed output port. The PatchEngine reads it via
   * `VideoEngine.getAudioSource(nodeId, portId)` when materializing a
   * video→audio edge; it then connects the source AudioNode into the
   * target audio module's input (via AudioEngine.getInputNode).
   *
   * Lifecycle: the module owns the AudioNode and disposes it. The bridge
   * disconnects on edge removal (its own teardown).
   *
   * Modules with no audio output omit the field entirely (the AudioContext
   * may not even be present if no audio engine is registered).
   */
  audioSources?: Map<string, { node: AudioNode; output: number }>;
  /** Apply a param value (fader change). Routes to a uniform or internal
   *  state that `draw()` reads next frame. */
  setParam(paramId: string, value: number): void;
  /** Optional: hand the module the latest AUDIO time-domain window for a
   *  modulation input (so its UI can draw a raw-waveform overlay). The
   *  cross-domain AUDIO cv-bridge calls this once per frame for `audio`-sourced
   *  modsignal edges only (cv/gate bridges never call it). TOYBOX implements it;
   *  modules without a waveform overlay omit it. */
  setParamWave?(paramId: string, window: Float32Array): void;
  /** Read a param's live value (motorized fader convention). For Phase 0
   *  this just returns the most-recently-set intrinsic value; once the
   *  CV→video bridge lands it will include modulator contributions. */
  readParam(paramId: string): number | undefined;
  /** Optional: arbitrary per-module data read (e.g. last frame ImageData
   *  for tests, current device id for INWARDS). Modules that need to
   *  expose internal state to their UI implement this. */
  read?(key: string): unknown;
  /** Optional: card-owned DOM elements that the module samples per
   *  frame (CAMERA's `<video>`, future PICTUREBOX's `<img>`). The card
   *  invokes this on mount with the element and on unmount with null.
   *  The factory itself stays DOM-free (so it remains testable in
   *  jsdom); the bridge runs through this hook. */
  attachExternalSource?(kind: 'video' | 'image', el: HTMLElement | null): void;
  /** Optional: subscribe to DISCRETE pulse events on a `gate`-typed
   *  audioSources port (e.g. DOOM's `evt_kill` / `evt_door` / `evt_gun_pN`).
   *  The callback fires synchronously when the module pulses the gate (via
   *  the same `pulseGate(CSN)` helper that schedules the CSN offset 0→1→0).
   *  Returns an unsubscribe fn. Modules that publish purely-continuous CV
   *  on the same port set MAY omit this; the bridge then falls back to
   *  analyser sampling.
   *
   *  WHY this exists alongside the analyser tap: a 10ms CSN pulse from a
   *  `gate` source can be missed by 60fps analyser sampling (≥1 frame in
   *  ~16ms has no overlap with the high window in the worst-case phase),
   *  and CI's slower rAF cadence makes the miss reliable. The pulse
   *  subscription is FRAME-INDEPENDENT — every `pulseGate` call fires the
   *  callback exactly once, so no pulse is ever dropped regardless of how
   *  often the video frame loop ticks. See PatchEngine.addSameDomainVideoCvBridge
   *  for the consumer side (it subscribes for `sourceType==='gate'` edges and
   *  dispatches a setParam(target, 1) → setParam(target, 0) pair into the
   *  destination's per-tick edge detector). */
  subscribePulse?(portId: string, cb: () => void): () => void;
  /** Tear down GL + non-GL resources. Idempotent. */
  dispose(): void;
}

/** Factory that materializes a video module instance. The engine passes a
 *  shared `VideoEngineContext` so the factory can compile shaders,
 *  allocate FBOs, etc. */
export type VideoModuleFactory = (
  ctx: VideoEngineContext,
  node: ModuleNode,
) => VideoNodeHandle;

/** Resources every video module factory needs. Wraps the WebGL2 context
 *  and a fullscreen-quad helper so individual modules don't reinvent the
 *  basics. */
export interface VideoEngineContext {
  gl: WebGL2RenderingContext;
  res: { readonly width: number; readonly height: number };
  /** Compile + link a fragment-shader program. The vertex shader is
   *  shared across modules — every video module is a fullscreen quad, so
   *  the vertex shader is fixed. Throws on compile/link failure with the
   *  shader log + source for debug. */
  compileFragment(fragSource: string): WebGLProgram;
  /** Allocate an RGBA8 framebuffer + texture at engine resolution.
   *  Returns both so the caller can both render-into and sample-from. */
  createFbo(): { fbo: WebGLFramebuffer; texture: WebGLTexture };
  /**
   * Allocate a FLOAT (RGBA16F / RGBA32F) framebuffer + texture at the
   * given size (defaults to engine resolution). Used by modules that need
   * signed / out-of-[0,1] precision in an intermediate render target — e.g.
   * B3NTB0X's NTSC composite-voltage pass (sync tip at -0.3, overdrive
   * headroom > 1.0) and future #44 Shadertoy work. KEPT GENERIC — it is NOT
   * NTSC-specific.
   *
   * Requires `EXT_color_buffer_float` to make RGBA16F/RGBA32F RENDERABLE
   * (a COLOR_ATTACHMENT); the extension is fetched + cached once. When the
   * extension is ABSENT (some mobile GPUs / headless CI), this gracefully
   * DEGRADES to RGBA8/UNSIGNED_BYTE at the same size and reports
   * `isFloat: false` so the caller can surface a "reduced precision" badge.
   *
   * Filter defaults to NEAREST. WARNING: LINEAR on a float colour
   * attachment needs `OES_texture_float_linear` and will silently read 0.0
   * without it (see waveform-video.ts:216-224) — default composite-voltage
   * targets to NEAREST and do any low-pass in the shader.
   *
   * OPTIONAL on the interface only so hand-built test-mock contexts (which
   * never instantiate a float-using module) don't have to stub it. The REAL
   * VideoEngine always provides it via context(); a factory that needs it can
   * assert its presence (b3ntb0x does).
   */
  createFloatFbo?(
    width?: number,
    height?: number,
    opts?: { filter?: 'nearest' | 'linear'; precision?: 'half' | 'full' },
  ): { fbo: WebGLFramebuffer; texture: WebGLTexture; isFloat: boolean; width: number; height: number };
  /** Issue the fullscreen quad draw call. Caller has already bound their
   *  framebuffer and program + uniforms. Used by every module's draw(). */
  drawFullscreenQuad(): void;
  /**
   * AudioContext for video modules that emit audio (DOOM's audio output,
   * future video modules with a soundtrack). The PatchEngine threads its
   * AudioEngine's context here on registration so video modules can
   * `createConstantSource()` / `createBufferSource()` / etc. and publish
   * the resulting node via VideoNodeHandle.audioSources for the
   * video→audio bridge to read.
   *
   * Optional because:
   *   - jsdom tests instantiate VideoEngine without an AudioContext;
   *   - legacy callers (Phase-0 reconciler tests) didn't thread it through;
   *   - non-audio-emitting video modules never need it.
   *
   * Modules that need audio output MUST guard:
   *   `if (!ctx.audioCtx) return null;` — and surface an "audio off" badge.
   */
  audioCtx?: AudioContext;

  /**
   * Notify the engine that this node's `audioSources` map has changed
   * identity for one or more ports — i.e. the AudioNode published for an
   * `audio_l` / `audio_r` (etc.) port is now a DIFFERENT node than before.
   *
   * Video sources publish a silent placeholder on their audio ports at
   * construction and SWAP it for the real node later (e.g. VIDEOBOX /
   * VIDEOVARISPEED's wireAudio() replaces a ConstantSource with the
   * MediaElementSource splitter once a file is loaded). A cross-domain
   * video→audio bridge that was connected BEFORE that swap captured the
   * stale placeholder and would otherwise stay wired to it forever (silent
   * downstream). Calling this after a swap lets the PatchEngine re-resolve
   * + re-connect any existing audio bridges from this node so the live node
   * reaches the destination. No-op if no listener is registered (jsdom / the
   * video engine running standalone).
   */
  notifyAudioSourcesChanged?(nodeId: string): void;
}

// ----------------------------------------------------------------------
// VideoEngine
// ----------------------------------------------------------------------

export class VideoEngine implements DomainEngine {
  domain = 'video' as const;
  /** Underlying drawing surface. We use OffscreenCanvas where available
   *  (every browser we ship to has it as of 2026 except old Safari, where
   *  we fall back to a regular HTMLCanvasElement). Either way, the
   *  context is WebGL2; modules never see the surface type. */
  readonly canvas: OffscreenCanvas | HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  readonly res = VIDEO_RES;

  private nodes = new Map<string, VideoNodeHandle>();
  private nodeMeta = new Map<string, ModuleNode>();
  private edges = new Map<string, Edge>();

  /**
   * Cross-domain CV bridges. Each entry samples one audio-side AnalyserNode
   * once per video frame and writes the value into a target video module's
   * param uniform. Edges of type cv→video param flow through this list (set
   * up by `PatchEngine.addEdge` when it detects a cross-domain edge).
   *
   * The map is keyed by edge id so removal is symmetric with addEdge.
   * Each entry owns its own AnalyserNode + a small Float32Array buffer.
   */
  private cvBridges = new Map<string, {
    analyser: AnalyserNode;
    /** Backed by a fresh ArrayBuffer (not SharedArrayBuffer) so TS's
     *  strict typed-array signature for getFloatTimeDomainData is met. */
    buf: Float32Array<ArrayBuffer>;
    targetNodeId: string;
    /** Precomputed gate-vs-param mapping: gate targets pass the raw cv
     *  through (the module edge-detects); continuous targets (with a
     *  `cvScale` hint) sweep their full param range. See cv-bridge-map.ts. */
    mapping: CvBridgeMapping;
    /** The patched source's cable type ('cv' | 'gate' | 'audio'). An 'audio'
     *  source is ENVELOPE-FOLLOWED (RMS over the analyser window) to a 0..1
     *  value each frame; cv/gate take the tail sample. The target module
     *  auto-detects the kind from the edge itself (see modules/toybox.ts). */
    sourceType: string;
    /** Per-bridge envelope-follower state, used ONLY for an `audio` source
     *  (fast attack / slow release one-pole over the window RMS). null for
     *  cv/gate (they take the tail sample). */
    env: EnvelopeFollower | null;
    /** Disconnect the upstream AudioNode tap into our analyser. */
    teardown: () => void;
  }>();

  /**
   * Cross-domain audio → video texture bridges. The PatchEngine
   * registers one entry per edge whose source is an audio module's
   * mono-video output and whose target is a video module's input.
   * Each bridge owns a waveform-video renderer drawing into its own
   * FBO+texture; the engine ticks all bridges (samples + renders)
   * before per-module draw() passes so target modules see fresh
   * input textures via lookupInput.
   *
   * Keyed by edge id (symmetric add/remove). Multiple distinct edges
   * sharing the same source port get independent renderers (cheap)
   * — keeps the bookkeeping uniform.
   */
  private videoTextureBridges = new Map<string, {
    sourceNodeId: string;
    sourcePortId: string;
    analyser: AnalyserNode;
    sampleRate: number;
    buf: Float32Array<ArrayBuffer>;
    renderer: WaveformRenderer | null;
    edge: Edge;
    /** Module-driven 2D draw path (SCOPE). When set, the bridge holds an
     *  OffscreenCanvas + 2D context, asks the source module to draw into
     *  it each frame via this callback, then uploads the canvas pixels
     *  into `customTexture` for the standard input-texture lookup. The
     *  GL `renderer` field is null in this mode. */
    drawFrame?: (canvas: OffscreenCanvas | HTMLCanvasElement) => void;
    customCanvas?: OffscreenCanvas;
    customCtx2d?: OffscreenCanvasRenderingContext2D;
    customTexture?: WebGLTexture;
  }>();

  /**
   * AudioContext threaded through from PatchEngine.registerDomain (when
   * an AudioEngine is also registered). Modules that emit audio (DOOM)
   * pull this out of `ctx.audioCtx` inside their factory so they can
   * create the upstream side of a video→audio bridge.
   *
   * null when no AudioEngine is registered (jsdom unit-test default).
   * Modules with audio outputs MUST guard for null + degrade gracefully
   * (silent operation + a visible badge on the card).
   */
  private audioCtx: AudioContext | null = null;

  /** Listener invoked when a node swaps the AudioNode identity on one of its
   *  audioSources ports (see VideoEngineContext.notifyAudioSourcesChanged).
   *  The PatchEngine registers this to re-resolve cross-domain audio bridges
   *  that captured a now-stale placeholder node. Null when running standalone. */
  private audioSourcesChangedListener: ((nodeId: string) => void) | null = null;

  private startTime = performance.now();
  private frameCount = 0;
  private rafId: number | null = null;

  /** Wall-clock of the previous step() (for iTimeDelta / iFrameRate). */
  private lastStepTime = performance.now();
  /** Seconds since the previous frame, surfaced as iTimeDelta. 0 until measured. */
  private timeDelta = 0;
  /** EMA-smoothed FPS estimate, surfaced as iFrameRate. Seeded at 60. */
  private frameRate = 60;

  /**
   * Per-node iMouse vec4 [x, y, z, w] in ENGINE pixel space (bottom-origin y,
   * Shadertoy .z/.w press semantics — see toybox-shadertoy.ts mouseToVec4). The
   * card computes this from pointer events on the preview canvas and pushes it
   * via setMouse(); a module reads it through VideoFrameContext.getMouse() and
   * sets the iMouse uniform on every Shadertoy pass. Absent → [0,0,0,0].
   */
  private mouseState = new Map<string, [number, number, number, number]>();

  /**
   * Lazily-resolved `EXT_color_buffer_float` support, cached after the first
   * createFloatFbo() call. `null` = not yet probed; `true`/`false` once
   * `gl.getExtension` has been asked exactly once. The extension is what
   * makes RGBA16F/RGBA32F a RENDERABLE colour attachment; sampling a float
   * texture does not need it.
   */
  private floatColorBufferExt: boolean | null = null;

  // Cached topological order — recomputed on graph mutations.
  private topoOrder: string[] = [];
  private topoStale = true;

  // Lazily-created shared resources.
  private fullscreenVao: WebGLVertexArrayObject | null = null;
  private vertexShader: WebGLShader | null = null;

  // Lazily-created copy program for blitting an OUTPUT module's texture
  // into the engine's drawing buffer on demand. See blitOutputToDrawingBuffer.
  private copyProgram: WebGLProgram | null = null;
  private copyUTex: WebGLUniformLocation | null = null;

  constructor(opts: { canvas?: OffscreenCanvas | HTMLCanvasElement } = {}) {
    if (opts.canvas) {
      this.canvas = opts.canvas;
    } else if (typeof OffscreenCanvas !== 'undefined') {
      this.canvas = new OffscreenCanvas(this.res.width, this.res.height);
    } else {
      // jsdom / old Safari path. Module-registry tests still work — they
      // never touch GL state — so we keep the door open by stubbing.
      const c = (typeof document !== 'undefined' ? document.createElement('canvas') : null);
      if (!c) throw new Error('VideoEngine: no canvas surface available in this environment');
      c.width = this.res.width;
      c.height = this.res.height;
      this.canvas = c;
    }

    const gl = this.canvas.getContext('webgl2', {
      // Don't flip the framebuffer alpha — we want black backgrounds in
      // OUTPUT to read as opaque so the canvas doesn't show through to
      // the rack background and create a halo around the live render.
      alpha: false,
      premultipliedAlpha: false,
      antialias: false,
      // Keep the drawing buffer so OUTPUT's blit-to-visible-canvas can
      // captureStream() in the future without surprises.
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error('VideoEngine: WebGL2 not supported on this device');
    this.gl = gl as WebGL2RenderingContext;
  }

  // -------- DomainEngine surface --------

  /** Async signature matches AudioEngine. We don't actually await here —
   *  video factories are synchronous (no shader fetch over the network) —
   *  but the reconciler treats every domain identically. */
  async addNode(node: ModuleNode): Promise<void> {
    if (this.nodes.has(node.id)) return;
    const def = getVideoModuleDef(node.type);
    if (!def) throw new Error(`VideoEngine.addNode: no video def for ${String(node.type)}`);
    if (def.domain !== 'video') {
      throw new Error(
        `VideoEngine.addNode: ${String(node.type)} has domain '${def.domain}', not 'video'`,
      );
    }
    const handle = (def as VideoModuleDef).factory(this.context(), node);
    this.nodes.set(node.id, handle);
    this.nodeMeta.set(node.id, node);
    this.topoStale = true;
    this.ensureLoop();
  }

  removeNode(nodeId: string): void {
    const handle = this.nodes.get(nodeId);
    if (!handle) return;
    handle.dispose();
    this.nodes.delete(nodeId);
    this.nodeMeta.delete(nodeId);
    this.mouseState.delete(nodeId);
    this.topoStale = true;
  }

  addEdge(edge: Edge): void {
    if (this.edges.has(edge.id)) return;
    this.edges.set(edge.id, edge);
    this.topoStale = true;
  }

  removeEdge(edgeId: string): void {
    if (this.edges.delete(edgeId)) this.topoStale = true;
  }

  setParam(nodeId: string, paramId: string, value: number): void {
    this.nodes.get(nodeId)?.setParam(paramId, value);
  }

  /**
   * Push the latest iMouse vec4 for a node (Shadertoy semantics, ENGINE pixel
   * space — bottom-origin y). The card's preview-canvas pointer handlers compute
   * this (client px → engine px via the letterbox inverse + the .z/.w press
   * state machine in toybox-shadertoy.ts) and call this each interaction; the
   * module reads it via VideoFrameContext.getMouse() and sets the iMouse uniform
   * on every Shadertoy pass. No-op-safe for unknown nodes (the state is keyed by
   * id and simply read back later if/when the node exists).
   */
  setMouse(nodeId: string, x: number, y: number, z: number, w: number): void {
    this.mouseState.set(nodeId, [x, y, z, w]);
  }

  readParam(nodeId: string, paramId: string): number | undefined {
    return this.nodes.get(nodeId)?.readParam(paramId);
  }

  read(nodeId: string, key: string): unknown {
    const h = this.nodes.get(nodeId);
    return h?.read ? h.read(key) : undefined;
  }

  /** Resolve which UPSTREAM source node currently feeds `(thisNodeId,
   *  inputId)`, by the same edge-ordering rule lookupInput() uses to pick the
   *  texture. Returns the source node id, or null if nothing is wired.
   *
   *  This is the engine-state hook the multi-OUTPUT e2e asserts on: each
   *  OUTPUT card must be driven by its OWN distinct source. Proving that via
   *  resolved routing is deterministic on software GL, unlike diffing the two
   *  cards' rendered framebuffer pixels (which flakes under CI rAF throttling
   *  and can't distinguish "shared render path" from "two sources that happen
   *  to look similar this frame"). */
  resolveInputSourceId(thisNodeId: string, inputId: string): string | null {
    if (this.videoTextureBridges.size > 0) {
      const hits: Array<{ edgeId: string; srcId: string }> = [];
      for (const [edgeId, b] of this.videoTextureBridges) {
        if (b.edge.target.nodeId === thisNodeId && b.edge.target.portId === inputId) {
          hits.push({ edgeId, srcId: b.edge.source.nodeId });
        }
      }
      if (hits.length > 0) {
        hits.sort((a, b) => a.edgeId.localeCompare(b.edgeId));
        return hits[0]!.srcId;
      }
    }
    const edges: Edge[] = [];
    for (const e of this.edges.values()) {
      if (e.target.nodeId === thisNodeId && e.target.portId === inputId) edges.push(e);
    }
    edges.sort((a, b) => a.id.localeCompare(b.id));
    for (const e of edges) {
      if (this.nodes.get(e.source.nodeId)) return e.source.nodeId;
    }
    return null;
  }

  /**
   * Forward a card-owned external DOM source (a `<video>` for CAMERA, a
   * future `<img>` for PICTUREBOX) to the named node's handle. No-op if
   * the node doesn't exist or doesn't implement the hook. Cards call this
   * on mount with the element and on unmount with `null`. Lives on
   * VideoEngine (not the cross-domain PatchEngine) because it's a
   * video-only concern; calling code reaches it via
   * `engine.getDomain<VideoEngine>('video').attachExternalSource(...)`.
   */
  attachExternalSource(
    nodeId: string,
    kind: 'video' | 'image',
    el: HTMLElement | null,
  ): void {
    const h = this.nodes.get(nodeId);
    h?.attachExternalSource?.(kind, el);
  }

  dispose(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    for (const bridge of this.cvBridges.values()) {
      try { bridge.teardown(); } catch { /* */ }
    }
    this.cvBridges.clear();
    for (const bridge of this.videoTextureBridges.values()) {
      try { bridge.renderer?.dispose(); } catch { /* */ }
      if (bridge.customTexture) {
        try { this.gl.deleteTexture(bridge.customTexture); } catch { /* */ }
      }
    }
    this.videoTextureBridges.clear();
    for (const handle of this.nodes.values()) handle.dispose();
    this.nodes.clear();
    this.nodeMeta.clear();
    this.edges.clear();
    this.topoOrder = [];

    const gl = this.gl;
    if (this.fullscreenVao) gl.deleteVertexArray(this.fullscreenVao);
    if (this.vertexShader) gl.deleteShader(this.vertexShader);
    if (this.copyProgram) {
      gl.deleteProgram(this.copyProgram);
      this.copyProgram = null;
      this.copyUTex = null;
    }
  }

  // -------- Render loop --------

  /** Run one frame's worth of draws. Test code calls this directly so it
   *  doesn't have to wait for rAF. */
  step(): void {
    if (this.topoStale) this.recomputeTopo();

    // E2E render-suppression hook (per-module-per-port sweeps only).
    //
    // When the e2e harness sets `globalThis.__videoEngineFreezeRender = true`
    // (via Playwright's addInitScript, BEFORE the app boots), we keep the
    // graph fully consistent — topo is recomputed above, nodes still mount
    // in addNode (shaders compiled, FBOs allocated → handles render), edges
    // still reconcile in addEdge — but SKIP the expensive per-frame work:
    // the cross-domain bridge ticks and every module's GL draw() pass.
    //
    // Why this is correct AND scoped:
    //   * The handle-presence and inputs-accept sweeps assert only at the
    //     DOM / patch-graph level (a handle is a Svelte-Flow element; an
    //     accepted edge is a graph-store entry). The heavy GL render is
    //     purely incidental to those assertions, so freezing it changes
    //     nothing they observe while eliminating the SwiftShader-bound
    //     per-frame cost that timed out heavy cards (b3ntb0x, mandelbulb).
    //   * NOTHING in production or any pixel-asserting spec (bespoke video
    //     specs, VRT, behavioral) sets this flag, so those keep rendering
    //     real pixels. The flag is opt-in per page, default-undefined.
    //
    // We still advance frame timing + the frame counter below so a later
    // un-freeze resumes with sane iTime/iFrameRate (no jump).
    const frozen =
      (globalThis as unknown as { __videoEngineFreezeRender?: boolean })
        .__videoEngineFreezeRender === true;
    if (frozen) {
      const now = performance.now();
      const dt = Math.min(0.1, Math.max(0, (now - this.lastStepTime) / 1000));
      this.lastStepTime = now;
      this.timeDelta = dt;
      if (dt > 1e-4) this.frameRate = this.frameRate * 0.9 + (1 / dt) * 0.1;
      this.frameCount++;
      return;
    }

    // 1. Sample every active cross-domain CV bridge BEFORE drawing this
    //    frame's modules. Each sample becomes the param value for the
    //    upcoming draw, so a frame's-worth of CV → video param coupling
    //    is one-frame-deterministic. Quantization at 60fps from a 48kHz
    //    audio source is the documented limit (see plan §2 'Cross-domain
    //    CV adapter').
    this.tickCvBridges();
    // 1b. Render every active audio → video texture bridge so the
    //     target video modules see fresh waveform textures during their
    //     draw() pass. Doing this BEFORE the topo loop matches the CV
    //     bridge ordering — both kinds of cross-domain handoff happen
    //     "before" intra-domain rendering each frame.
    this.tickVideoTextureBridges();

    // Per-frame timing for Shadertoy iTimeDelta / iFrameRate. Clamp the delta
    // to a sane window so a tab-backgrounded long-gap frame doesn't blow up a
    // dt-scaled shader (a feedback buffer that divides by iFrameRate).
    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0, (now - this.lastStepTime) / 1000));
    this.lastStepTime = now;
    this.timeDelta = dt;
    if (dt > 1e-4) {
      // EMA over ~half a second so the rate is stable but tracks throttling.
      this.frameRate = this.frameRate * 0.9 + (1 / dt) * 0.1;
    }

    const ctx: VideoFrameContext = {
      gl: this.gl,
      time: (performance.now() - this.startTime) / 1000,
      frame: this.frameCount++,
      timeDelta: this.timeDelta,
      frameRate: this.frameRate,
      getMouse: (thisNodeId) => this.mouseState.get(thisNodeId) ?? [0, 0, 0, 0],
      getInputTexture: (thisNodeId, inputId) => this.lookupInput(thisNodeId, inputId),
      isOutputConnected: (thisNodeId) => this.isOutputConnected(thisNodeId),
    };
    for (const id of this.topoOrder) {
      const handle = this.nodes.get(id);
      if (!handle) continue;
      handle.surface.draw(ctx);
    }
  }

  // -------- Per-OUTPUT visible-canvas blit --------
  //
  // Multi-OUTPUT routing fix (PR following PR-65):
  //
  // Phase-0 OUTPUT module wrote its result to BOTH its own FBO AND the
  // engine's default framebuffer (the OffscreenCanvas drawing buffer)
  // because every OUTPUT card's `drawImage(engine.canvas, ...)` reads from
  // that default FB. With one OUTPUT that worked. With N OUTPUTs they all
  // ran in topo order each frame and the LAST one to draw won — every
  // card showed the same content (whatever the last OUTPUT had as its
  // input), regardless of what was patched into each card.
  //
  // Fix: OUTPUT no longer writes to the default FB during its per-frame
  // draw(). Instead, each OUTPUT card calls this method right before its
  // `drawImage(engine.canvas, ...)` blit to selectively render ITS OWN
  // OUTPUT's FBO texture into the drawing buffer. The cards' rAF ticks
  // run sequentially in the JS event loop, so each card sees its own
  // freshly-blitted content via `engine.canvas`.
  //
  // The browser is required to flush GL writes before drawImage reads
  // from a WebGL canvas (HTML spec: drawImage from a WebGL canvas takes
  // a synchronization snapshot), so multiple cards reading from the same
  // engine canvas in the same frame all see consistent per-OUTPUT data.
  //
  // No-op if `nodeId` doesn't refer to a registered OUTPUT, or if the
  // OUTPUT's input is unpatched (the OUTPUT's own FBO is still
  // initialized in that case — to its idle pattern — so we always have
  // SOMETHING to blit).
  blitOutputToDrawingBuffer(nodeId: string): void {
    const handle = this.nodes.get(nodeId);
    if (!handle) return;
    // Only OUTPUT-shaped modules (those with both an FBO texture AND no
    // declared video output port) make sense to blit. We don't enforce
    // the type check here — any module with a surface.texture can in
    // principle be visualized — but in practice only OUTPUT calls this
    // path. Sources / effects render their own outputs to FBOs anyway.
    const tex = handle.surface.texture;
    if (!tex) return;
    const gl = this.gl;
    if (!this.copyProgram) {
      this.copyProgram = this.compileFragmentImpl(VideoEngine.COPY_FRAG_SRC);
      this.copyUTex = gl.getUniformLocation(this.copyProgram, 'uTex');
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.res.width, this.res.height);
    gl.useProgram(this.copyProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (this.copyUTex) gl.uniform1i(this.copyUTex, 0);
    this.drawFullscreenQuadImpl();
  }

  // Tiny pass-through fragment shader used by blitOutputToDrawingBuffer.
  // Independent from videoOut's COPY_FRAG_SRC so the engine has no
  // module-level dependency on a specific module file.
  private static readonly COPY_FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
void main() {
  outColor = texture(uTex, vUv);
}`;

  // -------- Cross-domain CV bridges --------

  /**
   * Register a cv → video param bridge. Caller (PatchEngine) creates an
   * AnalyserNode tapped to the audio source's output and hands it here
   * along with the target video node + param. Each frame, we read one
   * sample from the analyser and write it into the target module's
   * param via setParam. The teardown closes the upstream tap.
   *
   * Idempotent on edge id: re-adding the same id replaces the previous
   * entry (its teardown is invoked first).
   */
  addCvBridge(
    edgeId: string,
    analyser: AnalyserNode,
    targetNodeId: string,
    targetPortId: string,
    teardown: () => void,
    sourceType = 'cv',
  ): void {
    const existing = this.cvBridges.get(edgeId);
    if (existing) {
      try { existing.teardown(); } catch { /* */ }
    }
    // Resolve the input port id → paramTarget. Caller passes us the PORT
    // id from the edge target (e.g. "speed_cv"); the module def maps that
    // to the actual param (e.g. "speed"). Without this resolution, modules
    // like ACIDWARP / BENTBOX whose port id differs from the param id silently
    // dropped every CV write because setParam("speed_cv") finds no matching
    // key in their params object.
    const meta = this.nodeMeta.get(targetNodeId);
    const def = meta ? getVideoModuleDef(meta.type) : undefined;
    const input = def?.inputs?.find((p) => p.id === targetPortId);
    // Branch gate-vs-param up front (see cv-bridge-map.ts): gate-style cv
    // inputs (DOOM cv_<port>) get the RAW value so their edge detector
    // fires; continuous params with a `cvScale` hint get the incoming ±1
    // mapped across the param's full natural range (otherwise a bipolar
    // source only exercises a sub-range + clamps → "one quadrant").
    const mapping = buildCvBridgeMapping(input, targetPortId, def?.params, meta?.params);
    const bufLen = Math.max(32, analyser.fftSize);
    const buf = new Float32Array(new ArrayBuffer(bufLen * 4));
    this.cvBridges.set(edgeId, {
      analyser,
      buf,
      targetNodeId,
      mapping,
      sourceType,
      // Only an AUDIO source is envelope-followed; cv/gate take the tail sample.
      env: sourceType === 'audio' ? makeEnvelopeFollower() : null,
      teardown,
    });
  }

  removeCvBridge(edgeId: string): void {
    const entry = this.cvBridges.get(edgeId);
    if (!entry) return;
    try { entry.teardown(); } catch { /* */ }
    this.cvBridges.delete(edgeId);
  }

  private tickCvBridges(): void {
    if (this.cvBridges.size === 0) return;
    for (const bridge of this.cvBridges.values()) {
      const handle = this.nodes.get(bridge.targetNodeId);
      if (!handle) continue;
      bridge.analyser.getFloatTimeDomainData(bridge.buf);
      if (bridge.env) {
        // AUDIO source: envelope-follow the whole window (RMS → fast-attack /
        // slow-release one-pole) to a 0..1 modulation value. The target reads
        // this as an already-unipolar signal (it does NOT re-fold audio). Also
        // hand the raw window to the target so its UI can draw a waveform
        // overlay (TOYBOX's inline scope).
        const env = followEnvelope(bridge.env, bridge.buf);
        const v = mapCvBridgeValue(bridge.mapping, env);
        handle.setParam(bridge.mapping.targetParamId, v);
        handle.setParamWave?.(bridge.mapping.targetParamId, bridge.buf);
        continue;
      }
      // cv / gate: tail sample is "newest" in the rolling-window analyser.
      const raw = bridge.buf[bridge.buf.length - 1] ?? 0;
      // Gate target: raw value through (module edge-detects). Continuous
      // target: map ±1 across the param's full range (mirrors audio path).
      const v = mapCvBridgeValue(bridge.mapping, raw);
      handle.setParam(bridge.mapping.targetParamId, v);
    }
  }

  /**
   * Register an audio → video texture bridge. Owns a waveform-video
   * renderer that, each frame, samples the analyser and writes a
   * waveform trace into its own FBO+texture. The target video module's
   * input texture lookup (via lookupInput) returns this texture so the
   * standard per-module draw() logic stays untouched.
   *
   * Idempotent on edge id: a re-add disposes the previous renderer.
   */
  addVideoTextureBridge(
    edgeId: string,
    sourceNodeId: string,
    sourcePortId: string,
    analyser: AnalyserNode,
    sampleRate: number,
    edge: Edge,
    drawFrame?: (canvas: OffscreenCanvas | HTMLCanvasElement) => void,
  ): void {
    const existing = this.videoTextureBridges.get(edgeId);
    if (existing) {
      try { existing.renderer?.dispose(); } catch { /* */ }
      if (existing.customTexture) {
        try { this.gl.deleteTexture(existing.customTexture); } catch { /* */ }
      }
    }
    // 2048 samples covers ~46ms at 44.1kHz — long enough to read a
    // few cycles at audio-rate. Match the analyser's fftSize when
    // larger, so we never request more than the analyser can give.
    const bufLen = Math.max(1024, analyser.fftSize);
    const buf = new Float32Array(new ArrayBuffer(bufLen * 4));

    if (drawFrame) {
      // Module-driven 2D draw path (SCOPE). The module owns the pixel
      // logic; we own the canvas, the texture, and the per-frame
      // canvas → texture upload. Use OffscreenCanvas so this works in
      // tests + workers; fall back to a regular canvas where missing.
      let canvas: OffscreenCanvas;
      if (typeof OffscreenCanvas !== 'undefined') {
        canvas = new OffscreenCanvas(this.res.width, this.res.height);
      } else {
        // No-op in environments without OffscreenCanvas — the bridge
        // still registers so removeVideoTextureBridge is symmetric, but
        // the texture stays at its initial cleared state.
        this.videoTextureBridges.set(edgeId, {
          sourceNodeId,
          sourcePortId,
          analyser,
          sampleRate,
          buf,
          renderer: null,
          edge,
          drawFrame,
        });
        this.topoStale = true;
        this.ensureLoop();
        return;
      }
      const ctx2d = canvas.getContext('2d', { willReadFrequently: false }) as
        | OffscreenCanvasRenderingContext2D
        | null;
      if (!ctx2d) {
        // Same fall-through as no-OffscreenCanvas — register the bridge
        // for symmetric teardown but skip texture work. Should never
        // happen in mainstream browsers.
        this.videoTextureBridges.set(edgeId, {
          sourceNodeId,
          sourcePortId,
          analyser,
          sampleRate,
          buf,
          renderer: null,
          edge,
          drawFrame,
        });
        this.topoStale = true;
        this.ensureLoop();
        return;
      }
      const tex = this.gl.createTexture();
      if (!tex) throw new Error('VideoEngine: createTexture(custom) failed');
      this.gl.bindTexture(this.gl.TEXTURE_2D, tex);
      this.gl.texImage2D(
        this.gl.TEXTURE_2D,
        0,
        this.gl.RGBA8,
        this.res.width,
        this.res.height,
        0,
        this.gl.RGBA,
        this.gl.UNSIGNED_BYTE,
        null,
      );
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
      this.videoTextureBridges.set(edgeId, {
        sourceNodeId,
        sourcePortId,
        analyser,
        sampleRate,
        buf,
        renderer: null,
        edge,
        drawFrame,
        customCanvas: canvas,
        customCtx2d: ctx2d,
        customTexture: tex,
      });
    } else {
      const renderer = createWaveformRenderer(this.gl, this.res.width, this.res.height, {
        sampleCount: bufLen,
      });
      this.videoTextureBridges.set(edgeId, {
        sourceNodeId,
        sourcePortId,
        analyser,
        sampleRate,
        buf,
        renderer,
        edge,
      });
    }
    // Touch topo so an immediately-following step() sees the bridge.
    this.topoStale = true;
    // Boot the rAF loop if it isn't running — bridges are sources too.
    this.ensureLoop();
  }

  removeVideoTextureBridge(edgeId: string): void {
    const entry = this.videoTextureBridges.get(edgeId);
    if (!entry) return;
    try { entry.renderer?.dispose(); } catch { /* */ }
    if (entry.customTexture) {
      try { this.gl.deleteTexture(entry.customTexture); } catch { /* */ }
    }
    this.videoTextureBridges.delete(edgeId);
    this.topoStale = true;
  }

  private tickVideoTextureBridges(): void {
    if (this.videoTextureBridges.size === 0) return;
    for (const bridge of this.videoTextureBridges.values()) {
      if (bridge.drawFrame && bridge.customCanvas && bridge.customTexture) {
        // Module-driven 2D draw path. The module reads its own state
        // (analysers, params); we just hand it the canvas and upload
        // the result. texSubImage2D from a canvas is the WebGL2-blessed
        // path for canvas → texture transfer (no manual ImageData).
        try { bridge.drawFrame(bridge.customCanvas); } catch { /* don't crash the engine on a bad module draw */ }
        this.gl.bindTexture(this.gl.TEXTURE_2D, bridge.customTexture);
        // UNPACK_FLIP_Y_WEBGL flips the canvas's top-down 2D coords to
        // match the bottom-up GL convention so the trace renders the
        // right way up downstream. We restore the default afterwards
        // so other modules' texture uploads aren't affected.
        this.gl.pixelStorei(this.gl.UNPACK_FLIP_Y_WEBGL, true);
        this.gl.texSubImage2D(
          this.gl.TEXTURE_2D,
          0,
          0, 0,
          this.gl.RGBA,
          this.gl.UNSIGNED_BYTE,
          bridge.customCanvas as unknown as TexImageSource,
        );
        this.gl.pixelStorei(this.gl.UNPACK_FLIP_Y_WEBGL, false);
      } else if (bridge.renderer) {
        bridge.analyser.getFloatTimeDomainData(bridge.buf);
        bridge.renderer.update(bridge.buf);
        bridge.renderer.draw(this.res.width, this.res.height);
      }
    }
  }

  private ensureLoop(): void {
    if (this.rafId !== null) return;
    if (typeof requestAnimationFrame !== 'function') return; // SSR / tests
    const tick = () => {
      this.rafId = null;
      this.step();
      // Continue while we have nodes; idle out otherwise so the engine
      // doesn't burn CPU on an empty rack.
      if (this.nodes.size > 0) {
        this.rafId = requestAnimationFrame(tick);
      }
    };
    this.rafId = requestAnimationFrame(tick);
  }

  // -------- Topology --------

  private recomputeTopo(): void {
    const adj = new Map<string, Set<string>>(); // src -> dsts
    const indeg = new Map<string, number>();
    for (const id of this.nodes.keys()) {
      adj.set(id, new Set());
      indeg.set(id, 0);
    }
    for (const e of this.edges.values()) {
      const s = e.source.nodeId;
      const d = e.target.nodeId;
      if (!adj.has(s) || !adj.has(d)) continue; // edge across domains
      const dsts = adj.get(s)!;
      if (!dsts.has(d)) {
        dsts.add(d);
        indeg.set(d, (indeg.get(d) ?? 0) + 1);
      }
    }
    // Kahn's algorithm. Insertion-id order on ties keeps the topo stable
    // across repeated reconcile passes (so motion in the demo is steady).
    const q: string[] = [];
    for (const [id, n] of indeg) if (n === 0) q.push(id);
    q.sort();
    const out: string[] = [];
    while (q.length) {
      const id = q.shift()!;
      out.push(id);
      for (const nb of adj.get(id) ?? []) {
        indeg.set(nb, (indeg.get(nb) ?? 0) - 1);
        if (indeg.get(nb) === 0) {
          // Maintain id-sorted insertion to keep the order stable.
          let i = 0;
          while (i < q.length && q[i]! < nb) i++;
          q.splice(i, 0, nb);
        }
      }
    }
    if (out.length !== this.nodes.size) {
      // Cycle. Fall back to all nodes in id order — Phase 0 doesn't
      // support FEEDBACK yet, so this is a soft warning rather than a
      // hard fail. Phase 1's FEEDBACK module will use ping-pong FBOs and
      // explicitly mark its input as a self-loop the engine ignores in
      // topo terms.
      console.warn('[VideoEngine] cycle in graph; falling back to id-order');
      this.topoOrder = [...this.nodes.keys()].sort();
    } else {
      this.topoOrder = out;
    }
    this.topoStale = false;
  }

  /** Resolve `(thisNode, inputId)` → upstream texture by walking edges.
   *  Multi-edge to a single input takes the first connected source by
   *  edge id; Phase 1 will add explicit policy (sum / pick first / etc.). */
  private lookupInput(thisNodeId: string, inputId: string): WebGLTexture | null {
    // 1. Cross-domain audio → video texture bridges. The bridge holds
    //    the source nodeId+portId from the audio side AND the original
    //    edge (which carries the video-side target nodeId+portId).
    //    Iterate by edge id to keep multi-bridge tie-breaking stable.
    if (this.videoTextureBridges.size > 0) {
      const bridgeHits: Array<{ edgeId: string; tex: WebGLTexture }> = [];
      for (const [edgeId, b] of this.videoTextureBridges) {
        if (b.edge.target.nodeId === thisNodeId && b.edge.target.portId === inputId) {
          // Module-driven 2D draw bridges expose their own texture; the
          // GL-renderer flavor exposes the renderer's. Either is a
          // standard sampler2D from the consumer module's POV.
          const tex = b.customTexture ?? b.renderer?.texture ?? null;
          if (tex) bridgeHits.push({ edgeId, tex });
        }
      }
      if (bridgeHits.length > 0) {
        bridgeHits.sort((a, b) => a.edgeId.localeCompare(b.edgeId));
        return bridgeHits[0]!.tex;
      }
    }
    // 2. Standard intra-domain edges. Iterate edges in id order so a
    //    deterministic edge wins on multi-connect.
    const hits: Edge[] = [];
    for (const e of this.edges.values()) {
      if (e.target.nodeId === thisNodeId && e.target.portId === inputId) hits.push(e);
    }
    hits.sort((a, b) => a.id.localeCompare(b.id));
    for (const e of hits) {
      const src = this.nodes.get(e.source.nodeId);
      if (!src) continue;
      // Multi-output sources (SHAPEDRAMPS — h_lin / v_lin / h_out / v_out)
      // can't share a single surface.texture across distinct ports. They
      // expose per-port textures via `read('outputTexture:<portId>')`,
      // which we honor here before falling back to surface.texture (the
      // single-output convention every Phase-0/1 module uses).
      if (src.read) {
        const tex = src.read(`outputTexture:${e.source.portId}`) as WebGLTexture | null | undefined;
        if (tex) return tex;
      }
      if (src.surface.texture) return src.surface.texture;
    }
    return null;
  }

  /**
   * Does `thisNodeId`'s output drive at least one downstream consumer?
   *
   * True if any edge originates at this node (an intra-domain video edge to
   * another video module's input, OR a cross-domain bridge whose source is
   * this node). Perf-gated SOURCE modules read this via
   * VideoFrameContext.isOutputConnected to skip their render when nobody
   * downstream — and no on-card screen — would ever see the frame.
   *
   * Cheap O(edges); only called from per-frame draws of modules that opt
   * into the gate (currently MANDELBULB), so the linear scan is fine.
   */
  private isOutputConnected(thisNodeId: string): boolean {
    for (const e of this.edges.values()) {
      if (e.source.nodeId === thisNodeId) return true;
    }
    // Cross-domain video→audio / video→texture bridges also count as a
    // consumer: their edge's source is this node even if the destination
    // lives in another engine (so the edge isn't in topo `adj`).
    for (const b of this.videoTextureBridges.values()) {
      if (b.sourceNodeId === thisNodeId) return true;
    }
    return false;
  }

  // -------- Shared GL helpers exposed to module factories --------

  context(): VideoEngineContext {
    return {
      gl: this.gl,
      res: this.res,
      compileFragment: (src) => this.compileFragmentImpl(src),
      createFbo: () => this.createFboImpl(),
      createFloatFbo: (w, h, o) => this.createFloatFboImpl(w, h, o),
      drawFullscreenQuad: () => this.drawFullscreenQuadImpl(),
      audioCtx: this.audioCtx ?? undefined,
      notifyAudioSourcesChanged: (nodeId) => this.audioSourcesChangedListener?.(nodeId),
    };
  }

  /**
   * Register the listener invoked when a materialized node swaps the AudioNode
   * identity on one of its audioSources ports. The PatchEngine wires this to
   * re-resolve cross-domain video→audio bridges. Last registration wins.
   */
  onAudioSourcesChanged(cb: ((nodeId: string) => void) | null): void {
    this.audioSourcesChangedListener = cb;
  }

  /**
   * Inject the AudioContext from the sibling AudioEngine. Called by
   * PatchEngine.registerDomain when both domains are present so video
   * modules that emit audio (DOOM) see a live AudioContext in their
   * factory ctx. Safe to call multiple times — the last value wins.
   *
   * Why not pass via the constructor? VideoEngine is sometimes
   * registered BEFORE the AudioEngine (Canvas.svelte's boot order), and
   * we want the same VideoEngine instance to pick up the audio side
   * once it's available rather than forcing a re-register dance.
   */
  setAudioContext(ctx: AudioContext | null): void {
    this.audioCtx = ctx;
  }

  /**
   * Cross-domain bridge support (video → audio). Mirror of
   * AudioEngine.getVideoSource. Returns the AudioNode + output index a
   * video module has published for the named port (via
   * VideoNodeHandle.audioSources), or null when the node isn't
   * materialized or doesn't declare an audio source for the port.
   *
   * The PatchEngine reads this when adding a video→audio edge and
   * connects the source AudioNode to the downstream AudioEngine input.
   */
  getAudioSource(
    nodeId: string,
    portId: string,
  ): { node: AudioNode; output: number } | null {
    const handle = this.nodes.get(nodeId);
    if (!handle) return null;
    const src = handle.audioSources?.get(portId);
    return src ?? null;
  }

  /** Look up the live VideoNodeHandle for a given node id, or null if the
   *  module hasn't been materialized yet. The PatchEngine's same-domain
   *  video CV/gate bridge uses this to call `setParam` directly on a target
   *  handle (frame-independent pulse dispatch) and to call `subscribePulse`
   *  on a source handle. Lookup-only; the caller MUST NOT mutate the handle. */
  getNodeHandle(nodeId: string): VideoNodeHandle | null {
    return this.nodes.get(nodeId) ?? null;
  }

  /** Resolve a target node's input PORT id to the paramTarget the bridge
   *  feeds via setParam (e.g. SCOREBOARD's `score` port → `scoreTrig`). The
   *  same-domain CV/gate bridge needs this when bypassing addCvBridge's
   *  internal lookup to dispatch discrete pulses straight to the module's
   *  setParam. Falls back to the port id itself when there's no mapping
   *  (the convention for modules whose input id == param id). */
  resolveTargetParamId(targetNodeId: string, targetPortId: string): string {
    const meta = this.nodeMeta.get(targetNodeId);
    const def = meta ? getVideoModuleDef(meta.type) : undefined;
    const input = def?.inputs?.find((p) => p.id === targetPortId);
    return input?.paramTarget ?? targetPortId;
  }

  /** Vertex shader is shared across every module — they're all fullscreen
   *  quads. Inline because it's three lines. */
  private static readonly VERT_SRC = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

  private getOrCreateVertexShader(): WebGLShader {
    if (this.vertexShader) return this.vertexShader;
    const gl = this.gl;
    const vs = gl.createShader(gl.VERTEX_SHADER);
    if (!vs) throw new Error('VideoEngine: cannot create vertex shader');
    gl.shaderSource(vs, VideoEngine.VERT_SRC);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(vs);
      gl.deleteShader(vs);
      throw new Error(`VideoEngine: vertex shader compile failed: ${log}`);
    }
    this.vertexShader = vs;
    return vs;
  }

  private compileFragmentImpl(fragSource: string): WebGLProgram {
    const gl = this.gl;
    const vs = this.getOrCreateVertexShader();
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    if (!fs) throw new Error('VideoEngine: cannot create fragment shader');
    gl.shaderSource(fs, fragSource);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(fs);
      gl.deleteShader(fs);
      throw new Error(`VideoEngine: fragment shader compile failed: ${log}\n${fragSource}`);
    }
    const prog = gl.createProgram();
    if (!prog) {
      gl.deleteShader(fs);
      throw new Error('VideoEngine: cannot create program');
    }
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.linkProgram(prog);
    gl.deleteShader(fs); // linker keeps a copy
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error(`VideoEngine: program link failed: ${log}`);
    }
    return prog;
  }

  private createFboImpl(): { fbo: WebGLFramebuffer; texture: WebGLTexture } {
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error('VideoEngine: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      this.res.width,
      this.res.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const fbo = gl.createFramebuffer();
    if (!fbo) {
      gl.deleteTexture(tex);
      throw new Error('VideoEngine: createFramebuffer failed');
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteTexture(tex);
      gl.deleteFramebuffer(fbo);
      throw new Error(`VideoEngine: framebuffer incomplete: 0x${status.toString(16)}`);
    }
    return { fbo, texture: tex };
  }

  /**
   * Allocate a FLOAT (RGBA16F default, RGBA32F for precision:'full') FBO +
   * texture at the given size, degrading to RGBA8 when the GPU can't render
   * float. See the VideoEngineContext.createFloatFbo doc for the contract.
   *
   * Mirrors createFboImpl above but: (1) caller-chosen w/h (createFbo
   * hardcodes engine res), (2) RGBA16F/RGBA32F internalformat + HALF_FLOAT/
   * FLOAT type when EXT_color_buffer_float is present, (3) NEAREST filter by
   * default (LINEAR on a float attachment silently reads 0.0 without
   * OES_texture_float_linear — see waveform-video.ts), (4) on float
   * framebuffer-incomplete it deletes + retries once as RGBA8 (degrade)
   * rather than throwing, throwing only if RGBA8 is ALSO incomplete.
   */
  private createFloatFboImpl(
    width: number = this.res.width,
    height: number = this.res.height,
    opts?: { filter?: 'nearest' | 'linear'; precision?: 'half' | 'full' },
  ): { fbo: WebGLFramebuffer; texture: WebGLTexture; isFloat: boolean; width: number; height: number } {
    const gl = this.gl;
    // Probe the renderable-float extension exactly once, cache the result.
    if (this.floatColorBufferExt === null) {
      this.floatColorBufferExt = gl.getExtension('EXT_color_buffer_float') != null;
    }
    const wantFloat = this.floatColorBufferExt;
    const filter = opts?.filter === 'linear' ? gl.LINEAR : gl.NEAREST;

    // Build a texture of the requested storage type. Factored so the
    // float-incomplete degrade path can re-run it as RGBA8.
    const buildTexture = (asFloat: boolean): WebGLTexture | null => {
      const t = gl.createTexture();
      if (!t) return null;
      gl.bindTexture(gl.TEXTURE_2D, t);
      if (asFloat) {
        if (opts?.precision === 'full') {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
        } else {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
        }
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      }
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };

    const attach = (
      asFloat: boolean,
    ): { fbo: WebGLFramebuffer; texture: WebGLTexture } | { incomplete: true } | null => {
      const tex = buildTexture(asFloat);
      if (!tex) return null;
      const fbo = gl.createFramebuffer();
      if (!fbo) {
        gl.deleteTexture(tex);
        return null;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        gl.deleteTexture(tex);
        gl.deleteFramebuffer(fbo);
        return { incomplete: true };
      }
      return { fbo, texture: tex };
    };

    if (wantFloat) {
      const r = attach(true);
      if (r && !('incomplete' in r)) {
        return { fbo: r.fbo, texture: r.texture, isFloat: true, width, height };
      }
      // Float framebuffer incomplete (extension reported present but the
      // driver refuses this format) OR createTexture/Framebuffer failed —
      // fall through to the RGBA8 degrade path rather than throwing.
      this.floatColorBufferExt = false;
    }

    // Degrade (or non-float request): RGBA8.
    const r8 = attach(false);
    if (!r8) throw new Error('VideoEngine: createFloatFbo createTexture/Framebuffer failed');
    if ('incomplete' in r8) {
      throw new Error('VideoEngine: createFloatFbo framebuffer incomplete (RGBA8 fallback also failed)');
    }
    return { fbo: r8.fbo, texture: r8.texture, isFloat: false, width, height };
  }

  private drawFullscreenQuadImpl(): void {
    const gl = this.gl;
    if (!this.fullscreenVao) {
      // Create one VAO + buffer the first time. Two-triangle strip at
      // clip-space corners — every fragment shader sees the full screen.
      const vao = gl.createVertexArray();
      if (!vao) throw new Error('VideoEngine: createVertexArray failed');
      gl.bindVertexArray(vao);
      const buf = gl.createBuffer();
      if (!buf) {
        gl.deleteVertexArray(vao);
        throw new Error('VideoEngine: createBuffer failed');
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
        gl.STATIC_DRAW,
      );
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      this.fullscreenVao = vao;
    }
    gl.bindVertexArray(this.fullscreenVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }
}
