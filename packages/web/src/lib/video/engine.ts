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
//   - The engine renders at a LIVE resolution (`res`, mutable). It defaults to
//     VIDEO_RES = 1024×768 (4:3, "768p"); the OUTPUT aspect switch flips it
//     IN PLACE to 1366×768 (16:9) via setResolution() — same height, wider —
//     without tearing down the engine (the patched OUTPUT survives). 4:3 is the
//     default + the LZX analog-video heritage / DOOM viewport ratio; lower-res
//     native sources (SM64's 320×240, DOOM's 640×400) aspect-fit/letterbox into
//     it via ctx.res, so the axis math is res-adaptive; in 16:9 a 4:3-native
//     source side-pillarboxes, a 16:9 source fills edge-to-edge.
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
import { VIDEO_RES } from './video-res';
import { RenderWorkerBridge, workerFlagState, workerLocusEligible } from './worker/worker-bridge';
import { WorkerProxyHandle } from './worker/worker-proxy-handle';
import { computeActiveSet, isPullEvalOn } from './pull-eval';

/** The 4:3 default render resolution (1024×768, "768p"). Re-exported from
 *  video-res.ts (the single aspect→res source of truth) so every importer that
 *  reads `VIDEO_RES` from the engine keeps working; the OUTPUT aspect switch
 *  flips the LIVE engine res to 1366×768 (16:9) via setResolution. */
