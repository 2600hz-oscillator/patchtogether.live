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
//   STORAGE      multi-frame sensor integration =>  depth *= |H(w_beat)|
//   rolling sh.  row v starts at t + v*T_ro  =>  phase varies DOWN the frame
//   sampling     evaluate at t_n = floor(t*f_cam)/f_cam  =>  beat = alias of f
//   SHOULDER     the captured light saturates (sensor + monitor I_sat)
//
//   g(t, v) = A * [ 1 + m*sinc(f*T_e)*|H| * cos(2*pi*f*(t_n + T_e/2) + argH
//                                               + 2*pi*f*T_ro*v) ]
//   captured = shoulder(fb * g)
//
// The exposure boxcar contributes EXACTLY a sinc(f*T_e) attenuation — so
// sinc(1) = 0 reproduces the flicker-free shutter rule (shoot 1/50s under
// 50Hz) for free, and we unit-test that. A is an operating-point normaliser
// that keeps the frame-mean gain's GEOMETRIC mean at 1 (a multiplicative loop
// cares about the geometric mean, and an arithmetic-mean-1 gain has geometric
// mean < 1 by AM-GM), so switching FLICKER on does not silently damp the loop
// and re-tuning FEEDBACK is unnecessary.
//
// ── WHY v1 STROBED, AND WHAT |H| AND THE SHOULDER FIX ─────────────────
// v1 shipped exactly the first model and applied it as a LINEAR, FULL-DEPTH
// multiplier on the whole feedback tap. Measured on the row-aware loop mirror
// that backdraft.test.ts runs as a NEGATIVE CONTROL (identity transform,
// source = 0.06, FEEDBACK = 1.0, settled tail), v1's FULL-FIELD frame-to-frame
// luminance step was 0.469 at 6 Hz, 0.463 at 24 and 0.312 at 50 — three to five
// times WCAG 2.3.1's general flash threshold (a pair of opposing changes of
// >=0.10 relative luminance), and its full-field peak-to-peak reached 0.91.
// That is a photic strobe, not video feedback.
//
// The reason is NOT the emission physics, which v1 got right. It is that v1
// modelled emission -> exposure -> sampling faithfully and then skipped
// everything DOWNSTREAM of the sensor. Two downstream stages do essentially all
// of the softening in a real rig, and v1 had neither:
//
//  1. STORAGE. Crutchfield's Appendix A puts the loop's bandwidth ceiling at
//     ~3 Hz because the camera's own charge storage integrates ~10 raster times
//     ("and this is what is observed experimentally"). His eq. (4) carries it
//     as (I_n)_tau = sum_i I_{n-i} * L^i. A real loop physically CANNOT strobe.
//     v1 read the same passage and drew the opposite conclusion — that a modern
//     CMOS sensor has no such storage, so the flicker term dominates. Both
//     halves are true, and together they are the bug: deleting the integrator
//     is precisely why naive digital feedback reads harsh, so the fix is to put
//     it BACK rather than to add an LFO on top of its absence.
//     |H(w)| = (1-L)/|1 - L*e^{-iw}| at the BEAT frequency, so it cuts the fast
//     beats hard (6 Hz -> 0.16, 24 Hz -> 0.05, 10 Hz -> 0.10) and passes the
//     slow ones untouched (0.06 Hz -> 0.998). The fast positions become soft
//     shimmer; the slow positions keep their full breathing swing.
//
//  2. SHOULDER. A saturating capture curve makes the response LEVEL-DEPENDENT,
//     so the beat stops acting where the image is already hot and keeps acting
//     in the midtones — full-field flash becomes contour shimmer. It is also
//     the loop's only real amplitude limiter; clamp() alone is a hard clip that
//     is perfectly linear right up until it pins.
//
// Together these take the worst position from 0.469 to 0.066 (7.1x; 24 Hz
// improves 19x and 50 Hz 10x), comfortably inside WCAG, with NO arbitrary safety
// clamp anywhere — every term
// is a physical mechanism the literature documents. Two mechanisms were tested
// and REJECTED on the evidence: spatial diffusion (the Laplacian has eigenvalue
// zero on the uniform mode, so blur cannot damp a full-field pulse at all — the
// sim confirmed it changes the metric by <0.0005) and an AGC servo (absent from
// the primary source, and its sensitivity function passes exactly the fast
// beats that need taming). The research doc's SECTION 7 is the full v1 -> v2
// accounting: every mechanism considered, the per-position character notes, and
// the 59.94/119.88 genlock decisions.
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

/** FLICKER — the display's pulse rate, in the EXACT order the knob's 6
 *  positions sit in. Index 0 is OFF (the no-op identity), so the DEFAULT
 *  output is bit-identical to pre-FLICKER backdraft. */
export const BACKDRAFT_FLICKER_OPTIONS = ['off', '6', '24', '50', '60', '120'] as const;
export type BackdraftFlickerOption = (typeof BACKDRAFT_FLICKER_OPTIONS)[number];
export const BACKDRAFT_FLICKER_COUNT = BACKDRAFT_FLICKER_OPTIONS.length; // 6

/** Emission frequency in Hz for each knob position. 0 = OFF (no flicker).
 *
 *  The "60" position is 60000/1001 = 59.94 Hz, the REAL NTSC field rate — not
 *  60.000, and "120" is 2x that (119.88 Hz). Modelling either as an exact
 *  multiple of the 60 fps virtual camera would GENLOCK it — the camera would
 *  sample one identical phase forever, the gain would be a CONSTANT, and the
 *  position would behave as a dumb attenuator with no motion at all. The NTSC
 *  numbers are both more correct AND the ones that actually crawl.
 *
 *  6 = sub-refresh: no display refreshes this slowly, so this position models a
 *  slow strobe / BFI / dimmer. It is BELOW the camera rate, so there is no
 *  aliasing — the camera sees the pulsing DIRECTLY at 10 frames per cycle.
 *  24 = cinema. 50 = PAL/SECAM field rate + 50 Hz mains. 120 = a 120 Hz panel
 *  (or double-strobed 60).
 *
 *  Beats against the 60 Hz virtual camera, |f - round(f/60)*60|:
 *    6      -> 6 Hz      (10 frames/cycle — direct, slow breathing)
 *    24     -> 24 Hz     (2.5 frames/cycle)
 *    50     -> 10 Hz     (6 frames/cycle)
 *    59.94  -> 0.06 Hz   (~1000 frames/cycle — a slow swell)
 *    119.88 -> 0.12 Hz   (~500 frames/cycle) */
export const BACKDRAFT_FLICKER_HZ: readonly number[] = [
  0, 6, 24, 50, 60000 / 1001, (2 * 60000) / 1001,
];

/** Display emission modulation depth (0..1). Not 1.0 — a real display does not
 *  reach exactly zero between pulses; phosphor persistence / backlight tail
 *  leave a floor. 0.85 leaves a 15% floor. */
export const BACKDRAFT_FLICKER_DEPTH = 0.85;
/** Camera exposure time as a fraction of the virtual camera's frame period.
 *  0.25 = a 90-degree shutter (1/240 s at 60 fps).
 *
 *  v1 used 0.5 (a 180-degree shutter, 1/120 s). That is EXACTLY one period of
 *  120 Hz flicker, so sinc(f*T_e) = sinc(1) = 0 and the 120 position would be
 *  PERFECTLY DEAD — the flicker-free-shutter rule biting at full strength. A
 *  shorter shutter is also what a real camera picks when it is pointed at a
 *  bright screen (auto-exposure stops down), so 0.25 is both the physically
 *  natural choice for this rig and the one that leaves every position alive. */
export const BACKDRAFT_FLICKER_SHUTTER = 0.25;
/** Rolling-shutter readout time as a fraction of the frame period — how far
 *  the flicker phase drifts DOWN the frame. 0.5 = mid-range CMOS (real sensors
 *  span ~0.15 for fast stacked sensors to ~1.0 for cheap ones). It is a genuine
 *  trade-off: 0 is a global shutter (full mean pulsing, no bands), while
 *  readout = f_cam/f zeroes the mean-gain sinc and gives pure STANDING bands
 *  with no pulsing at all. At the 120 position f*T_ro is almost exactly 1, so
 *  the rolling shutter cancels the FULL-FIELD pulse essentially completely and
 *  leaves a pure crawling band — one full band cycle down the frame. */
export const BACKDRAFT_FLICKER_READOUT = 0.5;

/** Camera STORAGE time constant, in virtual-camera frames — the sensor's own
 *  multi-frame charge storage and integration.
 *
 *  This is the single biggest thing v1 was missing, and it is the mechanism
 *  Crutchfield 1984 (Appendix A, p.244) identifies as setting the loop's whole
 *  temporal character:
 *
 *    "the charge storage and integration during each raster time places an
 *     upper limit on the temporal frequency response of the system. In fact,
 *     this storage time tau_s can be quite a bit longer than the raster time
 *     tau_r ... A rough approximation to this would be tau_s ~ 10 tau_r ~ 1/3
 *     second. Thus the system's frequency response should always be slower
 *     than 3 Hz. And this is what is observed experimentally."
 *
 *  A REAL camera-into-monitor loop is bandwidth-limited to a few Hz by the
 *  camera itself, which is why it BREATHES rather than strobes. Modern CMOS
 *  sensors engineer this lag away, so a naive digital feedback loop deletes the
 *  largest softening element in the classic rig — and v1 deleted it and then
 *  added a full-depth gain LFO on top. 10 frames is Crutchfield's own figure.
 *
 *  We apply it in CLOSED FORM (see backdraftStorageResponse) rather than with a
 *  real accumulator, so it stays pure, stateless and bit-deterministic. */
export const BACKDRAFT_FLICKER_STORAGE_FRAMES = 10;

/** Knee of the capture SHOULDER — the sensor/monitor saturating nonlinearity.
 *
 *  Crutchfield, Appendix A: the vidicon photoconductor "response function
 *  saturates above some intensity threshold I_sat", and "within the monitor
 *  there are saturating nonlinearities in its response to large intensity
 *  signals and high brightness or high contrast settings". He lists these as
 *  errors excluded from his model "for simplicities sake" — but in a loop that
 *  saturation is the ONLY amplitude limiter, and a bare clamp() is not it.
 *
 *  Below the knee the capture is EXACTLY the identity; above it the response
 *  rolls off exponentially toward 1.0 with unit slope at the knee (C1). Because
 *  the incremental response falls to ~0 as a region approaches white, a gain
 *  modulation stops acting where the image is already hot and keeps acting in
 *  the midtones: the beat reads as CONTOUR shimmer instead of a full-field
 *  flash. (A bare gamma/power law would NOT do this — a power law is
 *  scale-free, so d(log out)/d(log in) is the same at every brightness.) */
export const BACKDRAFT_FLICKER_KNEE = 0.55;

// ── PURE TV — the bounded-screen (Crutchfield) map ─────────────────────
//
// Everything above builds an INFINITE PLANE: the live source is added to every
// pixel (`additive` in the shader) and the previous frame is defined everywhere
// (CLAMP_TO_EDGE on the ring textures). Neither condition can produce a NEST,
// because a nest needs a region that is NOT the picture.
//
// PURE TV replaces the composite with the map Crutchfield actually writes down
// (Physica D 10 (1984) 229-245, p.235: "b corresponds to the zoom control. If
// x' = bRx lies outside of R^2 then I_n(x') = 0" — a DIRICHLET-ZERO boundary,
// not a clamp). One pass places a copy of the ENTIRE previous frame — room,
// bezel and picture — inside a bounded SCREEN rectangle S:
//
//   d < 0        PICTURE : g * prev(A^-1 x)     the tube
//   0 <= d < tb  BEZEL   : room-lit dark plastic
//   d >= tb      ROOM    : the live input + an ambient floor
//
// so the frame contains S ⊋ T(S) ⊋ T²(S) ⊋ …, each delimited by its own bezel
// band. The nesting is forced by the geometry, not tuned. IN PURE TV YOUR INPUT
// IS THE ROOM, NOT THE PICTURE — the picture is the feedback.
//
// Design + adversarial review: .myrobots/plans/backdraft-pure-tv-2026-07-27.md.

/**
 * THE TEXTURE-UNIT MAP, as data, because a collision here is SILENT.
 *
 * The main composite binds units 0-6 and its `uniform1i` sampler bindings stay
 * live across the whole of draw(). The auto-exposure servo's two passes run in
 * the MIDDLE of that, between the main program's texture setup and its
 * drawFullscreenQuad — so any unit they touch that the main program is also
 * using is silently swapped out from under it. That really happened: the servo
 * originally used units 0 and 1 and quietly replaced the live IN A / IN B
 * source with the reduce input, which shows up as a wrong-looking room rather
 * than as an error.
 *
 * Any new pass MUST take a unit from the free end and be added here;
 * `backdraft-tv.test.ts` asserts the map stays disjoint.
 */
export const BACKDRAFT_TEXTURE_UNITS = {
  /** main composite */
  a: 0, b: 1, fb: 2, lighten: 3, darken: 4, persist: 5,
  /** the VIRTUAL REFRESH's older field (frame n-d-1) */
  fbPrev: 6,
  agcState: 7,
  /** auto-exposure servo passes — deliberately ABOVE the main program's range */
  agcReduceSrc: 8, agcPrevState: 9,
} as const;

/** TV MODE positions: 0 = OFF (the legacy composite), 1 = PURE TV (the
 *  bounded-screen nest, a strict contraction), 2 = CRITICAL (the same geometry
 *  with the auto-exposure servo, which is where the time lives). */
export const BACKDRAFT_TV_MODE_COUNT = 3;
export const BACKDRAFT_TV_MODE_LABELS = ['OFF', 'VIRTUAL CAMERA', 'CRITICAL'] as const;

/** Cycle the TV MODE — the card button and a tv_gate rising edge share this. */
export function backdraftNextTvMode(mode: number): number {
  const m = Math.round(mode);
  return !Number.isFinite(m) || m < 0 ? 1 : (m + 1) % BACKDRAFT_TV_MODE_COUNT;
}

// ── VIRTUAL CAMERA ORIENTATION ─────────────────────────────────────────
//
// Until now the virtual camera has been welded dead-on: the map from the
// previous frame to the screen was AFFINE (scale, roll, translate), which is
// exactly what a camera square-on to the set sees. Pointing it from anywhere
// else needs a PERSPECTIVE map — a homography — because an off-axis rectangle
// images as a trapezoid, and the trapezoid is then re-imaged by every pass.
//
// The model is an ordinary pinhole. The screen is a rectangle on the plane
// z = 0; the camera sits at (posX, posY, -dist), tilted by (tiltX, tiltY):
//
//   W = (s * R(phi) * p, 0)          the previous frame, placed on the screen
//   V = Rt^T * (W - C)               into camera space
//   q = dist * (V.x/V.z, V.y/V.z)    project
//
// DEGENERACY IS LOAD-BEARING: at tilt 0 and pos 0 this reduces ALGEBRAICALLY to
// q = s*R(phi)*p — the existing affine map, for ANY distance. So the shipped
// look, and every N-series assertion about it, is untouched by default, and
// `dist` only does anything once the camera is actually off-axis. Asserted in
// the tests rather than trusted.
//
// Re-aiming the camera MOVES THE VANISHING POINT: the nest's accumulation point
// is the fixed point of the map, so tilting or sliding the camera re-composes
// the whole frame-in-frame-in-frame instead of merely translating it. And since
// the map is ITERATED, that re-composition RECURSES — the move reaches level k
// only after k*DELAY frames, so a camera gesture travels inward through the
// network the same way room motion and the refresh seam do. (V9 pins it: dead-on
// accumulates dead centre, every tilt gives its own framing.)
//
// The design plan (§2.4) parked perspective as "phase 3 at the earliest"
// because it "compounds into an unreadable smear within ~6 levels". That is a
// real effect and it is NOT a defect: a camera at an angle to a set genuinely
// produces a nest that keystones and curls away toward the vanishing point,
// which is what off-axis video feedback looks like. It does mean deep levels go
// illegible faster than dead-on, so the readable-depth readout accounts for it.

/** The joysticks' own travel. Constrained deliberately: at full swing the
 *  keystone compounds so hard that the nest is unreadable within a couple of
 *  levels, so the controls stop where the picture is still worth looking at.
 *  Tilt reaches +-0.2 * 60 = +-12 deg, position +-0.5 * 1.5 = +-0.75 frame
 *  half-widths — still enough to sit outside the screen's edge. */
export const BACKDRAFT_CAM_TILT_RANGE = 0.2;
export const BACKDRAFT_CAM_POS_RANGE = 0.5;

/** Maximum camera tilt, degrees, at a FULL-SCALE (+-1) joystick value. Beyond ~60 deg the
 *  screen's far edge approaches the horizon and the nest degenerates into a
 *  sliver, so the range stops where the image is still worth looking at. */
export const BACKDRAFT_CAM_TILT_MAX_DEG = 60;
/** Camera translation at the joystick's extreme, in frame half-widths — 1.5
 *  puts the camera comfortably BEYOND the screen's borders, which is what the
 *  control is for. */
export const BACKDRAFT_CAM_POS_MAX = 1.5;
/** Camera distance at DIST 0 and 1. Short = wide-angle: a given tilt keystones
 *  violently and the nest curls hard. Long = telephoto: the same tilt barely
 *  skews it. This is the fader's whole job, so it spans a wide ratio. */
export const BACKDRAFT_CAM_DIST_MIN = 0.7;
export const BACKDRAFT_CAM_DIST_MAX = 9;

/** DIST knob -> camera distance. Geometric, so equal knob steps are equal
 *  FACTORS — perspective strength is a ratio, not an offset. */
export function backdraftCamDistance(dist: number): number {
  const d = Math.max(0, Math.min(1, dist));
  return BACKDRAFT_CAM_DIST_MIN
    * Math.pow(BACKDRAFT_CAM_DIST_MAX / BACKDRAFT_CAM_DIST_MIN, d);
}

/** 3x3 row-major multiply. */
function mat3Mul(a: readonly number[], b: readonly number[]): number[] {
  const o = new Array<number>(9).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      let v = 0;
      for (let k = 0; k < 3; k++) v += a[r * 3 + k]! * b[k * 3 + c]!;
      o[r * 3 + c] = v;
    }
  }
  return o;
}

/** 3x3 inverse. Returns null when singular (the camera is edge-on). */
function mat3Inv(m: readonly number[]): number[] | null {
  const [a, b, c, d, e, f, g, h, i] = m as unknown as number[];
  const A = e! * i! - f! * h!, B = -(d! * i! - f! * g!), C = d! * h! - e! * g!;
  const det = a! * A + b! * B + c! * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  return [
    A * inv, (c! * h! - b! * i!) * inv, (b! * f! - c! * e!) * inv,
    B * inv, (a! * i! - c! * g!) * inv, (c! * d! - a! * f!) * inv,
    C * inv, (b! * g! - a! * h!) * inv, (a! * e! - b! * d!) * inv,
  ];
}

