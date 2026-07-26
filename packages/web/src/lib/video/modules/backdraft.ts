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
// ── FLICKER (the display's pulsed emission, as our camera sees it) ────
// A real camera-into-monitor loop has NO constant per-pass gain. The display
// emits light in PULSES (one per refresh); the camera INTEGRATES over an
// exposure window shorter than the pulse period and SAMPLES at its own frame
// rate. Emission and sampling BEAT, so the fraction of each pulse the camera
// catches cycles above and below its own average — the instantaneous loop gain
// oscillates around unity. That is what lets light BUILD over several frames
// and then FADE, instead of racing to the clip ceiling and staying pinned.
//
// Without it (FLICKER = OFF, the default) the composite
//   out = clamp(source + fb*FEEDBACK*effectScale, 0, 1)
// has every coefficient non-negative and a monotone-increasing clamp, i.e. it
// is a MONOTONE POSITIVE MAP. Such a map has only fixed-point attractors:
// gain < 1 decays to equilibrium, gain > 1 climbs to white and stays. DELAY
// cannot change that — a delay only oscillates when the loop has a sign
// inversion or a level-dependent correction, and this one has neither.
//
// The model (derivation + sources:
// .myrobots/plans/backdraft-flicker-research-2026-07-26.md):
//
//   emission     e(t) = 1 + m*cos(2*pi*f*t)      (mean-normalised to 1)
//   exposure     integrate e over T_e  =>  depth *= sinc(f*T_e)
//   rolling sh.  row v starts at t + v*T_ro  =>  phase varies DOWN the frame
//   sampling     evaluate at t_n = floor(t*f_cam)/f_cam  =>  beat = alias of f
//
//   g(t, v) = A * [ 1 + m*sinc(f*T_e) * cos(2*pi*f*(t_n + T_e/2) + 2*pi*f*T_ro*v) ]
//
// The exposure boxcar contributes EXACTLY a sinc(f*T_e) attenuation — so
// sinc(1) = 0 reproduces the flicker-free shutter rule (shoot 1/50s under
// 50Hz) for free, and we unit-test that. A is an operating-point normaliser
// that keeps the frame-mean gain's GEOMETRIC mean at 1 (a multiplicative loop
// cares about the geometric mean, and an arithmetic-mean-1 gain has geometric
// mean < 1 by AM-GM), so switching FLICKER on does not silently damp the loop
// and re-tuning FEEDBACK is unnecessary. Crutchfield (Physica D 10, 1984)
// legitimately DROPPED this term because a vidicon tube integrates ~1/3 s and
// smears 10 refreshes flat; every modern CMOS sensor has a ~1/50-1/500 s
// exposure and no inter-frame storage, so the term he neglected is the one
// that dominates a present-day loop.
//
// Sampling is quantised onto a FIXED 60Hz virtual-camera grid. That is
// load-bearing for determinism: without it a 120Hz display would sample the
// 50Hz emission at 120Hz and see a 50Hz beat instead of a 10Hz one — the same
// knob settings, a completely different look.
//
// The gain multiplies the feedback tap IMMEDIATELY AFTER SAMPLING — it is the
// light the CAMERA captured, and the per-channel/luma/chroma gains are the
// ELECTRONICS downstream of the sensor — so both the additive accumulator and
// the hall-of-mirrors path inherit it with no special-casing. The row
// coordinate is the raw SCREEN vUv.y (the sensor scans the screen, not the
// feedback geometry), so bands are fixed in screen space and CRAWL at the beat
// rate.
//
// Because g is a function of ABSOLUTE simulation time (not a per-tap counter),
// the DELAY path composes the gains that really occurred at those times:
//   I_{n+1} = source + g(t_n) * FEEDBACK * effectScale * I_{n-d}
// so k passes multiply g at instants (d+1) frames apart. Commensurate beat and
// delay reinforce (locked pulsing / subharmonics); incommensurate precess
// (long non-repeating evolution). That coherence is free, and is where the
// network richness comes from.
//
// OFF is the DEFAULT and is BIT-IDENTICAL to the pre-FLICKER path: the whole
// block sits behind `if (uFlickerOn > 0.5)` in the shader (the same
// load-bearing-gate idiom as PIXELATE's `if (uPixelate > 0.0)`), so at OFF not
// one extra float operation executes.
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
export const BACKDRAFT_ZOOM_MIN = 0.4;
export const BACKDRAFT_ZOOM_MAX = 1.6;
/** ROTATE in degrees per iteration (signed). */
export const BACKDRAFT_ROTATE_MIN = -30;
export const BACKDRAFT_ROTATE_MAX = 30;
/** OFFSET X/Y in UV units per iteration (signed). 0.1 = 10% of the frame. */
export const BACKDRAFT_OFFSET_MIN = -0.1;
export const BACKDRAFT_OFFSET_MAX = 0.1;