export { VIDEO_RES };

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
  /**
   * Optional: reallocate any size-dependent GL resources the module owns
   * itself — i.e. EVERYTHING the engine's FBO registry can't resize for it.
   *
   * The OUTPUT aspect switch calls VideoEngine.setResolution(w,h) which mutates
   * the live `ctx.res` in place (so the module's per-frame `ctx.res.*` reads
   * pick up the new size automatically) and resizes every RGBA8 FBO it minted
   * via `ctx.createFbo()` (the common case — ~all procedural modules + colour
   * rings). A module that ALSO owns special buffers the engine doesn't know
   * about — depth renderbuffers, FLOAT FBOs (createFloatFbo), the video-frame
   * uploader's downscale canvas, multi-pass oversample targets — implements
   * this hook to reallocate those at the new (w,h). Mirrors p10entrancer's
   * per-renderer `(w,h) != lastSize` realloc (../p10entrancer
   * Mixer/MasterMixerOffscreen.swift). The module is NOT torn down — its
   * programs, uniform caches, ring head, etc. all survive; only the
   * size-dependent textures/renderbuffers re-spec. Called AFTER the engine
   * resizes its registry FBOs (so a depth-RB resize lands on an already-colour-
   * resized FBO, keeping it complete). Idempotent on the same size.
   *
   * Modules with no size-dependent state beyond their `ctx.createFbo()` outputs
   * omit it entirely.
   */
  resize?(width: number, height: number): void;
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
  /**
   * Optional: the SET of this node's output PORT ids that drive at least one
   * downstream consumer (intra-domain video edges + cross-domain video→texture
   * bridges). The per-PORT refinement of `isOutputConnected`, for MULTI-OUTPUT
   * modules that want to skip rendering the FBOs nobody reads.
   *
   * COLOUR OF MAGIC has 22 output FBOs; rendering all of them every frame is a
   * ~2.5× SwiftShader cost. It renders only the ports in this set PLUS the one
   * it previews, keeping steady-state cost near a single-output module's.
   *
   * Modules MUST treat an ABSENT helper (older engine builds / test mocks) as
   * "connectivity unknown → render everything", so they never wrongly go dark.
   * The returned set is engine-owned + read-only — callers must not mutate it.
   */
  connectedOutputPorts?(thisNodeId: string): ReadonlySet<string>;
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
  /**
   * Optional: per-port AudioNode SINKS that surface an `audio`-typed INPUT
   * port on this video module as an audio-domain destination (cross-domain
   * handoff, audio → video). The INVERSE of `audioSources`.
   *
   * A video module that CONSUMES PCM audio (RECORDERBOX's `audio_l` /
   * `audio_r` soundtrack capture) populates this map with one entry per
   * declared `audio`-typed INPUT port — typically a
   * `MediaStreamAudioDestinationNode` created via `ctx.audioCtx`. The
   * PatchEngine reads it via `VideoEngine.getAudioInput(nodeId, portId)`
   * when materializing an audio→video edge whose target port type is
   * `audio`; it then connects the upstream audio source's output
   * (AudioEngine.getOutputNode) straight into this sink node.
   *
   * Lifecycle: the module owns the AudioNode sink and disposes it. The
   * bridge disconnects the upstream source on edge removal (its own
   * teardown). Modules with no audio input omit the field entirely (the
   * AudioContext may not even be present if no audio engine is registered).
   */
  audioInputs?: Map<string, { node: AudioNode; input: number }>;
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
  /**
   * The engine's LIVE render resolution. Mutated IN PLACE by
   * VideoEngine.setResolution on an OUTPUT aspect switch (the same object
   * identity is kept), so a module's per-frame `ctx.res.width/height` reads
   * always see the current size with no re-plumbing — exactly how the
   * reference's renderers read `mixer.canvasSize` fresh each frame
   * (../p10entrancer). Modules MUST read it per-draw, not cache it at
   * construction, for size-dependent uniforms/viewports.
   */
  res: { readonly width: number; readonly height: number };
  /**
   * Whether the engine is rendering WIDER than the 4:3 default (i.e. the 16:9
   * aspect). Hungry modules (b3ntb0x's oversampled float passes) read this to
   * gate heavy-buffer guardrails. OPTIONAL so test-mock contexts (which never
   * set it) read as false = the default 4:3.
   */
  wideActive?: boolean;
  /** Compile + link a fragment-shader program. The vertex shader is
   *  shared across modules — every video module is a fullscreen quad, so
   *  the vertex shader is fixed. Throws on compile/link failure with the
   *  shader log + source for debug. */
  compileFragment(fragSource: string): WebGLProgram;
  /**
   * Allocate an RGBA8 framebuffer + texture at the engine resolution. Returns
   * both so the caller can render-into AND sample-from it.
   *
   * By default the engine REGISTERS the FBO so it auto-resizes the colour
   * texture when the aspect switch changes the engine res — the common case for
   * procedural sources, effects, and colour rings (no per-module resize code
   * needed). A module that attaches its OWN depth renderbuffer to the FBO (so
   * the engine resizing only the colour texture would leave the FBO
   * size-mismatched/incomplete) passes `{ managed: false }` and resizes the
   * whole FBO itself via its `resize` hook. OPTIONAL `opts` so existing
   * zero-arg callers are unchanged.
   */
  createFbo(opts?: { managed?: boolean }): { fbo: WebGLFramebuffer; texture: WebGLTexture };
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
  /**
   * The engine's LIVE render resolution — every per-module FBO + the drawing
   * buffer. Defaults to VIDEO_RES (1024×768, 4:3) but the OUTPUT aspect switch
   * mutates it IN PLACE via setResolution (the object identity is preserved so
   * the VideoEngineContext.res handed to every module factory tracks it for
   * free). Internally `_res` is mutable; `res` is the (read-only-typed) view
   * modules see. NOT readonly-rebuilt per toggle — that was the reverted #653
   * bug (full PatchEngine teardown broke the patched OUTPUT); we reallocate
   * buffers in place like the reference (../p10entrancer).
   */
  private _res: { width: number; height: number };
  get res(): { readonly width: number; readonly height: number } {
    return this._res;
  }

  private nodes = new Map<string, VideoNodeHandle>();
  private nodeMeta = new Map<string, ModuleNode>();
  private edges = new Map<string, Edge>();

  // ── Manual BASE value vs TRANSIENT modulation (clip-automation + CV) ──
  //
  // A video param is a SINGLE uniform value — unlike an AudioParam it has no
  // intrinsic-plus-summed-modulation split, so a transient writer that
  // overwrites the uniform REPLACES the value the user dialed in. MANUAL edits
  // (VideoEngine.setParam, driven by the reconciler off node.params) are the
  // BASE. Clip-automation PLAYBACK (scheduleParam / holdParam / setDisplayParam,
  // newly implemented below) and cross-domain CV bridges are TRANSIENT drivers:
  // they push a value onto the handle WITHOUT changing the base.
  //
  // THE STUCK-CONTROL BUG this prevents: when a transient driver stops (the
  // automation clip is deleted / the lane stops / a CV cable is unpatched) the
  // uniform is left at the LAST driven value. The reconciler will NOT re-push
  // node.params — it dedups against its own applied snapshot, which never
  // changed — so the on-screen fader is dead: moving it only recovers on a
  // value DISTINCT from the last applied one, and against a per-frame driver it
  // never recovers at all. Cure: every param under transient drive records the
  // frame its modulation is valid THROUGH; each frame we RESTORE the base for
  // any key whose modulation went stale (no driver refreshed it), so full
  // manual control ALWAYS returns the instant a driver stops. One mechanism
  // covers both automation and CV — the shared video-render seam.
  private baseParams = new Map<string, number>(); // key → last manual/base value
  private transientMods = new Map<string, { nodeId: string; paramId: string; untilFrame: number }>();
  /** How many render frames a single transient write keeps the param under
   *  modulation. Automation display ticks (~40fps) + CV bridges (per frame)
   *  refresh well inside this, so an ACTIVE driver never goes stale; when it
   *  STOPS the base restores ~this many frames later (~150ms — imperceptible,
   *  and clear of a GC/scheduler hiccup that would otherwise flicker). */
  private static readonly TRANSIENT_HOLD_FRAMES = 10;

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

  /**
   * Registry of engine-minted RGBA8 FBOs (the common `ctx.createFbo()` case),
   * keyed by the node that owns them, so setResolution can re-spec their colour
   * textures at the new engine res WITHOUT each procedural module writing its
   * own resize hook. Unmanaged FBOs (`createFbo({managed:false})` — those with
   * a module-owned depth renderbuffer) are excluded; their owner resizes them
   * via the `resize` surface hook. Entries are dropped on removeNode/dispose.
   */
  private managedFbos = new Map<string, Array<{ fbo: WebGLFramebuffer; texture: WebGLTexture }>>();
  /** The node id whose factory is currently running — set in addNode so
   *  createFboImpl can attribute managed FBOs to the right node. */
  private currentFactoryNodeId: string | null = null;

  /**
   * Fix E (offscreen-canvas render worker) — the main-thread side of the render
   * worker. Lazily constructed the first time a `renderLocus:'worker'` node is
   * added WHILE the flag is on. null when the flag is off or no worker-locus
   * node has been added (the common case — the worker is never spawned, and the
   * engine renders everything in this thread exactly as before). Disposed in
   * dispose(). See worker/worker-bridge.ts.
   */
  private workerBridge: RenderWorkerBridge | null = null;

  // ---- Sink-driven pull evaluation (see pull-eval.ts) ----

  /** Wall-clock (ms) of the most recent OBSERVATION of each node's output —
   *  an OUTPUT/preview card blit, a card `read()` poll, a test
   *  `outputTexture()` read, a pointer interaction. A node counts as WATCHED
   *  while its mark is younger than {@link VideoEngine.WATCH_TTL_MS}. */
  private watchedAt = new Map<string, number>();
  /** Card viewport visibility, fed by the Canvas-level IntersectionObserver
   *  (see $lib/ui/video-card-visibility). ABSENT = unknown = fail-open
   *  (treated as visible). `false` demotes a watched node — an offscreen
   *  card's preview loop keeps blitting, but nobody can see the result, so
   *  the node must not keep its chain rendering. */
  private cardVisible = new Map<string, boolean>();
  /** Hard render leases (refcounted): roots regardless of card visibility.
   *  Used by presentation surfaces that outlive the card's viewport rect
   *  (true fullscreen, present-on-second-display). */
  private renderLeases = new Map<string, number>();
  /** Cards previewing a SPECIFIC non-primary OUTPUT port inline (VIDEOCUBE's
   *  on-card SLICE viz) register a short-lived request here so the module's
   *  per-port render gate keeps that port rendering even while it is UNPATCHED.
   *  TTL-scoped (the same WATCH_TTL as a watch mark): once the card unmounts or
   *  goes offscreen it stops refreshing and the port returns to gated-off, so an
   *  idle rack pays nothing. nodeId → (portId → expiry, ms on the watch clock). */
  private previewPorts = new Map<string, Map<string, number>>();
  /** Per-node cumulative draw counter — the deterministic probe the pull-eval
   *  tests/e2e assert on (a skipped node's counter must not advance). */
  private framesDrawn = new Map<string, number>();
  /** Last frame's pull decision (node ids), for the `pullStats()` probe. */
  private lastEvaluated: string[] = [];
  private lastSkipped: string[] = [];
  /** How long an observation keeps a node watched. Long enough that a card's
   *  ~60fps blit loop never flickers the state (and that a synchronous
   *  test-driven `step()` burst inside one task can't expire it), short
   *  enough that an unmounted/hidden card decays within ~2s. */
  private static readonly WATCH_TTL_MS = 1500;
  /** Injectable clock for the watch marks (unit tests advance it to prove
   *  TTL decay without wall-clock sleeps). Defaults to performance.now. */
  private readonly watchNow: () => number;

  constructor(opts: {
    canvas?: OffscreenCanvas | HTMLCanvasElement;
    res?: { width: number; height: number };
    /** Test-only injectable clock for watch-mark TTL (defaults to
     *  performance.now — production callers never pass it). */
    watchNow?: () => number;
  } = {}) {
    this.watchNow = opts.watchNow ?? (() => performance.now());
    // Assign _res BEFORE any `this.res.*` read below (the OffscreenCanvas
    // sizing). Degenerate (0-dim) res falls back to the 4:3 VIDEO_RES so a
    // caller passing a glitched viewport never produces a 0-sized drawing
    // buffer.
    this._res =
      opts.res && opts.res.width > 0 && opts.res.height > 0
        ? { width: opts.res.width, height: opts.res.height }
        : { width: VIDEO_RES.width, height: VIDEO_RES.height };
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
    const vdef = def as VideoModuleDef;
    let handle: VideoNodeHandle;
    // Fix E — if this module is opted into the render worker AND the flag is on
    // AND the worker is usable, install a WorkerProxyHandle: the node renders in
    // the worker and finished frames copy back into a main-GL texture. Otherwise
    // the normal main-thread factory path below runs (byte-identical to today).
    const bridge = this.maybeWorkerBridge(vdef);
    if (bridge) {
      handle = new WorkerProxyHandle({
        gl: this.gl,
        bridge,
        node,
        factory: vdef.factory,
        // The fallback factory needs a context attributed to this node so its
        // managed FBOs resize on an aspect switch, exactly like the main path.
        context: () => this.context(node.id),
      });
    } else {
      // Mark which node's factory is running so createFboImpl attributes its
      // managed FBOs to it (for setResolution to resize later). Cleared in a
      // finally so a throwing factory never strands the attribution.
      this.currentFactoryNodeId = node.id;
      try {
        handle = vdef.factory(this.context(node.id), node);
      } finally {
        this.currentFactoryNodeId = null;
      }
    }
    this.nodes.set(node.id, handle);
    this.nodeMeta.set(node.id, node);
    // Seed the manual BASE for every declared param (node.params where present,
    // else the def default) so a param that gets automation/CV-modulated before
    // the user ever touches it still has a value to restore to when the driver
    // stops (see baseParams / sweepStaleTransients).
    for (const p of vdef.params) {
      const v = (node.params?.[p.id] ?? p.defaultValue) as number | undefined;
      if (typeof v === 'number') this.baseParams.set(this.paramKey(node.id, p.id), v);
    }
    // Pull-eval SPAWN GRACE: a fresh node starts watched for one TTL so it
    // renders from frame 1 while its card mounts and begins presenting
    // (the blit/read marks then keep it alive — or it decays if nothing
    // ever observes it).
    this.markWatched(node.id);
    this.topoStale = true;
    this.ensureLoop();
  }

  /**
   * Fix E — return the render-worker bridge to use for a module, or null to
   * render it on the main thread. Null when: the flag is off, the module isn't
   * `renderLocus:'worker'`, or the worker isn't supported in this runtime. The
   * bridge is constructed lazily (only the first worker-locus add spawns it),
   * so a rack with no worker modules never pays for a worker. Even when a bridge
   * is returned, the WorkerProxyHandle renders on the main thread until the
   * worker confirms a live WebGL2 context (bridge.ready()), so a worker that
   * fails to init degrades to the main path with no blank frames.
   */
  private maybeWorkerBridge(def: VideoModuleDef): RenderWorkerBridge | null {
    // Tri-state flag (default ON since PR V2): parity-complete
    // `renderLocus:'worker'` modules use the worker in the 'default' state;
    // `worker-experimental' ones need the explicit 'on'; 'off' kills all.
    if (!workerLocusEligible(def.renderLocus, workerFlagState())) return null;
    if (!this.workerBridge) {
      const b = new RenderWorkerBridge({
        res: { width: this._res.width, height: this._res.height },
      });
      if (!b.supported) {
        // Unsupported runtime — never use the worker for this engine instance.
        b.dispose();
        return null;
      }
      this.workerBridge = b;
    }
    return this.workerBridge.supported ? this.workerBridge : null;
  }

  removeNode(nodeId: string): void {
    const handle = this.nodes.get(nodeId);
    if (!handle) return;
    handle.dispose();
    this.nodes.delete(nodeId);
    this.nodeMeta.delete(nodeId);
    // Drop this node's base + transient param bookkeeping (keys are prefixed
    // with the node id).
    const prefix = `${nodeId} `;
    for (const k of this.baseParams.keys()) if (k.startsWith(prefix)) this.baseParams.delete(k);
    for (const k of this.transientMods.keys()) if (k.startsWith(prefix)) this.transientMods.delete(k);
    this.mouseState.delete(nodeId);
    this.managedFbos.delete(nodeId);
    this.watchedAt.delete(nodeId);
    this.previewPorts.delete(nodeId);
    this.cardVisible.delete(nodeId);
    this.renderLeases.delete(nodeId);
    this.framesDrawn.delete(nodeId);
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

  /**
   * MANUAL param write — the reconciler's node.params → engine seam (and any
   * card-direct engine.setParam). This is the BASE value: it's what the param
   * returns to when no transient driver (automation / CV) is active. We record
   * it so a stale-modulation sweep can restore it, then apply it to the handle.
   */
  setParam(nodeId: string, paramId: string, value: number): void {
    this.baseParams.set(this.paramKey(nodeId, paramId), value);
    this.nodes.get(nodeId)?.setParam(paramId, value);
  }

  private paramKey(nodeId: string, paramId: string): string {
    return `${nodeId} ${paramId}`;
  }

  /**
   * TRANSIENT drive — a NON-manual writer (clip-automation playback, a CV
   * bridge) pushes `value` onto the param's uniform for THIS moment without
   * disturbing the manual base. Marks the param modulated for the next
   * TRANSIENT_HOLD_FRAMES so the per-frame sweep won't reclaim it while the
   * driver keeps refreshing, and restores the base once it stops (no stuck
   * control). No-op for an absent node.
   */
  private driveTransient(nodeId: string, paramId: string, value: number): void {
    const handle = this.nodes.get(nodeId);
    if (!handle) return;
    const key = this.paramKey(nodeId, paramId);
    // Seed the base from the live handle the first time a param is driven
    // transiently before any manual write reached the engine — so the value it
    // restores to is the one currently shown, never undefined.
    if (!this.baseParams.has(key)) {
      const cur = handle.readParam(paramId);
      if (cur !== undefined) this.baseParams.set(key, cur);
    }
    this.transientMods.set(key, { nodeId, paramId, untilFrame: this.frameCount + VideoEngine.TRANSIENT_HOLD_FRAMES });
    handle.setParam(paramId, value);
  }

  /** Restore a param's manual base onto its handle NOW and clear its transient
   *  mark. Called when a driver ends explicitly (CV cable removed) and by the
   *  per-frame stale sweep. No-op when there's no recorded base. */
  private restoreBase(nodeId: string, paramId: string): void {
    const key = this.paramKey(nodeId, paramId);
    this.transientMods.delete(key);
    const base = this.baseParams.get(key);
    if (base !== undefined) this.nodes.get(nodeId)?.setParam(paramId, base);
  }

  /** Per-frame sweep (called at the top of step()): any param whose transient
   *  modulation has gone STALE — no automation/CV write refreshed it within
   *  TRANSIENT_HOLD_FRAMES — is returned to its manual base, so manual control
   *  is never left dead after a driver stops. Cheap: only iterates params that
   *  are (or recently were) modulated. */
  private sweepStaleTransients(): void {
    if (this.transientMods.size === 0) return;
    for (const [key, m] of [...this.transientMods]) {
      if (this.frameCount >= m.untilFrame) {
        this.transientMods.delete(key);
        const base = this.baseParams.get(key);
        if (base !== undefined) this.nodes.get(m.nodeId)?.setParam(m.paramId, base);
      }
    }
  }

  /**
   * Clip-automation PLAYBACK drive (DomainEngine.scheduleParam). Audio ramps
   * schedule a future AudioParam event; a video uniform can't be scheduled
   * ahead, so we apply the value immediately as a transient drive (the caller
   * feeds per-step / per-tick values, and setDisplayParam refines between
   * steps). atTime / ramp are audio-only and ignored here.
   */
  scheduleParam(nodeId: string, paramId: string, value: number, _atTime: number, _ramp: boolean): void {
    this.driveTransient(nodeId, paramId, value);
  }

  /**
   * Clip-automation HOLD-AT-SEAM drive (DomainEngine.holdParam). `toValue`
   * present ⇒ pin the uniform to that resting value transiently (hold-last-
   * value on stop / the release hand-off). `toValue` omitted ⇒ a truncate /
   * anchor seam that has no audio-ramp tail to cancel for video and is
   * immediately followed by the incoming clip's own drive (or the user's live
   * input), so it's a no-op here. Either way the base restores once drive stops.
   */
  holdParam(nodeId: string, paramId: string, _atTime: number, toValue?: number, _glideS?: number): void {
    if (toValue != null) this.driveTransient(nodeId, paramId, toValue);
  }

  /**
   * Clip-automation VISUAL-SMOOTHING drive (DomainEngine.setDisplayParam). For
   * AUDIO this is a display-cache-only refresh (the DSP already rendered the
   * ramp); a video module has no separate DSP, so the uniform IS the render —
   * we apply the interpolated value as a transient drive. This is the per-tick
   * (~40fps) path that makes video automation play back smoothly.
   */
  setDisplayParam(nodeId: string, paramId: string, value: number): void {
    this.driveTransient(nodeId, paramId, value);
  }

  /**
   * Fix E Phase 2 — forward a TOYBOX node.data snapshot to the render worker
   * so the worker-side TOYBOX handle can update its layer/combine state without
   * touching the Yjs store. Called by ToyboxCard whenever node.data changes
   * (reactive $effect on patch.nodes[id]?.data). A no-op when the worker is
   * not active for this node (the flag is off, the worker failed, or this node
   * is rendering on the main thread).
   */
  syncNodeData(nodeId: string, data: unknown): void {
    this.workerBridge?.sendToyboxSync(nodeId, data);
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
    // A pointer on a node's preview is an observation — keep it rendering.
    this.markWatched(nodeId);
    this.mouseState.set(nodeId, [x, y, z, w]);
  }

  // -------- Sink-driven pull evaluation: watch bookkeeping --------

  /**
   * Record that `nodeId`'s output was OBSERVED just now (presented on a
   * canvas, polled via read(), sampled by a test). The node counts as a pull
   * root for the next WATCH_TTL_MS, unless its card is known-offscreen
   * (setCardVisibility(false)). Called implicitly by
   * blitOutputToDrawingBuffer / read / outputTexture / setMouse; public so
   * bespoke presentation paths (and tests) can mark directly.
   */
  markWatched(nodeId: string): void {
    this.watchedAt.set(nodeId, this.watchNow());
  }

  /**
   * Feed card viewport visibility from the Canvas-level IntersectionObserver
   * (see $lib/ui/video-card-visibility). `false` demotes the node's watch
   * marks (an offscreen card's preview loop keeps blitting, but nobody can
   * see it); `true` restores; `null` clears back to unknown (fail-open =
   * visible) — used when a card unmounts.
   */
  setCardVisibility(nodeId: string, visible: boolean | null): void {
    if (visible === null) this.cardVisible.delete(nodeId);
    else this.cardVisible.set(nodeId, visible);
  }

  /**
   * Acquire a HARD render lease on a node: it stays a pull root regardless of
   * card visibility until the returned release fn is called (refcounted, and
   * release is idempotent). For presentation surfaces that outlive the card's
   * viewport rect: VideoOutCard's true-fullscreen / present-on-second-display
   * modes. NOT for preview loops — those use the soft blit/read marks so an
   * offscreen card decays naturally.
   */
  acquireRenderLease(nodeId: string): () => void {
    this.renderLeases.set(nodeId, (this.renderLeases.get(nodeId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.renderLeases.get(nodeId) ?? 0) - 1;
      if (n <= 0) this.renderLeases.delete(nodeId);
      else this.renderLeases.set(nodeId, n);
    };
  }

  /** Last frame's pull decision + cumulative per-node draw counts — the
   *  deterministic probe the pull-eval unit tests and e2e assert on (counters
   *  and membership, never pixel timing). JSON-safe for page.evaluate. */
  pullStats(): {
    enabled: boolean;
    evaluated: string[];
    skipped: string[];
    framesDrawn: Record<string, number>;
    /** The card-visibility feed as the engine currently sees it (absent id =
     *  unknown = fail-open). Diagnostic — lets a spec assert WHY a node was
     *  skipped/kept. */
    cardVisible: Record<string, boolean>;
    /** Nodes currently holding a hard render lease. */
    leased: string[];
  } {
    return {
      enabled: isPullEvalOn(),
      evaluated: [...this.lastEvaluated],
      skipped: [...this.lastSkipped],
      framesDrawn: Object.fromEntries(this.framesDrawn),
      cardVisible: Object.fromEntries(this.cardVisible),
      leased: [...this.renderLeases.keys()],
    };
  }

  /** Cumulative number of frames in which `nodeId`'s draw() actually ran. */
  framesDrawnFor(nodeId: string): number {
    return this.framesDrawn.get(nodeId) ?? 0;
  }

  /** Is this node a pull ROOT this frame? Exempt (side-effectful) nodes and
   *  leased nodes always are; watched nodes are unless their card is
   *  known-offscreen. */
  private isPullRoot(nodeId: string, handle: VideoNodeHandle, now: number): boolean {
    if (this.renderLeases.has(nodeId)) return true;
    if (this.isPullExempt(nodeId, handle)) return true;
    const at = this.watchedAt.get(nodeId);
    if (at === undefined || now - at > VideoEngine.WATCH_TTL_MS) return false;
    // Watched — but a known-offscreen card doesn't count as an observer.
    return this.cardVisible.get(nodeId) !== false;
  }

  /**
   * Side-effect audit (pull-eval exemptions): a module whose draw() has
   * observable effects BEYOND its output texture must keep running while
   * unwatched. Detected structurally from the handle —
   *   - `audioSources` non-empty: the module publishes live audio/CV on the
   *     AudioContext graph (DOOM/BLOOD/NIBBLES/GIBRIBBON game sims, the
   *     video players' soundtracks, MANDELBULB's sonification). Pausing
   *     draw() would freeze the simulation/CV that audio consumers hear.
   *   - `audioInputs` non-empty: the module CONSUMES audio (RECORDERBOX's
   *     soundtrack capture, MILKDROP/GRAPHICEQ analysis) — its draw() drains
   *     and reacts to a live stream; RECORDERBOX must capture while hidden.
   *   - `subscribePulse` present: the module publishes discrete pulse events
   *     from inside draw(); skipping draws would drop pulses.
   *   - def-level `pullExempt` flag: escape hatch for future stateful sims
   *     with no audio surface.
   * Everything else is texture-only: freezing it while unobserved is, by
   * definition, unobservable.
   */
  private isPullExempt(nodeId: string, handle: VideoNodeHandle): boolean {
    if (handle.audioSources && handle.audioSources.size > 0) return true;
    if (handle.audioInputs && handle.audioInputs.size > 0) return true;
    if (typeof handle.subscribePulse === 'function') return true;
    const meta = this.nodeMeta.get(nodeId);
    const def = meta ? getVideoModuleDef(meta.type) : undefined;
    return def?.pullExempt === true;
  }

  /**
   * Compute this frame's ACTIVE set (pull evaluation): reverse-reachable from
   * the roots through the intra-domain edge graph. Upstream sources of an
   * active node are active — a watched OUTPUT keeps its whole input chain
   * rendering; an unwatched, side-effect-free chain costs zero draws.
   */
  private computePullActiveSet(): Set<string> {
    const now = this.watchNow();
    const roots: string[] = [];
    for (const [id, handle] of this.nodes) {
      if (this.isPullRoot(id, handle, now)) roots.push(id);
    }
    // target -> upstream source node ids (only edges between materialized
    // video nodes matter for draw scheduling; cross-domain bridges tick
    // separately and games/CV emitters are already roots via exemptions).
    const incoming = new Map<string, string[]>();
    for (const e of this.edges.values()) {
      const t = e.target.nodeId;
      if (!this.nodes.has(t) || !this.nodes.has(e.source.nodeId)) continue;
      let list = incoming.get(t);
      if (!list) { list = []; incoming.set(t, list); }
      list.push(e.source.nodeId);
    }
    return computeActiveSet(roots, (id) => incoming.get(id) ?? []);
  }

  readParam(nodeId: string, paramId: string): number | undefined {
    return this.nodes.get(nodeId)?.readParam(paramId);
  }

  read(nodeId: string, key: string): unknown {
    const h = this.nodes.get(nodeId);
    if (!h) return undefined;
    // A card polling module state (ACIDWARP's snapshot preview, VFPGA's gate
    // LEDs, LUSHGARDEN's plant counter) is observing the node — keep it
    // rendering while the polls continue.
    this.markWatched(nodeId);
    return h.read ? h.read(key) : undefined;
  }

  /** The engine-level frame counter — advanced exactly once per step() (incl.
   *  the freeze-render path). With the rAF loop paused (`__videoEnginePause`),
   *  a test that drives step() owns this count exactly, so a before/after DELTA
   *  is the deterministic frame-count check for the Layer-B render-smoke (works
   *  for EVERY module, unlike a per-module `read('framesElapsed')`). */
  currentFrameCount(): number {
    return this.frameCount;
  }

  /** A node's OUTPUT texture, by the same rule edge-resolution uses: a
   *  multi-output module's per-port `read('outputTexture:<portId>')` if a port
   *  is given + present, else the single `surface.texture`. The canonical,
   *  module-agnostic way for the Layer-B render-smoke to read any node's output
   *  (no per-module `read('fboTexture')` key required). */
  outputTexture(nodeId: string, portId?: string): WebGLTexture | null {
    const h = this.nodes.get(nodeId);
    if (!h) return null;
    // Sampling a node's output texture (render-smoke readbacks, bespoke
    // consumers) is an observation — keep the node rendering.
    this.markWatched(nodeId);
    if (portId && h.read) {
      const t = h.read(`outputTexture:${portId}`) as WebGLTexture | null | undefined;
      if (t) return t;
    }
    return h.surface?.texture ?? null;
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

  /** True when the engine is rendering WIDER than the 4:3 default (the 16:9
   *  aspect). Surfaced to module factories via VideoEngineContext.wideActive so
   *  hungry modules can gate heavy-buffer guardrails. */
  get wideActive(): boolean {
    return this._res.width > VIDEO_RES.width;
  }

  /**
   * Switch the engine's internal render resolution IN PLACE — the OUTPUT aspect
   * switch (4:3 1024×768 ↔ 16:9 1366×768). This is the deliberate alternative to
   * the reverted #653 approach (which tore down + rebuilt the whole PatchEngine
   * on every toggle and broke the patched OUTPUT): here the one engine stays
   * alive — no node re-add, no AudioContext churn, no DOOM/SM64 restart. Mirrors
   * the reference's per-renderer realloc on a `canvasSize` change
   * (../p10entrancer).
   *
   * Steps (no-op if w/h unchanged):
   *   1. Mutate `_res` in place — every module's `ctx.res` is the same object,
   *      so per-frame `ctx.res.*` reads instantly see the new size.
   *   2. Resize the OffscreenCanvas drawing buffer (the OUTPUT cards blit from
   *      it, and blitOutputToDrawingBuffer viewports at `res`).
   *   3. Re-spec every ENGINE-MANAGED RGBA8 FBO's colour texture (the common
   *      procedural/effect/colour-ring case — auto, no per-module code).
   *   4. Resize every cross-domain audio→video texture-bridge surface so a
   *      patched waveform/scope source still fills the new canvas.
   *   5. Call each module's optional `surface.resize(w,h)` so it reallocates
   *      its OWN special buffers (depth RBs, FLOAT FBOs, the video-frame
   *      uploader canvas, oversample passes). Called AFTER (3) so a depth-RB
   *      resize lands on an already-colour-resized FBO → stays complete.
   *
   * Loaded video / images keep playing — their SOURCE textures are untouched;
   * the next uploaded frame lands at the new res (sharp). Returns true if a
   * resize happened.
   */
  setResolution(width: number, height: number): boolean {
    const w = Math.max(2, Math.round(width));
    const h = Math.max(2, Math.round(height));
    if (w === this._res.width && h === this._res.height) return false;

    // 1. Mutate in place (preserve object identity for ctx.res consumers).
    this._res.width = w;
    this._res.height = h;

    // 2. Resize the drawing buffer.
    try {
      this.canvas.width = w;
      this.canvas.height = h;
    } catch {
      /* OffscreenCanvas in some jsdom builds is read-only — non-fatal */
    }

    const gl = this.gl;

    // 3. Re-spec every managed RGBA8 colour texture to the new res. texImage2D
    //    with null data re-allocates the texture storage; the FBO keeps the
    //    same texture object so its attachment stays valid.
    for (const list of this.managedFbos.values()) {
      for (const { texture } of list) {
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, null);

    // 4. Resize cross-domain texture-bridge surfaces (waveform/scope sources).
    for (const b of this.videoTextureBridges.values()) {
      if (b.customTexture) {
        if (b.customCanvas) {
          try { b.customCanvas.width = w; b.customCanvas.height = h; } catch { /* */ }
        }
        gl.bindTexture(gl.TEXTURE_2D, b.customTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      }
      b.renderer?.resize?.(w, h);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);

    // 5. Let each module reallocate its own special buffers at the new res.
    //    A WorkerProxyHandle's resize forwards the new res to the worker AND
    //    re-specs its main-GL copy-back texture (see worker-proxy-handle.ts), so
    //    the off-thread render tracks the aspect switch with no extra plumbing.
    for (const handle of this.nodes.values()) {
      try { handle.surface.resize?.(w, h); } catch (e) {
        console.warn('[VideoEngine] module resize failed during setResolution:', e);
      }
    }
    return true;
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
    this.managedFbos.clear();
    this.topoOrder = [];
    this.watchedAt.clear();
    this.previewPorts.clear();
    this.cardVisible.clear();
    this.renderLeases.clear();
    this.framesDrawn.clear();
    this.lastEvaluated = [];
    this.lastSkipped = [];

    // Fix E — tear down the render worker (if one was spawned). Each proxy
    // handle already told the worker to removeNode in its dispose() above; this
    // terminates the worker + closes any pending bitmaps.
    if (this.workerBridge) {
      try { this.workerBridge.dispose(); } catch { /* */ }
      this.workerBridge = null;
    }

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

  /** E2E DETERMINISM hook (Layer-B render-smoke). When
   *  `globalThis.__videoEngineFreezeTime` is a finite number, the engine clock
   *  exposed as `frame.time` (ctx.time) is PINNED to it while draws STILL run —
   *  so a time-animated module renders an identical frame on every step. This is
   *  distinct from `__videoEngineFreezeRender`, which SKIPS the draw entirely
   *  (used by the per-port sweeps). Default-undefined → zero production effect. */
  private engineFrozenTimeSec(): number | null {
    const v = (globalThis as unknown as { __videoEngineFreezeTime?: unknown }).__videoEngineFreezeTime;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }

  /** Run one frame's worth of draws. Test code calls this directly so it
   *  doesn't have to wait for rAF. */
  step(): void {
    if (this.topoStale) this.recomputeTopo();

    // Determinism forwarding — mirror the main-thread freeze/pause globals
    // into the render worker (its own realm can't see them). BEFORE the
    // freeze-render early-return below, so a frozen harness stops worker
    // frames too. Cheap no-op when unchanged / no worker.
    this.workerBridge?.syncDeterminism();

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

    // 0a. Reclaim any param whose clip-automation / CV modulation went stale
    //     (the driver stopped) back to its manual base BEFORE this frame's
    //     drivers run — so an active driver re-marks its param immediately after
    //     and a stopped one is left at the user's value (no stuck control).
    this.sweepStaleTransients();

    // 0b. Sink-driven pull evaluation: compute this frame's ACTIVE set —
    //     the reverse-reachable subgraph from the frame's roots (watched /
    //     leased / side-effect-exempt nodes). null = pull eval disabled via
    //     the kill switch → evaluate everything (the legacy push behavior).
    const activeSet = isPullEvalOn() ? this.computePullActiveSet() : null;

    // 1. Sample every active cross-domain CV bridge BEFORE drawing this
    //    frame's modules. Each sample becomes the param value for the
    //    upcoming draw, so a frame's-worth of CV → video param coupling
    //    is one-frame-deterministic. Quantization at 60fps from a 48kHz
    //    audio source is the documented limit (see plan §2 'Cross-domain
    //    CV adapter'). NOT pull-filtered: setParam writes are cheap, feed
    //    card-side scopes/UI, and keep param state fresh for the frame a
    //    target wakes back up.
    this.tickCvBridges();
    // 1b. Render every active audio → video texture bridge so the
    //     target video modules see fresh waveform textures during their
    //     draw() pass. Doing this BEFORE the topo loop matches the CV
    //     bridge ordering — both kinds of cross-domain handoff happen
    //     "before" intra-domain rendering each frame. Pull-filtered: a
    //     bridge whose TARGET node is skipped this frame renders a texture
    //     nobody samples, so it is skipped with it.
    this.tickVideoTextureBridges(activeSet);

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
      time: this.engineFrozenTimeSec() ?? (performance.now() - this.startTime) / 1000,
      frame: this.frameCount++,
      timeDelta: this.timeDelta,
      frameRate: this.frameRate,
      getMouse: (thisNodeId) => this.mouseState.get(thisNodeId) ?? [0, 0, 0, 0],
      getInputTexture: (thisNodeId, inputId) => this.lookupInput(thisNodeId, inputId),
      isOutputConnected: (thisNodeId) => this.isOutputConnected(thisNodeId),
      connectedOutputPorts: (thisNodeId) => this.connectedOutputPorts(thisNodeId),
    };
    const evaluated: string[] = [];
    const skipped: string[] = [];
    for (const id of this.topoOrder) {
      const handle = this.nodes.get(id);
      if (!handle) continue;
      if (activeSet && !activeSet.has(id)) {
        // Pull eval: nothing observable depends on this node this frame —
        // zero render work. Its texture keeps its last contents; the frame
        // it becomes watched again it resumes rendering.
        skipped.push(id);
        continue;
      }
      evaluated.push(id);
      this.framesDrawn.set(id, (this.framesDrawn.get(id) ?? 0) + 1);
      handle.surface.draw(ctx);
    }
    this.lastEvaluated = evaluated;
    this.lastSkipped = skipped;
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
    // Every present path funnels through this blit (OUTPUT cards + the 30+
    // on-card preview loops), so a blit IS the "something is showing this
    // node" signal for pull evaluation. Mark BEFORE the GL work so even a
    // throwing stub context (unit tests) records the observation.
    this.markWatched(nodeId);
    // Only OUTPUT-shaped modules (those with both an FBO texture AND no
    // declared video output port) make sense to blit. We don't enforce
    // the type check here — any module with a surface.texture can in
    // principle be visualized — but in practice only OUTPUT calls this
    // path. Sources / effects render their own outputs to FBOs anyway.
    const tex = handle.surface.texture;
    if (!tex) return;
    this.blitTexToDrawingBuffer(tex);
  }

  /**
   * Blit a SPECIFIC output PORT's texture into the drawing buffer — the per-port
   * sibling of blitOutputToDrawingBuffer (which only ever blits the primary
   * surface / video_out). A card previewing a NON-primary output inline
   * (VIDEOCUBE's on-card SLICE cross-section) calls this each rAF: it
   *   (a) REQUESTS the port be rendered even while it is UNPATCHED
   *       (requestOutputPreview → the module's per-port gate keeps drawing it), and
   *   (b) blits the port's current FBO texture to the drawing buffer so the card's
   *       Canvas2D `drawImage(engine.canvas)` can show it — no WebGL in the card,
   *       so the card stays OUT of the WebGL attest basis.
   * Resolves the texture by the same rule edge-routing uses
   * (`read('outputTexture:<portId>')`), falling back to the primary surface for a
   * module that doesn't expose a per-port texture. No-op if the node is absent.
   */
  blitOutputPortToDrawingBuffer(nodeId: string, portId: string): void {
    const handle = this.nodes.get(nodeId);
    if (!handle) return;
    // Mark watched + register the preview request BEFORE any GL work (stub-GL
    // safe, mirrors blitOutputToDrawingBuffer's ordering discipline).
    this.requestOutputPreview(nodeId, portId);
    const tex =
      (handle.read?.(`outputTexture:${portId}`) as WebGLTexture | null | undefined) ??
      handle.surface?.texture ??
      null;
    if (!tex) return;
    this.blitTexToDrawingBuffer(tex);
  }

  /** Register/refresh a short-lived request that `portId` of `nodeId` be rendered
   *  for an inline card preview even while the port is UNPATCHED (see
   *  previewPorts). Also marks the node watched so it stays in the pull-eval
   *  active set. */
  private requestOutputPreview(nodeId: string, portId: string): void {
    this.markWatched(nodeId);
    let m = this.previewPorts.get(nodeId);
    if (!m) { m = new Map(); this.previewPorts.set(nodeId, m); }
    m.set(portId, this.watchNow() + VideoEngine.WATCH_TTL_MS);
  }

  /** Shared drawing-buffer blit for {blitOutputToDrawingBuffer,
   *  blitOutputPortToDrawingBuffer}: pass-through copy `tex` fullscreen into the
   *  default framebuffer at the engine res. */
  private blitTexToDrawingBuffer(tex: WebGLTexture): void {
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
    // The cable is gone: return the param it was driving to the manual base
    // immediately, so the control isn't stuck at the last CV value. (The
    // per-frame stale sweep would also catch this a few frames later; this is
    // the snappy explicit path.) Skip if ANOTHER live bridge still drives the
    // same target param.
    const stillDriven = [...this.cvBridges.values()].some(
      (b) => b.targetNodeId === entry.targetNodeId && b.mapping.targetParamId === entry.mapping.targetParamId,
    );
    if (!stillDriven) this.restoreBase(entry.targetNodeId, entry.mapping.targetParamId);
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

  private tickVideoTextureBridges(activeSet: Set<string> | null = null): void {
    if (this.videoTextureBridges.size === 0) return;
    for (const bridge of this.videoTextureBridges.values()) {
      // Pull eval: the bridge's texture is only ever sampled by its TARGET
      // video node's draw — if that node is skipped this frame, the bridge
      // render would be unobservable work. (activeSet null = pull disabled.)
      if (activeSet && !activeSet.has(bridge.edge.target.nodeId)) continue;
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
      // E2E DETERMINISM hook (Layer-B render-smoke): when
      // `globalThis.__videoEnginePause` is true, the rAF loop IDLES — it keeps
      // re-scheduling (so it resumes on un-pause) but does NOT auto-advance
      // step(). A test that drives step() ITSELF then owns the EXACT frame count
      // (framesElapsed becomes a pure function of the test's step() calls, immune
      // to background rAF ticks — the critique's fix for `framesElapsed === N`).
      // Direct test step() calls are unaffected. Default-undefined → no effect.
      const paused = (globalThis as unknown as { __videoEnginePause?: boolean }).__videoEnginePause === true;
      if (!paused) this.step();
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

  /**
   * The set of `thisNodeId`'s output PORT ids that drive ≥1 downstream consumer
   * (per-port refinement of isOutputConnected — see VideoFrameContext). Cheap
   * O(edges + bridges); called once per frame by multi-output modules that skip
   * unrendered FBOs (COLOUR OF MAGIC). A fresh set each call so the caller can
   * never corrupt engine state.
   */
  private connectedOutputPorts(thisNodeId: string): ReadonlySet<string> {
    const ports = new Set<string>();
    for (const e of this.edges.values()) {
      if (e.source.nodeId === thisNodeId) ports.add(e.source.portId);
    }
    for (const b of this.videoTextureBridges.values()) {
      if (b.sourceNodeId === thisNodeId) ports.add(b.sourcePortId);
    }
    // Inline card previews of a NON-primary output (VIDEOCUBE's on-card SLICE)
    // request the port here so the module's per-port gate keeps rendering it
    // while it is unpatched. Prune expired requests inline (TTL-scoped) so a
    // closed/hidden card releases the port back to gated-off.
    const pv = this.previewPorts.get(thisNodeId);
    if (pv) {
      const now = this.watchNow();
      for (const [portId, exp] of pv) {
        if (exp >= now) ports.add(portId);
        else pv.delete(portId);
      }
      if (pv.size === 0) this.previewPorts.delete(thisNodeId);
    }
    return ports;
  }

  // -------- Shared GL helpers exposed to module factories --------

  /**
   * Build the per-factory context handed to a module. `ownerNodeId` (set in
   * addNode while the factory runs) attributes managed `createFbo()` outputs to
   * the right node so setResolution can resize them. The `res` object is the
   * engine's LIVE `_res` (same identity), so a module's per-frame reads track
   * the aspect switch automatically.
   */
  context(ownerNodeId?: string | null): VideoEngineContext {
    const owner = ownerNodeId ?? this.currentFactoryNodeId ?? null;
    return {
      gl: this.gl,
      res: this.res,
      wideActive: this.wideActive,
      compileFragment: (src) => this.compileFragmentImpl(src),
      createFbo: (opts) => this.createFboImpl(undefined, undefined, opts?.managed ?? true, owner),
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

  /**
   * Cross-domain bridge support (audio → video AUDIO INPUT). The INVERSE of
   * getAudioSource. Returns the AudioNode SINK + input index a video module
   * has published for the named `audio`-typed INPUT port (via
   * VideoNodeHandle.audioInputs), or null when the node isn't materialized
   * or doesn't declare an audio input for the port.
   *
   * The PatchEngine reads this when adding an audio→video edge whose target
   * port type is `audio` (RECORDERBOX's soundtrack capture) and connects the
   * upstream AudioEngine source's output into this sink.
   */
  getAudioInput(
    nodeId: string,
    portId: string,
  ): { node: AudioNode; input: number } | null {
    const handle = this.nodes.get(nodeId);
    if (!handle) return null;
    const dst = handle.audioInputs?.get(portId);
    return dst ?? null;
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

  /**
   * Allocate an RGBA8 FBO + texture. Defaults to the engine res; `managed`
   * (default true) registers it under `owner` so setResolution re-specs its
   * colour texture on an aspect switch. `owner` is the node whose factory is
   * minting it (createFbo passes the addNode-set current node id).
   */
  private createFboImpl(
    width: number = this.res.width,
    height: number = this.res.height,
    managed = true,
    owner: string | null = null,
  ): { fbo: WebGLFramebuffer; texture: WebGLTexture } {
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error('VideoEngine: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      width,
      height,
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
    // Register a managed FBO at engine res so setResolution can resize it. We
    // only register engine-res FBOs (the default w/h path): a managed FBO with
    // a non-engine size makes no sense (its size wouldn't track the switch).
    if (managed && owner && width === this.res.width && height === this.res.height) {
      let list = this.managedFbos.get(owner);
      if (!list) { list = []; this.managedFbos.set(owner, list); }
      list.push({ fbo, texture: tex });
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
