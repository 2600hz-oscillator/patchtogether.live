// packages/web/src/lib/video/modules/frametable.ts
//
// FRAMETABLE — a video WAVETABLE oscillator.
//
// FrameTable continuously records the last 60 rendered input frames into a GPU
// frame ring (a TEXTURE_2D_ARRAY, one layer per frame). A MORPH knob scans a
// centre point through that 60-frame history and a SPREAD knob sets how wide a
// window around that centre each pixel may draw from. For EVERY output pixel the
// shader draws exactly ONE source frame, chosen probabilistically from a bell
// distribution over the window (centre frame most likely, periphery least). The
// per-pixel choice is fixed in SCREEN space by a static per-pixel threshold, so a
// still input yields a stable image (no TV-static shimmer) while moving content
// becomes a coherent, morph-scannable time-smear mosaic. FREEZE stops the ring
// from advancing so you can scrub a held 60-frame window; SAVE snapshots the
// current 60-frame ring into an in-GPU slot for later recall (VideoCube-ready).
//
// ── Owner's HARD REQUIREMENTS (met — see frametable-core.ts for the CPU mirror) ─
//   1. WHOLE-PIXEL SELECTION, not a blend. Each fragment outputs exactly ONE
//      source frame's pixel (a dither/mosaic), never an alpha-average.
//   2. O(1) PER FRAGMENT. The per-pixel frame index comes from the analytic
//      triangular inverse-CDF (one sqrt + one branch + one array fetch), never a
//      60-frame loop/accumulation.
//   3. STILL-IMAGE CONSISTENCY. The per-pixel threshold is STATIC in screen space
//      (gl_FragCoord, no time/frame/head term) → a still input yields a stable
//      output even while unfrozen; moving content becomes a coherent morph-
//      scannable time-smear, NOT per-frame random static.
//
// ── Storage: one TEXTURE_2D_ARRAY, 60 layers, RGBA8, half-res (512×384 ≈ 45 MiB) ─
// GLSL ES 3.00 forbids dynamically indexing a sampler ARRAY, but a sampler2DArray
// with a per-pixel-computed float layer is exactly the primitive FrameTable needs
// (a per-PIXEL dynamic lag). WebGL2 is unconditional here (the shared engine
// context is webgl2), so TEXTURE_2D_ARRAY / texImage3D / framebufferTextureLayer /
// copyTexSubImage3D are all core. MAX_ARRAY_TEXTURE_LAYERS is spec-guaranteed ≥
// 256, so 60 layers is always safe (a full-res 8×8 atlas would be 8192×6144 — at/
// above MAX_TEXTURE_SIZE on many GPUs + the SwiftShader CI renderer).
//
// NOTE (owner): this def lives in the WebGL attest basis (resolveWebglBasis sweeps
// lib/video/). Its real shader/def flips computeWebglHash → a ONE-TIME re-attest on
// a trusted GPU is REQUIRED; the co-located docs below are wrapped in
// docs-hash-ignore markers so DOC edits stay hash-transparent. Look-affecting new
// shader — do NOT auto-merge (held for owner visual preview).
//
// Design + research: .myrobots/plans/frametable-2026-07-19.md

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import { detectEdge, makeEdgeState, type EdgeState } from '$lib/doom/cv-gate-edge';
import {
  FRAMETABLE_RING_FRAMES,
  FRAMETABLE_RENDER_SCALE,
  FRAMETABLE_BLUE_NOISE_SIZE,
} from '$lib/video/frametable-core';

// ----------------------------------------------------------------------
// Param model.
// ----------------------------------------------------------------------

interface FrametableParams {
  morph: number;       // 0..1 — centre lag through the 60-frame ring (wraps)
  spread: number;      // 1..60 — bell window width (frames)
  shimmer: number;     // 0..1 — temporal dither of the threshold (default 0 = static)
  weightShape: number; // 0 = triangular (default), 1 = gaussian
  freeze: number;      // 0/1 — user-facing FREEZE toggle (button-latched; OR'd with the freeze-gate LEVEL)
  // Hidden synthetic gate-state params (no card fader):
  freezeGate: number;  // raw freeze_gate LEVEL; ring is frozen WHILE this is high (OR'd with `freeze`)
  saveTrig: number;    // raw save_trig sample / momentary button; RISING edge → snapshot
}