export interface BackdraftCamOrientation {
  /** -1..1 joystick, yaw — swings the camera left/right of the screen normal. */
  tiltX?: number;
  /** -1..1 joystick, pitch — swings it above/below. */
  tiltY?: number;
  /** -1..1 joystick, translation in the camera's own plane. */
  posX?: number;
  posY?: number;
  /** 0..1 fader -> camera distance (perspective strength). */
  dist?: number;
}

/**
 * The INVERSE homography the shader applies: camera-frame coordinate q ->
 * screen-plane coordinate p, in homogeneous form (row-major mat3).
 *
 * Returns the exact affine inverse when the camera is dead-on, so the default
 * path is bit-for-bit the map BACKDRAFT already had.
 */
export function backdraftCamInverseHomography(
  o: BackdraftCamOrientation,
  fill: number,
  rotateDeg: number,
): number[] {
  const s = Math.max(1e-4, fill);
  const th = (rotateDeg * Math.PI) / 180;
  const cs = Math.cos(th), sn = Math.sin(th);
  const R = BACKDRAFT_CAM_TILT_RANGE, P = BACKDRAFT_CAM_POS_RANGE;
  const tx = (Math.max(-R, Math.min(R, o.tiltX ?? 0)) * BACKDRAFT_CAM_TILT_MAX_DEG * Math.PI) / 180;
  const ty = (Math.max(-R, Math.min(R, o.tiltY ?? 0)) * BACKDRAFT_CAM_TILT_MAX_DEG * Math.PI) / 180;
  const cx = Math.max(-P, Math.min(P, o.posX ?? 0)) * BACKDRAFT_CAM_POS_MAX;
  const cy = Math.max(-P, Math.min(P, o.posY ?? 0)) * BACKDRAFT_CAM_POS_MAX;
  const D = backdraftCamDistance(o.dist ?? 0.5);

  // A: (p,1) -> (W - C), with the screen's own scale + roll folded in.
  const A = [
    s * cs, -s * sn, -cx,
    s * sn, s * cs, -cy,
    0, 0, D,
  ];
  // Camera rotation R = Ry(tiltX) * Rx(tiltY); we need R^T.
  const cx1 = Math.cos(tx), sx1 = Math.sin(tx);
  const cy1 = Math.cos(ty), sy1 = Math.sin(ty);
  const Ry = [cx1, 0, sx1, 0, 1, 0, -sx1, 0, cx1];
  const Rx = [1, 0, 0, 0, cy1, -sy1, 0, sy1, cy1];
  const Rm = mat3Mul(Ry, Rx);
  const Rt = [Rm[0]!, Rm[3]!, Rm[6]!, Rm[1]!, Rm[4]!, Rm[7]!, Rm[2]!, Rm[5]!, Rm[8]!];
  // Project: q_h = diag(D,D,1) * R^T * A * (p,1)
  const K = [D, 0, 0, 0, D, 0, 0, 0, 1];
  const H = mat3Mul(K, mat3Mul(Rt, A));
  const Hi = mat3Inv(H);
  // Singular (edge-on) — fall back to the dead-on affine inverse so the module
  // degrades to a plain nest instead of rendering garbage.
  if (!Hi) return [cs / s, sn / s, 0, -sn / s, cs / s, 0, 0, 0, 1];
  return Hi;
}

/** Screen fill (the TV's width as a fraction of the frame) at ZOOM's minimum. */
export const BACKDRAFT_TV_FILL_MIN = 0.35;
/** Screen fill at ZOOM = 1.0 (the default) — the chunky ~12-band tunnel. */
export const BACKDRAFT_TV_FILL_DEFAULT = 0.75;
/** Screen fill at ZOOM's maximum — a dense, thin-ringed tunnel. */
export const BACKDRAFT_TV_FILL_MAX = 0.95;

/** The per-pass loop gain at which PURE TV is exactly marginal — a REFERENCE
 *  value for the card readout and the docs, deliberately NOT a clamp.
 *
 *  An earlier revision clamped the OPERATOR NORM here (`opNorm * gEff <= 0.95`)
 *  so the map was a strict contraction for EVERY reachable knob combination and
 *  LUMA 2 / FEEDBACK 2 could never pin the interior white. That is more
 *  constrained than the instrument wants. Cranking LUMA, or pushing FEEDBACK to
 *  maximum with LUMA positive, SHOULD reach white-out: you cannot get feedback
 *  worth riding without a zone of uncontrollable feedback to ride toward, and a
 *  loop that cannot be over-driven is not an instrument.
 *
 *  So there is no ceiling and the loop gain is what the knobs say it is. What
 *  remains is the ALWAYS-ON capture shoulder and the bounded room — SOFT
 *  limiters that make a white-out roll off smoothly and, crucially, make it
 *  RECOVERABLE: back the knob down and the nest returns rather than the module
 *  wedging in a pinned state. RECOVERABILITY, not unconditional stability, is
 *  the property that is proven (N7d). */
export const BACKDRAFT_TV_GAIN_MARGINAL = 1.0;

/** The faceplate's reflection of the room, as a fraction. This is the depth
 *  PLATEAU the nest converges onto: `P(x) = GLASS * roomRgb(x)`.
 *
 *  It is deliberately proportional to the LOCAL room rather than absolute. An
 *  absolute lift makes the brightness cascade flat at room ≈ 0.20 and INVERTED
 *  (brightening inward) below it — the smeared grey field this mode exists to
 *  fix. Tying it to the already-computed room level keeps the cascade monotone
 *  at every room brightness, keeps `P <= 0.2 * room` by construction, and
 *  doubles as a spatially-varying glass reflection for free. */
export const BACKDRAFT_TV_GLASS = 0.2;

/** Room-light floor: a RANGE-PRESERVING lift `src*(1-A) + A`, so an unpatched
 *  (black) input still leaves a dim self-lit room and PURE TV demonstrates its
 *  own geometry with nothing patched. Crutchfield p.232 makes ambient light
 *  load-bearing in the real rig ("a flashlight, candle, or a quick flip of the
 *  light switch… to get the system oscillating again if the screen goes dark"). */
export const BACKDRAFT_TV_AMBIENT = 0.05;

/** Bezel half-width in SCREEN-LOCAL units, at BEZEL = 0 and BEZEL = 1.
 *  The fader reaches EXACTLY 0 — a borderless set — and the shipped look sits
 *  at the CENTRE of its travel, so the control opens both thinner and thicker
 *  than the default.
 *
 *  Note what 0 costs, because it is a real trade rather than a free option: the
 *  bezel is the only high-contrast boundary between level k and level k+1, so
 *  at 0 the nest stops reading as frames-within-frames and becomes a smooth
 *  zoom. That is a legitimate look and it is now reachable on purpose; it is
 *  simply not the one the mode is named for. */
export const BACKDRAFT_TV_BEZEL_MIN = 0;
export const BACKDRAFT_TV_BEZEL_MAX = 0.12;
/** The set's frame — dark plastic, multiplied by the room so a dark room
 *  darkens the set. */
export const BACKDRAFT_TV_BEZEL_RGB = [0.045, 0.045, 0.045] as const;
/** Camera-vs-tube white point. Compounds as W^k, so the nest drifts warm into
 *  depth. `[1,1,1]` disables it. */
export const BACKDRAFT_TV_WHITE = [1.0, 0.99, 0.975] as const;

/** PHOSPHOR knob 1.0 -> this one-frame residual. NOT actually phosphor: a
 *  colour-TV P22 phosphor's carry-over across one 60 Hz frame is 4e-73 (blue)
 *  to 6e-8 (red) — Crutchfield p.244 says so himself ("the phosphor's
 *  persistence is typically a single raster time and so it can be neglected
 *  compared to the vidicon's storage time"). The real integrator is the
 *  CAMERA's charge storage, tau_s ~ 10 frames ~ 1/3 s, which is what this is.
 *  Shipped under the owner's word; the docs say what it physically is. */
export const BACKDRAFT_TV_PHOSPHOR_MAX = 0.9;
/** Per-channel persistence tint — red decays slowest, as on a real tube. */
export const BACKDRAFT_TV_PHOSPHOR_RGB = [1.0, 0.94, 0.88] as const;

/**
 * THE VIRTUAL REFRESH — the seam the camera catches mid-redraw.
 *
 * A real monitor is redrawn LINE BY LINE, so at any instant its face is not one
 * coherent frame: it is a SEAM between two successive fields, new above the
 * beam and previous below it. A camera pointed at it catches that seam, and —
 * this is the part that matters — each nesting level re-photographs a screen
 * that ALREADY has one, so level k carries k seams at k different ages. That is
 * the refresh cascading through the network.
 *
 * BACKDRAFT has never had this. FLICKER modulates the row GAIN
 * (`gain + depth*cos(phase + v*rowPhase)`), which is a brightness band: every
 * row still comes from the SAME frame in time, so there is no seam and nothing
 * to cascade. Gain acts on the range; the refresh is a property of TIME.
 *
 * The seam is positioned in the MONITOR'S OWN RASTER coordinates (the tap's
 * `tapUv.y`), NOT in screen space, and that distinction is the whole effect: a
 * screen-space seam would cut one straight line across every level at once,
 * whereas a raster-space seam is re-imaged by every pass, so the level-k seam
 * lands at s^k of the level-0 one and the nest fills with them.
 *
 * The camera's own ROLLING SHUTTER stays in SCREEN space (the existing
 * `vUv.y * uFlickerRow` gain band) because the shutter scans the sensor, not
 * the scene. Both effects are real and they are not the same effect.
 */
/** Softness of the beam edge, in raster units — a real beam plus the phosphor's
 *  decay smears the seam over a few lines rather than leaving a hard cut. */
export const BACKDRAFT_TV_BEAM_SOFT = 0.012;

/**
 * Where the display's raster beam has reached at capture time, in [0,1).
 *
 * `phase` is already `2*pi*f*(t + T_exposure/2)`, so the beam's position within
 * the current refresh cycle is just its fractional part. This inherits FLICKER's
 * BEAT structure for free: between two camera frames the beam advances by f/60
 * cycles, so 59.94 Hz leaves it creeping (the classic slow hum bar) while 6 Hz
 * races it down the frame several times a second.
 */
export function backdraftTvBeam(
  flicker: number,
  timeSec: number,
  fps: number = BACKDRAFT_FPS,
): number {
  const t = backdraftFlickerTerms(flicker, timeSec, fps);
  if (!t.enabled) return 1;
  const b = (t.phase / (2 * Math.PI)) % 1;
  return b < 0 ? b + 1 : b;
}

/**
 * How much of THIS raster row is the NEW field: 1 above the beam (already
 * redrawn), 0 below it (still showing the previous field). `rasterY` is the row
 * in the MONITOR's own image space, i.e. the tap coordinate.
 */
export function backdraftTvRefreshMix(
  rasterY: number,
  beam: number,
  soft: number = BACKDRAFT_TV_BEAM_SOFT,
): number {
  const e0 = beam - soft, e1 = beam + soft;
  if (!(e1 > e0)) return rasterY < beam ? 1 : 0;
  const t = Math.max(0, Math.min(1, (rasterY - e0) / (e1 - e0)));
  return 1 - t * t * (3 - 2 * t);
}

/** ROTATE is read through this scale in PURE TV ONLY. The knob's +-30 deg range
 *  excludes EVERY symmetry lock Crutchfield photographs (n = 3/4/5/9 at
 *  120/90/72/40 deg, 1988 photos 27-31) and reaches only n >= 12, which by his
 *  own Arnold-tongue argument are the narrowest, least stable windows. Scaling
 *  inside the mode makes the full +-180 deg reachable while leaving stored
 *  patches and `rotate` CV response byte-for-byte unchanged in every other
 *  mode. */
export const BACKDRAFT_TV_ROTATE_SCALE = 6;

/** CRITICAL — the TIME half. PURE TV is a strict contraction and therefore
 *  converges to a STATIC nest; Crutchfield's travelling annuli, nucleation and
 *  bursts all live at loop gain ~ 1, which is inherently the unstable side.
 *  CRITICAL is that regime, on the same geometry: the contraction ceiling is
 *  replaced by a DRIVE law whose midpoint is exactly Lambda = 1.
 *
 *  Lambda(0) — safely contractive, so backing DRIVE off ALWAYS recovers. */
export const BACKDRAFT_TV_DRIVE_MIN = 0.9;
/** Lambda(1) — hard drive. The always-on shoulder means even here the loop
 *  parks around 0.83 rather than pinning at 1.0, so a white-out is SOFT and
 *  recoverable rather than terminal. */
export const BACKDRAFT_TV_DRIVE_MAX = 1.08;
/** The per-pass SPATIAL map `s*m` at DRIVE = 1 — the hard end of the expanding
 *  regime. Kept modest on purpose: `s*m` compounds every pass, so 1.10 already
 *  doubles a feature's radius in 7 passes, and larger values sweep structure
 *  off-frame faster than it can nucleate. */
export const BACKDRAFT_TV_EXPAND_MAX = 1.1;
// ── CRITICAL — the TIME half, via the camera's AUTO-EXPOSURE servo ──────
//
// PURE TV is a strict contraction and converges to a static nest. The design
// plan proposed recovering Crutchfield's dynamics by raising the gain ceiling
// to Lambda ~ 1.02-1.05 and adding his 1 % noise floor. MEASURED, that does
// not work, and it cannot: the always-on saturating shoulder is 1-Lipschitz
// and its derivative at the elevated operating point falls below 1/Lambda, so
// the per-pass operator remains a sup-norm CONTRACTION at its own fixed point
// however large Lambda is. A positive monotone map on a spatially contracting
// domain has a unique globally attracting fixed point. Four mechanisms were
// built and swept (raised ceiling; expanding spatial map; lagged local gain
// droop; off-diagonal hue rotation) and with the noise floor OFF every single
// one converged BIT-EXACTLY. The plan's §1.5 (always-on shoulder, so a
// white-out is recoverable) and its §1.10 (dynamics from raising the ceiling)
// are mutually exclusive.
//
// What breaks the contraction WITHOUT touching the shoulder is a second STATE
// VARIABLE with its own dynamics. The camera has exactly one, and it is the
// reason every real camera-pointed-at-a-TV rig breathes: AUTOMATIC EXPOSURE.
// The servo meters the frame it just captured and pushes its gain the other
// way, but it is an INTEGRATOR, so it always overshoots. Fast activator (the
// loop, which runs to white) against a lagged integrating inhibitor (the
// servo, which hauls it back) is a relaxation oscillator — and because the
// servo's correction reaches level k of the nest only after k*d frames, its
// oscillation propagates INWARD as a travelling annulus. That is Crutchfield's
// plate, and it is also literally "delay cascading through it".
//
// Linearising the two-state loop about the servo's set point gives
//   trace = J + 1,  det = J + G/tau
// with J < 1 the (contractive) per-pass slope and G the servo's authority, so
// the roots go COMPLEX and leave the unit circle once G/tau > 1 - J. The
// bifurcation is controlled by the servo's RATE, not by the loop gain — which
// is why DRIVE is the servo's time constant here.

/** CRITICAL's base loop gain. Fixed and comfortably above 1: the servo is what
 *  regulates the level, so this only has to guarantee the loop is always
 *  PUSHING toward white and the servo always has something to fight. */
export const BACKDRAFT_TV_CRIT_GAIN = 1.15;
/** The auto-exposure set point, as a fraction of the ROOM level — the frame
 *  mean the servo steers toward.
 *
 *  RELATIVE to the room, not absolute, and that is load-bearing: a real
 *  auto-exposure meters the scene it is in. With an absolute set point the
 *  servo cannot reach target in a dim room, rails at AGC_MAX and goes STATIC —
 *  measured, room 0.4 killed the limit cycle stone dead. Scaling the set point
 *  with the room keeps the servo in authority, and therefore keeps CRITICAL
 *  alive, at every room brightness.
 *
 *  The FRACTION has to leave headroom at the top too. At 0.8 the servo railed
 *  at AGC_MAX in a FULL-BRIGHTNESS room (the shoulder caps the achievable frame
 *  mean around 0.62, so an 0.8 set point is simply unreachable) and CRITICAL
 *  went dead at ROOM = 1.0 — which is the DEFAULT, so the mode was inert out of
 *  the box. Same bug class as a BEZEL fader whose minimum deletes the nest.
 *  0.5 is reachable from both sides at every room level, and it sits lower on
 *  the shoulder, which RAISES the loop's sensitivity to the gain and so widens
 *  the oscillating region rather than narrowing it. */
export const BACKDRAFT_TV_AGC_TARGET = 0.5;
/** Servo authority bounds. HARD-CLAMPED, and this is the recoverability
 *  guarantee: the exposure state can never wind up to a value it cannot come
 *  back from, so backing DRIVE off always returns a normal nest. */
export const BACKDRAFT_TV_AGC_MIN = 0.05;
export const BACKDRAFT_TV_AGC_MAX = 4.0;
/** DRIVE 0 / DRIVE 1 -> the servo's per-frame integral rate. Geometric between
 *  the two, so DRIVE is a musical (constant-ratio) control and CV across it
 *  sweeps decades of servo speed evenly. */
export const BACKDRAFT_TV_AGC_RATE_MIN = 6.0;
export const BACKDRAFT_TV_AGC_RATE_MAX = 130.0;

/** CRITICAL's LOCAL GAIN DROOP at DRIVE = 1 — the vidicon's charge depletion
 *  (`gain / (1 + kappa * prevOut)`), the lagged local inhibitor that turns the
 *  loop into a relaxation oscillator. */
export const BACKDRAFT_TV_DROOP_MAX = 1.0;
/** Crutchfield's measured noise floor, Appendix A: "a signal to noise ratio of
 *  about 40 db… about 1 % fluctuation". Multiplicative (signal-proportional,
 *  i.e. a real SNR) and deterministic — a frame-indexed hash, so FREEZE and the
 *  DRS/VRT pins stay bit-stable. Without it a marginal loop has nothing to
 *  amplify and simply parks; with it, near-unity gain grows and rotates the
 *  perturbations, which is where the plates live. */
export const BACKDRAFT_TV_NOISE = 0.01;

/** The shader's luma weights (Rec.601), shared with the CPU mirror so the
 *  chroma operator norm is computed against the SAME matrix the shader applies.
 *  (The design doc's published chromaNorm figures used Rec.709 and a single
 *  row; the true infinity-norm over these weights is larger — see
 *  backdraftTvChromaNorm.) */
export const BACKDRAFT_LUMA_WEIGHTS = [0.299, 0.587, 0.114] as const;