/** SHAPE — the geometric screen-mask options, in the EXACT order the SHAPE
 *  button + the shape_gate input cycle through them. SQUARE (index 0) is the
 *  FULL-FRAME identity (mask = 1 everywhere → no crop), so the DEFAULT output is
 *  unchanged from pre-SHAPE backdraft; the rounder/pointier shapes crop the
 *  frame into that shape. */
export const BACKDRAFT_SHAPES = ['square', 'circle', 'pentagon', 'triangle', 'octagon'] as const;
export type BackdraftShape = (typeof BACKDRAFT_SHAPES)[number];
export const BACKDRAFT_SHAPE_COUNT = BACKDRAFT_SHAPES.length; // 5
/** Inscribed-shape size in ASPECT-CORRECTED centre-relative UV units: the circle
 *  RADIUS / the polygon CIRCUMRADIUS. 0.5 reaches the top/bottom frame edges, so
 *  the corners (centre-distance > 0.5) are always cut — that's the visible crop
 *  the SHAPE mask makes. */
export const BACKDRAFT_SHAPE_RADIUS = 0.5;

/** FLICKER — the display's pulse rate, in the EXACT order the knob's 4
 *  positions sit in. Index 0 is OFF (the no-op identity), so the DEFAULT
 *  output is bit-identical to pre-FLICKER backdraft. */
export const BACKDRAFT_FLICKER_OPTIONS = ['off', '24', '50', '60'] as const;
export type BackdraftFlickerOption = (typeof BACKDRAFT_FLICKER_OPTIONS)[number];
export const BACKDRAFT_FLICKER_COUNT = BACKDRAFT_FLICKER_OPTIONS.length; // 4

/** Emission frequency in Hz for each knob position. 0 = OFF (no flicker).
 *
 *  The "60" position is 60000/1001 = 59.94 Hz, the REAL NTSC field rate — not
 *  60.000. Against a 60.00 Hz camera that beats at 0.06 Hz: the famously slow
 *  crawling hum bar you get pointing a camera at a television. Modelling it as
 *  exactly 60.000 would GENLOCK it — the camera would sample one identical
 *  phase forever, the gain would be a CONSTANT, and the position would behave
 *  as a dumb attenuator with no motion at all. 24 = cinema, 50 = PAL/SECAM
 *  field rate + 50 Hz mains. Beats against the 60 Hz virtual camera:
 *    24    -> |24 - 0*60| = 24 Hz    (2.5 frames/cycle — a hard strobe)
 *    50    -> |50 - 1*60| = 10 Hz    (6 frames/cycle — the best pulse)
 *    59.94 -> |59.94 - 60| = 0.06 Hz (~1000 frames/cycle — a slow breathe) */
export const BACKDRAFT_FLICKER_HZ: readonly number[] = [0, 24, 50, 60000 / 1001];

/** Display emission modulation depth (0..1). Not 1.0 — a real display does not
 *  reach exactly zero between pulses; phosphor persistence / backlight tail
 *  leave a floor. 0.85 leaves a 15% floor. */
export const BACKDRAFT_FLICKER_DEPTH = 0.85;
/** Camera exposure time as a fraction of the virtual camera's frame period.
 *  0.5 = a 180-degree shutter (1/120 s at 60 fps), the cinema/video convention. */
export const BACKDRAFT_FLICKER_SHUTTER = 0.5;
/** Rolling-shutter readout time as a fraction of the frame period — how far
 *  the flicker phase drifts DOWN the frame. 0.5 = mid-range CMOS (real sensors
 *  span ~0.15 for fast stacked sensors to ~1.0 for cheap ones). It is a genuine
 *  trade-off: 0 is a global shutter (full mean pulsing, no bands), while
 *  readout = f_cam/f zeroes the mean-gain sinc and gives pure STANDING bands
 *  with no pulsing at all. 0.5 keeps a strong mean pulse AND a visible
 *  ~0.42-cycle gradient that crawls at the beat rate. */
export const BACKDRAFT_FLICKER_READOUT = 0.5;

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

// SHAPE geometry mask — a regular-polygon / circle screen mask.
//   uShape:   0=square(full frame) 1=circle 2=pentagon 3=triangle 4=octagon.
//   uPureGeo: 1 = mask the FINAL OUTPUT in SCREEN space (a FIXED shape that cuts
//             content outside at ALL zooms); 0 = mask the SOURCE in the ZOOMED
//             feedback space so the shape SCALES with ZOOM and the cropped source
//             spills through the feedback loop.
//   uAspect:  frame width/height so the shape is round (not stretched).
uniform float uShape;
uniform float uPureGeo;
uniform float uAspect;