const FRAMETABLE_DEFAULTS: FrametableParams = {
  morph: 0,
  spread: 12,
  shimmer: 0,
  weightShape: 0,
  freeze: 0,
  freezeGate: 0,
  saveTrig: 0,
};

const PARAM_IDS: ReadonlySet<string> = new Set(Object.keys(FRAMETABLE_DEFAULTS));

const N = FRAMETABLE_RING_FRAMES;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

// ----------------------------------------------------------------------
// GLSL — the two passes. Both transliterate the pure core in frametable-core.ts.
// ----------------------------------------------------------------------

// P0 — copy the live source frame into the ring layer at `head`.
const COPY_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform float uHas;
void main(){ outColor = vec4(uHas > 0.5 ? texture(uTex, vUv).rgb : vec3(0.0), 1.0); }`;

// P1 — the O(1) whole-pixel SELECT pass (the analytic inverse-CDF). One
// array fetch per fragment, no loop, no blend.
const SELECT_FRAG = `#version 300 es
precision highp float;
precision highp sampler2DArray;
in vec2 vUv;
out vec4 outColor;

uniform sampler2DArray uRing;   // 60 layers (one per recorded frame)
uniform vec2  uBlueNoiseSize;   // screen-space threshold tile period
uniform float uMorph;           // 0..1
uniform float uSpread;          // 1..60
uniform float uShimmer;         // 0..1 (0 = static)
uniform float uWeightShape;     // 0 = triangular, 1 = gaussian
uniform int   uHead;            // ring write head this frame (newest layer)
uniform int   uFrameIndex;      // only used when uShimmer > 0
uniform float uHasContent;      // 0 until the ring has captured a real frame
const float N = ${FRAMETABLE_RING_FRAMES}.0;
const float PI = 3.14159265359;