/** The auto-exposure REDUCE target is BACKDRAFT_TV_AGC_TILES square, and each
 *  of its fragments averages the same number of taps — so the servo meters
 *  TILES^4 = 4096 samples of the previous frame for 64 fragments of work.
 *  A stochastic estimate of the frame mean at ~0.005 % of the main pass's
 *  fragment count; a full log-reduction pyramid would be strictly more
 *  expensive for no measurable gain in a control loop this slow. */
export const BACKDRAFT_TV_AGC_TILES = 8;

/** The servo state is stored LOG-ENCODED into [0,1]; both the servo pass and
 *  the main pass need to decode it, so the GLSL is shared verbatim. */
const AGC_DECODE_GLSL = `
const float AGC_MIN = ${BACKDRAFT_TV_AGC_MIN.toFixed(5)};
const float AGC_MAX = ${BACKDRAFT_TV_AGC_MAX.toFixed(5)};
float decodeAgc(float e) { return exp(mix(log(AGC_MIN), log(AGC_MAX), clamp(e, 0.0, 1.0))); }
`;

/** Auto-exposure REDUCE pass: previous output -> an 8x8 grid of local means. */
const AGC_REDUCE_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
const int TILES = ${BACKDRAFT_TV_AGC_TILES};
void main() {
  // This fragment owns one tile of the frame; average a TILES x TILES grid of
  // taps inside it. Sample centres are offset by half a step so the grid is
  // symmetric within the tile and no sample lands exactly on a tile seam.
  vec2 tile = vec2(1.0) / float(TILES);
  vec2 base = floor(vUv * float(TILES)) * tile;
  vec3 acc = vec3(0.0);
  for (int y = 0; y < TILES; y++) {
    for (int x = 0; x < TILES; x++) {
      vec2 o = (vec2(float(x), float(y)) + 0.5) * tile / float(TILES);
      acc += texture(uSrc, base + o).rgb;
    }
  }
  acc /= float(TILES * TILES);
  outColor = vec4(acc, 1.0);
}`;

/** Auto-exposure SERVO pass: one log-domain integrator step, into a 1x1 FBO.
 *  The state lives in a TEXTURE rather than in JS so nothing has to read
 *  pixels back — a readPixels here would sync the pipeline every frame. */
const AGC_SERVO_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uReduce;     // the 8x8 grid of local means
uniform sampler2D uPrevAgc;    // 1x1, previous servo state (log-encoded)
uniform float uHasPrevAgc;
uniform float uRate;           // servo integral rate (0 = servo disabled)
uniform float uTarget;         // set point, already scaled by ROOM
const int TILES = ${BACKDRAFT_TV_AGC_TILES};
${AGC_DECODE_GLSL}
// The state is stored LOG-ENCODED into [0,1]. Two reasons: the integrator is
// itself log-domain so this is its natural variable, and if the engine has to
// degrade the float FBO to RGBA8 the 8-bit quantisation then lands on the GAIN
// RATIO (~1.7 % per code) instead of on an absolute gain, which keeps the
// servo usable rather than sticking.
float encodeAgc(float a) {
  float lg = log(clamp(a, AGC_MIN, AGC_MAX));
  return clamp((lg - log(AGC_MIN)) / (log(AGC_MAX) - log(AGC_MIN)), 0.0, 1.0);
}
void main() {
  vec3 sum = vec3(0.0);
  for (int y = 0; y < TILES; y++) {
    for (int x = 0; x < TILES; x++) {
      sum += texelFetch(uReduce, ivec2(x, y), 0).rgb;
    }
  }
  float mean = dot(sum / float(TILES * TILES), vec3(0.299, 0.587, 0.114));
  float agc = uHasPrevAgc > 0.5 ? decodeAgc(texelFetch(uPrevAgc, ivec2(0, 0), 0).r) : 1.0;
  if (uRate > 0.0) {
    // a' = a * exp(rate * (ln target - ln mean)), hard-clamped by encodeAgc.
    // The clamp IS the recoverability guarantee: the exposure state is bounded,
    // so it can never wind up somewhere it cannot come back from.
    agc = agc * exp(uRate * (log(max(uTarget, 1e-4)) - log(max(mean, 1e-4))));
  }
  outColor = vec4(encodeAgc(agc), 0.0, 0.0, 1.0);
}`;

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
// emits in pulses. All the scalars are precomputed on the CPU by
// backdraftFlickerTerms() (see the header): the exposure-window integral, the
// multi-frame storage low-pass and the rolling-shutter row spread are all
// closed form, so the shader is one cos plus one shoulder. uFlickerOn is 0 at
// the OFF default and the block is branch-gated, so OFF executes not one extra
// float op (the PIXELATE precedent).
uniform float uFlickerOn;    // 0 = off (identity), 1 = on
uniform float uFlickerGain;  // A — operating-point normaliser (geometric mean 1)
uniform float uFlickerDepth; // A * depth * sinc(f*T_exposure) * |H(w_beat)|
uniform float uFlickerPhase; // 2*pi*f*(t_virtualFrame + T_exposure/2) + arg H, wrapped
uniform float uFlickerRow;   // 2*pi*f*T_readout — phase spread DOWN the frame
uniform float uFlickerKnee;  // capture shoulder knee (sensor/monitor I_sat)

// PURE TV — the bounded-screen (Crutchfield) map. uTvOn is 0 at the default and
// the whole block is branch-gated, so OFF executes not one extra float op (the
// PIXELATE / FLICKER load-bearing-gate idiom). Because uTvOn is a UNIFORM the
// branch is uniform control flow, which is what makes fwidth() legal inside it.
uniform float uTvOn;         // 0 = off (the legacy composite), 1 = PURE TV
uniform float uTvFill;       // s  — the screen's linear fill of the frame
uniform float uTvBezel;      // tb — bezel half-width in SCREEN-LOCAL units
uniform float uTvRoom;       // ROOM 0..1 — the ambient/room-light level
uniform float uTvOpNorm;     // max|rgb| * |luma| * max(W) * ||C_chroma||inf
uniform float uTvCos;        // cos(phi), phi = rotate * 6 (PURE TV only)
uniform float uTvSin;        // sin(phi)
uniform vec3  uTvPhos;       // per-channel ONE-FRAME residual (0,0,0 = off)
uniform sampler2D uPersist;  // ring[head-1] — the previous OUTPUT, untransformed
uniform float uHasPersist;
// VIRTUAL REFRESH — the display is redrawn line by line, so its face is a SEAM
// between two fields. uFbPrev is the OLDER one (frame n-d-1); uTvBeam is where
// the beam has reached, in the MONITOR's raster coordinates.
uniform sampler2D uFbPrev;
uniform float uHasFbPrev;
uniform float uTvRefresh;    // 0 = no seam (FLICKER off) — the exact no-op
uniform float uTvBeam;
// VIRTUAL CAMERA ORIENTATION — the INVERSE homography, camera frame -> screen
// plane. At tilt 0 / pos 0 this IS the old affine inverse, so the default path
// is unchanged. uTvPersp is 0 there, which skips the perspective divide.
uniform mat3 uTvCam;
uniform float uTvPersp;
// CRITICAL. uTvGainScale/uTvGainCeil carry BOTH modes with no extra branch:
// PURE TV passes (FEEDBACK, TV_GAIN_MAX/opNorm) so the operator-norm
// contraction ceiling bites; CRITICAL passes (CRIT_GAIN*agc/opNorm, +inf) so
// the auto-exposure servo -- not a clamp -- regulates the level.
uniform float uTvGainScale;
uniform float uTvNoise;      // Crutchfield's ~1% sensor noise (0 in PURE TV)
uniform float uTvFrame;      // frame index, for the deterministic noise hash
uniform sampler2D uTvAgc;    // 1x1 auto-exposure servo state (log-encoded)
uniform float uHasTvAgc;     // 0 until the servo has run at least once

const float MAX_EFFECT_SCALE = ${BACKDRAFT_MAX_EFFECT_SCALE.toFixed(1)};
const float BD_PI = 3.14159265359;
const float TV_GLASS    = ${BACKDRAFT_TV_GLASS.toFixed(4)};
const float TV_AMBIENT  = ${BACKDRAFT_TV_AMBIENT.toFixed(4)};
const float TV_KNEE     = ${BACKDRAFT_FLICKER_KNEE.toFixed(4)};
const float TV_BEAM_SOFT = ${BACKDRAFT_TV_BEAM_SOFT.toFixed(4)};
${AGC_DECODE_GLSL}
const vec3  TV_BEZEL_RGB = vec3(${BACKDRAFT_TV_BEZEL_RGB.map((c) => c.toFixed(4)).join(', ')});
const vec3  TV_WHITE     = vec3(${BACKDRAFT_TV_WHITE.map((c) => c.toFixed(4)).join(', ')});

float luma(vec3 c) {
  return dot(c, vec3(0.299, 0.587, 0.114));
}

// Signed distance to the SCREEN in aspect-corrected, centre-relative,
// SCREEN-LOCAL space; negative inside the picture. SHAPE picks the outline:
// 0 = the rect TV (the exact iq box SDF, so the outer bezel corners round
// slightly as a real set's do), 1 = round CRT, 2/3/4 = pentagon / triangle /
// octagon (the 1988 boundary-condition experiment as a knob).
//
// BOUNDARY INVARIANT: d < 0 implies the tap UV is inside [0,1]^2 — the rect SDF
// IS that test, and every other shape is inscribed in it. So CLAMP_TO_EDGE is
// not reached by the sample CENTRE and NO GL state changes; every other mode
// keeps its documented clamp behaviour. (Bilinear reads a 2x2 neighbourhood, so
// a fragment within half a texel of the frame edge does touch the clamp — and
// it clamps to the previous frame's edge texel, which is ROOM, i.e. the same
// value the correct neighbour would have.) The invariant depends on aspect >= 1
// and on the 0.5 shape radius, so it is asserted in backdraft.test.ts (N-INV),
// not merely asserted here.
float tvScreenSdf(vec2 p) {
  int s = int(uShape + 0.5);
  if (s <= 0) {
    vec2 e = abs(p) - vec2(uAspect * 0.5, 0.5);
    return length(max(e, vec2(0.0))) + min(max(e.x, e.y), 0.0);
  }
  float r = ${BACKDRAFT_SHAPE_RADIUS.toFixed(3)};
  if (s == 1) return length(p) - r;
  float n = s == 2 ? 5.0 : (s == 3 ? 3.0 : 8.0);
  float apothem = r * cos(BD_PI / n);
  float ang = atan(p.x, p.y);
  float seg = (2.0 * BD_PI) / n;
  return cos(seg * floor(0.5 + ang / seg) - ang) * length(p) - apothem;
}

