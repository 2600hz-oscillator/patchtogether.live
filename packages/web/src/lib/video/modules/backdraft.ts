// packages/web/src/lib/video/modules/backdraft.ts
//
// BACKDRAFT — video feedback generator.
//
// A "source" image is crossfaded between two video inputs (in_a / in_b)
// by MIX, then composited with a PROCESSED copy of BACKDRAFT's OWN
// previous output. The fed-back frame is delayed by a frame-ring tap
// (DELAY, 0..500ms), colour-processed (LUMA / CHROMA / per-channel R/G/B
// gain, each -100%..+200%), and scaled per-pixel by two key masks
// (LIGHTEN boosts the feedback effect where bright, DARKEN reduces it).
//
// ── Feedback loop + 1-frame lag ───────────────────────────────────────
// Like FEEDBACK / VDELAY, we resolve the cycle internally: BACKDRAFT
// reads its OWN previous output from a ring of FBO textures it wrote on
// past frames — never sampling the texture it's writing this frame (no
// GL feedback loop). The published surface.texture is the just-written
// output, so downstream modules see frame N while BACKDRAFT's feedback
// tap reads frame N-1..N-30. This is the same 1-frame-lag cycle the
// engine's topo fallback tolerates (id-order on cycles).
//
// ── DELAY as a frame ring ─────────────────────────────────────────────
// We keep a ring of recent OUTPUT frames (BUFFER_FRAMES). DELAY is
// a knob in milliseconds (0..500). At ~60fps, 500ms ≈ 30 frames; we size
// the ring to MAX_DELAY_FRAMES+slop. The tap is NEAREST-frame:
// frames = round(delayMs / 1000 * 60), clamped to [1, ring-1] (always at
// least 1 so feedback genuinely lags and we never read the slot we're
// about to overwrite). No interpolation — nearest is visually
// indistinguishable at video rate and keeps the shader to one sample.
//
// ── Colour math on the fed-back frame ────────────────────────────────
//   * Per-channel R/G/B gain: rgb *= vec3(R, G, B). 1.0 = neutral.
//   * LUMA gain: scales the pixel's overall brightness about black:
//       rgb *= luma (so >1 brightens, <1 darkens, <0 inverts-ish).
//   * CHROMA gain: scales SATURATION about the pixel's own luma:
//       rgb = lum + (rgb - lum) * chroma   (1.0 = neutral, 0 = greyscale,
//       2.0 = double saturation, <0 = hue-inverted). "Chroma" here means
//       colourfulness/saturation gain (resolved ambiguity — see report).
//   Order: per-channel gain → luma → chroma. All three default to 1.0.
//
// ── Mask combine (LIGHTEN / DARKEN) ───────────────────────────────────
// Each mask is a key (black = no effect, sentinel when unpatched). The
// per-pixel feedback EFFECT scale is the additive, order-independent:
//
//   effectScale = clamp(1 + lightenKnob*lightenMask - darkenKnob*darkenMask,
//                       0, MAX_EFFECT_SCALE)
//
// LIGHTEN turns the feedback UP where its mask is bright; DARKEN turns it
// DOWN where its mask is bright; a pixel in BOTH gets both contributions
// (they cancel/stack additively, independent of order). Knobs are 0..1.
//
//   feedbackContribution = processedFedBack * FEEDBACK * effectScale
//   out = clamp(source + feedbackContribution, 0, 1)
//
// FEEDBACK max is 2.0 (>1 allowed for runaway trails; bounded so a hot
// source + max feedback can't NaN the accumulator — the shader clamps to
// [0,1] each frame anyway).
//
// ── SPATIAL FEEDBACK TRANSFORM (the tunnel/spiral/trail maker) ─────────
// The classic video-feedback look (zooming tunnels, spiralling echoes,
// directional smear) comes from geometrically transforming the fed-back
// frame a LITTLE each iteration so the transform COMPOUNDS over the
// feedback loop. We apply a per-iteration affine to the feedback tap's UV
// (NOT the source): before sampling ring[head - delayFrames], we map the
// current UV back through the inverse of "zoom about centre, rotate about
// centre, then translate". Sampling the PREVIOUS output through this map
// means each surviving echo is re-zoomed/re-rotated/re-shifted again every
// frame, so after N iterations a pixel has been transformed N times → a
// deep tunnel / long spiral / long trail.
//
//   ZOOM    — scale of the fed-back frame about its centre. Neutral 1.0.
//             <1 makes the echo SMALLER each pass → it recedes toward the
//             centre → an OUTWARD/expanding tunnel; >1 makes it LARGER →
//             it grows past the edges → an INWARD/zooming-in tunnel.
//   ROTATE  — degrees per iteration about the centre (signed). Combined
//             with ZOOM≠1 the receding/growing echoes also twist → spiral.
//   OFFSET X/Y — translation of the fed-back frame (signed, UV units).
//             A constant shift each pass → a directional trail/smear.
//
// All four default to the IDENTITY transform (zoom 1, rotate 0, offset 0),
// so at defaults the feedback tap samples 1:1 exactly as before and ALL
// prior BACKDRAFT behaviour is unchanged.
//
// We sample with CLAMP_TO_EDGE on the ring textures so UVs pushed past the
// frame edge by the transform read the edge pixel (the tunnel reads cleanly
// — no wrap-around tiling, no black seam mid-frame).
//
// ── FREEZE (VRT determinism) ──────────────────────────────────────────
// `freeze` param (0/1): when >=0.5, draw() is a no-op — the ring + output
// hold their last contents, so the on-card / output pixels are stable
// across rAF ticks. Feedback is time-evolving by nature; the VRT scene
// settles the loop, then sets freeze=1 to pin a deterministic frame.
//
// Inputs:
//   in_a / in_b (video): two RGB sources crossfaded by MIX.
//   lighten / darken (video): per-pixel mask sources for LIGHTEN/DARKEN scaling.
//   mix (cv, linear, paramTarget=mix): displaces MIX crossfade.
//   feedback (cv, linear, paramTarget=feedback): displaces feedback ratio.
//   delay (cv, linear, paramTarget=delay): displaces delay in ms.
//   delay_clock (cv, paramTarget=delayClock): rising-edge clock-locked delay.
//   luma / chroma (cv, linear, paramTarget=…): per-channel feedback colour CV.
//   r / g / b (cv, linear, paramTarget=…): per-channel feedback gain CV (-1..2).
//   lighten_cv / darken_cv (cv, linear, paramTarget=…): displaces mask amounts.
//   pixelate (cv, linear, paramTarget=pixelate): displaces the PIXELATE amount.
//   zoom / rotate / offsetx / offsety (cv, linear, paramTarget=…): affine-warp CV.
//   mirror_x_gate / mirror_y_gate (cv, paramTarget=…Gate): rising edge toggles mirror.
//
// Outputs:
//   out (video): the feedback-rendered output.
//
// Params:
//   mix (linear 0..1): crossfade between in_a (0) and in_b (1).
//   feedback (linear 0..BACKDRAFT_MAX_FEEDBACK): per-frame feedback ratio.
//   delay (linear 0..BACKDRAFT_MAX_DELAY_MS): tap delay in ms.
//   luma / chroma (linear -1..2): feedback luma / chroma gain (negative inverts).
//   r / g / b (linear -1..2): per-channel feedback gain.
//   lighten / darken (linear 0..1): per-pixel scaling-mask amounts.
//   pixelate (linear 0..1): reduce the SOURCE resolution (0 = identity, 1 = 1 cell).
//   zoom (linear BACKDRAFT_ZOOM_MIN..MAX): per-pass zoom on the feedback tap.
//   rotate (linear BACKDRAFT_ROTATE_MIN..MAX): per-pass rotation.
//   offsetX / offsetY (linear BACKDRAFT_OFFSET_MIN..MAX): per-pass translation.
//   delayClock (linear 0..1): persisted clock-locked-delay state.
//   mirrorX / mirrorY (linear 0..1): horizontal / vertical mirror toggles.
//   mirrorXGate / mirrorYGate (linear 0..1): persisted edge-state for the mirror-gate inputs.
//   freeze (linear 0..1): ≥0.5 pins the ring + output (for VRT deterministic capture).

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import { detectEdge, makeEdgeState, type EdgeState } from '$lib/doom/cv-gate-edge';