// FLICKER — the virtual camera's per-pixel CAPTURE GAIN for a display that
// emits in pulses. All four scalars are precomputed on the CPU by
// backdraftFlickerTerms() (see the header): the exposure-window integral and
// the rolling-shutter row spread are closed-form sincs, so the shader is one
// cos. uFlickerOn is 0 at the OFF default and the block is branch-gated, so
// OFF executes not one extra float op (the PIXELATE precedent).
uniform float uFlickerOn;    // 0 = off (identity), 1 = on
uniform float uFlickerGain;  // A — operating-point normaliser (geometric mean 1)
uniform float uFlickerDepth; // A * depth * sinc(f*T_exposure)
uniform float uFlickerPhase; // 2*pi*f*(t_virtualFrame + T_exposure/2), wrapped
uniform float uFlickerRow;   // 2*pi*f*T_readout — phase spread DOWN the frame

const float MAX_EFFECT_SCALE = ${BACKDRAFT_MAX_EFFECT_SCALE.toFixed(1)};
const float BD_PI = 3.14159265359;

float luma(vec3 c) {
  return dot(c, vec3(0.299, 0.587, 0.114));
}

// SHAPE mask — 1.0 INSIDE the shape, 0.0 outside, antialiased. The uv arg is the
// coordinate to test (the screen vUv for PURE GEO ON, the zoomed feedback UV for
// OFF). SQUARE (uShape<=0) is the full-frame identity (always 1.0). p is
// aspect-corrected centre-relative so circles stay round + polygons stay regular
// regardless of the frame's aspect ratio.
float shapeMask(vec2 uv) {
  int s = int(uShape + 0.5);
  if (s <= 0) return 1.0; // SQUARE = full frame (no crop)
  vec2 p = (uv - vec2(0.5)) * vec2(uAspect, 1.0);
  float r = ${BACKDRAFT_SHAPE_RADIUS.toFixed(3)};
  float d;
  if (s == 1) {
    d = length(p) - r; // circle: signed distance to radius r
  } else {
    // pentagon (5) / triangle (3) / octagon (8). iq regular-polygon SDF:
    // apothem = circumradius * cos(PI/n); d = (dist to nearest edge) - apothem.
    float n = s == 2 ? 5.0 : (s == 3 ? 3.0 : 8.0);
    float apothem = r * cos(BD_PI / n);
    float ang = atan(p.x, p.y);
    float seg = (2.0 * BD_PI) / n;
    d = cos(seg * floor(0.5 + ang / seg) - ang) * length(p) - apothem;
  }
  float aa = max(fwidth(d), 1e-4);
  return 1.0 - smoothstep(-aa, aa, d); // 1 inside (d<0) → 0 outside
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

  // SHAPE mask in SCREEN space (used by PURE GEO ON) — a FIXED shape on the
  // canvas, independent of ZOOM. Computed here in uniform flow so its fwidth()
  // antialias derivative is well-defined.
  float maskScreen = shapeMask(vUv);

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

  // FLICKER — scale the fed-back light by what the camera's exposure window
  // actually caught of the display's pulse this frame. Applied HERE, straight
  // after the tap and BEFORE the colour processing, because this is the light
  // the SENSOR captured and the R/G/B/luma/chroma gains are the ELECTRONICS
  // downstream of it; both the additive accumulator and the hall of mirrors
  // then inherit it with no special-casing. The row term uses the raw SCREEN
  // vUv.y (not the mirror-folded/feedback uv) because the rolling shutter
  // scans the SCREEN — so bands stay fixed in screen space and crawl at the
  // beat rate. The IF GATE is LOAD-BEARING: at OFF the output is bit-identical
  // to the pre-FLICKER path.
  if (uFlickerOn > 0.5) {
    fb *= uFlickerGain + uFlickerDepth * cos(uFlickerPhase + vUv.y * uFlickerRow);
  }

  // SHAPE mask in the ZOOMED feedback space (used by PURE GEO OFF) — the shape
  // SCALES with ZOOM (and follows the rotate/offset of the feedback geometry).
  float maskSource = shapeMask(fbUv);
  // PURE GEO OFF: crop the live SOURCE in the zoomed space so the cropped shape
  // feeds back through the tunnel — zoom-IN spills its content toward the corners
  // (the OUTPUT stays unmasked so the periphery fills), zoom-OUT shrinks it. At
  // SQUARE (maskSource==1) this is a no-op, so the default output is unchanged.
  if (uPureGeo < 0.5) source *= maskSource;

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

  // PURE GEO ON: crop the FINAL OUTPUT in SCREEN space → a FIXED shape that cuts
  // content outside at ALL zooms (the black border feeds back as black, so the
  // crop stays stable frame-to-frame). At SQUARE (maskScreen==1) this is a no-op.
  if (uPureGeo > 0.5) outc *= maskScreen;

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
  // SHAPE geometry mask. `shape` is a discrete index into BACKDRAFT_SHAPES
  // (0=square=full frame). `pureGeo` (0/1) picks the masking SPACE: 1 = screen
  // (fixed shape), 0 = zoomed feedback (shape scales with zoom, spills). Both
  // default to the no-op (square + off). Buttons set them; the gate inputs cycle
  // / toggle them on a rising edge.
  shape: number;     // 0..BACKDRAFT_SHAPE_COUNT-1 (discrete)
  pureGeo: number;   // 0/1
  // Synthetic gate params the shape_gate / pure_geo_gate CV bridge writes (raw
  // 0..1 swing). Hidden — no card knob; the module edge-detects a rising edge to
  // CYCLE shape / TOGGLE pureGeo.
  shapeGate: number;   // 0..1 raw gate sample
  pureGeoGate: number; // 0..1 raw gate sample
  // FLICKER — a DISCRETE index into BACKDRAFT_FLICKER_OPTIONS
  // (0=off, 1=24Hz, 2=50Hz, 3=60Hz). 0 is the no-op identity.
  flicker: number;   // 0..BACKDRAFT_FLICKER_COUNT-1 (discrete)
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
  // SHAPE neutral = square (full frame) + pure-geo OFF → no crop at defaults, so
  // the out-of-box behaviour matches pre-SHAPE backdraft exactly.
  shape: 0,
  pureGeo: 0,
  shapeGate: 0,
  pureGeoGate: 0,
  // FLICKER neutral = OFF (index 0) → the capture-gain block is branch-skipped
  // entirely, so out-of-box output is bit-identical to pre-FLICKER backdraft.
  flicker: 0,
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
 * Pure SHAPE-cycle math: the NEXT shape index after `shape`, wrapping back to 0
 * past the last. The SHAPE button + a rising edge on the shape_gate input both
 * advance via this. Rounds the (possibly fractional) stored value first.
 */
export function backdraftNextShape(shape: number, count: number = BACKDRAFT_SHAPE_COUNT): number {
  return (((Math.round(shape) % count) + count) % count + 1) % count;
}

/**
 * Pure SHAPE-mask value — the exact CPU mirror of the shader's `shapeMask()`.
 * Returns 1.0 INSIDE the shape, 0.0 outside. (The shader adds a sub-pixel
 * antialias band that never affects the inside/corner classification, so the CPU
 * mirror is binary.) Shared so the unit tests + the shader pin one definition of
 * the geometry.
 *
 *   shape 0 (square)            → FULL FRAME: always 1.0 (the no-crop identity).
 *   shape 1 (circle)            → |p| <= R.
 *   shapes 2/3/4 (pentagon/triangle/octagon) → regular n-gon, circumradius R.
 *
 * `p` is the ASPECT-CORRECTED centre-relative coordinate
 *   p = (uv - 0.5) * (aspect, 1),  aspect = frame width / height.
 */
export function backdraftShapeMask(
  u: number,
  v: number,
  shape: number,
  aspect: number,
  radius: number = BACKDRAFT_SHAPE_RADIUS,
): number {
  const s = Math.round(shape);
  if (s <= 0) return 1; // SQUARE = full frame
  const px = (u - 0.5) * aspect;
  const py = v - 0.5;
  const len = Math.hypot(px, py);
  if (s === 1) return len <= radius ? 1 : 0; // circle
  const n = s === 2 ? 5 : s === 3 ? 3 : 8; // pentagon / triangle / octagon
  const apothem = radius * Math.cos(Math.PI / n);
  const ang = Math.atan2(px, py);
  const seg = (2 * Math.PI) / n;
  const d = Math.cos(seg * Math.round(ang / seg) - ang) * len - apothem;
  return d <= 0 ? 1 : 0;
}

/**
 * Normalised sinc, sinc(x) = sin(pi*x)/(pi*x), with sinc(0) = 1.
 *
 * This is the frequency response of a BOXCAR integrator of unit width, and it
 * is why both of the FLICKER model's attenuations are exact rather than fudged:
 * a camera's exposure window and a rolling shutter's readout window are both
 * boxcars in time. sinc(1) = 0 is the flicker-free shutter rule (an exposure
 * exactly one flicker period long sees no flicker at all — shoot 1/50s under
 * 50Hz mains, 1/60s under 60Hz).
 */
export function backdraftSinc(x: number): number {
  const ax = Math.abs(x);
  if (ax < 1e-9) return 1;
  return Math.sin(Math.PI * x) / (Math.PI * x);
}

/** The precomputed per-frame FLICKER scalars handed to the shader. The shader
 *  evaluates exactly one cosine from them:
 *
 *    g(row v) = gain + depth * cos(phase + v * rowPhase)
 */
export interface BackdraftFlickerTerms {
  /** False at the OFF position — the shader branch is skipped entirely. */
  enabled: boolean;
  /** The display's emission frequency in Hz (0 when disabled). */
  hz: number;
  /** A — the operating-point normaliser. Exactly 1 when disabled. */
  gain: number;
  /** A * depth * sinc(f*T_exposure) — the per-ROW modulation amplitude.
   *  Exactly 0 when disabled. */
  depth: number;
  /** 2*pi*f*(t_virtualFrame + T_exposure/2), wrapped into [0, 2*pi).
   *  Wrapped on the CPU (float64) so the shader's float32 cos never loses
   *  precision as the simulation clock grows. */
  phase: number;
  /** 2*pi*f*T_readout — how far the flicker phase drifts from the bottom row
   *  to the top row (the rolling-shutter band spread, in radians). */
  rowPhase: number;
  /** The FRAME-MEAN gain this frame (the row average of g). The CPU mirror of
   *  what the shader's per-row gain averages to; the extra sinc(f*T_readout)
   *  factor is the rolling shutter partially washing the whole-frame pulse out.
   *  Exactly 1 when disabled. */
  meanGain: number;
}

/**
 * THE FLICKER MODEL — pure, deterministic, frame-rate independent.
 *
 * Given the discrete FLICKER knob index and the accumulated SIMULATION time,
 * return the scalars the shader needs to reproduce
 *
 *   g(t, v) = A * [ 1 + m*sinc(f*T_e) * cos(2*pi*f*(t_n + T_e/2) + 2*pi*f*T_ro*v) ]
 *
 * where
 *   f    = the display's emission frequency (BACKDRAFT_FLICKER_HZ[index]),
 *   m    = BACKDRAFT_FLICKER_DEPTH (emission modulation depth),
 *   T_e  = BACKDRAFT_FLICKER_SHUTTER / fps  (exposure window; 180-degree shutter),
 *   T_ro = BACKDRAFT_FLICKER_READOUT / fps  (rolling-shutter readout),
 *   t_n  = floor(t*fps)/fps  — the VIRTUAL CAMERA frame grid,
 *   A    = 2/(1 + sqrt(1 - a^2)),  a = m*sinc(f*T_e)*sinc(f*T_ro).
 *
 * Three properties this function is unit-tested for, each load-bearing:
 *
 *  1. OFF is EXACT. index 0 returns { enabled:false, gain:1, depth:0,
 *     meanGain:1 } with no float slop, and the shader branch-skips it, so the
 *     default output is bit-identical to pre-FLICKER backdraft.
 *  2. The BEAT is quantised to the fixed `fps` virtual-camera grid, NOT to the
 *     real render rate. Without this a 120Hz ProMotion display would sample the
 *     50Hz emission at 120Hz and see a 50Hz beat instead of a 10Hz one — same
 *     knob, different look, and tests would diverge from users.
 *  3. The exposure boxcar contributes exactly sinc(f*T_e), so an exposure that
 *     is a whole number of flicker periods kills the flicker completely — the
 *     real flicker-free-shutter rule, reproduced rather than approximated.
 *
 * `A` exists because a multiplicative loop cares about the GEOMETRIC mean of
 * its gain, and a gain with arithmetic mean 1 has geometric mean < 1 (AM-GM).
 * Without A, switching FLICKER on would silently damp the loop and the user
 * would have to re-hunt their FEEDBACK setting; a real operator compensates by
 * reopening the iris, and A is that compensation folded in. It is the exact
 * closed form of exp(-mean(log(1 + a*cos))).
 *
 * @param flicker  the FLICKER param (a discrete index; rounded + clamped).
 * @param timeSec  accumulated SIMULATION time in seconds (frame.time).
 * @param fps      the virtual camera's FIXED frame rate.
 */
export function backdraftFlickerTerms(
  flicker: number,
  timeSec: number,
  fps: number = BACKDRAFT_FPS,
): BackdraftFlickerTerms {
  const OFF: BackdraftFlickerTerms = {
    enabled: false, hz: 0, gain: 1, depth: 0, phase: 0, rowPhase: 0, meanGain: 1,
  };
  const idx = Math.max(0, Math.min(BACKDRAFT_FLICKER_COUNT - 1, Math.round(flicker)));
  const hz = BACKDRAFT_FLICKER_HZ[idx] ?? 0;
  if (idx <= 0 || hz <= 0 || !(fps > 0)) return OFF;

  const expose = BACKDRAFT_FLICKER_SHUTTER / fps; // T_e
  const readout = BACKDRAFT_FLICKER_READOUT / fps; // T_ro
  const sExpose = backdraftSinc(hz * expose);
  const sReadout = backdraftSinc(hz * readout);

  // Per-row modulation depth (exposure boxcar only) and the FRAME-MEAN depth
  // (the rolling shutter's row average adds the second sinc).
  const rowDepth = BACKDRAFT_FLICKER_DEPTH * sExpose;
  const meanDepth = BACKDRAFT_FLICKER_DEPTH * sExpose * sReadout;

  // Operating-point normaliser: geometric mean of the frame-mean gain == 1.
  const a = Math.min(0.999999, Math.abs(meanDepth));
  const gain = 2 / (1 + Math.sqrt(1 - a * a));

  // VIRTUAL CAMERA sampling grid — quantise simulation time to whole frames
  // before taking the phase. This is what fixes the beat frequency on every
  // machine regardless of the real render rate (property 2 above).
  const n = Math.floor(Math.max(0, timeSec) * fps);
  const tn = n / fps;

  // Phase at the CENTRE of the exposure window (the boxcar's group delay),
  // wrapped in float64 so the shader's float32 cos stays precise forever.
  const TWO_PI = Math.PI * 2;
  const raw = TWO_PI * hz * (tn + expose / 2);
  const phase = raw - TWO_PI * Math.floor(raw / TWO_PI);
  const rowPhase = TWO_PI * hz * readout;

  // The row average of gain + gain*rowDepth*cos(phase + v*rowPhase) over
  // v in [0,1] is gain*(1 + meanDepth*cos(phase + rowPhase/2)).
  const meanGain = gain * (1 + meanDepth * Math.cos(phase + rowPhase / 2));

  return {
    enabled: true,
    hz,
    gain,
    depth: gain * rowDepth,
    phase,
    rowPhase,
    meanGain,
  };
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
    // SHAPE gate inputs — gate/clock style (NO cvScale => raw passthrough). A
    // RISING edge on shape_gate CYCLES the shape; on pure_geo_gate TOGGLES the
    // pure-geometry masking space. The module edge-detects them.
    { id: 'shape_gate',    type: 'cv', paramTarget: 'shapeGate' },
    { id: 'pure_geo_gate', type: 'cv', paramTarget: 'pureGeoGate' },
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
    // SHAPE geometry mask. `shape` is a DISCRETE index (0=square=full frame …
    // 4=octagon); the SHAPE button + shape_gate cycle it. `pureGeo` (0/1) picks
    // the masking space; the PURE GEO button + pure_geo_gate toggle it.
    { id: 'shape',   label: 'Shape',    defaultValue: DEFAULTS.shape,   min: 0, max: BACKDRAFT_SHAPE_COUNT - 1, curve: 'discrete' },
    { id: 'pureGeo', label: 'Pure Geo', defaultValue: DEFAULTS.pureGeo, min: 0, max: 1, curve: 'linear' },
    // Synthetic gate params the shape_gate / pure_geo_gate bridge writes — hidden
    // (no card knob); the module edge-detects a rising edge to CYCLE / TOGGLE.
    { id: 'shapeGate',   label: 'Shape Gate',   defaultValue: DEFAULTS.shapeGate,   min: 0, max: 1, curve: 'linear' },
    { id: 'pureGeoGate', label: 'PureGeo Gate', defaultValue: DEFAULTS.pureGeoGate, min: 0, max: 1, curve: 'linear' },
    // FLICKER — a DISCRETE 4-position index (0=off, 1=24Hz, 2=50Hz, 3=60Hz)
    // modelling the display's pulsed emission as our virtual camera captures
    // it. 0 = OFF is the bit-identical no-op default.
    { id: 'flicker', label: 'Flicker', defaultValue: DEFAULTS.flicker, min: 0, max: BACKDRAFT_FLICKER_COUNT - 1, curve: 'discrete' },
    // freeze is a hidden VRT/determinism toggle — no card control.
    { id: 'freeze',   label: 'Freeze',   defaultValue: DEFAULTS.freeze,   min: 0,  max: 1,                     curve: 'linear' },
  ],

  // docs-hash-ignore:start
  docs: {
    explanation: `BACKDRAFT is a video feedback generator. It builds a "source" image by crossfading two video inputs (IN A / IN B) with MIX, then composites that against a processed copy of its OWN previous output, read from an internal ring of past frames so there is no live GL feedback loop (downstream sees frame N while the tap reads N-1..N-30). The fed-back frame is delayed (DELAY, 0-500ms or a clock pulse), colour-processed (per-channel R/G/B gain, then LUMA brightness, then CHROMA saturation), scaled per-pixel by two key masks (KEY+ lightens / KEY- darkens the effect), and geometrically warped a little each pass (ZOOM/ROTATE/OFF X/OFF Y) so the transform COMPOUNDS into tunnels, spirals, and directional trails. Two MIRROR buttons fold the whole composited frame into a kaleidoscope. A SHAPE button cuts the frame to a geometric mask (square = full frame, then circle / pentagon / triangle / octagon), and a PURE GEO button picks the masking SPACE: ON masks the FINAL OUTPUT in screen space (a fixed shape that cuts everything outside it at all zooms), OFF masks the SOURCE in the zoomed feedback space so the shape scales with ZOOM and its content spills out through the feedback tunnel (zoom-in pushes it toward the corners, zoom-out shrinks it). As FEEDBACK approaches its max (and a spatial transform is active) the additive trail-accumulator ramps into a pure recursive hall of mirrors. A FLICKER control (OFF / 24 / 50 / 60 Hz) models the display's pulsed emission as the virtual camera actually captures it: the emission rate beats against the camera's 60 fps sampling, so the per-frame loop gain oscillates around unity instead of being constant, and light can build up over several frames and then fade away rather than pinning at white — with a rolling-shutter band crawling down the frame at the beat rate. Usage: patch a camera or generator into IN A, raise FEEDBACK toward ~1 and nudge ZOOM off 1.0 (with a little ROTATE) for the classic infinite-tunnel look; add OFF X/Y for smear, PIXELATE for blocky lo-fi, a SHAPE for a geometric vignette, and clock DELAY CLK for rhythmic echo. Output is the OUT video jack. The card shows a large live video preview on the left that is resizable via the bottom-right corner-drag handle (width/height persist, snapped to rack tiles); right-click the preview for Full Frame / Full Screen / Present-on-another-display.`,
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
      shape_gate: "Gate/clock input (raw passthrough, edge-detected). A RISING edge CYCLES the Shape mask to the next geometry (square → circle → pentagon → triangle → octagon → square). Edge-triggered, not a held level.",
      pure_geo_gate: "Gate/clock input (raw passthrough, edge-detected). A RISING edge TOGGLES the Pure Geo masking space (screen-space crop ↔ zoomed-source crop). Edge-triggered, not a held level.",
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
      zoom: "Zoom (0.4..1.6, default 1.0): per-pass scale of the feedback tap about centre. <1 makes echoes recede (expanding tunnel), >1 magnifies them (zoom-in tunnel); 1 = no tunnel.",
      rotate: "Rot / Rotate (-30..+30 °, default 0): per-pass rotation of the feedback tap about centre. Combined with Zoom≠1 the echoes twist into a spiral; 0 = no spiral.",
      offsetX: "OffX / Off X (-0.1..+0.1, default 0): per-pass horizontal translation (UV units) of the feedback tap, making a directional trail/smear; 0 = none.",
      offsetY: "OffY / Off Y (-0.1..+0.1, default 0): per-pass vertical translation (UV units) of the feedback tap, making a directional trail/smear; 0 = none.",
      delayClock: "Delay Clk (0..1, default 0): hidden synthetic param the DELAY CLK CV bridge writes (raw gate swing). No card knob; the module edge-detects it to measure the pulse period that overrides the Delay control.",
      mirrorX: "Mirror X (0/1, default 0): kaleidoscope toggle that folds the left half of the composited output over the right. Set by the MIRROR X button or flipped by a rising edge on mirror_x_gate.",
      mirrorY: "Mirror Y (0/1, default 0): kaleidoscope toggle that folds the top half of the output over the bottom (both on = a 4-way quadrant fold). Set by the MIRROR Y button or flipped by mirror_y_gate.",
      mirrorXGate: "Mir X Gate (0..1, default 0): hidden synthetic param the mirror_x_gate CV bridge writes (raw gate swing). No card knob; a rising edge flips Mirror X.",
      mirrorYGate: "Mir Y Gate (0..1, default 0): hidden synthetic param the mirror_y_gate CV bridge writes (raw gate swing). No card knob; a rising edge flips Mirror Y.",
      shape: "Shape (discrete 0..4, default 0 = square): the geometric mask cut over the frame — square (full frame, no crop), circle, pentagon, triangle, octagon. The SHAPE button cycles it; shape_gate cycles it on a rising edge.",
      pureGeo: "Pure Geo (0/1, default 0 = off): the SHAPE masking SPACE. ON masks the FINAL OUTPUT in screen space (a fixed shape that cuts content outside it at all zooms); OFF masks the SOURCE in the zoomed feedback space, so the shape scales with Zoom and its content spills out through the feedback tunnel. The PURE GEO button toggles it; pure_geo_gate toggles it on a rising edge.",
      shapeGate: "Shape Gate (0..1, default 0): hidden synthetic param the shape_gate CV bridge writes (raw gate swing). No card knob; a rising edge cycles Shape.",
      pureGeoGate: "PureGeo Gate (0..1, default 0): hidden synthetic param the pure_geo_gate CV bridge writes (raw gate swing). No card knob; a rising edge toggles Pure Geo.",
      flicker: "Flicker (discrete OFF / 24 / 50 / 60, default OFF): models the fact that a real display emits light in PULSES rather than continuously, and that the camera integrates over an exposure window shorter than the pulse period and samples at its own frame rate. The two rates BEAT, so the per-frame loop gain cycles above and below its own average instead of being constant — which is what lets pulses of light build up over several frames and then fade away rather than saturating to white and staying there. OFF is the exact no-op (the shader branch is skipped, output is bit-identical). The virtual camera runs at a fixed 60 fps, so the beat against it is 24 Hz at the 24 position (2.5 frames per cycle — a hard strobe), 10 Hz at 50 (6 frames per cycle — the cleanest build-and-fade pulsing, and the classic look of filming a PAL monitor with an NTSC camera), and 0.06 Hz at 60 (the 60 position is the true NTSC field rate 60000/1001 = 59.94 Hz, giving a ~16.7-second slow breathe — the slowly crawling hum bar you see filming a television; exactly 60.000 would genlock to a constant gain and not move at all). A 180-degree shutter (1/120 s) sets how much of each pulse is caught, and a rolling shutter spreads the flicker phase down the frame, so a soft light/dark band crawls vertically at the beat rate and feeds back through the loop. The loop's average gain is held constant as you switch positions, so the FB control keeps meaning the same thing.",
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
    const uShape = u('uShape');
    const uPureGeo = u('uPureGeo');
    const uAspect = u('uAspect');
    const uFlickerOn = u('uFlickerOn');
    const uFlickerGain = u('uFlickerGain');
    const uFlickerDepth = u('uFlickerDepth');
    const uFlickerPhase = u('uFlickerPhase');
    const uFlickerRow = u('uFlickerRow');

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

    // ── SHAPE / PURE GEO gate tracking ────────────────────────────────
    // A rising edge on shape_gate CYCLES the shape; on pure_geo_gate TOGGLES
    // pureGeo. Same edge-detect convention as the mirror gates; the bridge only
    // writes while patched, so an unpatched gate never spuriously fires.
    const shapeGate = makeEdgeState();
    const pureGeoGate = makeEdgeState();

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

        // SHAPE gate: a rising edge CYCLES the shape. PURE GEO gate: a rising
        // edge TOGGLES the masking space. The button/UI reflects the resulting
        // (possibly gate-driven) state because we mutate the shared `params`.
        if (detectEdge(shapeGate, params.shapeGate)?.pressed) {
          params.shape = backdraftNextShape(params.shape);
        }
        if (detectEdge(pureGeoGate, params.pureGeoGate)?.pressed) {
          params.pureGeo = params.pureGeo >= 0.5 ? 0 : 1;
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

        // SHAPE geometry mask. Round the discrete shape index, pass pureGeo as a
        // 0/1 flag, and the frame aspect so circles/polygons stay un-stretched.
        g.uniform1f(uShape, Math.max(0, Math.min(BACKDRAFT_SHAPE_COUNT - 1, Math.round(params.shape))));
        g.uniform1f(uPureGeo, params.pureGeo >= 0.5 ? 1.0 : 0.0);
        g.uniform1f(uAspect, ctx.res.height > 0 ? ctx.res.width / ctx.res.height : 1.0);

        // FLICKER — the virtual camera's capture gain for this frame. Derived
        // from `frame.time` (the engine's accumulated SIMULATION clock, the
        // repo's Idiom-A pattern and the one clock `__videoEngineFreezeTime`
        // pins) and quantised inside backdraftFlickerTerms() onto the FIXED
        // BACKDRAFT_FPS virtual-camera grid — so the beat is the same on a
        // 60Hz panel, a 120Hz ProMotion panel, and SwiftShader on CI. At OFF
        // this is { on: 0, gain: 1, depth: 0 } and the shader branch-skips the
        // whole block, so the output stays bit-identical.
        const flick = backdraftFlickerTerms(params.flicker, frame.time);
        g.uniform1f(uFlickerOn, flick.enabled ? 1.0 : 0.0);
        g.uniform1f(uFlickerGain, flick.gain);
        g.uniform1f(uFlickerDepth, flick.depth);
        g.uniform1f(uFlickerPhase, flick.phase);
        g.uniform1f(uFlickerRow, flick.rowPhase);

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