// The capture SHOULDER at the fixed TV knee. ALWAYS ON inside the screen — at
// the PURE TV default FLICKER is OFF, and a bare clamp() is linear right up
// until it pins, which is not an amplitude limiter (see this file's
// BACKDRAFT_FLICKER_KNEE note). 1-Lipschitz, so it cannot break the
// operator-norm contraction guarantee.
vec3 tvShoulder(vec3 x) {
  vec3 over = max(x - vec3(TV_KNEE), vec3(0.0));
  return min(x, vec3(TV_KNEE)) + (1.0 - TV_KNEE) * (1.0 - exp(-over / (1.0 - TV_KNEE)));
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
  // PURE TV reads the RAW source as the ROOM. Captured HERE because PURE GEO is
  // ignored in PURE TV (SHAPE means exactly one thing there: the screen), and
  // the PURE GEO OFF branch below crops "source" in place.
  vec3 srcRaw = source;

  // Fed-back frame (delayed previous output), sampled through the spatial
  // feedback transform so the geometry COMPOUNDS over iterations (tunnels /
  // spirals / trails). CLAMP_TO_EDGE on the ring textures keeps UVs pushed
  // past the edge reading the edge pixel. Zero on cold start.
  vec2 fbUv = feedbackUv(uv);
  // The "&& uTvOn < 0.5" guard keeps PURE TV at COST PARITY with today's OFF
  // path: the TV branch does its OWN uFb tap (through the bounded-screen map)
  // and its own persistence tap, so this legacy fetch would be a pure waste.
  vec3 fb = (uHasFb > 0.5 && uTvOn < 0.5) ? texture(uFb, fbUv).rgb : vec3(0.0);

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
  // ("&& uTvOn < 0.5": PURE TV applies its OWN peak-normalised flicker + its own
  // always-on shoulder inside the screen, so this legacy exp() would be waste —
  // and exp() is not free on SwiftShader. Provably a no-op at uTvOn = 0.)
  if (uFlickerOn > 0.5 && uTvOn < 0.5) {
    fb *= uFlickerGain + uFlickerDepth * cos(uFlickerPhase + vUv.y * uFlickerRow);
    // SHOULDER — the sensor's (and the monitor's) saturating response to large
    // intensity signals. Identity below the knee; above it, roll off toward 1.0
    // with unit slope at the knee. This is what makes the flicker read as
    // CONTOUR shimmer instead of a full-field flash: the incremental response
    // goes to ~0 as a region approaches white, so the beat stops acting exactly
    // where the loop is hottest, and it is also the loop's only true amplitude
    // limiter (a bare clamp is linear right up until it pins).
    float k = uFlickerKnee;
    vec3 over = max(fb - vec3(k), vec3(0.0));
    fb = min(fb, vec3(k)) + (1.0 - k) * (1.0 - exp(-over / (1.0 - k)));
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

  // ── PURE TV — the BOUNDED SCREEN ────────────────────────────────────────
  // Everything above builds an infinite PLANE: the live source is added to
  // EVERY pixel and CLAMP_TO_EDGE makes the previous frame defined everywhere,
  // so there is no complement and nothing can nest. Here the previous frame is
  // placed, whole, INSIDE a bounded screen rectangle; outside it is the room.
  // Dirichlet-zero at the screen edge (Crutchfield 1984 p.235) instead of a
  // clamp — that single substitution is the difference between a tunnel and a
  // television. The branch is appended and OVERWRITES outc; no statement above
  // is edited, which also means PURE GEO is ignored here by construction.
  if (uTvOn > 0.5) {
    float s = max(uTvFill, 1e-4);
    // Aspect-corrected, centre-relative (the shapeMask convention), so a rolled
    // TV stays RECTANGULAR at 4:3 instead of shearing into a parallelogram.
    vec2 q = (uv - vec2(0.5)) * vec2(uAspect, 1.0) - vec2(uOffX * uAspect, uOffY);
    // Which previous-frame pixel is here. Dead-on this is the plain affine
    // inverse of T(q') = c + s*R(phi)*q'; off-axis it is the inverse HOMOGRAPHY
    // of the pinhole camera, so an angled set images as a trapezoid and every
    // pass re-images the one before it.
    vec2 p;
    float behind = 0.0;
    if (uTvPersp > 0.5) {
      vec3 hp = uTvCam * vec3(q, 1.0);
      // hp.z <= 0 is BEHIND the camera — there is no image of those points, so
      // they must read as room rather than wrapping round to a mirrored ghost.
      behind = hp.z <= 1e-4 ? 1.0 : 0.0;
      p = hp.xy / (abs(hp.z) < 1e-4 ? 1e-4 : hp.z);
    } else {
      p = vec2(q.x * uTvCos + q.y * uTvSin, -q.x * uTvSin + q.y * uTvCos) / s;
    }
    float d = tvScreenSdf(p);
    // Force everything behind the camera outside the screen.
    d = mix(d, 1.0, behind);
    vec2 tapUv = p / vec2(uAspect, 1.0) + vec2(0.5);

    // THE ROOM — the live source at full strength plus an ambient floor,
    // OUTSIDE the screen only. The ambient lift is range-preserving, so an
    // unpatched (black) input still leaves a dim self-lit room and PURE TV
    // demonstrates its own geometry with nothing patched.
    vec3 roomRgb = uTvRoom * (srcRaw * (1.0 - TV_AMBIENT) + vec3(TV_AMBIENT));

    // PURE TV — THE CONTRACTION CONTRACT: clamp the OPERATOR norm, not the
    // gain. The colour chain multiplies the tap before the gain and every one
    // of its knobs reaches 2.0, so clamping g alone lets LUMA >= 1.18 pin the
    // interior to white and delete the nest.
    // CRITICAL — the ceiling is +inf and uTvGainScale already carries the
    // auto-exposure servo's state, so the LEVEL is regulated by a servo with
    // memory instead of by a clamp. That servo is the whole reason CRITICAL
    // has time in it: raising a clamped ceiling cannot destabilise a positive
    // monotone map, but an INTEGRATING inhibitor overshoots, and past DRIVE
    // 0.5 the overshoot becomes a sustained limit cycle.
    float agc = uHasTvAgc > 0.5 ? decodeAgc(texelFetch(uTvAgc, ivec2(0, 0), 0).r) : 1.0;
    float gEff = uTvGainScale * agc * effectScale;

    // FLICKER, PEAK-normalised on the CPU (uFlickerGain/uFlickerDepth are
    // pre-divided by their peak when tvMode = 1), so flick <= 1 always: a
    // pulsed emitter attenuates, it cannot boost. Row phase reads the raw
    // SCREEN vUv.y — the rolling shutter scans the sensor, not the scene.
    float flick = uFlickerGain + uFlickerDepth * cos(uFlickerPhase + vUv.y * uFlickerRow);
    vec3 tap = uHasFb > 0.5 ? texture(uFb, tapUv).rgb : vec3(0.0);
    // THE VIRTUAL REFRESH. The set is mid-redraw: rows the beam has already
    // passed show the NEW field, rows below it still show the PREVIOUS one. The
    // seam sits in the MONITOR's raster (tapUv.y), not in screen space, so each
    // pass RE-IMAGES the seam it photographed and adds its own -- level k ends
    // up carrying k seams at s^k spacing. A screen-space seam would instead cut
    // one straight line across every level at once and cascade nothing.
    // Gated: at FLICKER OFF this is skipped entirely and the tap is unchanged.
    if (uTvRefresh > 0.5) {
      vec3 tapOld = uHasFbPrev > 0.5 ? texture(uFbPrev, tapUv).rgb : tap;
      float newness = 1.0 - smoothstep(uTvBeam - TV_BEAM_SOFT, uTvBeam + TV_BEAM_SOFT, tapUv.y);
      tap = mix(tapOld, tap, newness);
    }
    // Crutchfield's measured sensor noise (Appendix A, "about 1 % fluctuation"),
    // MULTIPLICATIVE so it is a real SNR — it cannot seed anything in a dark
    // region, which is exactly why his rig needs a flashlight to restart a dark
    // screen. Deterministic (a frame-indexed hash), so FREEZE and the VRT pins
    // stay bit-stable. It is TEXTURE here, not the mechanism: CRITICAL's limit
    // cycle is measured with this term switched OFF.
    if (uTvNoise > 0.0) {
      float nz = fract(sin(gl_FragCoord.x * 12.9898 + gl_FragCoord.y * 78.233
                           + uTvFrame * 37.719) * 43758.5453);
      tap *= 1.0 + uTvNoise * (2.0 * nz - 1.0);
    }
    tap = tvShoulder(tap * flick);
    tap *= vec3(uR, uG, uBlue) * uLuma * TV_WHITE;
    float tl = luma(tap);
    tap = vec3(tl) + (tap - vec3(tl)) * uChroma;
    // The glass reflects the LOCAL room, which is also the depth plateau
    // P = GLASS * room. An ABSOLUTE lift here flattens the cascade at room 0.20
    // and INVERTS it (brightening inward) below that — the exact smeared grey
    // field this mode exists to remove.
    vec3 pictureRgb = tap * gEff + TV_GLASS * roomRgb * max(0.0, 1.0 - gEff);

    // Three exhaustive, disjoint regions. The bezel is NOT decoration: it is
    // the only high-contrast boundary between level k and level k+1, and
    // without it the nest is just a smooth zoom. Antialiased because level 0's
    // jaggies would otherwise feed back into every deeper level.
    vec3 bezelRgb = TV_BEZEL_RGB * uTvRoom;
    float aa = max(fwidth(d), 1e-4);
    float inScreen = 1.0 - smoothstep(-aa, aa, d);
    float inSet    = 1.0 - smoothstep(uTvBezel - aa, uTvBezel + aa, d);
    vec3 outTv = mix(mix(roomRgb, bezelRgb, inSet), pictureRgb, inScreen);

    // PHOSPHOR — one IN-PLACE, UNTRANSFORMED, UNIT-DC-GAIN pole (Crutchfield's
    // L*(I_n)_tau term, which BACKDRAFT has never had in any form). Unit DC
    // gain is a STABILITY REQUIREMENT: (1-rho)*g + rho < 1 for any g < 1, and
    // the fixed point satisfies I* = C(I*), so rho changes only the temporal
    // smear and never the converged image. Level k has been through the pole k
    // times, so it carries the k-fold convolution — deeper levels are older in
    // proportion to k and blurrier in time in proportion to sqrt(k).
    vec3 prevOut = uHasPersist > 0.5 ? texture(uPersist, vUv).rgb : outTv;
    outc = mix(outTv, prevOut, uTvPhos);
  }

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
  // (0=off, 1=6Hz, 2=24Hz, 3=50Hz, 4=59.94Hz, 5=119.88Hz). 0 is the no-op
  // identity.
  flicker: number;   // 0..BACKDRAFT_FLICKER_COUNT-1 (discrete)
  // PURE TV — the bounded-screen (Crutchfield) mode. tvMode 0 is the exact-zero
  // no-op (the shader branch is skipped entirely). `tvGate` is the synthetic
  // raw-gate param the tv_gate CV bridge writes; a rising edge TOGGLES tvMode.
  // 0 = OFF, 1 = PURE TV, 2 = CRITICAL. Discrete; the card button and the
  // tv_gate rising edge both CYCLE it.
  tvMode: number;    // 0/1/2
  tvGate: number;    // 0..1 raw gate sample
  room: number;      // 0..1 — room/ambient light level OUTSIDE the screen
  bezel: number;     // 0..1 — screen-frame width (mapped to tb, floored)
  phosphor: number;  // 0..1 — one-frame residual (camera storage), 0 = off
  drive: number;     // 0..1 — CRITICAL only: the auto-exposure servo's rate
  // VIRTUAL CAMERA ORIENTATION. All neutral at the defaults, where the map is
  // exactly the dead-on affine one.
  camTiltX: number;  // -1..1 yaw
  camTiltY: number;  // -1..1 pitch
  camPosX: number;   // -1..1 translation in the camera's plane
  camPosY: number;   // -1..1
  camDist: number;   // 0..1 -> camera distance (perspective strength)
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
  // PURE TV neutral = OFF; the shader branch is skipped entirely, so the
  // out-of-box output is structurally unchanged from pre-PURE-TV backdraft.
  // ROOM / BEZEL carry the mode's own defaults (they are inert while OFF) and
  // PHOSPHOR defaults to the exact-zero no-op — a colour TV genuinely has NO
  // inter-frame persistence, so 0 is also the honest "TV" position.
  tvMode: 0,
  tvGate: 0,
  room: 1.0,
  // Centre of travel — the shipped bezel, with room to go thinner (0 px) or
  // thicker from there.
  bezel: 0.5,
  phosphor: 0,
  // DRIVE 0.5 sits exactly ON the measured Hopf point, so CRITICAL opens at the
  // edge itself — back it off for a still nest, push it up to make it breathe.
  drive: 0.5,
  camTiltX: 0,
  camTiltY: 0,
  camPosX: 0,
  camPosY: 0,
  camDist: 0.5,
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

/**
 * The BEAT frequency in Hz: the alias of an emission at `hz` sampled by a
 * camera running at `fps`. |f - round(f/fps)*fps|.
 *
 * This is the rate at which the loop actually sees the flicker, and therefore
 * the frequency at which every downstream temporal filter must be evaluated.
 * Below the camera rate there is no aliasing and the beat IS the emission rate
 * (6 Hz -> 6 Hz); near a multiple of it the beat collapses to almost nothing
 * (59.94 Hz -> 0.06 Hz), which is the famous slowly-crawling hum bar.
 */
export function backdraftBeatHz(hz: number, fps: number = BACKDRAFT_FPS): number {
  if (!(hz > 0) || !(fps > 0)) return 0;
  return Math.abs(hz - Math.round(hz / fps) * fps);
}

/** Magnitude + phase of the camera's multi-frame STORAGE low-pass at a given
 *  beat frequency. See BACKDRAFT_FLICKER_STORAGE_FRAMES for why this term is
 *  the heart of the v2 rework. */
export interface BackdraftStorageResponse {
  /** |H| in [0,1] — how much of the beat survives the sensor's integration. */
  mag: number;
  /** arg H in radians (a lag, so <= 0). */
  arg: number;
}

/**
 * The camera's charge-storage integrator, evaluated in CLOSED FORM.
 *
 * Crutchfield models the sensor's temporal storage as a geometric sum over past
 * frames, (I_n)_tau = sum_i I_{n-i} * L^i. Normalised to unit DC gain that is a
 * one-pole IIR with per-frame retention L = exp(-1/tauFrames), whose frequency
 * response is
 *
 *   H(w) = (1 - L) / (1 - L*e^{-i*w}),   w = 2*pi*f_beat/fps
 *
 * Because the gain signal we ship is a pure sinusoid at the beat frequency, the
 * steady-state response is EXACT — we get the physics of a 10-frame integrator
 * with no accumulator, no per-frame state, and therefore no threat to
 * determinism or to the freeze/DRS pins.
 *
 * The shape is the whole point: it is a LOW-PASS on the BEAT, so it cuts the
 * fast beats (which are the strobe) and passes the slow ones (which are the
 * breathing). That single fact is what separates the 6/24/50 positions from the
 * 60/120 positions in v2.
 */
export function backdraftStorageResponse(
  beatHz: number,
  tauFrames: number = BACKDRAFT_FLICKER_STORAGE_FRAMES,
  fps: number = BACKDRAFT_FPS,
): BackdraftStorageResponse {
  if (!(tauFrames > 0) || !(fps > 0)) return { mag: 1, arg: 0 };
  const L = Math.exp(-1 / tauFrames);
  const w = (2 * Math.PI * Math.abs(beatHz)) / fps;
  const re = 1 - L * Math.cos(w);
  const im = L * Math.sin(w);
  const den = Math.hypot(re, im);
  if (!(den > 0)) return { mag: 1, arg: 0 };
  return { mag: (1 - L) / den, arg: -Math.atan2(im, re) };
}

/**
 * The capture SHOULDER — the sensor/monitor saturating response, as a pure
 * function, mirroring the shader exactly.
 *
 * Identity below the knee; above it an exponential roll-off toward 1.0 with
 * unit slope at the knee (so it is C1 and never adds a visible crease).
 * `knee -> 1` is the identity, which is how OFF stays exact.
 */
export function backdraftShoulder(x: number, knee: number = BACKDRAFT_FLICKER_KNEE): number {
  const k = Math.min(1, Math.max(0, knee));
  if (k >= 1 || x <= k) return x;
  return k + (1 - k) * (1 - Math.exp(-(x - k) / (1 - k)));
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
  /** A * depth * sinc(f*T_exposure) * |H(w_beat)| — the per-ROW modulation
   *  amplitude. Exactly 0 when disabled. */
  depth: number;
  /** 2*pi*f*(t_virtualFrame + T_exposure/2) + arg H, wrapped into [0, 2*pi).
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
  /** The BEAT frequency in Hz — the rate the loop actually sees (0 when
   *  disabled). Every temporal filter below is evaluated here, not at `hz`. */
  beatHz: number;
  /** |H| of the camera's multi-frame storage integrator at `beatHz`. 1 when
   *  disabled. This is the term that separates "shimmer" from "breathe". */
  storage: number;
  /** The capture SHOULDER knee handed to the shader. Exactly 1 (= the identity
   *  transfer, no shoulder at all) when disabled. */
  knee: number;
}

/**
 * THE FLICKER MODEL — pure, deterministic, frame-rate independent.
 *
 * Given the discrete FLICKER knob index and the accumulated SIMULATION time,
 * return the scalars the shader needs to reproduce
 *
 *   g(t, v) = A * [ 1 + m*sinc(f*T_e)*|H| * cos(2*pi*f*(t_n + T_e/2) + argH
 *                                              + 2*pi*f*T_ro*v) ]
 *
 * where
 *   f    = the display's emission frequency (BACKDRAFT_FLICKER_HZ[index]),
 *   m    = BACKDRAFT_FLICKER_DEPTH (emission modulation depth),
 *   T_e  = BACKDRAFT_FLICKER_SHUTTER / fps  (exposure window; 90-degree shutter),
 *   T_ro = BACKDRAFT_FLICKER_READOUT / fps  (rolling-shutter readout),
 *   t_n  = floor(t*fps)/fps  — the VIRTUAL CAMERA frame grid,
 *   H    = the camera's multi-frame STORAGE low-pass at the BEAT frequency,
 *   A    = 2/(1 + sqrt(1 - a^2)),  a = m*sinc(f*T_e)*|H|*sinc(f*T_ro).
 *
 * plus the capture SHOULDER (returned as `knee`), applied by the shader to the
 * gain-scaled tap.
 *
 * Four properties this function is unit-tested for, each load-bearing:
 *
 *  1. OFF is EXACT. index 0 returns { enabled:false, gain:1, depth:0,
 *     meanGain:1, knee:1 } with no float slop, and the shader branch-skips it,
 *     so the default output is bit-identical to pre-FLICKER backdraft.
 *  2. The BEAT is quantised to the fixed `fps` virtual-camera grid, NOT to the
 *     real render rate. Without this a 120Hz ProMotion display would sample the
 *     50Hz emission at 120Hz and see a 50Hz beat instead of a 10Hz one — same
 *     knob, different look, and tests would diverge from users.
 *  3. The exposure boxcar contributes exactly sinc(f*T_e), so an exposure that
 *     is a whole number of flicker periods kills the flicker completely — the
 *     real flicker-free-shutter rule, reproduced rather than approximated.
 *  4. STORAGE is a LOW-PASS ON THE BEAT: |H| is monotonically decreasing in
 *     beat frequency, so the fast-beat positions are strongly attenuated and
 *     the slow-beat ones pass essentially untouched. This is what makes 6/24/50
 *     shimmer instead of strobe while 60/120 keep their full slow swing, and it
 *     is why v2 needs no arbitrary safety clamp anywhere.
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
    beatHz: 0, storage: 1, knee: 1,
  };
  const idx = Math.max(0, Math.min(BACKDRAFT_FLICKER_COUNT - 1, Math.round(flicker)));
  const hz = BACKDRAFT_FLICKER_HZ[idx] ?? 0;
  if (idx <= 0 || hz <= 0 || !(fps > 0)) return OFF;

  const expose = BACKDRAFT_FLICKER_SHUTTER / fps; // T_e
  const readout = BACKDRAFT_FLICKER_READOUT / fps; // T_ro
  const sExpose = backdraftSinc(hz * expose);
  const sReadout = backdraftSinc(hz * readout);

  // The camera's own multi-frame charge storage, evaluated at the frequency the
  // loop actually sees (the BEAT, not the emission rate). This is the term that
  // holds a real rig under Crutchfield's observed ~3 Hz ceiling, and the one v1
  // was missing.
  const beatHz = backdraftBeatHz(hz, fps);
  const store = backdraftStorageResponse(beatHz, BACKDRAFT_FLICKER_STORAGE_FRAMES, fps);

  // Per-row modulation depth (exposure boxcar + storage) and the FRAME-MEAN
  // depth (the rolling shutter's row average adds the second sinc).
  const rowDepth = BACKDRAFT_FLICKER_DEPTH * sExpose * store.mag;
  const meanDepth = rowDepth * sReadout;

  // Operating-point normaliser: geometric mean of the frame-mean gain == 1.
  const a = Math.min(0.999999, Math.abs(meanDepth));
  const gain = 2 / (1 + Math.sqrt(1 - a * a));

  // VIRTUAL CAMERA sampling grid — quantise simulation time to whole frames
  // before taking the phase. This is what fixes the beat frequency on every
  // machine regardless of the real render rate (property 2 above).
  const n = Math.floor(Math.max(0, timeSec) * fps);
  const tn = n / fps;

  // Phase at the CENTRE of the exposure window (the boxcar's group delay), plus
  // the storage integrator's own lag. Wrapped in float64 so the shader's
  // float32 cos stays precise forever.
  const TWO_PI = Math.PI * 2;
  const raw = TWO_PI * hz * (tn + expose / 2) + store.arg;
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
    beatHz,
    storage: store.mag,
    knee: BACKDRAFT_FLICKER_KNEE,
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

// ─────────────────────────────────────────────────────────────────────────
// PURE TV — the pure functions. Every one of these is the EXACT CPU mirror of
// a shader expression, so the GEOMETRY (the thing that has to nest) is proven
// in the fast, deterministic, GL-free `unit` lane and the e2e only has to show
// that the GPU really renders it. `toybox-feedback.ts` (tunnelTap /
// simulateTunnel) is the precedent.
// ─────────────────────────────────────────────────────────────────────────

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/**
 * ZOOM -> screen FILL. ZOOM defaults to 1.0, and reusing it raw would mean "the
 * TV fills the frame" — no room, no nest, a degenerate default. This piecewise
 * linear remap is pure, monotone and unit-tested:
 *
 *   zoom  0.4   0.6   0.8   1.0    1.2    1.45  1.6
 *   fill  0.350 0.483 0.617 0.750  0.817  0.900 0.950
 *
 * HIGHER ZOOM = the TV subtends MORE of the frame = a DEEPER nest of thinner,
 * lower-contrast rings. LOWER ZOOM = a chunky 4-level Droste with a big room.
 */
export function backdraftTvFill(zoom: number): number {
  const z = Math.max(BACKDRAFT_ZOOM_MIN, Math.min(BACKDRAFT_ZOOM_MAX, zoom));
  return z <= 1
    ? BACKDRAFT_TV_FILL_MIN
      + ((z - BACKDRAFT_ZOOM_MIN) / (1 - BACKDRAFT_ZOOM_MIN))
        * (BACKDRAFT_TV_FILL_DEFAULT - BACKDRAFT_TV_FILL_MIN)
    : BACKDRAFT_TV_FILL_DEFAULT
      + ((z - 1) / (BACKDRAFT_ZOOM_MAX - 1))
        * (BACKDRAFT_TV_FILL_MAX - BACKDRAFT_TV_FILL_DEFAULT);
}

/** BEZEL knob -> half-width `tb` in SCREEN-LOCAL units (so a level-k bezel
 *  lands at `tb*s^k` automatically — deeper bezels shrink because they are
 *  IMAGES of the real one). Floored so BEZEL = 0 cannot delete the nest. */
export function backdraftTvBezel(bezel: number): number {
  return BACKDRAFT_TV_BEZEL_MIN
    + (BACKDRAFT_TV_BEZEL_MAX - BACKDRAFT_TV_BEZEL_MIN) * clamp01(bezel);
}

/** The ROTATE knob's effective screen roll in PURE TV: `phi = rotate * 6`, so
 *  the +-30 deg fader spans the full +-180 deg and every Crutchfield symmetry
 *  lock becomes reachable. Outside PURE TV the knob is untouched. */
export function backdraftTvRotationDeg(rotateDeg: number): number {
  const r = Math.max(BACKDRAFT_ROTATE_MIN, Math.min(BACKDRAFT_ROTATE_MAX, rotateDeg));
  return r * BACKDRAFT_TV_ROTATE_SCALE;
}

/**
 * The n-fold rosette the current screen roll locks to: `n = round(360/|phi|)`.
 * DESCRIPTIVE ONLY — this map is a strict contraction, so it converges to a
 * STATIC nest. There is no precession, no limit cycle and no travelling
 * annulus to claim (those need loop gain ~ 1; see the plan's CRITICAL mode).
 * n = 0 means "no roll".
 */
export function backdraftRotationLock(deg: number): { n: number } {
  const a = Math.abs(deg);
  return { n: a < 1e-6 ? 0 : Math.round(360 / a) };
}

/**
 * `‖C_c‖∞` — the exact infinity-norm of the shader's CHROMA operator
 *   C_c v = luma(v)*1 + (v - luma(v)*1) * c
 * i.e. `max_i Σ_j |(1-c)*w_j + c*δ_ij|` over the shader's Rec.601 luma weights.
 *
 * Exactly 1 for c in [0,1] (the row sums telescope to (1-c) + c). Outside that
 * it grows: 2.772 at c = 2, 2.544 at c = -1 — both on the BLUE row, because it
 * carries the smallest luma weight.
 *
 * (The design doc published 2.575 / 2.150 here. Those are the RED row under
 * Rec.709 weights; this shader's `luma()` is Rec.601 and the norm is a max over
 * all three rows. The corrected values are larger, so the clamp below is
 * strictly TIGHTER than the design's — the contraction guarantee is preserved,
 * not weakened.)
 */
export function backdraftTvChromaNorm(chroma: number): number {
  let m = 0;
  for (let i = 0; i < 3; i++) {
    let s = 0;
    for (let j = 0; j < 3; j++) {
      s += Math.abs((1 - chroma) * BACKDRAFT_LUMA_WEIGHTS[j]! + (i === j ? chroma : 0));
    }
    m = Math.max(m, s);
  }
  return m;
}

/**
 * The per-pass COLOUR-CHAIN operator norm — everything the shader multiplies
 * the tap by BEFORE the feedback gain:
 *
 *   opNorm = max(|r|,|g|,|b|) * |luma| * max(W) * ‖C_chroma‖∞
 *
 * This is the quantity `backdraftTvGain` divides the ceiling by, and the reason
 * LUMA 1.2 or R 1.3 can no longer pin the interior to white.
 */
export function backdraftTvOpNorm(p: {
  r: number; g: number; b: number; luma: number; chroma: number;
  white?: readonly [number, number, number];
}): number {
  const w = p.white ?? BACKDRAFT_TV_WHITE;
  const rgb = Math.max(Math.abs(p.r), Math.abs(p.g), Math.abs(p.b));
  const wMax = Math.max(Math.abs(w[0]), Math.abs(w[1]), Math.abs(w[2]));
  return rgb * Math.abs(p.luma) * wMax * backdraftTvChromaNorm(p.chroma);
}

/**
 * The EFFECTIVE per-pass screen gain — the exact CPU mirror of the shader's
 *   gEff = min(FEEDBACK * effectScale, TV_GAIN_MAX / max(opNorm, 1e-4))
 *
 * NO CEILING. The loop gain is exactly what the knobs say, so the colour chain
 * rides on top of FEEDBACK and driving LUMA or FEEDBACK up reaches white-out —
 * which is the point: there is no feedback worth riding without an
 * uncontrollable zone to ride toward. The capture shoulder and the bounded room
 * are SOFT limiters, so the white-out rolls off and is recoverable.
 */
export function backdraftTvGain(
  _opNorm: number,
  feedback: number,
  effectScale: number,
): number {
  return Math.max(0, feedback) * Math.max(0, effectScale);
}

/**
 * CRITICAL's DRIVE law: the knob -> the LOOP GAIN Lambda, with the resolution
 * concentrated where the interesting behaviour is.
 *
 * A binary "critical: on" is not playable — the whole regime lives in roughly
 * Lambda in [0.95, 1.05] and the behaviour changes fast across it, so a control
 * whose useful range is 5 % of its travel is an on/off switch with extra steps.
 * This is an odd, C1, monotone law about the midpoint:
 *
 *   t = 2*drive - 1;   Lambda = 1 + t*|t| * (t < 0 ? 0.10 : 0.08)
 *
 * so DRIVE 0.5 is EXACTLY Lambda = 1, and **81 % of the fader travel lands
 * inside Lambda in [0.95, 1.05]** (x in [0.147, 0.956]) while the ends still
 * reach a safely contractive 0.90 and a hard 1.08. A CV ramp across the range
 * is a smooth approach to the edge, not a cliff. (t*|t| rather than t^3: the
 * cubic is so flat at the midpoint that the middle fifth of the fader reads as
 * a dead zone.)
 */
export function backdraftTvDriveGain(drive: number): number {
  const t = 2 * clamp01(drive) - 1;
  const span = t < 0 ? 1 - BACKDRAFT_TV_DRIVE_MIN : BACKDRAFT_TV_DRIVE_MAX - 1;
  return 1 + t * Math.abs(t) * span;
}

/**
 * CRITICAL's DRIVE law: the knob -> the auto-exposure servo's per-frame
 * integral RATE. GEOMETRIC (constant-ratio) between the two endpoints:
 *
 *   rate(d) = RATE_MIN * (RATE_MAX / RATE_MIN)^d
 *
 * Geometric rather than linear because the servo's behaviour is scale-free in
 * its rate — what matters is the RATIO between the servo's time constant and
 * the loop's own rise time, so equal knob steps must be equal FACTORS. A
 * linear law would spend 90 % of its travel in the over-damped mud and cross
 * the whole interesting region in the last few percent, which is exactly the
 * unplayable control the owner rejected. Over the fader:
 *
 *   DRIVE  0.00  0.25  0.50  0.75  1.00
 *   rate   6.0   12.9  27.9  60.2  130.0     (tau = 1/rate frames)
 *
 * The endpoints are chosen so that DRIVE 0.5 lands ON the measured HOPF POINT
 * (rate ~ 5): below it the servo regulates to a dead-still nest, above it it
 * overshoots into a sustained limit cycle. Measured swing of the frame mean
 * over a late window, with the noise floor OFF:
 *
 *   rate    2..20   40      80+
 *   swing   0.000   0.260   0.390
 *
 * measured identically at ROOM 1.0 / 0.7 / 0.4, so the edge does not move as
 * the room changes. The BOTTOM half of the fader is the well-behaved regulator
 * and the TOP half is the limit cycle, deepening monotonically — and DRIVE 0.5
 * is the edge itself.
 *
 * The Hopf point (where the servo starts to overshoot and the picture begins
 * to breathe) sits near the middle of the travel, and BOTH sides of it are
 * reachable with fine resolution — below it the exposure is a smooth,
 * well-behaved regulator; above it the servo hunts, the picture blooms toward
 * white and is hauled back, and the correction propagates inward through the
 * nest one level per DELAY as a travelling annulus. "Riding the edge of white
 * out" is riding DRIVE across that point.
 *
 * Because the mapping is a pure ratio law it is also the right shape for CV: a
 * linear CV ramp sweeps the servo speed by a constant factor per unit, so a
 * slow LFO on DRIVE reads as a smooth accelerando into instability rather than
 * a cliff.
 */
export function backdraftTvAgcRate(drive: number): number {
  const d = clamp01(drive);
  return BACKDRAFT_TV_AGC_RATE_MIN
    * Math.pow(BACKDRAFT_TV_AGC_RATE_MAX / BACKDRAFT_TV_AGC_RATE_MIN, d);
}

/**
 * One step of the auto-exposure servo — a LOG-DOMAIN INTEGRATOR, hard-clamped.
 *
 *   a' = clamp( a * exp( rate * (ln target - ln mean) ), AGC_MIN, AGC_MAX )
 *
 * Log domain so the servo is scale-free (it corrects by a RATIO, like a real
 * iris in stops, so it behaves the same at any room brightness). Integrating
 * so it has memory — which is what makes it overshoot, and the overshoot is
 * the whole instrument. Hard-clamped because that clamp IS the recoverability
 * guarantee: the exposure state is bounded, so it can never wind up somewhere
 * it cannot come back from.
 */
export function backdraftTvAgcStep(
  agc: number,
  frameMean: number,
  rate: number,
  target: number = BACKDRAFT_TV_AGC_TARGET,
): number {
  const m = Math.max(1e-4, frameMean);
  const next = agc * Math.exp(rate * (Math.log(Math.max(1e-4, target)) - Math.log(m)));
  if (!Number.isFinite(next)) return 1;
  return Math.min(BACKDRAFT_TV_AGC_MAX, Math.max(BACKDRAFT_TV_AGC_MIN, next));
}

/**
 * CRITICAL's DRIVE law, GEOMETRIC half: the knob -> the per-pass SPATIAL map
 * `sm = s*m`, where `s` is the screen's size in frame and `m` is the tube's own
 * magnification of the signal it displays (monitor overscan).
 *
 * THIS IS THE HALF THAT CARRIES THE TIME, and the design plan got it wrong.
 * The plan's §1.10 says the route to Crutchfield's dynamics is "raise the gain
 * ceiling to ~1.02-1.05, keep the shoulder, add the noise floor". MEASURED, it
 * is not: at every reachable setting that recipe converges to a static image
 * and stays there, bit-exactly with the noise off. The reason is structural,
 * not a tuning miss — the per-pass operator is a POSITIVE MONOTONE map on a
 * SPATIALLY CONTRACTING domain (`sm < 1`), so it has a unique globally
 * attracting fixed point for ANY linear gain. Raising Lambda past 1 only moves
 * that fixed point up the shoulder; it cannot make one appear where the
 * geometry drags every perturbation into the centre and deletes it.
 *
 * What DOES carry time is the sign of `sm - 1`:
 *
 *   sm < 1   the fixed point ATTRACTS. Structure is transported INWARD, shrinks
 *            geometrically, and is absorbed. The nest is static (PURE TV).
 *   sm > 1   the fixed point REPELS. Structure is transported OUTWARD, GROWS,
 *            and new structure continuously nucleates at the centre. This is
 *            the regime every Crutchfield plate is photographed in ("center",
 *            Plates 2/3/5/7), and it is why ZOOM is HIS bifurcation parameter.
 *
 * So DRIVE moves both halves together, and the two critical points coincide at
 * the SAME midpoint: `Lambda = 1` exactly when `sm = 1` exactly, at DRIVE 0.5.
 * Below it the mode is a stable nest that merely brightens; above it the nest
 * opens out into travelling structure that eventually whites out. "Riding the
 * edge" is riding DRIVE across 0.5, which is what the odd `t*|t|` law puts the
 * resolution under.
 *
 * At DRIVE 0 the magnification is exactly 1 — PURE TV's own geometry — so the
 * bottom of the fader is always a safe, familiar nest to fall back to.
 */
export function backdraftTvDriveMagnify(drive: number, fill: number): number {
  const s = Math.min(0.999999, Math.max(1e-4, fill));
  const t = 2 * clamp01(drive) - 1;
  const span = t < 0 ? 1 - s : BACKDRAFT_TV_EXPAND_MAX - 1;
  return (1 + t * Math.abs(t) * span) / s;
}

/**
 * CRITICAL's effective per-pass screen gain. Unlike PURE TV this is NOT clamped
 * to a contraction — that is the point of the mode. DRIVE sets the LOOP gain
 * (the operator norm is divided out), so the edge stays at DRIVE = 0.5 whatever
 * the colour knobs are doing: LUMA and CHROMA change the colour, not where the
 * cliff is.
 *
 * FEEDBACK is IGNORED in CRITICAL (the card greys it) — one knob to ride, no
 * two-knob interaction to hunt, and FEEDBACK's stored value + CV mapping stay
 * untouched for every other mode.
 */
export function backdraftTvCriticalGain(
  opNorm: number,
  drive: number,
  effectScale: number,
): number {
  return (backdraftTvDriveGain(drive) * Math.max(0, effectScale))
    / Math.max(Math.abs(opNorm), 1e-4);
}

/**
 * The deterministic sensor-noise hash — the exact CPU mirror of the shader's.
 * Frame-indexed, so FREEZE (draw() early-returns) and a pinned simulation clock
 * both keep it bit-stable; there is no RNG state anywhere.
 */
export function backdraftTvNoise(x: number, y: number, frame: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233 + frame * 37.719) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * FLICKER in PURE TV, PEAK-normalised: a pure duty-cycle ATTENUATION, never a
 * boost.
 *
 * The shipped `backdraftFlickerTerms` normalises the GEOMETRIC MEAN of the
 * frame-mean gain to 1 — correct for an ADDITIVE accumulator, wrong for a
 * bounded loop with no source anchor inside the screen. Its per-row PEAK is
 * `gain*(1+rowDepth)`, which reaches 1.88 at the 60 position and 1.54 at 120;
 * the loop gain then sits above 1 for ~8 s / ~4 s of every cycle and the nest
 * goes FLAT (every level inside k = 2 within one 8-bit code of every other).
 *
 * A pulsed emitter cannot emit more than 100 % of its drive, so the physically
 * correct normalisation in a bounded loop is PEAK at unity. The 60 position
 * becomes a slow 16.7 s swell between a full nest and a 13 %-brightness one.
 *
 * @param v the SCREEN-space row coordinate (the rolling shutter scans the
 *          sensor, not the scene), so the band stays screen-fixed.
 */
export function backdraftTvFlickerMult(
  flicker: number,
  timeSec: number,
  v: number,
  fps: number = BACKDRAFT_FPS,
): number {
  const t = backdraftFlickerTerms(flicker, timeSec, fps);
  const peak = t.gain + t.depth;
  if (!(peak > 0)) return 1;
  return (t.gain + t.depth * Math.cos(t.phase + v * t.rowPhase)) / peak;
}

/** PHOSPHOR knob -> the per-channel ONE-FRAME residual `rho`. Red slowest. */
export function backdraftTvPhosphorRgb(p: number): [number, number, number] {
  const a = clamp01(p) * BACKDRAFT_TV_PHOSPHOR_MAX;
  return [
    a * BACKDRAFT_TV_PHOSPHOR_RGB[0],
    a * BACKDRAFT_TV_PHOSPHOR_RGB[1],
    a * BACKDRAFT_TV_PHOSPHOR_RGB[2],
  ];
}

/**
 * Signed distance to the SCREEN in aspect-corrected, centre-relative,
 * SCREEN-LOCAL space (`p`), negative inside the picture. SHAPE selects the
 * screen's outline: 0 = the rect TV (the frame rect itself), 1 = a round CRT,
 * 2/3/4 = pentagon / triangle / octagon — the 1988 boundary-condition
 * experiment as a knob.
 *
 * The rect uses the exact iq box SDF so the outer bezel corners round slightly,
 * as a real set does. Every non-rect shape is INSCRIBED (circumradius
 * BACKDRAFT_SHAPE_RADIUS = 0.5 reaches the top/bottom frame edges), which is
 * what makes `d < 0 ⟹ tapUv ∈ [0,1]²` hold — see backdraftTvTap.
 */
export function backdraftTvScreenSdf(
  px: number,
  py: number,
  shape: number,
  aspect: number,
  radius: number = BACKDRAFT_SHAPE_RADIUS,
): number {
  const s = Math.round(shape);
  if (s <= 0) {
    // iq box SDF, half-extents = the frame's own half-extents.
    const ex = Math.abs(px) - aspect * 0.5;
    const ey = Math.abs(py) - 0.5;
    return Math.hypot(Math.max(ex, 0), Math.max(ey, 0)) + Math.min(Math.max(ex, ey), 0);
  }
  const len = Math.hypot(px, py);
  if (s === 1) return len - radius;
  const n = s === 2 ? 5 : s === 3 ? 3 : 8;
  const apothem = radius * Math.cos(Math.PI / n);
  const ang = Math.atan2(px, py);
  const seg = (2 * Math.PI) / n;
  return Math.cos(seg * Math.round(ang / seg) - ang) * len - apothem;
}

/** Geometry of the bounded screen for one frame. `bezelTb` is already mapped
 *  through backdraftTvBezel; `rotateDeg` is already the EFFECTIVE roll phi. */
export interface BackdraftTvGeo {
  aspect: number;
  /** s — the screen's linear fill, from backdraftTvFill(zoom). */
  fill: number;
  /** phi — the effective screen roll in degrees (backdraftTvRotationDeg). */
  rotateDeg: number;
  offX: number;
  offY: number;
  /** tb — bezel half-width in screen-local units (backdraftTvBezel). */
  bezelTb: number;
  shape: number;
  radius?: number;
  /**
   * m — the TUBE's own MAGNIFICATION of the signal it is showing (monitor
   * overscan). 1 = the set displays the incoming frame edge-to-edge, which is
   * PURE TV. Above 1 the tube shows only the middle `1/m` of the signal, blown
   * up to fill the same glass.
   *
   * This is the SECOND geometric degree of freedom, and it is the one that
   * decides whether the mode has TIME in it. The screen's SIZE is `s`; the
   * per-pass spatial map is `s*m`. At `s*m < 1` the map contracts to its fixed
   * point, so every perturbation is dragged to the centre and dies — which is
   * why raising the amplitude gain alone can NEVER animate this geometry (see
   * backdraftTvCriticalGain). At `s*m > 1` the fixed point REPELS: structure
   * is transported OUTWARD and continuously re-nucleates at the centre, which
   * is exactly what Crutchfield photographs.
   */
  magnify?: number;
}

export type BackdraftTvRegion = 'screen' | 'bezel' | 'room';

/**
 * OUTPUT PIXEL -> which PREVIOUS-frame pixel the tube is showing, plus which of
 * the three exhaustive, disjoint regions this pixel is in.
 *
 * Forward: `T(q') = c + s*R(phi)*q'` places the whole previous frame inside the
 * screen. This is its inverse, in aspect-corrected centre-relative space (the
 * convention `shapeMask` already uses) so a rolled TV stays RECTANGULAR instead
 * of shearing at 4:3.
 *
 * BOUNDARY INVARIANT: `d < 0 ⟹ tapUv ∈ [0,1]²`. The rect SDF *is* the [0,1]²
 * test and every other shape is inscribed in it, so CLAMP_TO_EDGE is not
 * reached by the sample CENTRE and NO GL state changes — every other mode keeps
 * its documented clamp behaviour. (Bilinear reads a 2x2 neighbourhood, so a
 * fragment within half a texel of the frame edge does touch the clamp; it
 * clamps to the previous frame's edge texel, which is ROOM — the same value the
 * correct neighbour would have. That is why this is stated as "the sample
 * centre", not as "unreachable".) The invariant silently depends on aspect >= 1
 * and on BACKDRAFT_SHAPE_RADIUS <= 0.5, so it is an executable assertion
 * (backdraft.test.ts, N-INV), not a comment.
 */
export function backdraftTvTap(
  u: number,
  v: number,
  o: BackdraftTvGeo,
): { tapU: number; tapV: number; d: number; region: BackdraftTvRegion } {
  const a = o.aspect;
  const s = Math.max(1e-4, o.fill);
  const th = (o.rotateDeg * Math.PI) / 180;
  const c = Math.cos(th);
  const sn = Math.sin(th);
  const dx = (u - 0.5) * a - o.offX * a;
  const dy = v - 0.5 - o.offY;
  // R(-phi) then undo the scale.
  const px = (dx * c + dy * sn) / s;
  const py = (-dx * sn + dy * c) / s;
  const d = backdraftTvScreenSdf(px, py, o.shape, a, o.radius);
  // The SDF (the glass) uses `p`; the TAP additionally divides by the tube's
  // own magnification, so the set's SIZE and what it MAGNIFIES are independent.
  // m >= 1 shrinks |tapUv - 0.5|, so the boundary invariant `d < 0 => tapUv in
  // [0,1]^2` is only ever made TIGHTER by magnification (N-INV covers both).
  const m = Math.max(1e-4, o.magnify ?? 1);
  return {
    tapU: px / (a * m) + 0.5,
    tapV: py / m + 0.5,
    d,
    region: d < 0 ? 'screen' : d < o.bezelTb ? 'bezel' : 'room',
  };
}

/** One pixel of the PURE TV composite. Every field mirrors a shader value. */
export interface BackdraftTvCompositeArgs {
  /** The RAW previous-frame sample at tapUv (pre-flicker, pre-shoulder). */
  tap: readonly [number, number, number];
  /** The previous OUTPUT at the SAME x — untransformed. Crutchfield's
   *  `L*(I_n)_tau` term, and the whole of "phosphor". */
  persist: readonly [number, number, number];
  /** The RAW live source at x (pre-PURE-GEO — PURE GEO is ignored in PURE TV). */
  src: readonly [number, number, number];
  /** Signed distance from backdraftTvTap. */
  d: number;
  bezelTb: number;
  /** ROOM knob 0..1. */
  room: number;
  /** gEff from backdraftTvGain. */
  gain: number;
  /** Peak-normalised flicker multiplier, <= 1. */
  flick?: number;
  colour: { r: number; g: number; b: number; luma: number; chroma: number };
  white?: readonly [number, number, number];
  /** Per-channel one-frame residual from backdraftTvPhosphorRgb. */
  phos?: readonly [number, number, number];
  /** Capture-shoulder knee. ALWAYS ON inside the screen (see the plan §1.5):
   *  at the PURE TV default FLICKER is OFF, and a bare clamp() is not an
   *  amplitude limiter. */
  knee?: number;
  /** Antialias half-width for the two screen edges (0 = the hard CPU mirror,
   *  matching backdraftShapeMask's binary convention). */
  aa?: number;
  /** Multiplicative sensor-noise fraction (CRITICAL only; 0 in PURE TV). */
  noise?: number;
  /** Per-pass HUE ROTATION in radians about the luma axis (CRITICAL). */
  hue?: number;
  /** CRITICAL's LOCAL GAIN DROOP (kappa) — the vidicon's charge depletion: a
   *  patch that was bright LAST frame reads back with less gain THIS frame.
   *  0 = off (PURE TV). See BACKDRAFT_TV_DROOP_MAX. */
  droop?: number;
  /** The noise sample for this pixel/frame, in [0,1) (backdraftTvNoise). */
  noiseSample?: number;
}

export function backdraftTvComposite(args: BackdraftTvCompositeArgs): [number, number, number] {
  const w = args.white ?? BACKDRAFT_TV_WHITE;
  const phos = args.phos ?? [0, 0, 0];
  const knee = args.knee ?? BACKDRAFT_FLICKER_KNEE;
  const flick = args.flick ?? 1;
  const g = args.gain;
  const { r, g: gg, b, luma, chroma } = args.colour;

  // ROOM — the live source at full strength plus an ambient floor, OUTSIDE the
  // screen only. Injecting it inside S is exactly the defect PURE TV exists to
  // fix: a flat full-strength copy on every pass overwrites every level.
  const room: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    room[i] = args.room * (args.src[i]! * (1 - BACKDRAFT_TV_AMBIENT) + BACKDRAFT_TV_AMBIENT);
  }

  // The tube: shoulder(tap * flick) -> colour chain -> gain, plus the glass
  // reflection of the LOCAL room (which is also the depth plateau).
  const tint: [number, number, number] = [0, 0, 0];
  const chan = [r, gg, b];
  // Crutchfield's ~1 % sensor noise, multiplicative so it is a real SNR: it
  // cannot seed anything in a dark region (which is why his rig needs a
  // flashlight to restart a dark screen), but at near-unity loop gain it is
  // what the instability has to amplify.
  const nz = 1 + (args.noise ?? 0) * (2 * (args.noiseSample ?? 0.5) - 1);
  for (let i = 0; i < 3; i++) {
    tint[i] = backdraftShoulder(args.tap[i]! * flick * nz, knee) * chan[i]! * luma * w[i]!;
  }
  const l = BACKDRAFT_LUMA_WEIGHTS[0]! * tint[0]!
    + BACKDRAFT_LUMA_WEIGHTS[1]! * tint[1]!
    + BACKDRAFT_LUMA_WEIGHTS[2]! * tint[2]!;
  const picture: [number, number, number] = [0, 0, 0];
  // The glass plateau vanishes as the loop gain reaches 1 and must not go
  // NEGATIVE once the user drives PAST it: an over-driven loop has no plateau
  // left, it is all picture.
  const liftF = Math.max(0, 1 - g);
  // LOCAL GAIN DROOP — the vidicon's charge depletion, and the ONE ingredient
  // that gives this geometry a time axis. Every other lever (raising the gain
  // ceiling, expanding the spatial map) leaves a POSITIVE MONOTONE per-pass
  // operator, which has a unique globally attracting fixed point no matter how
  // large the gain is; measured, all of them converge bit-exactly. Droop makes
  // the loop TWO-dimensional per pixel — a fast activator (the tap) against a
  // slow, LAGGED inhibitor (the previous output at the same x, smoothed by
  // PHOSPHOR) — which is a relaxation oscillator, and spatially coupled by the
  // screen map it is an excitable medium. That is Crutchfield's regime.
  const droop = args.droop ?? 0;
  const hue = args.hue ?? 0;
  const tc: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) tc[i] = l + (tint[i]! - l) * chroma;
  if (hue !== 0) {
    // Off-diagonal colour coupling (Crutchfield eq. 5, p.236: "their
    // off-diagonal elements the coupling of the color signals"): rotate the
    // chroma vector about the luma axis by `hue` radians per pass.
    const ca = Math.cos(hue), sa = Math.sin(hue);
    const lm = BACKDRAFT_LUMA_WEIGHTS[0]! * tc[0]! + BACKDRAFT_LUMA_WEIGHTS[1]! * tc[1]! + BACKDRAFT_LUMA_WEIGHTS[2]! * tc[2]!;
    const c0 = tc[0]! - lm, c1 = tc[1]! - lm, c2 = tc[2]! - lm;
    const k = 1 / Math.sqrt(3);
    // Rodrigues rotation about (1,1,1)/sqrt(3).
    const dot = k * (c0 + c1 + c2);
    const cx0 = k * (c1 - c2), cx1 = k * (c2 - c0), cx2 = k * (c0 - c1);
    tc[0] = lm + c0 * ca + cx0 * sa + k * dot * (1 - ca);
    tc[1] = lm + c1 * ca + cx1 * sa + k * dot * (1 - ca);
    tc[2] = lm + c2 * ca + cx2 * sa + k * dot * (1 - ca);
  }
  for (let i = 0; i < 3; i++) {
    const gLocal = droop > 0 ? g / (1 + droop * Math.max(0, args.persist[i]!)) : g;
    picture[i] = tc[i]! * gLocal + BACKDRAFT_TV_GLASS * room[i]! * liftF;
  }

  // Three regions, resolved with the same two smoothsteps the shader uses (the
  // TV branch runs in UNIFORM control flow, so fwidth() is legal there).
  const aa = args.aa ?? 0;
  const step = (e0: number, e1: number, x: number): number => {
    if (!(e1 > e0)) return x < e0 ? 0 : 1;
    const t = clamp01((x - e0) / (e1 - e0));
    return t * t * (3 - 2 * t);
  };
  const inScreen = 1 - step(-aa, aa, args.d);
  const inSet = 1 - step(args.bezelTb - aa, args.bezelTb + aa, args.d);

  const out: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const bez = BACKDRAFT_TV_BEZEL_RGB[i]! * args.room;
    const base = room[i]! + (bez - room[i]!) * inSet;
    const composed = base + (picture[i]! - base) * inScreen;
    // PHOSPHOR — one IN-PLACE, UNTRANSFORMED, UNIT-DC-GAIN pole. Unit DC gain
    // is a STABILITY REQUIREMENT: sup-norm loop gain (1-rho)*g + rho < 1 for
    // any g<1, and the fixed point satisfies I* = C(I*), so rho changes only
    // the temporal smear and NEVER the converged image. Had the two terms
    // ADDED, rho = 0.9 with FEEDBACK 0.85 would blow up instantly.
    out[i] = clamp01(composed + (args.persist[i]! - composed) * phos[i]!);
  }
  return out;
}