// Dave-Hoskins hash21 → [0,1). Mirrors frametable-core.hash21.
float hash21(vec2 p){
  vec3 p3 = fract(vec3(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Winitzki erf^-1 (a = 0.147) — gaussian "smooth" mode only.
float erfinv(float x){
  float a = 0.147;
  float ln = log(max(1e-12, 1.0 - x*x)); // ln(1-x^2) < 0
  float t1 = 2.0/(PI*a) + 0.5*ln;
  float t2 = ln/a;                       // negative -> t1*t1 - t2 > t1*t1
  float s = x < 0.0 ? -1.0 : 1.0;
  return s * sqrt(max(0.0, sqrt(t1*t1 - t2) - t1));
}

int wrapRing(float x){ float m = mod(x, N); if (m < 0.0) m += N; return int(m); }

void main(){
  if (uHasContent < 0.5){ outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec2 uv = vUv;

  // (1) STATIC per-pixel threshold — SCREEN space (gl_FragCoord), NEVER image UV,
  //     NEVER time/frame/head. This staticness is what gives still-image
  //     consistency (hard req #3). v1 uses a stable per-pixel HASH (screen-locked,
  //     tiled at uBlueNoiseSize).
  //     TODO(frametable): embed a 128x128 void-and-cluster blue-noise R8 tile
  //     (sampled here instead of the hash) for a tighter spatial histogram + less
  //     visible structure. The hash fully satisfies req #3; the tile is a QUALITY
  //     upgrade only. See .myrobots/plans/frametable-2026-07-19.md §4.
  vec2 bn = mod(gl_FragCoord.xy, uBlueNoiseSize);
  float t = hash21(floor(bn));

  // optional temporal shimmer (default 0 => fully static)
  if (uShimmer > 0.0)
    t = fract(t + uShimmer * fract(float(uFrameIndex) * 0.61803399)); // golden-ratio hop

  // (2) params -> geometry (lag space).
  float c = uMorph  * N;   // continuous centre lag (wraps)
  float h = 0.5 * uSpread; // triangular half-width == window half-width

  // (3) threshold -> offset. Triangular default; gaussian if uWeightShape >= 0.5.
  float d;
  if (uWeightShape < 0.5) {
    d = (t < 0.5) ? h * (sqrt(2.0 * t) - 1.0)
                  : h * (1.0 - sqrt(2.0 * (1.0 - t)));       // triangular inverse-CDF
  } else {
    float sigma = uSpread / 6.0;                             // h == 3 sigma
    float A = 0.00135;                                       // Phi(-3)
    float p = A + t * (1.0 - 2.0 * A);
    d = clamp(sigma * 1.41421356 * erfinv(2.0 * p - 1.0), -h, h);
  }

  // (4) centre lag + offset, wrap, then lag -> layer, round to nearest.
  float lag   = mod(c + d + N, N);
  float layer = mod(float(uHead) - lag, N);
  int   k     = wrapRing(layer + 0.5);   // +0.5 then floor == round

  // (5) sample that SINGLE frame at this pixel — ONE random-access fetch, no blend.
  outColor = vec4(texture(uRing, vec3(uv, float(k))).rgb, 1.0);
}`;

// ----------------------------------------------------------------------
// GL resource helpers (module-owned — the array + output are NOT engine-managed
// FBOs; ctx.createFbo() only mints auto-resizing TEXTURE_2D).
// ----------------------------------------------------------------------

/** A 60-layer RGBA8 TEXTURE_2D_ARRAY at (w×h). LINEAR, CLAMP on S/T/R. */
function createRingArray(gl: WebGL2RenderingContext, w: number, h: number, layers: number): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error('frametable: createTexture (ring array) failed');
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
  gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, w, h, layers, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  return tex;
}

/** A plain RGBA8 TEXTURE_2D render target (the SELECT output = surface.texture). */
function createTarget(gl: WebGL2RenderingContext, w: number, h: number): { fbo: WebGLFramebuffer; texture: WebGLTexture } {
  const tex = gl.createTexture();
  if (!tex) throw new Error('frametable: createTexture (output) failed');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer();
  if (!fbo) { gl.deleteTexture(tex); throw new Error('frametable: createFramebuffer failed'); }
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, texture: tex };
}

/** An in-GPU SAVE snapshot: a full copy of the 60-layer ring at the moment of
 *  save (VideoCube-ready — the Cube reads it through the handle's read() hook). */
interface RingSnapshot {
  tex: WebGLTexture; // TEXTURE_2D_ARRAY, `layers` deep
  layers: number;
  w: number;
  h: number;
  head: number;      // write head at save time = NEXT slot to write (oldest layer)
  newest: number;    // newest COMPLETED layer = (head-1+N)%N — matches the shader's uHead
}

export const frametableDef: VideoModuleDef = {
  type: 'frametable',
  palette: { top: 'Video modules', sub: 'Processors' },
  domain: 'video',
  label: 'frametable',
  category: 'effects',
  // The ring must keep FILLING even when unobserved: the 60-frame history reaches
  // BACK in time, so a gap from a paused-while-unwatched period would be a visible
  // seam the instant you MORPH back through it. pullExempt keeps the ring coherent.
  pullExempt: true,
  inputs: [
    { id: 'video_in', type: 'video' },
    // Continuous knobs → matching CV inputs (cvScale REQUIRED on type:'cv').
    { id: 'morph_cv',       type: 'cv', paramTarget: 'morph',       cvScale: { mode: 'linear' } },
    { id: 'spread_cv',      type: 'cv', paramTarget: 'spread',      cvScale: { mode: 'linear' } },
    { id: 'shimmer_cv',     type: 'cv', paramTarget: 'shimmer',     cvScale: { mode: 'linear' } },
    { id: 'weightShape_cv', type: 'cv', paramTarget: 'weightShape', cvScale: { mode: 'linear' } },
    // FREEZE gate — a MOMENTARY level hold (edge:'gate'): the ring is frozen WHILE
    // the gate is held HIGH, OR'd with the persistent button toggle. Routed to a
    // synthetic `freezeGate` param so the per-frame gate LEVEL never stomps the
    // button's latched `freeze`. SAVE trigger fires a one-shot snapshot on the
    // rising edge. Gate-typed → no cvScale.
    { id: 'freeze_gate', type: 'gate', edge: 'gate',    paramTarget: 'freezeGate' },
    { id: 'save_trig',   type: 'gate', edge: 'trigger', paramTarget: 'saveTrig'   },
  ],
  outputs: [{ id: 'video_out', type: 'video' }],
  params: [
    { id: 'morph',       label: 'morph',   defaultValue: FRAMETABLE_DEFAULTS.morph,       min: 0, max: 1,  curve: 'linear' },
    { id: 'spread',      label: 'spread',  defaultValue: FRAMETABLE_DEFAULTS.spread,      min: 1, max: 60, curve: 'linear' },
    { id: 'shimmer',     label: 'shimmer', defaultValue: FRAMETABLE_DEFAULTS.shimmer,     min: 0, max: 1,  curve: 'linear' },
    // weight-shape: 0 = triangular (default), 1 = gaussian ("smooth").
    { id: 'weightShape', label: 'shape',   defaultValue: FRAMETABLE_DEFAULTS.weightShape, min: 0, max: 1,  curve: 'linear' },
    // user-facing FREEZE toggle (button-latched; OR'd with the freeze_gate LEVEL to freeze).
    { id: 'freeze',      label: 'freeze',  defaultValue: FRAMETABLE_DEFAULTS.freeze,      min: 0, max: 1,  curve: 'linear' },
    // hidden synthetic gate-state params (no card fader).
    { id: 'freezeGate',  label: 'frz gate',defaultValue: FRAMETABLE_DEFAULTS.freezeGate,  min: 0, max: 1,  curve: 'linear' },
    { id: 'saveTrig',    label: 'save',    defaultValue: FRAMETABLE_DEFAULTS.saveTrig,    min: 0, max: 1,  curve: 'linear' },
  ],

  // docs-hash-ignore:start
  docs: {
    explanation:
      'FRAMETABLE is a video WAVETABLE oscillator. It continuously records the last 60 rendered input frames into a GPU frame ring (a TEXTURE_2D_ARRAY, one layer per frame), and treats that 60-frame history like the single-cycle waves of a wavetable synth: MORPH scans a centre point through the table and SPREAD sets how wide a window around that centre each pixel may draw from. For EVERY output pixel the shader draws exactly ONE source frame — a whole-pixel dither/mosaic, never an alpha-average across frames — chosen probabilistically from a bell distribution over the window (the centre frame most likely, the periphery least). The frame index is picked in O(1) by an analytic inverse-CDF (one sqrt, one branch, one array fetch — no 60-frame loop). The per-pixel choice is fixed in SCREEN space by a static per-pixel threshold with no time term, so a STILL input yields a stable image (no TV-static shimmer) even while the ring keeps refreshing, while MOVING content becomes a coherent, morph-scannable time-smear mosaic that scanning MORPH slides through like a soft crossfade. SPREAD 1 collapses to a single frame (a delta = crisp playback of one moment); wider SPREAD blends more of the history into the bell. SHAPE morphs the bell from triangular (default, compact) to gaussian (smooth). SHIMMER (default 0 = fully static) animates the threshold along a golden-ratio sequence for a gentle living grain on moving content while the time-averaged distribution stays the target bell. FREEZE (a toggle button, plus a freeze gate that holds the ring frozen while the gate is high) stops the ring from advancing so you can scrub a held 60-frame window with MORPH/SPREAD; SAVE (a momentary button, also a rising edge on the save trigger) snapshots the current 60-frame ring into an in-GPU slot for later recall (and to feed a future video Cube). Rendered at half engine resolution (SwiftShader/CI budget); an unpatched input renders black. The selection math (triangular/gaussian inverse-CDF, ring wrap, head→layer mapping, freeze/save reducers) is a 1:1 CPU mirror unit-tested in $lib/video/frametable-core. All ports live on the yellow drill-down PATCH PANEL (no raw side jacks).',
    inputs: {
      video_in: 'The source video recorded, frame by frame, into the 60-frame ring. Unpatched, the output is black.',
      morph_cv: 'CV that modulates MORPH (the centre point scanned through the 60-frame history), swept linearly over 0..1 (wraps at the ring seam).',
      spread_cv: 'CV that modulates SPREAD (the bell window width in frames), swept linearly over 1..60.',
      shimmer_cv: 'CV that modulates SHIMMER (temporal dither of the per-pixel threshold), swept linearly over 0..1.',
      weightShape_cv: 'CV that modulates SHAPE (the bell shape, triangular↔gaussian), swept linearly over 0..1.',
      freeze_gate: 'FREEZE gate. WHILE the gate is HELD HIGH (level >= 0.5) the ring is frozen — a momentary hold, with the output staying live over the held 60 frames — and it resumes the instant the gate drops low. OR-combined with the FREEZE toggle button, so either can freeze the ring independently.',
      save_trig: 'SAVE trigger. A RISING edge fires ONCE, snapshotting the current 60-frame ring into an in-GPU slot (idempotent per edge — held high does not re-snapshot).',
    },
    outputs: {
      video_out: 'The selected-frame mosaic: for every pixel, the single source frame chosen by the MORPH/SPREAD bell. The card preview shows this output.',
    },
    controls: {
      morph: 'MORPH (0..1, default 0): scans the centre point through the 60-frame ring (wraps at the seam). With moving content, sweeping MORPH slides the coherent time-smear through the history like a soft crossfade.',
      spread: 'SPREAD (1..60, default 12): the width of the bell window (in frames) each pixel may draw from. 1 = a single frame (a delta, crisp playback of one moment); wider blends more of the history, the centre frame still most likely.',
      shimmer: 'SHIMMER (0..1, default 0): temporal dither of the static per-pixel threshold along a golden-ratio (temporally blue-noise) sequence. 0 = fully static (still input → stable image). Low values add a gentle living grain to moving content; the time-averaged distribution stays the target bell.',
      weightShape: 'SHAPE (0..1, default 0): morphs the selection bell from triangular (0, compact) to gaussian (1, smooth). Triangular is compactly supported (the window IS the support); gaussian tapers within the same window.',
      freeze: 'FREEZE (0/1, default 0): stops the ring from advancing so the held 60-frame window can be scrubbed with MORPH/SPREAD (the select/output pass keeps running, so the controls stay live over the frozen frames). The toggle button latches it; the freeze gate additionally holds it frozen while that gate is high.',
      freezeGate: 'Hidden synthetic param the freeze-gate CV bridge writes each frame with the live gate LEVEL; while it is HIGH (>= 0.5) the ring is held frozen (OR-combined with the FREEZE toggle, so the per-frame level never stomps the button\'s latched state). Exposed only as the freeze gate jack, not as a knob.',
      saveTrig: 'Hidden synthetic param the SAVE momentary button sets and the save-trigger CV bridge writes; a RISING edge on it snapshots the current 60-frame ring into an in-GPU slot (idempotent per edge). Exposed only as the SAVE button + save trigger jack, not as a knob.',
    },
  },
  controlFamilies: [],
  // docs-hash-ignore:end

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;

    // Module-owned reduced-res resources (the module owns its own resize).
    let rw = Math.max(1, Math.round(ctx.res.width * FRAMETABLE_RENDER_SCALE));
    let rh = Math.max(1, Math.round(ctx.res.height * FRAMETABLE_RENDER_SCALE));

    let ringTex = createRingArray(gl, rw, rh, N);
    // One reusable framebuffer, retargeted per ring layer with framebufferTextureLayer.
    let ringFbo = gl.createFramebuffer();
    if (!ringFbo) throw new Error('frametable: createFramebuffer (ring) failed');
    let outTarget = createTarget(gl, rw, rh);

    // Clear every ring layer to black so an unwritten layer never samples garbage.
    function clearRing(): void {
      gl.bindFramebuffer(gl.FRAMEBUFFER, ringFbo);
      gl.viewport(0, 0, rw, rh);
      gl.clearColor(0, 0, 0, 1);
      for (let i = 0; i < N; i++) {
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, ringTex, 0, i);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    clearRing();

    // 1×1 black sentinel for the unpatched-input case (never bind a null sampler).
    const emptyTex = gl.createTexture();
    if (!emptyTex) throw new Error('frametable: createTexture (sentinel) failed');
    gl.bindTexture(gl.TEXTURE_2D, emptyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Deferred program compile (mandelbulb/mirrorpool CI discipline) + cached uniforms.
    let progs: { copy: WebGLProgram; select: WebGLProgram } | null = null;
    let u: {
      copyTex: WebGLUniformLocation | null; copyHas: WebGLUniformLocation | null;
      ring: WebGLUniformLocation | null; bnSize: WebGLUniformLocation | null;
      morph: WebGLUniformLocation | null; spread: WebGLUniformLocation | null;
      shimmer: WebGLUniformLocation | null; shape: WebGLUniformLocation | null;
      head: WebGLUniformLocation | null; frameIndex: WebGLUniformLocation | null;
      hasContent: WebGLUniformLocation | null;
    } | null = null;
    let glFailed = false;
    function ensurePrograms(): boolean {
      if (progs) return true;
      if (glFailed) return false;
      try {
        const copy = ctx.compileFragment(COPY_FRAG);
        const select = ctx.compileFragment(SELECT_FRAG);
        progs = { copy, select };
        u = {
          copyTex: gl.getUniformLocation(copy, 'uTex'),
          copyHas: gl.getUniformLocation(copy, 'uHas'),
          ring: gl.getUniformLocation(select, 'uRing'),
          bnSize: gl.getUniformLocation(select, 'uBlueNoiseSize'),
          morph: gl.getUniformLocation(select, 'uMorph'),
          spread: gl.getUniformLocation(select, 'uSpread'),
          shimmer: gl.getUniformLocation(select, 'uShimmer'),
          shape: gl.getUniformLocation(select, 'uWeightShape'),
          head: gl.getUniformLocation(select, 'uHead'),
          frameIndex: gl.getUniformLocation(select, 'uFrameIndex'),
          hasContent: gl.getUniformLocation(select, 'uHasContent'),
        };
      } catch { glFailed = true; return false; }
      return true;
    }

    // Merge stored params over defaults (strip stray keys).
    const raw = node.params as Record<string, unknown>;
    const filtered: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) if (PARAM_IDS.has(k) && typeof v === 'number') filtered[k] = v;
    const params: FrametableParams = { ...FRAMETABLE_DEFAULTS, ...(filtered as Partial<FrametableParams>) };

    let head = 0;
    let framesElapsed = 0;
    let capturedAny = false;

    // Edge state: save-trig rising edge SNAPSHOTS (cv-gate-edge hysteresis
    // detector). FREEZE is a level-read (frozen while the gate is high), no edge.
    const saveEdge: EdgeState = makeEdgeState();

    // In-GPU SAVE-slot registry (VideoCube-ready). v1: a single default slot,
    // overwritten each save (the old texture is freed). The named-slot picker is
    // a documented follow-up.
    const snapshots = new Map<string, RingSnapshot>();
    const DEFAULT_SLOT = 'default';

    /** Snapshot the live 60-layer ring into a fresh array (copyTexSubImage3D per
     *  layer). Idempotent per SAVE rising edge (the edge detector gates the call). */
    function snapshotRing(slot: string = DEFAULT_SLOT): void {
      const snapTex = createRingArray(gl, rw, rh, N);
      const readFbo = gl.createFramebuffer();
      if (!readFbo) { gl.deleteTexture(snapTex); return; }
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, readFbo);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, snapTex);
      for (let i = 0; i < N; i++) {
        gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, ringTex, 0, i);
        gl.copyTexSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, 0, 0, rw, rh);
      }
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.deleteFramebuffer(readFbo);
      const prev = snapshots.get(slot);
      if (prev) gl.deleteTexture(prev.tex);
      snapshots.set(slot, { tex: snapTex, layers: N, w: rw, h: rh, head, newest: (head - 1 + N) % N });
    }

    const surface: VideoNodeSurface = {
      fbo: outTarget.fbo,
      texture: outTarget.texture,
      draw(frame) {
        if (!ensurePrograms() || !progs || !u) return;
        const g = frame.gl;

        // SAVE: fire ONCE per rising edge of saveTrig (idempotent per edge).
        if (detectEdge(saveEdge, params.saveTrig)?.pressed === true) snapshotRing();

        // Frozen while the button toggle is latched OR the freeze gate is held high.
        const frozen = params.freeze >= 0.5 || params.freezeGate >= 0.5;
        const inputTex = frame.getInputTexture(node.id, 'video_in');

        // ── P0: SELECT — one whole-pixel frame per fragment (O(1) inverse-CDF). ──
        // Sample the ring as written by PRIOR frames: the newest FULLY-WRITTEN layer
        // is (head-1) mod N. We deliberately do NOT treat the layer captured THIS
        // frame as newest — sampling an array layer in the SAME draw it was rendered
        // into is a same-frame read-after-write that ANGLE/some drivers return as
        // undefined/black (it read all-black at spread=1 on Chromium). Selecting
        // BEFORE the capture makes every sampled layer a completed prior write, and
        // costs one imperceptible frame of "newest" latency.
        const newestHead = (head - 1 + N) % N;
        g.bindFramebuffer(g.FRAMEBUFFER, outTarget.fbo);
        g.viewport(0, 0, rw, rh);
        g.useProgram(progs.select);
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D_ARRAY, ringTex);
        g.uniform1i(u.ring, 0);
        g.uniform2f(u.bnSize, FRAMETABLE_BLUE_NOISE_SIZE, FRAMETABLE_BLUE_NOISE_SIZE);
        g.uniform1f(u.morph, clamp01(params.morph));
        g.uniform1f(u.spread, clamp(params.spread, 1, N));
        g.uniform1f(u.shimmer, clamp01(params.shimmer));
        g.uniform1f(u.shape, clamp01(params.weightShape));
        g.uniform1i(u.head, newestHead);
        g.uniform1i(u.frameIndex, frame.frame | 0);
        g.uniform1f(u.hasContent, capturedAny ? 1 : 0);
        ctx.drawFullscreenQuad();

        // ── P1: CAPTURE live input → ring[head] (unless FROZEN), then advance. The
        //        just-captured frame becomes the newest for the NEXT draw's select. ──
        if (!frozen) {
          g.bindFramebuffer(g.FRAMEBUFFER, ringFbo);
          g.framebufferTextureLayer(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, ringTex, 0, head);
          g.viewport(0, 0, rw, rh);
          g.useProgram(progs.copy);
          g.activeTexture(g.TEXTURE0);
          // NEVER bind the ring layer we write as a sampler (GL feedback loop);
          // the copy reads the upstream input (or the black sentinel).
          g.bindTexture(g.TEXTURE_2D, inputTex ?? emptyTex);
          g.uniform1i(u.copyTex, 0);
          g.uniform1f(u.copyHas, inputTex ? 1 : 0);
          ctx.drawFullscreenQuad();
          if (inputTex) capturedAny = true;
          head = (head + 1) % N;
          framesElapsed++;
        }

        g.bindFramebuffer(g.FRAMEBUFFER, null);
      },
      resize(w, h) {
        gl.deleteTexture(ringTex);
        gl.deleteFramebuffer(outTarget.fbo);
        gl.deleteTexture(outTarget.texture);
        rw = Math.max(1, Math.round(w * FRAMETABLE_RENDER_SCALE));
        rh = Math.max(1, Math.round(h * FRAMETABLE_RENDER_SCALE));
        ringTex = createRingArray(gl, rw, rh, N);
        outTarget = createTarget(gl, rw, rh);
        clearRing();
        head = 0; framesElapsed = 0; capturedAny = false;
        surface.fbo = outTarget.fbo;
        surface.texture = outTarget.texture;
      },
      dispose() {
        gl.deleteTexture(ringTex);
        gl.deleteFramebuffer(ringFbo);
        gl.deleteFramebuffer(outTarget.fbo);
        gl.deleteTexture(outTarget.texture);
        gl.deleteTexture(emptyTex);
        for (const snap of snapshots.values()) gl.deleteTexture(snap.tex);
        snapshots.clear();
        if (progs) { gl.deleteProgram(progs.copy); gl.deleteProgram(progs.select); }
      },
    };

    return {
      domain: 'video',
      surface,
      setParam(paramId, value) {
        // freezeGate is the live gate LEVEL (read as-is in draw); no edge here.
        if (paramId in params) (params as unknown as Record<string, number>)[paramId] = value;
      },
      readParam(paramId) {
        return (params as unknown as Record<string, number>)[paramId];
      },
      read(key) {
        // Canonical output (also surface.texture for single-texture consumers).
        if (key === 'outputTexture:video_out' || key === 'fboTexture') return surface.texture;
        // VideoCube readiness: the live ring + a saved snapshot slot, readable
        // through the shared GL context so a Cube face can page through the table.
        // `newest` is the newest COMPLETED layer (matches the shader's uHead); `head`
        // is the raw write head (the NEXT slot to write = OLDEST layer), so a consumer
        // that wants "the latest frame" must use `newest`, not `head`.
        if (key === 'ringLive') return { tex: ringTex, layers: N, w: rw, h: rh, head, newest: (head - 1 + N) % N };
        if (typeof key === 'string' && key.startsWith('ringSnapshot:')) {
          return snapshots.get(key.slice('ringSnapshot:'.length));
        }
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