/** Assumed engine frame rate for the ms→frames delay mapping. The engine
 *  drives one step per rAF (~60fps); we document nearest-frame semantics. */
export const BACKDRAFT_FPS = 60;
/** Max DELAY knob value in milliseconds. */
export const BACKDRAFT_MAX_DELAY_MS = 500;
/** Ring depth: enough frames to cover MAX_DELAY_MS at FPS, plus headroom
 *  so the tap (>=1 behind head) never aliases the slot we overwrite.
 *  At 60fps, 500ms = 30 frames; +1 slot so the deepest tap (30) is still
 *  < ringSize and never aliases the head we're writing. = 31. Each slot is
 *  a full-res FBO+texture, so this is the VRAM cap: exactly what 500ms
 *  needs at 60fps, no more (we do not over-allocate beyond 500ms). */
export const BACKDRAFT_BUFFER_FRAMES =
  Math.ceil((BACKDRAFT_MAX_DELAY_MS / 1000) * BACKDRAFT_FPS) + 1; // = 31
/** Upper bound on the per-pixel feedback effect scale after mask combine.
 *  (Unrelated to the clock; kept where it was.) */
export const BACKDRAFT_MAX_EFFECT_SCALE = 4;

/** When a DELAY CLOCK is patched, the feedback delay tracks ONE clock-pulse
 *  duration (the interval between the last two rising edges). The max
 *  response is BACKDRAFT_MAX_DELAY_MS = 500ms, which is exactly one beat at
 *  120 BPM (60000/120 = 500). Slower clocks (period > 500ms) cap there;
 *  faster clocks shorten the delay proportionally. This is the same cap the
 *  DELAY knob uses, so the ring (sized for 500ms) always holds it. */
export const BACKDRAFT_CLOCK_BPM_AT_MAX = 120;
/** FEEDBACK knob ceiling (>1 = runaway trails). */
export const BACKDRAFT_MAX_FEEDBACK = 2.0;

/** Normalised FEEDBACK (feedback / BACKDRAFT_MAX_FEEDBACK) at which the
 *  hall-of-mirrors blend begins. Below it the composite is the classic
 *  additive accumulator (trails/echoes) unchanged; from here up to 1.0
 *  (max FEEDBACK) it ramps to a PURE recursive hall of mirrors — the live
 *  source confined to the new ring, the interior pure feedback (mirrors the
 *  TUNNEL fix in toybox.ts). 0.7 → the top ~third of the slider ramps in;
 *  the default feedback (0.85 → norm 0.425) stays fully additive. */
export const BACKDRAFT_HALL_LO = 0.7;

/** Spatial-transform knob ranges (per feedback iteration). A small
 *  deviation compounds over the loop into a strong tunnel/spiral/trail. */
export const BACKDRAFT_ZOOM_MIN = 0.8;
export const BACKDRAFT_ZOOM_MAX = 1.2;
/** ROTATE in degrees per iteration (signed). */
export const BACKDRAFT_ROTATE_MIN = -30;
export const BACKDRAFT_ROTATE_MAX = 30;
/** OFFSET X/Y in UV units per iteration (signed). 0.1 = 10% of the frame. */
export const BACKDRAFT_OFFSET_MIN = -0.1;
export const BACKDRAFT_OFFSET_MAX = 0.1;

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uA;        // in_a
uniform sampler2D uB;        // in_b
uniform sampler2D uFb;       // delayed previous OUTPUT (the feedback tap)
uniform sampler2D uLighten;  // lighten key mask
uniform sampler2D uDarken;   // darken key mask
uniform float uHasA;
uniform float uHasB;
uniform float uHasFb;
uniform float uHasLighten;
uniform float uHasDarken;

uniform float uMix;        // 0..1 crossfade in_a -> in_b
uniform float uFeedback;   // 0..2.0 overall feedback amount
uniform float uLuma;       // -1..+2 luma gain   (1 = neutral)
uniform float uChroma;     // -1..+2 chroma/sat  (1 = neutral)
uniform float uR;          // -1..+2 red gain
uniform float uG;          // -1..+2 green gain
uniform float uBlue;       // -1..+2 blue gain
uniform float uLightenKnob; // 0..1
uniform float uDarkenKnob;  // 0..1

// Spatial feedback transform (applied to the feedback tap's UV only).
uniform float uZoom;        // scale about centre (1 = identity)
uniform float uCos;         // cos(rotate), precomputed on CPU
uniform float uSin;         // sin(rotate), precomputed on CPU
uniform float uOffX;        // UV translation x (per iteration)
uniform float uOffY;        // UV translation y (per iteration)

// MIRROR X / MIRROR Y — kaleidoscope fold on the FINAL OUTPUT sampling.
// 1.0 = on, 0.0 = off. Applied to the output UV (vUv) before everything
// else, so the whole composited frame is folded (the displayed content
// is mirrored, not just one input).
uniform float uMirrorX;
uniform float uMirrorY;

// PIXELATE — reduce the resolution of the SOURCE (in_a/in_b) sampling.
// 0 = identity (no snapping, bit-exact), rising = blockier, 1 = the whole
// frame collapses to a single 1×1 cell (one averaged/representative colour).
// uRes is the source resolution in cells at pixelate=0 (so pixelate≈0 ≈ 1:1).
uniform float uPixelate; // 0..1
uniform float uRes;      // source resolution in cells (e.g. fbo width)

const float MAX_EFFECT_SCALE = ${BACKDRAFT_MAX_EFFECT_SCALE.toFixed(1)};

float luma(vec3 c) {
  return dot(c, vec3(0.299, 0.587, 0.114));
}

// Map an output UV to the FEEDBACK-TAP UV. The forward "look" of the
// transform is: take the previous frame, ZOOM it about centre, ROTATE it
// about centre, then OFFSET it. To find which source pixel lands at this
// output pixel we invert that: undo offset, then un-rotate + un-scale about
// the centre. (zoom>1 => we sample a SMALLER region around centre => the
// echo appears magnified next frame => zoom-in tunnel.)
vec2 feedbackUv(vec2 uv) {
  vec2 p = uv - vec2(0.5);          // centre-relative
  p -= vec2(uOffX, uOffY);          // undo translation
  // undo rotation (rotate by -theta): R(-t) = [[cos, sin], [-sin, cos]]
  vec2 r = vec2(p.x * uCos + p.y * uSin,
               -p.x * uSin + p.y * uCos);
  r /= max(uZoom, 1e-4);            // undo zoom about centre
  return r + vec2(0.5);
}

// MIRROR fold on the OUTPUT sampling UV. MIRROR X folds the LEFT half over
// the right (right half becomes a mirror of the left): keep uv.x<0.5, map
// the right half to (1.0 - uv.x). MIRROR Y folds the visual TOP half into the
// bottom. With this repo's full backdraft→videoOut→canvas chain, sampling
// uv.y maps so that the VISUAL TOP corresponds to uv.y>=0.5 (verified by
// e2e: keeping uv.y<0.5 kept the bottom). So to keep the visual TOP we KEEP
// uv.y>=0.5 and reflect the low half via (1.0 - uv.y). Both on = a 4-way
// (quadrant) fold = classic kaleidoscope.
vec2 mirrorUv(vec2 uv) {
  if (uMirrorX > 0.5) uv.x = uv.x < 0.5 ? uv.x : (1.0 - uv.x);
  if (uMirrorY > 0.5) uv.y = uv.y >= 0.5 ? uv.y : (1.0 - uv.y);
  return uv;
}