/** Level-k annulus brightness. With `knee >= 1` (no shoulder) this is the
 *  closed form `B_k = room*g^k + P*(1-g^k)`; with the real 0.55 knee the
 *  always-on capture shoulder compresses the bright end, so it is iterated. */
export function backdraftTvLevelBrightness(
  k: number,
  gain: number,
  plateau: number,
  room: number = 1,
  knee: number = 1,
): number {
  const lift = plateau * (1 - gain);
  let b = room;
  const n = Math.max(0, Math.round(k));
  for (let i = 0; i < n; i++) b = gain * backdraftShoulder(b, knee) + lift;
  return b;
}

/**
 * How deep the nest actually RESOLVES, and why it stops there.
 *
 *   resolution — the level at which the picture is 2 px across
 *   contrast   — the level at which the gain cascade falls under 1/255
 *   resolved   — the honest band count: the level at which the BEZEL band
 *                (the only thing separating level k from k+1) goes sub-pixel.
 *                This is the binding constraint and it is what the card shows.
 */
export function backdraftTvDepth(o: {
  fill: number;
  gain: number;
  widthPx: number;
  bezelTb?: number;
  aspect?: number;
}): { resolution: number; contrast: number; resolved: number } {
  const s = Math.min(0.999999, Math.max(1e-4, o.fill));
  const g = Math.min(0.999999, Math.max(1e-4, o.gain));
  const w = Math.max(2, o.widthPx);
  const tb = o.bezelTb ?? backdraftTvBezel(0.4);
  const aspect = o.aspect ?? 4 / 3;
  const resolution = Math.log(2 / w) / Math.log(s);
  const contrast = Math.log(1 / 255) / Math.log(g);
  const kBezel = Math.log(aspect / Math.max(1e-9, tb * w)) / Math.log(s) - 1;
  return {
    resolution,
    contrast,
    resolved: Math.max(0, Math.floor(Math.min(kBezel, resolution, contrast))),
  };
}

/** Options for the GL-free PURE TV mirror. Defaults reproduce the module's
 *  shipped PURE TV defaults on a bright static room. */
export interface BackdraftTvSimOptions {
  /** Frame width in cells. Height = round(size/aspect). 128 resolves 5-6
   *  levels at fill 0.75; 512 resolves ~10. */
  size?: number;
  aspect?: number;
  frames?: number;
  /** ZOOM knob (remapped through backdraftTvFill) — or pass `fill` directly. */
  zoom?: number;
  fill?: number;
  /** The RAW rotate knob; the ×6 PURE TV scale is applied here. */
  rotate?: number;
  /** …or the effective roll phi in degrees, bypassing the scale. */
  rotateDeg?: number;
  offX?: number;
  offY?: number;
  bezel?: number;
  shape?: number;
  room?: number;
  /** Live source. A scalar is a flat grey; a function gives a textured room. */
  source?: number | ((u: number, v: number) => readonly [number, number, number]);
  feedback?: number;
  effectScale?: number;
  r?: number; g?: number; b?: number; luma?: number; chroma?: number;
  white?: readonly [number, number, number];
  phosphor?: number;
  flicker?: number;
  /** Simulation seconds per frame, for the FLICKER phase (default 1/60). */
  dt?: number;
  /** DELAY in frames (d >= 1) — level k is k*d frames old. */
  delayFrames?: number;
  /** Quantise every written frame to RGBA8, as the real FBOs do. */
  quantize?: boolean;
  knee?: number;
  /** Seed the ring with this constant instead of black (cold start). */
  seed?: number;
  /** CRITICAL: replace the contraction ceiling with the DRIVE law + noise. */
  critical?: boolean;
  drive?: number;
  /** Tube magnification m (see BackdraftTvGeo.magnify). Defaults to the DRIVE
   *  law's own magnification in CRITICAL, and to exactly 1 in PURE TV. */
  magnify?: number;
  /** Force the VIRTUAL REFRESH on/off independently of FLICKER. Defaults to
   *  "on whenever FLICKER is on", which is the shipped coupling; setting it
   *  false ISOLATES the refresh from flicker's gain band, which is what makes a
   *  clean control possible (flicker changes brightness everywhere, so
   *  flicker-on vs flicker-off cannot attribute anything to the seam). */
  refresh?: boolean;
  /** Override the auto-exposure servo rate (defaults to the DRIVE law). */
  agcRate?: number;
  /** Override the auto-exposure set point. */
  agcTarget?: number;
  /** Local gain droop kappa (see BackdraftTvCompositeArgs.droop). */
  droop?: number;
  /** Per-pass hue rotation in radians (see BackdraftTvCompositeArgs.hue). */
  hue?: number;
  /** Override the noise fraction (defaults to BACKDRAFT_TV_NOISE in CRITICAL,
   *  0 in PURE TV). Set explicitly to build the noise-only negative control. */
  noise?: number;
  /** Called after every frame with (frameIndex, frameBuffer) — lets a test
   *  watch the evolution without re-running the sim. */
  onFrame?: (n: number, frame: Float32Array) => void;
}

export interface BackdraftTvSimResult {
  frame: Float32Array;
  width: number;
  height: number;
  aspect: number;
  fill: number;
  bezelTb: number;
  gain: number;
  plateau: number;
  /** Mean |Δ| between the last two frames — how converged the run is. */
  lastDelta: number;
  /** Final auto-exposure servo state (1 when the servo is off). */
  agc: number;
}

/**
 * The GL-free PURE TV mirror: bilinear tap, a ring of `d+1` past frames, the
 * explicit three-region boundary, the in-place persistence pole, optional
 * RGBA8 quantisation. This is where NESTING is proven — a shader cannot be
 * unit-tested, and the whole feature is a geometric claim.
 */