void main() {
  // Mirror fold applied to the FINAL output sampling UV — folds the whole
  // composited frame (source + feedback), so the DISPLAYED content mirrors.
  vec2 uv = mirrorUv(vUv);

  // PIXELATE — snap the SOURCE sampling UV to a coarse grid BEFORE sampling
  // in_a/in_b, reducing the input's effective resolution. The
  // "if (uPixelate > 0.0)" gate is LOAD-BEARING: at PIXELATE=0 we do NOT snap,
  // so the source sampling is bit-identical to the original. As PIXELATE rises
  // the grid coarsens from uRes cells down to 1 cell; at 1.0 the whole frame
  // collapses to a single cell (one representative colour). Applied to the
  // source UV only — the feedback tap + masks keep their own UVs.
  vec2 srcUv = uv;
  if (uPixelate > 0.0) {
    float cells = max(1.0, mix(uRes, 1.0, clamp(uPixelate, 0.0, 1.0)));
    srcUv = (floor(srcUv * cells) + 0.5) / cells; // snap to cell centres
  }

  // Source = crossfade of the two inputs (zero where unpatched).
  vec3 a = uHasA > 0.5 ? texture(uA, srcUv).rgb : vec3(0.0);
  vec3 b = uHasB > 0.5 ? texture(uB, srcUv).rgb : vec3(0.0);
  vec3 source = mix(a, b, clamp(uMix, 0.0, 1.0));

  // Fed-back frame (delayed previous output), sampled through the spatial
  // feedback transform so the geometry COMPOUNDS over iterations (tunnels /
  // spirals / trails). CLAMP_TO_EDGE on the ring textures keeps UVs pushed
  // past the edge reading the edge pixel. Zero on cold start.
  vec2 fbUv = feedbackUv(uv);
  vec3 fb = uHasFb > 0.5 ? texture(uFb, fbUv).rgb : vec3(0.0);

  // Per-channel gain.
  fb *= vec3(uR, uG, uBlue);
  // Luma gain about black.
  fb *= uLuma;
  // Chroma (saturation) gain about the pixel's own luma.
  float l = luma(fb);
  fb = vec3(l) + (fb - vec3(l)) * uChroma;

  // Mask combine — additive, order-independent. Masks read as luma so a
  // colour mask still keys on brightness. Unpatched mask => 0 (neutral).
  float lm = uHasLighten > 0.5 ? luma(texture(uLighten, uv).rgb) : 0.0;
  float dm = uHasDarken  > 0.5 ? luma(texture(uDarken,  uv).rgb) : 0.0;
  float effectScale = clamp(
    1.0 + uLightenKnob * lm - uDarkenKnob * dm,
    0.0, MAX_EFFECT_SCALE);

  // ── ADDITIVE accumulator — the classic trail/echo generator. The live
  // SOURCE is re-injected at full strength on EVERY pixel, so for the bulk of
  // the FEEDBACK range you get bright building trails. The drawback at the TOP
  // of the range: the flat source floods the whole interior, so you never get a
  // true recursive hall of mirrors (the same problem TUNNEL had before its
  // ring-gated rewrite).
  vec3 contribution = fb * uFeedback * effectScale;
  vec3 additive = source + contribution;

  // ── HALL OF MIRRORS — engaged as FEEDBACK approaches its max. Source enters
  // ONLY in the new ring (the band the spatial transform vacates — exactly
  // where the feedback tap reads OUTSIDE the previous frame); the interior is
  // PURE recursive feedback (previous frame re-sampled through the transform at
  // near-unity persistence). Zero flat source in the interior → a complete
  // hall of mirrors at full FEEDBACK. This mirrors toybox.ts's TUNNEL fix
  // (ring ? src : mirror), generalised to BACKDRAFT's full affine tap.
  //
  // GUARD: a hall of mirrors needs a recursive geometry. With the default
  // IDENTITY transform (zoom 1, no rotate/offset) the tap covers the whole
  // frame so NO ring exists; squeezing the source out would just decay to
  // black. So the hall only engages when a spatial transform is present — at
  // identity we keep the additive accumulator regardless of FEEDBACK.
  bool hasTransform =
    abs(uZoom - 1.0) > 1e-3 || abs(uOffX) > 1e-4 ||
    abs(uOffY) > 1e-4 || abs(uSin) > 1e-4;
  float fbNorm = clamp(uFeedback / ${BACKDRAFT_MAX_FEEDBACK.toFixed(1)}, 0.0, 1.0);
  // Ramp the hall in over the TOP of the slider (smoothstep from BACKDRAFT_HALL_LO
  // to 1.0); full hall exactly at max FEEDBACK, additive untouched below.
  float hallAmt = hasTransform
    ? smoothstep(${BACKDRAFT_HALL_LO.toFixed(2)}, 1.0, fbNorm)
    : 0.0;

  // Ring = the feedback tap left the previous frame.
  bool inRing = fbUv.x < 0.0 || fbUv.x > 1.0 || fbUv.y < 0.0 || fbUv.y > 1.0;
  // Persistence < 1 so the nest recedes into depth without blowing out (TUNNEL
  // uses uDecay for this). Masks (effectScale) still modulate it — darken can
  // blank a region of the hall, lighten deepens it — but it's clamped < 1.
  float hallGain = clamp(mix(0.90, 0.985, fbNorm) * effectScale, 0.0, 0.985);
  vec3 hall = inRing ? source : fb * hallGain;

  vec3 outc = mix(additive, hall, hallAmt);
  outColor = vec4(clamp(outc, 0.0, 1.0), 1.0);
}`;

export interface BackdraftParams {
  mix: number;       // 0..1
  feedback: number;  // 0..BACKDRAFT_MAX_FEEDBACK
  delay: number;     // 0..BACKDRAFT_MAX_DELAY_MS (ms, default 500)
  delayClock: number; // raw DELAY CLOCK gate sample (0..1). Synthetic param
                      // the gate-style CV bridge writes; the module
                      // edge-detects it. Not a user knob (no card control).
  luma: number;      // -1..+2
  chroma: number;    // -1..+2
  r: number;         // -1..+2
  g: number;         // -1..+2
  b: number;         // -1..+2
  lighten: number;   // 0..1
  darken: number;    // 0..1
  pixelate: number;  // 0..1 — reduce source resolution (0 = identity, 1 = 1 cell)
  // Spatial feedback transform (per iteration). Defaults = identity.
  zoom: number;      // BACKDRAFT_ZOOM_MIN..MAX (1 = no tunnel)
  rotate: number;    // BACKDRAFT_ROTATE_MIN..MAX degrees (0 = no spiral)
  offsetX: number;   // BACKDRAFT_OFFSET_MIN..MAX (0 = no trail)
  offsetY: number;   // BACKDRAFT_OFFSET_MIN..MAX (0 = no trail)
  // MIRROR kaleidoscope fold (0/1). Buttons toggle these; a rising edge on
  // the matching gate input also FLIPS them. Default off (identity).
  mirrorX: number;   // 0/1 — fold left half over right
  mirrorY: number;   // 0/1 — fold top half over bottom
  // Synthetic gate params the mirror_x_gate / mirror_y_gate CV bridge
  // writes (raw 0..1 swing). Hidden — no card knob; the module edge-detects
  // a rising edge to FLIP mirrorX / mirrorY.
  mirrorXGate: number; // 0..1 raw gate sample
  mirrorYGate: number; // 0..1 raw gate sample
  freeze: number;    // 0/1 (VRT determinism)
}

const DEFAULTS: BackdraftParams = {
  mix: 0.5,
  feedback: 0.85,
  delay: 16,    // ~1 frame at 60fps — a tight, lively trail by default
  delayClock: 0, // gate idles low; only meaningful while DELAY CLOCK patched
  luma: 1.0,
  chroma: 1.0,
  r: 1.0,
  g: 1.0,
  b: 1.0,
  lighten: 1.0,
  darken: 1.0,
  // PIXELATE neutral = 0 → no resolution reduction (identity source sampling).
  pixelate: 0,
  // Spatial transform neutral = identity (no tunnel/spiral/trail) so the
  // out-of-box behaviour matches the original 1:1 feedback tap exactly.
  zoom: 1.0,
  rotate: 0,
  offsetX: 0,
  offsetY: 0,
  // Mirror fold OFF by default → identity output (unchanged behaviour).
  mirrorX: 0,
  mirrorY: 0,
  mirrorXGate: 0,
  mirrorYGate: 0,
  freeze: 0,
};

/**
 * Pure DELAY-knob → ring-tap-frame mapping. NEAREST-frame: round the ms
 * delay to whole frames at BACKDRAFT_FPS, then clamp to [1, ringSize-1]
 * so the tap always lags by at least one frame and never aliases the
 * head slot we're about to overwrite. Exported for unit tests + the
 * draw() tap math share one source of truth.
 */
export function backdraftDelayFrames(
  delayMs: number,
  ringSize: number,
  fps: number = BACKDRAFT_FPS,
): number {
  if (ringSize < 2) return 1;
  const raw = Math.round((Math.max(0, delayMs) / 1000) * fps);
  return Math.max(1, Math.min(ringSize - 1, raw));
}

/**
 * Pure ring tap index: the slot `frames` behind `head` (the slot draw()
 * is about to write). Mirror of vdelayTapIndex; kept local so the two
 * modules can diverge later.
 */
export function backdraftTapIndex(head: number, frames: number, size: number): number {
  if (size <= 0) throw new Error('backdraftTapIndex: size must be positive');
  const f = Math.max(1, Math.min(size - 1, Math.floor(frames)));
  return ((head - f) % size + size) % size;
}

/**
 * Pure mask-combine math (per-pixel). additive + order-independent:
 *   clamp(1 + lightenKnob*lightenMask - darkenKnob*darkenMask, 0, max)
 * All inputs in [0,1] (masks) / [0,1] (knobs). Returns the effect scale.
 */
export function backdraftEffectScale(
  lightenMask: number,
  darkenMask: number,
  lightenKnob: number,
  darkenKnob: number,
  maxScale: number = BACKDRAFT_MAX_EFFECT_SCALE,
): number {
  const raw = 1 + lightenKnob * lightenMask - darkenKnob * darkenMask;
  return Math.max(0, Math.min(maxScale, raw));
}

/**
 * Pure CPU mirror of the shader's final composite — the blend between the
 * classic ADDITIVE accumulator (source + fb·feedback·effectScale) and the
 * ring-gated recursive HALL OF MIRRORS the top of the FEEDBACK range ramps
 * into. Exported so the hall math is unit-tested in lock-step with the shader
 * (the TUNNEL precedent: tunnelTap() in toybox-feedback.ts).
 *
 * The hall engages only when a spatial transform is present (`hasTransform`) —
 * with the identity transform there is no ring to gate the source into, so the
 * additive accumulator is kept regardless of FEEDBACK (squeezing the source out
 * would just decay the frame to black). At full FEEDBACK with a transform the
 * interior is PURE feedback (zero flat source); source enters only in the ring.
 *
 * @returns one pixel's output RGB, each channel clamped to [0,1].
 */
export function backdraftHallComposite(args: {
  /** Live source (crossfaded in_a/in_b), already pixelate-snapped. */
  source: readonly [number, number, number];
  /** Feedback tap, ALREADY colour-processed (per-channel/luma/chroma gain). */
  fb: readonly [number, number, number];
  /** Feedback-tap UV (from backdraftFeedbackUv). Outside [0,1]² ⇒ the ring. */
  fbUv: { u: number; v: number };
  /** FEEDBACK knob, 0..maxFeedback. */
  feedback: number;
  /** Mask effect scale (from backdraftEffectScale). */
  effectScale: number;
  /** Whether any spatial transform is active (zoom≠1 || rotate≠0 || offset≠0). */
  hasTransform: boolean;
  maxFeedback?: number;
  hallLo?: number;
}): [number, number, number] {
  const { source, fb, fbUv, feedback, effectScale, hasTransform } = args;
  const maxFb = args.maxFeedback ?? BACKDRAFT_MAX_FEEDBACK;
  const hallLo = args.hallLo ?? BACKDRAFT_HALL_LO;

  const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
  // GLSL smoothstep(e0, e1, x).
  const smoothstep = (e0: number, e1: number, x: number): number => {
    const t = clamp01((x - e0) / (e1 - e0 || 1e-9));
    return t * t * (3 - 2 * t);
  };

  const fbNorm = clamp01(feedback / maxFb);
  const hallAmt = hasTransform ? smoothstep(hallLo, 1, fbNorm) : 0;
  const inRing = fbUv.u < 0 || fbUv.u > 1 || fbUv.v < 0 || fbUv.v > 1;
  const hallGain = Math.max(0, Math.min(0.985, lerp(0.9, 0.985, fbNorm) * effectScale));

  const out: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const additive = source[i] + fb[i] * feedback * effectScale;
    const hall = inRing ? source[i] : fb[i] * hallGain;
    out[i] = clamp01(lerp(additive, hall, hallAmt));
  }
  return out;
}

/**
 * Pure spatial feedback-tap UV transform — the exact CPU mirror of the
 * shader's `feedbackUv()`. Given an output UV in [0,1]² it returns the UV
 * to sample from the PREVIOUS output, applying the INVERSE of
 * "zoom about centre → rotate about centre (degrees) → translate (offset)".
 *
 * Because we map output→source (inverse), the *visible* transform of the
 * fed-back image is the forward one: zoom>1 magnifies the echo, a positive
 * rotate spins it, and a positive offset shifts it. Exported so the unit
 * tests and the shader share one definition of the geometry.
 *
 *   identity (zoom=1, rotate=0, offset=0) → returns uv unchanged.
 */
export function backdraftFeedbackUv(
  u: number,
  v: number,
  zoom: number,
  rotateDeg: number,
  offsetX: number,
  offsetY: number,
): { u: number; v: number } {
  const theta = (rotateDeg * Math.PI) / 180;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  // centre-relative, undo translation
  let px = u - 0.5 - offsetX;
  let py = v - 0.5 - offsetY;
  // undo rotation: R(-theta) = [[c, s], [-s, c]]
  const rx = px * c + py * s;
  const ry = -px * s + py * c;
  // undo zoom about centre
  const z = Math.max(Math.abs(zoom) < 1e-4 ? 1e-4 : zoom, 1e-4);
  px = rx / z;
  py = ry / z;
  return { u: px + 0.5, v: py + 0.5 };
}

/**
 * Pure PIXELATE snap — the exact CPU mirror of the shader's source-UV snap.
 * Reduces the input's effective resolution by snapping a UV to a coarse grid:
 *
 *   pixelate <= 0      → returns the UV UNCHANGED (identity; the shader's
 *                        `if (uPixelate > 0.0)` gate skips the snap, so the
 *                        output is bit-identical to the un-pixelated path).
 *   0 < pixelate < 1   → snaps to a grid of `cells` cell-centres, where
 *                        cells = mix(res, 1, pixelate) (coarsens from `res`
 *                        cells down toward 1 as pixelate rises).
 *   pixelate >= 1      → cells = 1 → every UV maps to the single centre
 *                        (0.5, 0.5): the whole frame is one cell / one colour.
 *
 * Exported so the unit tests + the shader share one definition of the grid.
 */
export function backdraftPixelateUv(
  u: number,
  v: number,
  pixelate: number,
  res: number,
): { u: number; v: number } {
  if (pixelate <= 0) return { u, v };
  const p = Math.min(1, pixelate);
  const cells = Math.max(1, res * (1 - p) + 1 * p); // mix(res, 1, p)
  return {
    u: (Math.floor(u * cells) + 0.5) / cells,
    v: (Math.floor(v * cells) + 0.5) / cells,
  };
}

/**
 * Pure MIRROR fold of an output UV — the exact CPU mirror of the shader's
 * `mirrorUv()`. MIRROR X folds the LEFT half over the right (right half =
 * mirror of left); MIRROR Y folds the TOP half over the bottom. With this
 * repo's full backdraft→videoOut→canvas chain the VISUAL TOP corresponds to
 * uv.y>=0.5 (verified by e2e), so MIRROR Y KEEPS uv.y>=0.5 and reflects the
 * low half via (1-uv.y) — i.e. the visual top is mirrored into the bottom.
 * Both on = quadrant fold (kaleidoscope). Idempotent on the kept half.
 * Exported so the unit tests + shader share one definition of the geometry.
 */
export function backdraftMirrorUv(
  u: number,
  v: number,
  mirrorX: boolean,
  mirrorY: boolean,
): { u: number; v: number } {
  return {
    u: mirrorX ? (u < 0.5 ? u : 1 - u) : u,
    v: mirrorY ? (v >= 0.5 ? v : 1 - v) : v,
  };
}

/**
 * Per-instance MIRROR-GATE tracker. A RISING EDGE on the mirror_x_gate /
 * mirror_y_gate CV input FLIPS (toggles) that axis's mirror boolean — so a
 * clock/sequencer can flip the kaleidoscope rhythmically. Hysteresis edge
 * detection (rise>0.6 / fall<0.4), the same convention as DELAY CLOCK + the
 * DOOM gates. (Toggle-on-edge, NOT hold-style — see report.)
 */
export interface BackdraftMirrorGateState {
  x: EdgeState;
  y: EdgeState;
}

export function makeBackdraftMirrorGateState(): BackdraftMirrorGateState {
  return { x: makeEdgeState(), y: makeEdgeState() };
}

/**
 * Feed one gate sample into the edge detector; return true iff this sample
 * produced a RISING edge (caller flips the corresponding mirror boolean).
 * Pure aside from mutating `edge` in place.
 */
export function backdraftMirrorGateTick(edge: EdgeState, sample: number): boolean {
  const ev = detectEdge(edge, sample);
  return ev?.pressed === true;
}

/**
 * Per-instance DELAY-CLOCK tracker state. A rising edge on the (hysteresis)
 * gate timestamps `time` (wall-clock seconds from the engine frame); the
 * period is the interval between the last two rising edges. We keep only the
 * most-recent edge time + the last measured period, so once a steady clock
 * has fired twice we can PREDICT the next pulse one period ahead and keep
 * the feedback delay locked to it without waiting for the next edge.
 */
export interface BackdraftClockState {
  edge: EdgeState;
  /** Wall-clock seconds of the most recent rising edge (-1 = none yet). */
  lastRiseTime: number;
  /** Measured pulse period in seconds (interval between the last two rising
   *  edges). 0 until we've seen two edges. On a steady clock this is the
   *  one-pulse-ahead prediction window. */
  periodSec: number;
}

export function makeBackdraftClockState(): BackdraftClockState {
  return { edge: makeEdgeState(), lastRiseTime: -1, periodSec: 0 };
}

/**
 * Feed one DELAY-CLOCK sample into the tracker. Pure aside from mutating
 * `state` in place (one state per instance). On a RISING edge we measure the
 * interval since the previous rising edge and store it as the new period
 * (the most-recent measured interval — exactly what the spec asks for: a
 * steady clock predicts the next pulse one period ahead; random/irregular
 * gates simply use whatever the last interval was, i.e. stochastic).
 *
 * Returns true iff this sample produced a rising edge (useful for tests).
 */
export function backdraftClockTick(
  state: BackdraftClockState,
  sample: number,
  timeSec: number,
): boolean {
  const ev = detectEdge(state.edge, sample);
  if (ev?.pressed) {
    if (state.lastRiseTime >= 0) {
      const dt = timeSec - state.lastRiseTime;
      if (dt > 0) state.periodSec = dt;
    }
    state.lastRiseTime = timeSec;
    return true;
  }
  return false;
}

/**
 * Resolve the effective feedback delay (ms) for this frame.
 *
 *   - clock NOT patched  → the DELAY knob value, unchanged (today's behaviour).
 *   - clock patched      → ONE clock-pulse duration = the last measured
 *                          period (sec → ms), clamped to [0, maxMs]. 500ms
 *                          lines up with one beat at 120 BPM. Until the clock
 *                          has produced two edges (periodSec == 0) we have no
 *                          measurement yet, so we fall back to the knob — the
 *                          delay snaps to the pulse period as soon as the
 *                          second edge lands and then PREDICTS forward (the
 *                          period is reused every frame, no re-measure needed).
 *
 * Pure; shared by draw() + the unit tests so the mapping has one source of
 * truth.
 */
export function backdraftEffectiveDelayMs(
  knobDelayMs: number,
  clockPatched: boolean,
  periodSec: number,
  maxMs: number = BACKDRAFT_MAX_DELAY_MS,
): number {
  if (!clockPatched || periodSec <= 0) {
    return Math.max(0, Math.min(maxMs, knobDelayMs));
  }
  const pulseMs = periodSec * 1000;
  return Math.max(0, Math.min(maxMs, pulseMs));
}

export const backdraftDef: VideoModuleDef = {
  type: 'backdraft',
  palette: { top: 'Video modules', sub: 'Processors' },
  domain: 'video',
  label: 'backdraft',
  category: 'effects',
  schemaVersion: 1,
  inputs: [
    { id: 'in_a',    type: 'video' },
    { id: 'in_b',    type: 'video' },
    // KEY masks. 'video' so any source (LINES / SHAPES / a key) patches in.
    { id: 'lighten', type: 'video' },
    { id: 'darken',  type: 'video' },
    // CV inputs — port id == param id; linear cvScale (bipolar where the
    // param range is signed: luma/chroma/r/g/b span -1..+2).
    { id: 'mix',         type: 'cv', paramTarget: 'mix',      cvScale: { mode: 'linear' } },
    { id: 'feedback',    type: 'cv', paramTarget: 'feedback', cvScale: { mode: 'linear' } },
    { id: 'delay',       type: 'cv', paramTarget: 'delay',    cvScale: { mode: 'linear' } },
    // DELAY CLOCK — gate/clock input. NO cvScale => the bridge passes the
    // RAW swing through (gate semantics) and the module edge-detects rising
    // edges to measure the pulse period. When patched it OVERRIDES the DELAY
    // knob (feedback delay = one clock-pulse duration, capped at 500ms).
    { id: 'delay_clock', type: 'cv', paramTarget: 'delayClock' },
    { id: 'luma',        type: 'cv', paramTarget: 'luma',     cvScale: { mode: 'linear' } },
    { id: 'chroma',      type: 'cv', paramTarget: 'chroma',   cvScale: { mode: 'linear' } },
    { id: 'r',           type: 'cv', paramTarget: 'r',        cvScale: { mode: 'linear' } },
    { id: 'g',           type: 'cv', paramTarget: 'g',        cvScale: { mode: 'linear' } },
    { id: 'b',           type: 'cv', paramTarget: 'b',        cvScale: { mode: 'linear' } },
    { id: 'lighten_cv',  type: 'cv', paramTarget: 'lighten',  cvScale: { mode: 'linear' } },
    { id: 'darken_cv',   type: 'cv', paramTarget: 'darken',   cvScale: { mode: 'linear' } },
    { id: 'pixelate',    type: 'cv', paramTarget: 'pixelate', cvScale: { mode: 'linear' } },
    // Spatial feedback transform CV (linear; bipolar where signed).
    { id: 'zoom',        type: 'cv', paramTarget: 'zoom',     cvScale: { mode: 'linear' } },
    { id: 'rotate',      type: 'cv', paramTarget: 'rotate',   cvScale: { mode: 'linear' } },
    { id: 'offsetx',     type: 'cv', paramTarget: 'offsetX',  cvScale: { mode: 'linear' } },
    { id: 'offsety',     type: 'cv', paramTarget: 'offsetY',  cvScale: { mode: 'linear' } },
    // MIRROR gate inputs — gate/clock style (NO cvScale => raw passthrough).
    // A RISING edge FLIPS (toggles) the matching mirror axis, so a clock can
    // flip the kaleidoscope rhythmically. The module edge-detects them.
    { id: 'mirror_x_gate', type: 'cv', paramTarget: 'mirrorXGate' },
    { id: 'mirror_y_gate', type: 'cv', paramTarget: 'mirrorYGate' },
  ],
  outputs: [
    { id: 'out', type: 'video' },
  ],
  params: [
    { id: 'mix',      label: 'Mix',      defaultValue: DEFAULTS.mix,      min: 0,  max: 1,                     curve: 'linear' },
    { id: 'feedback', label: 'Feedback', defaultValue: DEFAULTS.feedback, min: 0,  max: BACKDRAFT_MAX_FEEDBACK, curve: 'linear' },
    { id: 'delay',    label: 'Delay',    defaultValue: DEFAULTS.delay,    min: 0,  max: BACKDRAFT_MAX_DELAY_MS, curve: 'linear' },
    { id: 'luma',     label: 'Luma',     defaultValue: DEFAULTS.luma,     min: -1, max: 2,                     curve: 'linear' },
    { id: 'chroma',   label: 'Chroma',   defaultValue: DEFAULTS.chroma,   min: -1, max: 2,                     curve: 'linear' },
    { id: 'r',        label: 'R',        defaultValue: DEFAULTS.r,        min: -1, max: 2,                     curve: 'linear' },
    { id: 'g',        label: 'G',        defaultValue: DEFAULTS.g,        min: -1, max: 2,                     curve: 'linear' },
    { id: 'b',        label: 'B',        defaultValue: DEFAULTS.b,        min: -1, max: 2,                     curve: 'linear' },
    { id: 'lighten',  label: 'Lighten',  defaultValue: DEFAULTS.lighten,  min: 0,  max: 1,                     curve: 'linear' },
    { id: 'darken',   label: 'Darken',   defaultValue: DEFAULTS.darken,   min: 0,  max: 1,                     curve: 'linear' },
    // PIXELATE — reduce the source resolution. 0 = identity (output unchanged),
    // 1 = the whole frame collapses to one cell (one representative colour).
    { id: 'pixelate', label: 'Pixelate', defaultValue: DEFAULTS.pixelate, min: 0,  max: 1,                     curve: 'linear' },
    // Spatial feedback transform — identity defaults (no tunnel/spiral/trail).
    { id: 'zoom',     label: 'Zoom',     defaultValue: DEFAULTS.zoom,     min: BACKDRAFT_ZOOM_MIN,   max: BACKDRAFT_ZOOM_MAX,   curve: 'linear' },
    { id: 'rotate',   label: 'Rotate',   defaultValue: DEFAULTS.rotate,   min: BACKDRAFT_ROTATE_MIN, max: BACKDRAFT_ROTATE_MAX, curve: 'linear' },
    { id: 'offsetX',  label: 'Off X',    defaultValue: DEFAULTS.offsetX,  min: BACKDRAFT_OFFSET_MIN, max: BACKDRAFT_OFFSET_MAX, curve: 'linear' },
    { id: 'offsetY',  label: 'Off Y',    defaultValue: DEFAULTS.offsetY,  min: BACKDRAFT_OFFSET_MIN, max: BACKDRAFT_OFFSET_MAX, curve: 'linear' },
    // delayClock is the synthetic gate param the DELAY CLOCK CV bridge
    // writes (raw 0..1 swing). Hidden — no card knob; the module edge-detects
    // it to measure the pulse period that overrides the DELAY knob.
    { id: 'delayClock', label: 'Delay Clk', defaultValue: DEFAULTS.delayClock, min: 0, max: 1, curve: 'linear' },
    // MIRROR kaleidoscope toggles (0/1). Buttons on the card set these; the
    // gate inputs flip them on a rising edge. Default off.
    { id: 'mirrorX',  label: 'Mirror X', defaultValue: DEFAULTS.mirrorX,  min: 0,  max: 1,                     curve: 'linear' },
    { id: 'mirrorY',  label: 'Mirror Y', defaultValue: DEFAULTS.mirrorY,  min: 0,  max: 1,                     curve: 'linear' },
    // Synthetic gate params the mirror_x_gate / mirror_y_gate bridge writes —
    // hidden (no card knob); the module edge-detects a rising edge to FLIP.
    { id: 'mirrorXGate', label: 'Mir X Gate', defaultValue: DEFAULTS.mirrorXGate, min: 0, max: 1, curve: 'linear' },
    { id: 'mirrorYGate', label: 'Mir Y Gate', defaultValue: DEFAULTS.mirrorYGate, min: 0, max: 1, curve: 'linear' },
    // freeze is a hidden VRT/determinism toggle — no card control.
    { id: 'freeze',   label: 'Freeze',   defaultValue: DEFAULTS.freeze,   min: 0,  max: 1,                     curve: 'linear' },
  ],

  // docs-hash-ignore:start
  docs: {
    explanation: `BACKDRAFT is a video feedback generator. It builds a "source" image by crossfading two video inputs (IN A / IN B) with MIX, then composites that against a processed copy of its OWN previous output, read from an internal ring of past frames so there is no live GL feedback loop (downstream sees frame N while the tap reads N-1..N-30). The fed-back frame is delayed (DELAY, 0-500ms or a clock pulse), colour-processed (per-channel R/G/B gain, then LUMA brightness, then CHROMA saturation), scaled per-pixel by two key masks (KEY+ lightens / KEY- darkens the effect), and geometrically warped a little each pass (ZOOM/ROTATE/OFF X/OFF Y) so the transform COMPOUNDS into tunnels, spirals, and directional trails. Two MIRROR buttons fold the whole composited frame into a kaleidoscope. As FEEDBACK approaches its max (and a spatial transform is active) the additive trail-accumulator ramps into a pure recursive hall of mirrors. Usage: patch a camera or generator into IN A, raise FEEDBACK toward ~1 and nudge ZOOM off 1.0 (with a little ROTATE) for the classic infinite-tunnel look; add OFF X/Y for smear, PIXELATE for blocky lo-fi, and clock DELAY CLK for rhythmic echo. Output is the OUT video jack. The card shows a large live video preview on the left that is resizable via the bottom-right corner-drag handle (width/height persist, snapped to rack tiles); right-click the preview for Full Frame / Full Screen / Present-on-another-display.`,
    inputs: {
      in_a: "Video source A. Crossfaded against IN B by MIX to form the live 'source' image that is re-injected each frame; unpatched it reads black.",
      in_b: "Video source B. The other end of the MIX crossfade (MIX=1 selects this input fully); unpatched it reads black.",
      lighten: "Video KEY+ mask. Read as luma per pixel; where bright it scales the feedback effect UP (paired with the Lighten control). Unpatched = neutral (no boost).",
      darken: "Video KEY- mask. Read as luma per pixel; where bright it scales the feedback effect DOWN (paired with the Darken control). Unpatched = neutral (no cut).",
      mix: "CV (linear) that modulates the Mix crossfade between IN A (0) and IN B (1).",
      feedback: "CV (linear) that modulates the FB (feedback) amount, the per-frame persistence ratio of the fed-back frame.",
      delay: "CV (linear) that modulates the Delay control, the feedback tap delay in milliseconds (0-500ms).",
      delay_clock: "Gate/clock input (raw passthrough, edge-detected). Each rising edge times a pulse; once two edges land, the feedback delay locks to one clock-pulse duration (capped at 500ms = one beat at 120 BPM) and OVERRIDES the Delay control.",
      luma: "CV (linear) that modulates the Luma control, the feedback's overall brightness gain about black.",
      chroma: "CV (linear) that modulates the Chr (chroma/saturation) control of the fed-back frame.",
      r: "CV (linear, bipolar) that modulates the R per-channel red gain of the feedback (range -1..+2).",
      g: "CV (linear, bipolar) that modulates the G per-channel green gain of the feedback (range -1..+2).",
      b: "CV (linear, bipolar) that modulates the B per-channel blue gain of the feedback (range -1..+2).",
      lighten_cv: "CV (linear) that modulates the Lgt (Lighten) control, the amount the KEY+ mask boosts the feedback effect.",
      darken_cv: "CV (linear) that modulates the Drk (Darken) control, the amount the KEY- mask reduces the feedback effect.",
      pixelate: "CV (linear) that modulates the Pix (Pixelate) control, reducing the source's effective resolution (0 = identity, 1 = a single cell).",
      zoom: "CV (linear) that modulates the Zoom control, the per-pass scale of the feedback tap about centre that builds the tunnel.",
      rotate: "CV (linear, bipolar) that modulates the Rot (Rotate) control, the per-pass rotation in degrees that turns the feedback into a spiral.",
      offsetx: "CV (linear, bipolar) that modulates the OffX (Off X) control, the per-pass horizontal translation of the feedback tap (directional trail).",
      offsety: "CV (linear, bipolar) that modulates the OffY (Off Y) control, the per-pass vertical translation of the feedback tap (directional trail).",
      mirror_x_gate: "Gate/clock input (raw passthrough, edge-detected). A RISING edge TOGGLES (flips) the Mirror X kaleidoscope fold, so a clock can flip it rhythmically. Edge-triggered, not a held level.",
      mirror_y_gate: "Gate/clock input (raw passthrough, edge-detected). A RISING edge TOGGLES (flips) the Mirror Y kaleidoscope fold. Edge-triggered, not a held level.",
    },
    outputs: {
      out: "The feedback-rendered video output: the crossfaded source composited with the processed, delayed, spatially-warped, mask-scaled copy of the previous output.",
    },
    controls: {
      mix: "Mix (0..1, default 0.5): crossfade between IN A (0) and IN B (1) to form the live source image.",
      feedback: "FB / Feedback (0..2.0, default 0.85): per-frame feedback persistence. Above 1.0 gives runaway trails; near max (with a spatial transform active) it ramps into a pure recursive hall of mirrors. Each frame is clamped to [0,1] so it cannot blow out.",
      delay: "Delay (0..500 ms, default 16): feedback tap delay, snapped to the nearest whole frame (~1 frame at default). Overridden + shown as 'Dly·CLK' with a CLK badge while DELAY CLK is patched.",
      luma: "Luma (-1..+2, default 1.0): brightness gain of the fed-back frame about black. 1 = neutral, >1 brightens, <1 darkens, negative inverts.",
      chroma: "Chr / Chroma (-1..+2, default 1.0): saturation gain about the pixel's own luma. 1 = neutral, 0 = greyscale, 2 = double saturation, negative = hue-inverted.",
      r: "R (-1..+2, default 1.0): per-channel red gain on the feedback. 1 = neutral.",
      g: "G (-1..+2, default 1.0): per-channel green gain on the feedback. 1 = neutral.",
      b: "B (-1..+2, default 1.0): per-channel blue gain on the feedback. 1 = neutral.",
      lighten: "Lgt / Lighten (0..1, default 1.0): how much the KEY+ mask boosts the feedback effect where the mask is bright.",
      darken: "Drk / Darken (0..1, default 1.0): how much the KEY- mask reduces the feedback effect where the mask is bright.",
      pixelate: "Pix / Pixelate (0..1, default 0): reduces the SOURCE resolution. 0 = identity (bit-exact), rising = blockier, 1 = the whole frame collapses to one representative colour.",
      zoom: "Zoom (0.8..1.2, default 1.0): per-pass scale of the feedback tap about centre. <1 makes echoes recede (expanding tunnel), >1 magnifies them (zoom-in tunnel); 1 = no tunnel.",
      rotate: "Rot / Rotate (-30..+30 °, default 0): per-pass rotation of the feedback tap about centre. Combined with Zoom≠1 the echoes twist into a spiral; 0 = no spiral.",
      offsetX: "OffX / Off X (-0.1..+0.1, default 0): per-pass horizontal translation (UV units) of the feedback tap, making a directional trail/smear; 0 = none.",
      offsetY: "OffY / Off Y (-0.1..+0.1, default 0): per-pass vertical translation (UV units) of the feedback tap, making a directional trail/smear; 0 = none.",
      delayClock: "Delay Clk (0..1, default 0): hidden synthetic param the DELAY CLK CV bridge writes (raw gate swing). No card knob; the module edge-detects it to measure the pulse period that overrides the Delay control.",
      mirrorX: "Mirror X (0/1, default 0): kaleidoscope toggle that folds the left half of the composited output over the right. Set by the MIRROR X button or flipped by a rising edge on mirror_x_gate.",
      mirrorY: "Mirror Y (0/1, default 0): kaleidoscope toggle that folds the top half of the output over the bottom (both on = a 4-way quadrant fold). Set by the MIRROR Y button or flipped by mirror_y_gate.",
      mirrorXGate: "Mir X Gate (0..1, default 0): hidden synthetic param the mirror_x_gate CV bridge writes (raw gate swing). No card knob; a rising edge flips Mirror X.",
      mirrorYGate: "Mir Y Gate (0..1, default 0): hidden synthetic param the mirror_y_gate CV bridge writes (raw gate swing). No card knob; a rising edge flips Mirror Y.",
      freeze: "Freeze (0/1, default 0): hidden determinism toggle. At ≥0.5 draw() is a no-op so the ring + output hold their last frame for deterministic VRT capture. No card control.",
    },
  },
  // docs-hash-ignore:end
  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);

    const u = (name: string): WebGLUniformLocation | null => gl.getUniformLocation(program, name);
    const uA = u('uA');
    const uB = u('uB');
    const uFb = u('uFb');
    const uLighten = u('uLighten');
    const uDarken = u('uDarken');
    const uHasA = u('uHasA');
    const uHasB = u('uHasB');
    const uHasFb = u('uHasFb');
    const uHasLighten = u('uHasLighten');
    const uHasDarken = u('uHasDarken');
    const uMix = u('uMix');
    const uFeedback = u('uFeedback');
    const uLuma = u('uLuma');
    const uChroma = u('uChroma');
    const uR = u('uR');
    const uG = u('uG');
    const uBlue = u('uBlue');
    const uLightenKnob = u('uLightenKnob');
    const uDarkenKnob = u('uDarkenKnob');
    const uZoom = u('uZoom');
    const uCos = u('uCos');
    const uSin = u('uSin');
    const uOffX = u('uOffX');
    const uOffY = u('uOffY');
    const uMirrorX = u('uMirrorX');
    const uMirrorY = u('uMirrorY');
    const uPixelate = u('uPixelate');
    const uRes = u('uRes');

    // Ring buffer of OUTPUT frames + a dedicated current-output FBO. We
    // render the composite into ring[head] (which IS this frame's output),
    // and publish ring[head].texture downstream. The feedback tap reads
    // ring[head - delayFrames] — a frame we wrote on a PAST step, so we
    // never sample the texture being written this frame.
    const ring: { fbo: WebGLFramebuffer; texture: WebGLTexture }[] = [];
    for (let i = 0; i < BACKDRAFT_BUFFER_FRAMES; i++) ring.push(ctx.createFbo());

    // 1×1 black sentinel for unbound inputs / cold-start tap. Black =
    // no-effect (zero source, zero feedback, zero mask). Same pattern as
    // V-MIXER / VDELAY: never bind our own output as a spare sampler.
    const emptyTex = gl.createTexture();
    if (!emptyTex) throw new Error('BACKDRAFT: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, emptyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const params: BackdraftParams = { ...DEFAULTS, ...(node.params as Partial<BackdraftParams>) };
    let head = 0;
    let framesElapsed = 0;

    // ── DELAY CLOCK tracking ──────────────────────────────────────────
    // The gate-style CV bridge calls setParam('delayClock', raw) EVERY frame
    // the DELAY CLOCK edge exists (even when the gate is low between pulses);
    // it stops calling when the edge is removed. So "was delayClock written
    // since the last draw" is a robust PATCHED signal that doesn't confuse an
    // idle-low clock with an unpatched input. We bump a write sequence on
    // every setParam and compare it in draw().
    const clock = makeBackdraftClockState();
    let clockWriteSeq = 0;        // ++ on every setParam('delayClock')
    let clockSeqSeenInDraw = -1;  // last seq observed by draw()
    let clockPatched = false;

    // ── MIRROR gate tracking ──────────────────────────────────────────
    // A rising edge on mirror_x_gate / mirror_y_gate FLIPS the matching
    // mirror boolean. We edge-detect the raw gate sample written by the CV
    // bridge each frame. Like the DELAY CLOCK, the bridge only writes while
    // patched, so an unpatched gate never spuriously fires.
    const mirrorGate = makeBackdraftMirrorGateState();

    const surface: VideoNodeSurface = {
      fbo: ring[0]!.fbo,
      texture: ring[0]!.texture,
      draw(frame) {
        // FREEZE: hold last output (ring + surface.texture unchanged) so
        // the feedback render is pixel-stable for deterministic VRT.
        if (params.freeze >= 0.5) return;

        const g = frame.gl;
        const aTex = frame.getInputTexture(node.id, 'in_a');
        const bTex = frame.getInputTexture(node.id, 'in_b');
        const lightenTex = frame.getInputTexture(node.id, 'lighten');
        const darkenTex = frame.getInputTexture(node.id, 'darken');

        // DELAY CLOCK: detect patched-ness (did the bridge write delayClock
        // since the previous draw?) then feed the raw gate sample to the
        // edge detector to measure the pulse period.
        clockPatched = clockWriteSeq !== clockSeqSeenInDraw;
        clockSeqSeenInDraw = clockWriteSeq;
        if (clockPatched) backdraftClockTick(clock, params.delayClock, frame.time);

        // MIRROR gates: a rising edge on either gate FLIPS the matching
        // mirror boolean. The button/UI reflects the resulting (possibly
        // gate-toggled) state because we mutate the shared `params`.
        if (backdraftMirrorGateTick(mirrorGate.x, params.mirrorXGate)) {
          params.mirrorX = params.mirrorX >= 0.5 ? 0 : 1;
        }
        if (backdraftMirrorGateTick(mirrorGate.y, params.mirrorYGate)) {
          params.mirrorY = params.mirrorY >= 0.5 ? 0 : 1;
        }

        // Effective delay (ms): the DELAY knob, OR — when a DELAY CLOCK is
        // patched and has measured a period — one clock-pulse duration,
        // capped at 500ms. The measured period is reused every frame (the
        // one-pulse-ahead prediction on a steady clock), so the feedback
        // refresh stays locked to the pulses without re-measuring.
        const effectiveDelayMs = backdraftEffectiveDelayMs(
          params.delay,
          clockPatched,
          clock.periodSec,
        );
        const delayFrames = backdraftDelayFrames(effectiveDelayMs, BACKDRAFT_BUFFER_FRAMES);
        const tapIdx = backdraftTapIndex(head, delayFrames, BACKDRAFT_BUFFER_FRAMES);
        // Cold start: until we've written at least `delayFrames` frames the
        // tap slot is still its cleared (black) initial state — read the
        // sentinel so the loop starts from zero feedback.
        const fbTex = framesElapsed >= delayFrames ? ring[tapIdx]!.texture : emptyTex;

        const dst = ring[head]!;
        g.bindFramebuffer(g.FRAMEBUFFER, dst.fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(program);

        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, aTex ?? emptyTex);
        g.uniform1i(uA, 0);
        g.uniform1f(uHasA, aTex ? 1.0 : 0.0);

        g.activeTexture(g.TEXTURE1);
        g.bindTexture(g.TEXTURE_2D, bTex ?? emptyTex);
        g.uniform1i(uB, 1);
        g.uniform1f(uHasB, bTex ? 1.0 : 0.0);

        g.activeTexture(g.TEXTURE2);
        g.bindTexture(g.TEXTURE_2D, fbTex);
        g.uniform1i(uFb, 2);
        g.uniform1f(uHasFb, framesElapsed >= delayFrames ? 1.0 : 0.0);

        g.activeTexture(g.TEXTURE3);
        g.bindTexture(g.TEXTURE_2D, lightenTex ?? emptyTex);
        g.uniform1i(uLighten, 3);
        g.uniform1f(uHasLighten, lightenTex ? 1.0 : 0.0);

        g.activeTexture(g.TEXTURE4);
        g.bindTexture(g.TEXTURE_2D, darkenTex ?? emptyTex);
        g.uniform1i(uDarken, 4);
        g.uniform1f(uHasDarken, darkenTex ? 1.0 : 0.0);

        g.uniform1f(uMix,         Math.max(0, Math.min(1, params.mix)));
        g.uniform1f(uFeedback,    Math.max(0, Math.min(BACKDRAFT_MAX_FEEDBACK, params.feedback)));
        g.uniform1f(uLuma,        params.luma);
        g.uniform1f(uChroma,      params.chroma);
        g.uniform1f(uR,           params.r);
        g.uniform1f(uG,           params.g);
        g.uniform1f(uBlue,        params.b);
        g.uniform1f(uLightenKnob, Math.max(0, Math.min(1, params.lighten)));
        g.uniform1f(uDarkenKnob,  Math.max(0, Math.min(1, params.darken)));

        // Spatial feedback transform. Clamp to the documented ranges, then
        // precompute cos/sin of the rotation so the shader stays branch-free.
        const zoom = Math.max(BACKDRAFT_ZOOM_MIN, Math.min(BACKDRAFT_ZOOM_MAX, params.zoom));
        const rot = Math.max(BACKDRAFT_ROTATE_MIN, Math.min(BACKDRAFT_ROTATE_MAX, params.rotate));
        const theta = (rot * Math.PI) / 180;
        const offX = Math.max(BACKDRAFT_OFFSET_MIN, Math.min(BACKDRAFT_OFFSET_MAX, params.offsetX));
        const offY = Math.max(BACKDRAFT_OFFSET_MIN, Math.min(BACKDRAFT_OFFSET_MAX, params.offsetY));
        g.uniform1f(uZoom, zoom);
        g.uniform1f(uCos, Math.cos(theta));
        g.uniform1f(uSin, Math.sin(theta));
        g.uniform1f(uOffX, offX);
        g.uniform1f(uOffY, offY);

        // MIRROR kaleidoscope fold (applied to the FINAL output sampling UV).
        g.uniform1f(uMirrorX, params.mirrorX >= 0.5 ? 1.0 : 0.0);
        g.uniform1f(uMirrorY, params.mirrorY >= 0.5 ? 1.0 : 0.0);

        // PIXELATE — clamp to [0,1]; the source resolution (in cells) is the
        // FBO width so pixelate≈0 ≈ 1:1, and the shader's `if (uPixelate>0)`
        // gate keeps pixelate=0 bit-identical. At 1 → 1 cell → flat colour.
        g.uniform1f(uPixelate, Math.max(0, Math.min(1, params.pixelate)));
        g.uniform1f(uRes, ctx.res.width);

        ctx.drawFullscreenQuad();
        g.bindFramebuffer(g.FRAMEBUFFER, null);

        // Publish the just-written output, then advance the ring head.
        surface.texture = dst.texture;
        surface.fbo = dst.fbo;
        head = (head + 1) % BACKDRAFT_BUFFER_FRAMES;
        framesElapsed++;
      },
      dispose() {
        for (const r of ring) {
          gl.deleteFramebuffer(r.fbo);
          gl.deleteTexture(r.texture);
        }
        gl.deleteTexture(emptyTex);
        gl.deleteProgram(program);
      },
    };

    return {
      domain: 'video',
      surface,
      setParam(paramId, value) {
        if (paramId in params) (params as unknown as Record<string, number>)[paramId] = value;
        // The gate-style CV bridge writes delayClock every frame while the
        // DELAY CLOCK input is patched; bump the seq so draw() can tell the
        // input is live (vs an unpatched input that never writes).
        if (paramId === 'delayClock') clockWriteSeq++;
      },
      readParam(paramId) {
        return (params as unknown as Record<string, number>)[paramId];
      },
      read(key) {
        if (key === 'fboTexture') return surface.texture;
        // UI: is the DELAY CLOCK driving the delay (knob overridden)? True
        // once the clock is patched AND has measured at least one period.
        if (key === 'clockDriving') return clockPatched && clock.periodSec > 0;
        if (key === 'clockPeriodSec') return clock.periodSec;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