export function simulateBackdraftTv(o: BackdraftTvSimOptions = {}): BackdraftTvSimResult {
  const aspect = o.aspect ?? 4 / 3;
  const W = Math.max(8, Math.round(o.size ?? 128));
  const H = Math.max(8, Math.round(W / aspect));
  const frames = Math.max(1, Math.round(o.frames ?? 120));
  const fill = o.fill ?? backdraftTvFill(o.zoom ?? 1);
  const rotateDeg = o.rotateDeg ?? backdraftTvRotationDeg(o.rotate ?? 0);
  const bezelTb = backdraftTvBezel(o.bezel ?? 0.4);
  const room = o.room ?? 1;
  const d = Math.max(1, Math.round(o.delayFrames ?? 1));
  const knee = o.knee ?? BACKDRAFT_FLICKER_KNEE;
  const dt = o.dt ?? 1 / BACKDRAFT_FPS;
  const colour = {
    r: o.r ?? 1, g: o.g ?? 1, b: o.b ?? 1, luma: o.luma ?? 1, chroma: o.chroma ?? 1,
  };
  const white = o.white ?? BACKDRAFT_TV_WHITE;
  const phos = backdraftTvPhosphorRgb(o.phosphor ?? 0);
  const opNorm = backdraftTvOpNorm({ ...colour, white });
  const critical = o.critical === true;
  // PURE TV: the operator-norm contraction ceiling. CRITICAL: a fixed base loop
  // gain above 1, REGULATED each frame by the auto-exposure servo below.
  const baseGain = critical
    ? (BACKDRAFT_TV_CRIT_GAIN * Math.max(0, o.effectScale ?? 1)) / Math.max(opNorm, 1e-4)
    : backdraftTvGain(opNorm, o.feedback ?? 0.85, o.effectScale ?? 1);
  const agcRate = critical ? (o.agcRate ?? backdraftTvAgcRate(o.drive ?? 0.5)) : 0;
  const agcTarget = o.agcTarget ?? BACKDRAFT_TV_AGC_TARGET * Math.max(0.05, room);
  let agc = 1;
  const noise = o.noise ?? (critical ? BACKDRAFT_TV_NOISE : 0);
  const droop = o.droop ?? 0;
  const hue = o.hue ?? 0;
  const magnify = o.magnify ?? 1;
  const geo: BackdraftTvGeo = { aspect, fill, rotateDeg, offX: o.offX ?? 0, offY: o.offY ?? 0, bezelTb, shape: o.shape ?? 0, magnify };

  const srcFn = typeof o.source === 'function'
    ? o.source
    : ((): ((u: number, v: number) => readonly [number, number, number]) => {
      const s = typeof o.source === 'number' ? o.source : 1;
      const flat: readonly [number, number, number] = [s, s, s];
      return () => flat;
    })();

  const N = W * H * 3;
  // d + 2, not d + 1: the VIRTUAL REFRESH needs frame n-d-1 as well as n-d.
  const ringSize = d + 2;
  const ring: Float32Array[] = [];
  for (let i = 0; i < ringSize; i++) {
    const f = new Float32Array(N);
    if (o.seed) f.fill(o.seed);
    ring.push(f);
  }
  let persist = new Float32Array(N);
  if (o.seed) persist.fill(o.seed);

  // Precompute the per-pixel tap + region (the geometry is time-invariant).
  const tapU = new Float32Array(W * H);
  const tapV = new Float32Array(W * H);
  const dist = new Float32Array(W * H);
  const srcRgb = new Float32Array(N);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const u = (x + 0.5) / W;
      const v = (y + 0.5) / H;
      const t = backdraftTvTap(u, v, geo);
      tapU[i] = t.tapU; tapV[i] = t.tapV; dist[i] = t.d;
      const s = srcFn(u, v);
      srcRgb[i * 3] = s[0]; srcRgb[i * 3 + 1] = s[1]; srcRgb[i * 3 + 2] = s[2];
    }
  }

  const sample = (buf: Float32Array, u: number, v: number, out: [number, number, number]): void => {
    // Bilinear with CLAMP_TO_EDGE, exactly as the GL sampler does.
    const fx = Math.min(W - 1, Math.max(0, u * W - 0.5));
    const fy = Math.min(H - 1, Math.max(0, v * H - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
    const ax = fx - x0, ay = fy - y0;
    for (let c = 0; c < 3; c++) {
      const p00 = buf[(y0 * W + x0) * 3 + c]!, p10 = buf[(y0 * W + x1) * 3 + c]!;
      const p01 = buf[(y1 * W + x0) * 3 + c]!, p11 = buf[(y1 * W + x1) * 3 + c]!;
      out[c] = (p00 * (1 - ax) + p10 * ax) * (1 - ay) + (p01 * (1 - ax) + p11 * ax) * ay;
    }
  };

  const tapRgb: [number, number, number] = [0, 0, 0];
  const tapOldRgb: [number, number, number] = [0, 0, 0];
  const persistRgb: [number, number, number] = [0, 0, 0];
  const srcPix: [number, number, number] = [0, 0, 0];
  let head = 0;
  let lastDelta = 0;
  let lastGain = baseGain;

  for (let n = 0; n < frames; n++) {
    const prev = ring[(head - d + ringSize) % ringSize]!;
    const prevOlder = ring[(head - d - 1 + ringSize) % ringSize]!;
    const beam = backdraftTvBeam(o.flicker ?? 0, n * dt);
    const refreshOn = o.refresh ?? ((o.flicker ?? 0) > 0);
    const dst = ring[head]!;
    const timeSec = n * dt;
    let delta = 0;
    // The exposure the camera is using THIS frame — metered off the frame it
    // captured LAST frame, which is what makes the servo a lagged integrator
    // rather than an instantaneous divider.
    const gain = baseGain * agc;
    lastGain = gain;
    let frameSum = 0;
    for (let y = 0; y < H; y++) {
      const v = (y + 0.5) / H;
      const flick = backdraftTvFlickerMult(o.flicker ?? 0, timeSec, v);
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        sample(prev, tapU[i]!, tapV[i]!, tapRgb);
        if (refreshOn) {
          // The seam sits in the MONITOR's raster (the tap row), so each pass
          // re-images the seam it photographed and adds its own.
          sample(prevOlder, tapU[i]!, tapV[i]!, tapOldRgb);
          const newness = backdraftTvRefreshMix(tapV[i]!, beam);
          for (let c = 0; c < 3; c++) {
            tapRgb[c] = tapOldRgb[c]! + (tapRgb[c]! - tapOldRgb[c]!) * newness;
          }
        }
        persistRgb[0] = persist[i * 3]!; persistRgb[1] = persist[i * 3 + 1]!; persistRgb[2] = persist[i * 3 + 2]!;
        srcPix[0] = srcRgb[i * 3]!; srcPix[1] = srcRgb[i * 3 + 1]!; srcPix[2] = srcRgb[i * 3 + 2]!;
        const px = backdraftTvComposite({
          tap: tapRgb, persist: persistRgb, src: srcPix, d: dist[i]!, bezelTb,
          room, gain, flick, colour, white, phos, knee, noise, droop, hue,
          noiseSample: noise > 0 ? backdraftTvNoise(x, y, n) : 0.5,
        });
        for (let c = 0; c < 3; c++) {
          const q = o.quantize ? Math.round(px[c]! * 255) / 255 : px[c]!;
          delta += Math.abs(q - dst[i * 3 + c]!);
          dst[i * 3 + c] = q;
          frameSum += q;
        }
      }
    }
    lastDelta = delta / N;
    if (agcRate > 0) agc = backdraftTvAgcStep(agc, frameSum / N, agcRate, agcTarget);
    persist = dst.slice();
    head = (head + 1) % ringSize;
    if (o.onFrame) o.onFrame(n, dst);
  }

  return {
    frame: ring[(head - 1 + ringSize) % ringSize]!,
    width: W, height: H, aspect, fill, bezelTb, gain: lastGain, agc,
    plateau: BACKDRAFT_TV_GLASS * room, lastDelta,
  };
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
    // PURE TV — tv_gate is gate/clock style (NO cvScale => raw passthrough); a
    // RISING edge TOGGLES the bounded-screen mode. ROOM + PHOSPHOR are
    // continuous knob modulators and carry cvScale like every other fader CV.
    // (A slow LFO on ROOM is Crutchfield's flashlight gesture — p.232 makes
    // external illumination load-bearing, not decorative.)
    { id: 'tv_gate',       type: 'cv', paramTarget: 'tvGate' },
    { id: 'room',          type: 'cv', paramTarget: 'room',     cvScale: { mode: 'linear' } },
    { id: 'phosphor',      type: 'cv', paramTarget: 'phosphor', cvScale: { mode: 'linear' } },
    { id: 'drive',         type: 'cv', paramTarget: 'drive',    cvScale: { mode: 'linear' } },
    // VIRTUAL CAMERA ORIENTATION — two joysticks + a fader, all CV-able.
    { id: 'cam_tilt_x',    type: 'cv', paramTarget: 'camTiltX', cvScale: { mode: 'linear' } },
    { id: 'cam_tilt_y',    type: 'cv', paramTarget: 'camTiltY', cvScale: { mode: 'linear' } },
    { id: 'cam_pos_x',     type: 'cv', paramTarget: 'camPosX',  cvScale: { mode: 'linear' } },
    { id: 'cam_pos_y',     type: 'cv', paramTarget: 'camPosY',  cvScale: { mode: 'linear' } },
    { id: 'cam_dist',      type: 'cv', paramTarget: 'camDist',  cvScale: { mode: 'linear' } },
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
    // FLICKER — a DISCRETE 6-position index (0=off, 1=6Hz, 2=24Hz, 3=50Hz,
    // 4=59.94Hz, 5=119.88Hz) modelling the display's pulsed emission as our
    // virtual camera captures it, and what the camera's own storage + shoulder
    // then do to it. 0 = OFF is the bit-identical no-op default.
    { id: 'flicker', label: 'Flicker', defaultValue: DEFAULTS.flicker, min: 0, max: BACKDRAFT_FLICKER_COUNT - 1, curve: 'discrete' },
    // PURE TV — the bounded-screen (Crutchfield) mode. `tvMode` is a DISCRETE
    // 3-position index (0=off, 1=PURE TV, 2=CRITICAL); the TV button and the
    // tv_gate rising edge both cycle it. 0 is the exact-zero no-op: the shader
    // branch is skipped entirely and the legacy composite is untouched.
    { id: 'tvMode',   label: 'TV Mode',  defaultValue: DEFAULTS.tvMode,   min: 0, max: BACKDRAFT_TV_MODE_COUNT - 1, curve: 'discrete' },
    // Synthetic gate param the tv_gate CV bridge writes — hidden (no card
    // knob); the module edge-detects a rising edge to CYCLE the mode.
    { id: 'tvGate',   label: 'TV Gate',  defaultValue: DEFAULTS.tvGate,   min: 0,  max: 1,                     curve: 'linear' },
    { id: 'room',     label: 'Room',     defaultValue: DEFAULTS.room,     min: 0,  max: 1,                     curve: 'linear' },
    { id: 'bezel',    label: 'Bezel',    defaultValue: DEFAULTS.bezel,    min: 0,  max: 1,                     curve: 'linear' },
    { id: 'phosphor', label: 'Phos',     defaultValue: DEFAULTS.phosphor, min: 0,  max: 1,                     curve: 'linear' },
    { id: 'drive',    label: 'Drive',    defaultValue: DEFAULTS.drive,    min: 0,  max: 1,                     curve: 'linear' },
    // VIRTUAL CAMERA ORIENTATION — bipolar joysticks, unipolar distance fader.
    { id: 'camTiltX', label: 'Tilt X',   defaultValue: DEFAULTS.camTiltX, min: -BACKDRAFT_CAM_TILT_RANGE, max: BACKDRAFT_CAM_TILT_RANGE, curve: 'linear' },
    { id: 'camTiltY', label: 'Tilt Y',   defaultValue: DEFAULTS.camTiltY, min: -BACKDRAFT_CAM_TILT_RANGE, max: BACKDRAFT_CAM_TILT_RANGE, curve: 'linear' },
    { id: 'camPosX',  label: 'Cam X',    defaultValue: DEFAULTS.camPosX,  min: -BACKDRAFT_CAM_POS_RANGE,  max: BACKDRAFT_CAM_POS_RANGE,  curve: 'linear' },
    { id: 'camPosY',  label: 'Cam Y',    defaultValue: DEFAULTS.camPosY,  min: -BACKDRAFT_CAM_POS_RANGE,  max: BACKDRAFT_CAM_POS_RANGE,  curve: 'linear' },
    { id: 'camDist',  label: 'Dist',     defaultValue: DEFAULTS.camDist,  min: 0,  max: 1,                     curve: 'linear' },
    // freeze is a hidden VRT/determinism toggle — no card control.
    { id: 'freeze',   label: 'Freeze',   defaultValue: DEFAULTS.freeze,   min: 0,  max: 1,                     curve: 'linear' },
  ],

  docs: {
    explanation: `BACKDRAFT is a video feedback generator. It builds a "source" image by crossfading two video inputs (IN A / IN B) with MIX, then composites that against a processed copy of its OWN previous output, read from an internal ring of past frames so there is no live GL feedback loop (downstream sees frame N while the tap reads N-1..N-30). The fed-back frame is delayed (DELAY, 0-500ms or a clock pulse), colour-processed (per-channel R/G/B gain, then LUMA brightness, then CHROMA saturation), scaled per-pixel by two key masks (KEY+ lightens / KEY- darkens the effect), and geometrically warped a little each pass (ZOOM/ROTATE/OFF X/OFF Y) so the transform COMPOUNDS into tunnels, spirals, and directional trails. Two MIRROR buttons fold the whole composited frame into a kaleidoscope. A SHAPE button cuts the frame to a geometric mask (square = full frame, then circle / pentagon / triangle / octagon), and a PURE GEO button picks the masking SPACE: ON masks the FINAL OUTPUT in screen space (a fixed shape that cuts everything outside it at all zooms), OFF masks the SOURCE in the zoomed feedback space so the shape scales with ZOOM and its content spills out through the feedback tunnel (zoom-in pushes it toward the corners, zoom-out shrinks it). As FEEDBACK approaches its max (and a spatial transform is active) the additive trail-accumulator ramps into a pure recursive hall of mirrors. A FLICKER control (OFF / 6 / 24 / 50 / 60 / 120 Hz) models the display's pulsed emission as the virtual camera actually captures it, and then models what the CAMERA does to it: the emission rate beats against the camera's 60 fps sampling, so the per-frame loop gain oscillates around unity instead of being constant, and light can build up over several frames and then fade away rather than pinning at white — with a rolling-shutter band crawling down the frame at the beat rate. The captured light then passes through the sensor's multi-frame charge storage (a low-pass on the BEAT, so fast beats become soft shimmer while slow ones keep their full swing) and its saturating shoulder (so the modulation stops acting where the image is already hot and reads as contour shimmer rather than a full-field flash). That is what makes the fast positions breathe instead of strobe. Usage: patch a camera or generator into IN A, raise FEEDBACK toward ~1 and nudge ZOOM off 1.0 (with a little ROTATE) for the classic infinite-tunnel look; add OFF X/Y for smear, PIXELATE for blocky lo-fi, a SHAPE for a geometric vignette, and clock DELAY CLK for rhythmic echo. Output is the OUT video jack. The card carries NO in-rack picture. It used to show a 320×240 display, and that display was the single biggest consumer of the card's width and height; taking it out bought the module a narrower rack tier and taller faders, which is the better trade for a panel with this many controls. Feedback is still steered by watching it, so the output is one click away rather than always-on: the ⛶ OUTPUT button opens Full Frame (the card itself becomes a video panel in the rack), Full Screen, and Present-on-another-display, all of which grow the SAME surface — the button is now the only entry point, since there is no picture to right-click. For an arbitrarily-sized monitor, patch OUT into VIDEO OUT. The controls sit in two rows. Down the left of the first row are the discrete switches — MIRROR X / MIRROR Y, SHAPE and PURE GEO — with TV MODE, its fill/band readout and the OUTPUT button to their right and the six-position FLICKER switch beneath them; beside and below them run the labelled fader banks: LOOP (Mix/FB/Delay), COLOUR (Luma/Chroma/R/G/B), KEY (Lighten/Darken), GEOMETRY (Zoom/Rotate/Off X/Off Y/Pixelate), TV SCREEN (Room/Border/Phosphor/Drive — BORDER is the bezel, i.e. the screen frame's thickness) and VIRTUAL CAMERA, whose two 2-D pads steer the camera's TILT and POSITION with a DIST fader beside them. A control that does nothing in the current mode is DIMMED rather than hidden or disabled, so it stays draggable, resettable and MIDI-learnable and the card never changes height with the mode: the TV SCREEN bank dims while TV MODE is OFF (its title becomes a button that turns TV MODE on), and PURE GEO dims in PURE TV / CRITICAL, where SHAPE means only the screen's outline.`,
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
      tv_gate: "Gate/clock input (raw passthrough, edge-detected). A RISING edge CYCLES TV MODE (off → PURE TV → CRITICAL → off), so a clock can flip the module between the infinite-plane tunnel and the bounded-screen television. Edge-triggered, not a held level.",
      room: "CV (linear) that modulates the Room control — the light level OUTSIDE the TV screen in PURE TV / CRITICAL. A slow LFO here is Crutchfield's flashlight gesture (his rig needs external light to restart a dark screen). No effect while TV MODE is off.",
      phosphor: "CV (linear) that modulates the Phos control, the one-frame image retention (camera charge storage) applied in place. No effect while TV MODE is off.",
      cam_tilt_x: "CV (linear, bipolar) that modulates Tilt X — swings the virtual camera left/right of the screen's normal, keystoning the set horizontally. No effect while TV MODE is off.",
      cam_tilt_y: "CV (linear, bipolar) that modulates Tilt Y — swings the virtual camera above/below the screen's normal, keystoning it vertically. No effect while TV MODE is off.",
      cam_pos_x: "CV (linear, bipolar) that modulates Cam X — slides the virtual camera sideways in its own plane, out past the screen's borders at the extremes. No effect while TV MODE is off.",
      cam_pos_y: "CV (linear, bipolar) that modulates Cam Y — slides the virtual camera up/down in its own plane. No effect while TV MODE is off.",
      cam_dist: "CV (linear) that modulates Dist — how far the virtual camera stands off, i.e. how violently a given tilt keystones. No effect while TV MODE is off, or while the camera is dead-on.",
      drive: "CV (linear) that modulates the Drive control — CRITICAL's auto-exposure servo rate, i.e. how hard the mode sits on the edge of white-out. Below the midpoint the picture is a still nest; above it, it breathes. No effect outside CRITICAL.",
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
      flicker: "Flicker (discrete OFF / 6 / 24 / 50 / 60 / 120, default OFF): in PURE TV / CRITICAL this ALSO drives the virtual refresh — the line-by-line redraw seam that cascades through the nest (see TV Mode). Models a real display emitting light in PULSES rather than continuously, the camera integrating over an exposure window shorter than the pulse period, and the camera sampling at its own frame rate. The two rates BEAT, so the per-frame loop gain cycles above and below its own average instead of being constant — which is what lets pulses of light build up over several frames and then fade away rather than saturating to white and staying there. OFF is the exact no-op (the shader branch is skipped, output is bit-identical). The virtual camera runs at a fixed 60 fps, so the beat is: 6 Hz at the 6 position (below the camera rate, so no aliasing — the camera sees the pulsing DIRECTLY at 10 frames per cycle, the slowest and most obvious breathing); 24 Hz at 24 (2.5 frames per cycle, a fine fast texture); 10 Hz at 50 (6 frames per cycle — the classic look of filming a PAL monitor with an NTSC camera, and the best all-round build-and-fade); 0.06 Hz at 60 (the true NTSC field rate 60000/1001 = 59.94 Hz, a ~16.7-second slow swell — the slowly crawling hum bar you see filming a television); and 0.12 Hz at 120 (119.88 Hz, 2x NTSC — the rolling shutter fits almost exactly one full band cycle down the frame here, which cancels the whole-frame pulsing and leaves a PURE crawling band). Exact multiples of 60 would genlock to a constant gain and not move at all, which is why the 60 and 120 positions use the NTSC rates. A 90-degree shutter (1/240 s) sets how much of each pulse is caught, and the rolling shutter spreads the flicker phase down the frame so a soft light/dark band crawls vertically at the beat rate and feeds back through the loop. Two camera-side terms keep it watchable rather than strobing: the sensor's multi-frame charge storage is a LOW-PASS ON THE BEAT (it cuts 6/24/50 hard and passes 60/120 essentially untouched, so the fast positions shimmer and the slow ones breathe), and a saturating capture shoulder makes the response level-dependent so the modulation acts on midtone contours instead of flashing the whole field. The loop's average gain is held constant as you switch positions, so the FB control keeps meaning the same thing.",
      tvMode: "TV Mode (discrete OFF / PURE TV / CRITICAL, default OFF): switches BACKDRAFT from an infinite feedback PLANE to a bounded SCREEN. OFF is the exact no-op — the shader branch is skipped and the classic composite is untouched. PURE TV builds the thing a camera pointed at a television actually sees: the previous frame is drawn, whole, inside a bezelled screen rectangle that fills 75% of the frame (set by ZOOM), and OUTSIDE that screen is the live input — so IN PURE TV YOUR INPUT IS THE ROOM, NOT THE PICTURE, and the picture is the feedback. Because each pass places the entire previous view (room, bezel and picture) inside the next screen, the image NESTS: about 11 resolved frames-within-frames, each 3/4 the size of the last and each dimmer, converging on a milky core at 20% of the room level. That nesting is forced by the geometry rather than tuned, which is why no combination of the old FEEDBACK/ZOOM controls could ever produce it — the old map adds the live input to EVERY pixel and clamps the previous frame across the whole plane, so there is no 'outside the TV' left to re-image. PURE TV is a strict contraction: it converges to a STILL nest, and motion in the room cascades inward one level per DELAY. CRITICAL keeps that geometry and adds the camera's AUTOMATIC EXPOSURE — a servo with memory that meters the frame it just captured and pushes its gain the other way. Because it integrates, it overshoots, and past the DRIVE midpoint the overshoot becomes a self-sustaining limit cycle: the picture blooms toward white, the servo hauls it back, and the correction propagates inward through the nest one level per DELAY as a travelling annulus. That is the mode for riding the edge of white-out. In BOTH TV modes the FLICKER control additionally drives a VIRTUAL REFRESH: a real set is redrawn line by line, so its face at any instant is a SEAM between two successive fields — new above the beam, previous below it — and a camera pointed at it catches that seam. Because the seam sits in the MONITOR's own raster rather than in the camera's frame, every nesting level re-photographs a screen that already has one, so level k carries k seams at k different ages and the refresh cascades inward through the whole nest. FLICKER's rate sets how fast the beam sweeps: the 60 position (the true NTSC field rate) leaves it creeping, which is the classic slow hum bar you see filming a television, while the 6 position races it down the frame several times a second. FLICKER OFF is the exact no-op — no beam, no seam, and the tap is unchanged. This is a different effect from FLICKER's rolling-shutter brightness band, which stays in SCREEN space because the shutter scans the sensor and not the scene: one changes a row's BRIGHTNESS, the other changes which FRAME the row came from. The TV button cycles the mode; tv_gate cycles it on a rising edge.",
      tvGate: "TV Gate (0..1, default 0): hidden synthetic param the tv_gate CV bridge writes (raw gate swing). No card knob; a rising edge cycles TV MODE.",
      room: "Room (0..1, default 1.0): the light level OUTSIDE the screen in PURE TV / CRITICAL — the live input at full strength plus a 5% ambient floor. The ambient floor is range-preserving, so even with nothing patched the mode still lights its own room and demonstrates its geometry. Turning ROOM down dims the set and the whole nest with it (the brightness cascade stays correctly ordered at every room level, rather than flattening or inverting as an absolute lift would). Inert while TV MODE is off.",
      bezel: "Bezel — labelled BORDER on the card, because 'border thickness' is what people look for (0..1, default 0.5 = the shipped look, mid-travel): the THICKNESS of the set's border, in screen-local units, so a level-k bezel automatically lands 3/4-scaled — deeper borders shrink because they are IMAGES of the real one. The fader reaches EXACTLY 0 (a borderless screen) at the bottom and opens thicker than the default at the top. Worth knowing what 0 costs, because it is a real trade rather than a free option: the border is the only high-contrast boundary between one nesting level and the next, so at 0 the nest stops reading as frames-within-frames and becomes a smooth zoom. That is a legitimate look, it is simply not the one the mode is named for. Inert while TV MODE is off.",
      phosphor: "Phos / Phosphor (0..1, default 0): one-frame image retention, applied IN PLACE (no transform) — the term that makes delay smear rather than step. Despite the name this is NOT phosphor: a colour TV's P22 phosphor retains about 4e-73 of a frame, which is nothing, and Crutchfield says so himself. The real integrator in a camera-at-a-TV rig is the CAMERA's charge storage, roughly 10 frames, and that is what this models. Level k has been through the filter k times, so deeper levels are older in proportion to k and blurrier in time in proportion to the square root of k. Unit DC gain, so it changes only the temporal smear and never the converged image. Tube ladder: 0 = colour TV (no inter-frame tail exists, and the honest default), 0.13 = P4 mono TV, 0.16 = P1 scope green, 0.86 = P39 radar, 1.0 = P7 dual-layer radar. Inert while TV MODE is off.",
      drive: "Drive (0..1, default 0.5): CRITICAL's auto-exposure servo RATE — how hard the mode rides the edge of white-out. This is a time constant, not a gain, and the fader is geometric (equal steps are equal FACTORS, from 1 to 49 per frame) because a servo speed is scale-free; that also makes a linear CV ramp read as a smooth accelerando into instability rather than a cliff. The default 0.5 sits exactly ON the measured bifurcation. Below it the servo is a well-behaved regulator and the nest is dead still; above it the servo overshoots into a sustained limit cycle and the picture breathes — blooming toward white, being hauled back, and sending each correction inward through the nest one level per DELAY. The swing deepens monotonically with the knob. The exposure state is hard-clamped, which is what makes a white-out always recoverable: back DRIVE off and the nest returns. Ignored outside CRITICAL.",
      camTiltX: "Tilt X (-0.2..+0.2, default 0 = dead-on): VIRTUAL CAMERA ORIENTATION. Swings the camera left or right of the screen's normal while it keeps pointing the same way, so the set images as a TRAPEZOID rather than a rectangle — the far edge shorter than the near one. Because every pass re-photographs the pass before it, the keystone COMPOUNDS: the nest curls away toward the vanishing point instead of shrinking straight into the middle. Deep levels therefore go illegible sooner than they do dead-on; that is what an angled camera really does, not a defect. Re-aiming the camera also MOVES THE VANISHING POINT — the accumulation point of the frame-in-frame-in-frame is the fixed point of the map, so tilting re-composes the whole nest rather than just sliding the picture across the frame. And because the map is ITERATED, that re-composition RECURSES THROUGH THE FEEDBACK NETWORK: the move reaches level k only after k*DELAY frames, so a camera gesture travels inward through the nest exactly the way motion in the room and the refresh seam do. 0 is the exact dead-on default, where the map is the plain affine one and this control costs nothing.",
      camTiltY: "Tilt Y (-0.2..+0.2, default 0 = dead-on): the vertical half of the tilt joystick — swings the camera above or below the screen's normal, keystoning the set top-to-bottom. Combine with Tilt X to look in from a corner. 0 is dead-on.",
      camPosX: "Cam X (-0.5..+0.5, default 0 = centred): VIRTUAL CAMERA ORIENTATION. Slides the camera sideways in its own plane — at the extremes it sits well BEYOND the screen's borders. Position alone SHIFTS the view without bending it; the bend comes from Tilt. The two together are how you look at the set from above and off to one side, exactly as you would move a real camera: raise Cam Y, then tilt down to bring the screen back into frame.",
      camPosY: "Cam Y (-0.5..+0.5, default 0 = centred): slides the camera up or down in its own plane, from dead centre to above or below the screen. Pairs with Tilt Y.",
      camDist: "Dist (0..1, default 0.5): how far the virtual camera stands off the screen, and therefore how hard a given TILT keystones. Short (wide-angle) throws violent perspective and makes the nest curl hard; long (telephoto) barely skews it. The fader is geometric — equal steps are equal FACTORS — because perspective strength is a ratio, not an offset. It does NOTHING while the camera is dead-on, since a square-on view has no perspective to strengthen.",
      freeze: "Freeze (0/1, default 0): hidden determinism toggle. At ≥0.5 draw() is a no-op so the ring + output hold their last frame for deterministic VRT capture. No card control.",
    },
  },
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
    const uFlickerKnee = u('uFlickerKnee');
    const uTvOn = u('uTvOn');
    const uTvFill = u('uTvFill');
    const uTvBezel = u('uTvBezel');
    const uTvRoom = u('uTvRoom');
    const uTvOpNorm = u('uTvOpNorm');
    const uTvCos = u('uTvCos');
    const uTvSin = u('uTvSin');
    const uTvPhos = u('uTvPhos');
    const uPersist = u('uPersist');
    const uHasPersist = u('uHasPersist');
    const uTvGainScale = u('uTvGainScale');
    const uTvNoise = u('uTvNoise');
    const uTvFrame = u('uTvFrame');
    const uTvAgc = u('uTvAgc');
    const uHasTvAgc = u('uHasTvAgc');
    const uFbPrev = u('uFbPrev');
    const uHasFbPrev = u('uHasFbPrev');
    const uTvRefresh = u('uTvRefresh');
    const uTvBeam = u('uTvBeam');
    const uTvCam = u('uTvCam');
    const uTvPersp = u('uTvPersp');

    // ── CRITICAL's auto-exposure servo ────────────────────────────────
    // Two tiny passes: REDUCE the previous output to an 8x8 grid of local
    // means, then integrate one servo step into a 1x1 state texture. The state
    // lives in a TEXTURE, ping-ponged, so nothing reads pixels back — a
    // readPixels here would sync the GL pipeline every single frame. Both are
    // allocated lazily on the first CRITICAL frame, so a rack that never
    // touches CRITICAL pays nothing.
    const agcProgReduce = ctx.compileFragment(AGC_REDUCE_SRC);
    const agcProgServo = ctx.compileFragment(AGC_SERVO_SRC);
    const uRedSrc = gl.getUniformLocation(agcProgReduce, 'uSrc');
    const uSrvReduce = gl.getUniformLocation(agcProgServo, 'uReduce');
    const uSrvPrev = gl.getUniformLocation(agcProgServo, 'uPrevAgc');
    const uSrvHasPrev = gl.getUniformLocation(agcProgServo, 'uHasPrevAgc');
    const uSrvRate = gl.getUniformLocation(agcProgServo, 'uRate');
    const uSrvTarget = gl.getUniformLocation(agcProgServo, 'uTarget');
    type Rt = { fbo: WebGLFramebuffer; texture: WebGLTexture };
    let agcReduce: Rt | null = null;
    let agcState: [Rt, Rt] | null = null;
    let agcCur = 0;
    let agcPrimed = false;
    const ensureAgc = (): boolean => {
      if (agcReduce && agcState) return true;
      if (!ctx.createFloatFbo) return false;
      const T = BACKDRAFT_TV_AGC_TILES;
      agcReduce = ctx.createFloatFbo(T, T, { filter: 'nearest' });
      agcState = [
        ctx.createFloatFbo(1, 1, { filter: 'nearest', precision: 'full' }),
        ctx.createFloatFbo(1, 1, { filter: 'nearest', precision: 'full' }),
      ];
      agcPrimed = false;
      return true;
    };

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
    // TV MODE gate: a rising edge CYCLES OFF -> PURE TV -> CRITICAL -> OFF.
    const tvGate = makeEdgeState();

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
        // TV MODE gate: a rising edge CYCLES the mode. Same convention as the
        // shape gate; the bridge only writes while patched, so an unpatched
        // gate never spuriously fires, and the card button reflects the
        // resulting state because we mutate the shared `params`.
        if (detectEdge(tvGate, params.tvGate)?.pressed) {
          params.tvMode = backdraftNextTvMode(params.tvMode);
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

        g.activeTexture(g.TEXTURE0 + BACKDRAFT_TEXTURE_UNITS.a);
        g.bindTexture(g.TEXTURE_2D, aTex ?? emptyTex);
        g.uniform1i(uA, BACKDRAFT_TEXTURE_UNITS.a);
        g.uniform1f(uHasA, aTex ? 1.0 : 0.0);

        g.activeTexture(g.TEXTURE0 + BACKDRAFT_TEXTURE_UNITS.b);
        g.bindTexture(g.TEXTURE_2D, bTex ?? emptyTex);
        g.uniform1i(uB, BACKDRAFT_TEXTURE_UNITS.b);
        g.uniform1f(uHasB, bTex ? 1.0 : 0.0);

        g.activeTexture(g.TEXTURE0 + BACKDRAFT_TEXTURE_UNITS.fb);
        g.bindTexture(g.TEXTURE_2D, fbTex);
        g.uniform1i(uFb, BACKDRAFT_TEXTURE_UNITS.fb);
        g.uniform1f(uHasFb, framesElapsed >= delayFrames ? 1.0 : 0.0);

        g.activeTexture(g.TEXTURE0 + BACKDRAFT_TEXTURE_UNITS.lighten);
        g.bindTexture(g.TEXTURE_2D, lightenTex ?? emptyTex);
        g.uniform1i(uLighten, BACKDRAFT_TEXTURE_UNITS.lighten);
        g.uniform1f(uHasLighten, lightenTex ? 1.0 : 0.0);

        g.activeTexture(g.TEXTURE0 + BACKDRAFT_TEXTURE_UNITS.darken);
        g.bindTexture(g.TEXTURE_2D, darkenTex ?? emptyTex);
        g.uniform1i(uDarken, BACKDRAFT_TEXTURE_UNITS.darken);
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
        g.uniform1f(uFlickerKnee, flick.knee);

        // ── PURE TV / CRITICAL ────────────────────────────────────────
        const tvMode = Math.max(0, Math.min(BACKDRAFT_TV_MODE_COUNT - 1, Math.round(params.tvMode)));
        const tvOn = tvMode > 0;
        const critical = tvMode === 2;
        const room = Math.max(0, Math.min(1, params.room));
        // The colour chain's operator norm — the quantity the PURE TV ceiling
        // divides by, and the reason LUMA 1.2 or R 1.3 can no longer pin the
        // interior to white.
        const opNorm = Math.max(1e-4, backdraftTvOpNorm({
          r: params.r, g: params.g, b: params.b, luma: params.luma, chroma: params.chroma,
        }));

        // The servo runs BEFORE the main pass and meters ring[head-1] — the
        // previous output — so there is no read-write hazard with `dst`.
        let agcTex: WebGLTexture | null = null;
        if (critical && framesElapsed >= 1 && ensureAgc() && agcReduce && agcState) {
          const prevOut = ring[(head - 1 + BACKDRAFT_BUFFER_FRAMES) % BACKDRAFT_BUFFER_FRAMES]!;
          const T = BACKDRAFT_TV_AGC_TILES;
          g.bindFramebuffer(g.FRAMEBUFFER, agcReduce.fbo);
          g.viewport(0, 0, T, T);
          g.useProgram(agcProgReduce);
          // TEXTURE7/8, NOT 0/1: the main program's uA/uB/uFb bindings are
          // already live on units 0-5 at this point, and rebinding those units
          // here would silently swap the live SOURCE for the reduce input.
          g.activeTexture(g.TEXTURE0 + BACKDRAFT_TEXTURE_UNITS.agcReduceSrc);
          g.bindTexture(g.TEXTURE_2D, prevOut.texture);
          g.uniform1i(uRedSrc, BACKDRAFT_TEXTURE_UNITS.agcReduceSrc);
          ctx.drawFullscreenQuad();

          const nextIdx = agcCur ^ 1;
          const srvDst = agcState[nextIdx]!;
          const srvSrc = agcState[agcCur]!;
          g.bindFramebuffer(g.FRAMEBUFFER, srvDst.fbo);
          g.viewport(0, 0, 1, 1);
          g.useProgram(agcProgServo);
          g.activeTexture(g.TEXTURE0 + BACKDRAFT_TEXTURE_UNITS.agcReduceSrc);
          g.bindTexture(g.TEXTURE_2D, agcReduce.texture);
          g.uniform1i(uSrvReduce, BACKDRAFT_TEXTURE_UNITS.agcReduceSrc);
          g.activeTexture(g.TEXTURE0 + BACKDRAFT_TEXTURE_UNITS.agcPrevState);
          g.bindTexture(g.TEXTURE_2D, srvSrc.texture);
          g.uniform1i(uSrvPrev, BACKDRAFT_TEXTURE_UNITS.agcPrevState);
          g.uniform1f(uSrvHasPrev, agcPrimed ? 1.0 : 0.0);
          g.uniform1f(uSrvRate, backdraftTvAgcRate(params.drive));
          // Set point RELATIVE to the room: an absolute one rails the servo in
          // a dim room and the limit cycle dies.
          g.uniform1f(uSrvTarget, BACKDRAFT_TV_AGC_TARGET * Math.max(0.05, room));
          ctx.drawFullscreenQuad();

          agcCur = nextIdx;
          agcPrimed = true;
          agcTex = srvDst.texture;
          // Restore the main render target the rest of draw() expects.
          g.bindFramebuffer(g.FRAMEBUFFER, dst.fbo);
          g.viewport(0, 0, ctx.res.width, ctx.res.height);
          g.useProgram(program);
        }

        g.uniform1f(uTvOn, tvOn ? 1.0 : 0.0);
        g.uniform1f(uTvFill, backdraftTvFill(zoom));
        g.uniform1f(uTvBezel, backdraftTvBezel(params.bezel));
        g.uniform1f(uTvRoom, room);
        g.uniform1f(uTvOpNorm, opNorm);
        // ROTATE x6 inside PURE TV only, so every Crutchfield symmetry lock
        // (n = 3/4/5/9) is reachable without remapping `rotate` CV anywhere else.
        const tvTheta = (backdraftTvRotationDeg(rot) * Math.PI) / 180;
        g.uniform1f(uTvCos, Math.cos(tvTheta));
        g.uniform1f(uTvSin, Math.sin(tvTheta));
        const phos = backdraftTvPhosphorRgb(params.phosphor);
        g.uniform3f(uTvPhos, phos[0], phos[1], phos[2]);
        g.uniform1f(uTvNoise, critical ? BACKDRAFT_TV_NOISE : 0);
        g.uniform1f(uTvFrame, framesElapsed % 4096);
        // The servo state is a TEXTURE, sampled by the main pass — never read
        // back to the CPU, so the pipeline never syncs.
        g.activeTexture(g.TEXTURE0 + BACKDRAFT_TEXTURE_UNITS.agcState);
        g.bindTexture(g.TEXTURE_2D, agcTex ?? emptyTex);
        g.uniform1i(uTvAgc, BACKDRAFT_TEXTURE_UNITS.agcState);
        g.uniform1f(uHasTvAgc, agcTex ? 1.0 : 0.0);
        if (critical) {
          // The servo regulates the level, so there is NO ceiling here. The
          // always-on shoulder and the bounded room stay as SOFT limiters, which
          // is what makes a white-out recoverable rather than terminal.
          g.uniform1f(uTvGainScale, BACKDRAFT_TV_CRIT_GAIN / opNorm);
        } else {
          // No ceiling: FEEDBACK straight through, so the colour chain's own
          // gain rides on top of it and over-driving to white is reachable.
          g.uniform1f(uTvGainScale, Math.max(0, Math.min(BACKDRAFT_MAX_FEEDBACK, params.feedback)));
        }

        // PHOSPHOR's in-place tap: the previous OUTPUT at the SAME x. Bound
        // even when tvMode = 0 (the sentinel) so the sampler is never stale.
        g.activeTexture(g.TEXTURE0 + BACKDRAFT_TEXTURE_UNITS.persist);
        const persistTex = tvOn && framesElapsed >= 1
          ? ring[(head - 1 + BACKDRAFT_BUFFER_FRAMES) % BACKDRAFT_BUFFER_FRAMES]!.texture
          : emptyTex;
        g.bindTexture(g.TEXTURE_2D, persistTex);
        g.uniform1i(uPersist, BACKDRAFT_TEXTURE_UNITS.persist);
        g.uniform1f(uHasPersist, tvOn && framesElapsed >= 1 ? 1.0 : 0.0);

        // VIRTUAL REFRESH — the OLDER field (frame n-d-1). The set is mid-redraw,
        // so rows below the beam still show this one. Only meaningful in a TV
        // mode with FLICKER on; at FLICKER OFF uTvRefresh is 0 and the shader
        // skips the whole branch, leaving the tap bit-identical.
        const refreshOn = tvOn && flick.enabled;
        const prevIdx = backdraftTapIndex(head, delayFrames + 1, BACKDRAFT_BUFFER_FRAMES);
        const hasPrev = refreshOn && framesElapsed >= delayFrames + 1;
        g.activeTexture(g.TEXTURE0 + BACKDRAFT_TEXTURE_UNITS.fbPrev);
        g.bindTexture(g.TEXTURE_2D, hasPrev ? ring[prevIdx]!.texture : emptyTex);
        g.uniform1i(uFbPrev, BACKDRAFT_TEXTURE_UNITS.fbPrev);
        g.uniform1f(uHasFbPrev, hasPrev ? 1.0 : 0.0);
        g.uniform1f(uTvRefresh, refreshOn ? 1.0 : 0.0);
        g.uniform1f(uTvBeam, backdraftTvBeam(params.flicker, frame.time));

        // VIRTUAL CAMERA ORIENTATION. Dead-on (every joystick centred) skips
        // the perspective divide entirely and the affine path runs exactly as
        // before — the shipped look is untouched by default.
        const camOff = params.camTiltX !== 0 || params.camTiltY !== 0
          || params.camPosX !== 0 || params.camPosY !== 0;
        g.uniform1f(uTvPersp, camOff ? 1.0 : 0.0);
        if (camOff) {
          const Hi = backdraftCamInverseHomography(
            { tiltX: params.camTiltX, tiltY: params.camTiltY, posX: params.camPosX, posY: params.camPosY, dist: params.camDist },
            backdraftTvFill(zoom), backdraftTvRotationDeg(rot),
          );
          // GL mat3 is COLUMN-major; the model is built row-major.
          g.uniformMatrix3fv(uTvCam, false, new Float32Array([
            Hi[0]!, Hi[3]!, Hi[6]!, Hi[1]!, Hi[4]!, Hi[7]!, Hi[2]!, Hi[5]!, Hi[8]!,
          ]));
        }

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
        if (agcReduce) {
          gl.deleteFramebuffer(agcReduce.fbo);
          gl.deleteTexture(agcReduce.texture);
        }
        for (const r of agcState ?? []) {
          gl.deleteFramebuffer(r.fbo);
          gl.deleteTexture(r.texture);
        }
        gl.deleteTexture(emptyTex);
        gl.deleteProgram(program);
        gl.deleteProgram(agcProgReduce);
        gl.deleteProgram(agcProgServo);
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
