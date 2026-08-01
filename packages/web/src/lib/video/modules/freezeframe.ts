// packages/web/src/lib/video/modules/freezeframe.ts
//
// FREEZEFRAME — video SAMPLE & HOLD with per-channel posterize.
//
// Two behaviours fused into one module:
//
//   1. SAMPLE & HOLD (the "freeze frame"). `gate_in` honours BOTH readings
//      of the unified gate cable — a HELD GATE and a TRIGGER PULSE:
//
//        gate UNPATCHED     → live passthrough (mirrors the audio S&H
//                             convention where an unpatched gate = "track").
//        patched, level LOW → FROZEN. The hold buffer is not written, so the
//                             last captured frame persists.
//        RISING EDGE        → EXACTLY ONE frame update, then still again.
//        level HELD HIGH    → continuous update (live) for as long as it is high.
//
//      ── THE SEMANTICS RULE (how a HELD GATE is told apart from a TRIGGER) ──
//      We never measure pulse WIDTH at the source. Two independent conditions:
//
//        (i)  ONE-SHOT LATCH. Every rising edge of the value stream (hysteresis
//             detector, `$lib/doom/cv-gate-edge`) sets `triggerArmed`. The next
//             draw captures one frame and CLEARS it. The latch is a BOOLEAN,
//             not a counter, so N edges inside one frame interval still produce
//             exactly ONE captured frame (there is only one frame to capture),
//             and a pulse SHORTER THAN A FRAME can never be missed — the edge
//             is detected in setParam, off the draw clock entirely.
//        (ii) QUALIFIED LEVEL. A draw ALSO captures if the level it observes is
//             >= GATE_HI **and that level has stood since at least
//             HOLD_QUALIFY_MS after the rising edge that raised it**.
//
//      In one line: **HELD = "the level is STILL high one bridge write after
//      the edge that raised it"; TRIGGER = "an edge happened, and by the time
//      the level could next be re-reported it was low again".**
//
//      WHY (ii) NEEDS THE QUALIFY WINDOW — and why no faster rule exists. The
//      bridge does not hand us the waveform. It hands us a STAIRCASE of tail
//      samples, one per ~25 ms scheduler tick, and we hold that sample until
//      the next one. A 5 ms trigger whose pulse happens to straddle a tick
//      instant is therefore reported as level-HIGH for a WHOLE TICK PERIOD, and
//      over that window it is bit-for-bit INDISTINGUISHABLE from a gate that
//      just opened — both arrive as `0, 1, 1`. The first discriminating
//      information is the NEXT write (trigger → 0, hold → 1), so one tick is
//      the information-theoretic floor for this decision, not an implementation
//      shortcut. Measured before the qualify window existed: 6 triggers
//      produced 36 captures at 240 fps (6 spurious frames each, once per
//      pulse-straddles-tick). HOLD_QUALIFY_MS is 3 ticks, so the spurious high
//      has always been overwritten before it can qualify.
//      Cost: a genuinely held gate updates its one-shot frame immediately and
//      then goes continuous ~75 ms later. There is no gap in coverage — the
//      latch already refreshed the image at the edge.
//
//      ⚠ WHY 3 TICKS AND NOT 2 — the DERIVED-GATE tie. 2 ticks is exactly 50 ms,
//      which is exactly `DEFAULT_GATE_LEN_S` (the width GATEMAIDEN widens a
//      trigger to). A gate of that width is observed HIGH over exactly one
//      qualify window, so it sat precisely ON the boundary and its
//      classification hung on tick jitter. Resolved DOWNWARD — see
//      HOLD_QUALIFY_MS below for the arithmetic. The invariant it buys:
//      **inserting GATEMAIDEN into the path does not change the frame count.**
//
//      WHY (i) CANNOT BE A LEVEL TEST (the bug this fixes — owner report
//      2026-07-31, "triggers do nothing"): the cross-domain gate bridge
//      (PatchEngine.installGateDispatch) does not stream the waveform. It
//      COUNTS rising edges in the audio thread and REPLAYS them on the ~25 ms
//      scheduler tick as `setParam(0); setParam(1)` per edge followed by
//      `setParam(currentLevel)`. Measured on the real chain, one trigger
//      arrives as three writes inside the SAME MILLISECOND:
//          3221:0  3221:1  3221:0
//      so `params.gateLevel` is 0 at every draw and a level-only consumer sees
//      NOTHING — 0 of 23 rendered frames updated across 6 triggers. When the
//      tick's tail sample happened to land inside the 5–10 ms pulse the level
//      stuck at 1 until the next tick and 1–2 whole frames were captured, i.e.
//      the classic nondeterministic zero-one-or-two. Edge detection in
//      setParam is the only mechanism that can deliver EXACTLY ONE. (Same
//      shape as SHAPEGEN's clock_in and MILKDROP's nextTrig, both of which
//      edge-detect inside setParam for this reason.)
//
//      How we know whether `gate_in` is PATCHED: the CV bridge writes the gate
//      level into our `gateLevel` param via setParam while an edge exists —
//      EVERY VIDEO FRAME on the per-frame `cv` path (VideoEngine.tickCvBridges)
//      or EVERY ~25 ms SCHEDULER TICK on the `gate` path (installGateDispatch).
//      When nothing is patched, setParam('gateLevel') is never called. So
//      "patched" = "written recently". ⚠ THE UNIT MATTERS: the write cadence is
//      WALL-CLOCK (a Worker timer), the draw cadence is FRAMES, and
//      frames-between-writes = 0.025 × fps — 1.5 at 60 fps but 3.0 at 120 and
//      4.1 at 165. A pure FRAME-count grace of 3 (what this module shipped
//      with) therefore reads "unpatched" on a 120 Hz display and leaks live
//      frames into a frozen image. The grace is primarily in MILLISECONDS
//      (GATE_PATCH_GRACE_MS, 20× the tick), OR'd with the frame count as the
//      floor for very low frame rates (SwiftShader at ~8 fps).
//      This is the video-domain analogue of the "fall back to a default
//      when the input is unpatched" pattern (SKIFREE's mouse fallback for
//      an unpatched X/Y — here the fallback is "live passthrough").
//
//   2. PER-CHANNEL POSTERIZE (colour-depth reducer):
//      Four QUANT knobs (quant_r / quant_g / quant_b / quant_luma) each
//      reduce the colour depth of ONE channel. The knob sweep maps to a
//      quantization step count:
//          7:00 / min (0.0)   → 256 levels (passthrough, full depth)
//          midway     (0.5)   → 32 levels
//          max        (1.0)   → 2 levels (on/off)
//      With all four at max the combined image is ~posterized to a few
//      bits per channel. The mapping is geometric in log2(levels) so the
//      step count is STRICTLY monotonic-decreasing across the sweep and
//      hits 256 / 32 / 2 exactly at 0 / 0.5 / 1.
//
// Outputs (all video):
//   video_out : the R/G/B channels recombined WITH their per-channel
//               quantization applied (the QUANT-luma knob ALSO applies to
//               the combined output as an overall luma posterize, so the
//               luma knob isn't a dead control on `video_out`).
//   r_out / g_out / b_out : the single quantized channel rendered as an
//               intensity image (grey: that channel in all three RGB).
//   luma_out  : the quantized Rec.601 luma rendered as an intensity image.
//
// Inputs:
//   video_in (video) : the source frame.
//   gate_in (gate)   : sample-&-hold gate, declared `edge: 'gate'` because the
//     LEVEL is what it primarily reads (held high = live). It additionally
//     one-shots on a rising edge so a trigger works — the same principled
//     dual-reading exception GATEMAIDEN's `in` port documents.
//
// Params:
//   quant_r / quant_g / quant_b / quant_luma (linear 0..1): per-channel
//     posterize amount (0 = full depth, 1 = 2 levels). See QUANT mapping.
//   gateLevel (hidden, linear 0..1): synthetic param the CV bridge drives
//     with the live gate value. Not a knob — rendered only as the cv jack.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import { GATE_HI } from '$lib/audio/gate-trigger';
import { detectEdge, makeEdgeState, type EdgeState } from '$lib/doom/cv-gate-edge';

// ----------------------------------------------------------------------
// Pure math — exported for unit tests (no GL).
// ----------------------------------------------------------------------

/** Full 8-bit colour depth. */
export const QUANT_MAX_LEVELS = 256;
/** Mid-sweep level count (knob = 0.5). */
export const QUANT_MID_LEVELS = 32;
/** Minimum level count (knob = max): on/off. */
export const QUANT_MIN_LEVELS = 2;

/** Rec.601 luma weights — same as LUMA / the GLSL `dot()` below. */
export const LUMA_WEIGHTS = { r: 0.299, g: 0.587, b: 0.114 } as const;

/**
 * Map a QUANT knob value (0..1) to a quantization STEP COUNT.
 *
 * Geometric in log2(levels) so the result is strictly monotonic and lands
 * on the spec's anchor points exactly:
 *     knob 0.0 → 256 levels  (log2 = 8)
 *     knob 0.5 →  32 levels  (log2 = 5)
 *     knob 1.0 →   2 levels  (log2 = 1)
 * Two linear segments in log2 space (8→5 over [0,0.5], 5→1 over [0.5,1]).
 *
 * The returned value is a continuous (non-integer) level count: the GLSL
 * `floor(c * levels) / (levels - 1)` posterizer accepts any real ≥ 2, and
 * keeping it continuous makes a CV sweep of the knob smooth. Callers that
 * need an integer step count (display / discrete tests) can round it.
 */
export function quantLevels(knob: number): number {
  const k = Math.min(1, Math.max(0, knob));
  const LOG_MAX = Math.log2(QUANT_MAX_LEVELS); // 8
  const LOG_MID = Math.log2(QUANT_MID_LEVELS); // 5
  const LOG_MIN = Math.log2(QUANT_MIN_LEVELS); // 1
  let logLevels: number;
  if (k <= 0.5) {
    // 0..0.5 : 8 → 5
    logLevels = LOG_MAX + (LOG_MID - LOG_MAX) * (k / 0.5);
  } else {
    // 0.5..1 : 5 → 1
    logLevels = LOG_MID + (LOG_MIN - LOG_MID) * ((k - 0.5) / 0.5);
  }
  return Math.pow(2, logLevels);
}

/**
 * Posterize a single normalized channel value (0..1) to `levels` steps.
 * Mirrors the GLSL `floor(c * levels) / (levels - 1)` with the same
 * clamping. `levels` is clamped to ≥ 2 so we never divide by 0.
 *
 * At levels = 256 this is effectively identity for 8-bit input (the only
 * difference is values land on the 256-step grid, which 8-bit input
 * already sits on). At levels = 2 it's a hard threshold to {0, 1}.
 */
export function posterizeChannel(value: number, levels: number): number {
  const v = Math.min(1, Math.max(0, value));
  const n = Math.max(2, levels);
  // floor(v * n) ranges 0..n (n only at v===1). Clamp the index to n-1 so
  // a full-white input maps to the top bucket, then normalize by n-1 so
  // the output spans the full 0..1 range.
  const idx = Math.min(n - 1, Math.floor(v * n));
  return idx / (n - 1);
}

/** Rec.601 luma of a normalized RGB triplet (each 0..1). */
export function lumaOf(r: number, g: number, b: number): number {
  return LUMA_WEIGHTS.r * r + LUMA_WEIGHTS.g * g + LUMA_WEIGHTS.b * b;
}

/** Gate threshold for "open" (capture) vs "closed" (freeze). The canonical
 *  repo-wide HIGH threshold — NOT re-derived here (see `$lib/audio/gate-trigger`). */
export const GATE_HIGH_THRESHOLD = GATE_HI;

/** Inputs to the per-draw sample-&-hold decision. Named fields (not positional)
 *  because the two capture reasons — a HELD level and a latched EDGE — are
 *  independent and must not be confusable at a call site. */
export interface CaptureInputs {
  /** Is something wired to gate_in? (See gateIsPatched.) */
  gatePatched: boolean;
  /** The gate LEVEL this draw observes. */
  gateLevel: number;
  /** Has the hold buffer ever been written with real content? */
  holdSeeded: boolean;
  /** A rising edge arrived since the previous draw — the ONE-SHOT latch. */
  triggerArmed: boolean;
  /** Has the level stood high long enough to be a HELD gate rather than the
   *  one-tick staircase echo of a trigger pulse? (See holdQualified.) */
  levelQualified: boolean;
}

/**
 * Pure sample-&-hold decision: should THIS frame capture the live input
 * into the hold buffer (true) or freeze the last-held frame (false)?
 *
 *   - first frame     → always capture so the hold buffer seeds with real
 *     content (a frozen-on-spawn gate would otherwise show black);
 *   - gate UNPATCHED  → always capture (live passthrough);
 *   - TRIGGER ARMED   → capture ONCE (the caller clears the latch after the
 *     draw, so a short pulse yields exactly one updated frame);
 *   - gate HELD HIGH  → capture (continuous update while the level is high),
 *     but only once the high has QUALIFIED as a hold (see the header: an
 *     unqualified high is the one-tick staircase echo of a trigger);
 *   - otherwise       → freeze.
 *
 * The trigger and level tests are deliberately SEPARATE: a level test alone
 * cannot deliver "exactly one" for a pulse shorter than the frame interval,
 * and an edge test alone would swallow the continuous held-gate case.
 *
 * Exported so the freeze logic is unit-testable without a GL context.
 */
export function shouldCapture(i: CaptureInputs): boolean {
  if (!i.holdSeeded) return true;      // seed the buffer on the first frame
  if (!i.gatePatched) return true;     // unpatched = live passthrough
  if (i.triggerArmed) return true;     // rising edge = exactly one frame
  return i.levelQualified && i.gateLevel >= GATE_HIGH_THRESHOLD; // held = continuous
}

/**
 * Has the current HIGH level stood long enough to be a real HELD GATE rather
 * than the staircase echo of a trigger pulse? See the header for why one
 * scheduler tick is the information-theoretic floor here.
 *
 * `lastRiseMs` is the wall clock of the rising edge that raised the current
 * level. `-Infinity` (never observed a rise — the gate was already high when we
 * were patched, or a test hook forced the level) qualifies immediately: there
 * is no candidate trigger to confuse it with.
 *
 * `qualifyMs` is injectable ONLY so a test can run the NEGATIVE CONTROL (drive
 * the identical timeline with the pre-decision 50 ms window and prove the
 * boundary assertions go red). Production always uses the default.
 */
export function holdQualified(
  nowMs: number,
  lastRiseMs: number,
  qualifyMs: number = HOLD_QUALIFY_MS,
): boolean {
  return (nowMs - lastRiseMs) >= qualifyMs;
}

/**
 * Pure "is gate_in patched?" decision — i.e. "did the CV bridge write our
 * gateLevel recently enough". See the header for why the primary unit is
 * MILLISECONDS: the bridge's write cadence is wall-clock (a ~25 ms Worker
 * tick, or one write per video frame on the per-frame `cv` path) while the
 * draw cadence is frames, so a pure frame-count grace silently means a
 * different thing on every display refresh rate (3 frames is 50 ms at 60 Hz
 * but only 18 ms at 165 Hz — shorter than one scheduler tick).
 *
 * The frame count is retained OR'd in as the floor for the opposite extreme:
 * CI's SwiftShader renderer draws at ~8 fps, where 3 frames is ~375 ms.
 */
/** Monotonic wall clock in ms. Isolated so the freshness test has ONE source
 *  of time and the unit is visible at every call site. (Deliberately NOT the
 *  engine's `frame.time`: that is PINNED by the render-smoke determinism hook,
 *  and the quantity being measured here — how stale the bridge's last write is
 *  — is a real wall-clock cadence, not a render clock.) */
function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export function gateIsPatched(a: {
  nowMs: number;
  lastWriteMs: number;
  frame: number;
  lastWriteFrame: number;
}): boolean {
  return (a.nowMs - a.lastWriteMs) <= GATE_PATCH_GRACE_MS
    || (a.frame - a.lastWriteFrame) <= GATE_PATCH_GRACE;
}

// ----------------------------------------------------------------------
// GLSL — combined + per-channel/luma isolate passes share one shader.
// `uMode` selects which output FBO this draw is producing.
// ----------------------------------------------------------------------

const MODE_COMBINED = 0; // recombined R/G/B, each channel posterized
const MODE_R = 1;        // R channel only, as intensity (grey)
const MODE_G = 2;        // G channel only
const MODE_B = 3;        // B channel only
const MODE_LUMA = 4;     // Rec.601 luma, posterized, as intensity (grey)

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex;
uniform float uHasInput;
uniform float uMode;       // 0 combined, 1 R, 2 G, 3 B, 4 luma
uniform float uLevelsR;    // quant step count for R    (>= 2)
uniform float uLevelsG;    // quant step count for G
uniform float uLevelsB;    // quant step count for B
uniform float uLevelsLuma; // quant step count for luma

// Posterize one normalized channel to N levels. Matches posterizeChannel().
float posterize(float c, float levels) {
  float n = max(2.0, levels);
  float idx = min(n - 1.0, floor(c * n));
  return idx / (n - 1.0);
}

void main() {
  if (uHasInput < 0.5) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  vec3 src = texture(uTex, vUv).rgb;

  if (uMode < 0.5) {
    // Combined: each channel posterized at its own step count, then the
    // overall luma posterized too so QUANT LUMA shapes the combined out.
    vec3 q = vec3(
      posterize(src.r, uLevelsR),
      posterize(src.g, uLevelsG),
      posterize(src.b, uLevelsB)
    );
    // Apply the luma-depth reduction as a ratio so it can't shift hue.
    float luma = dot(q, vec3(0.299, 0.587, 0.114));
    float lumaSafe = max(luma, 1e-5);
    float lq = posterize(luma, uLevelsLuma);
    vec3 outRgb = clamp(q * (lq / lumaSafe), 0.0, 1.0);
    outColor = vec4(outRgb, 1.0);
    return;
  }
  if (uMode < 1.5) {
    float r = posterize(src.r, uLevelsR);
    outColor = vec4(r, r, r, 1.0);
    return;
  }
  if (uMode < 2.5) {
    float g = posterize(src.g, uLevelsG);
    outColor = vec4(g, g, g, 1.0);
    return;
  }
  if (uMode < 3.5) {
    float b = posterize(src.b, uLevelsB);
    outColor = vec4(b, b, b, 1.0);
    return;
  }
  // luma
  float luma = dot(src, vec3(0.299, 0.587, 0.114));
  float lq = posterize(luma, uLevelsLuma);
  outColor = vec4(lq, lq, lq, 1.0);
}`;

// Copy shader for the HOLD buffer: when the gate is HIGH (or unpatched →
// live), we capture the current input into the hold FBO; when LOW we skip
// the copy so the hold FBO retains its last contents (the "frozen" frame).
const COPY_FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform float uHasInput;
void main() {
  outColor = uHasInput > 0.5 ? vec4(texture(uTex, vUv).rgb, 1.0)
                             : vec4(0.0, 0.0, 0.0, 1.0);
}`;

interface FreezeframeParams {
  quant_r: number;
  quant_g: number;
  quant_b: number;
  quant_luma: number;
  /** Hidden synthetic param driven by the gate CV bridge. */
  gateLevel: number;
}

const DEFAULTS: FreezeframeParams = {
  quant_r: 0,
  quant_g: 0,
  quant_b: 0,
  quant_luma: 0,
  gateLevel: 0,
};

/** How long (WALL CLOCK, ms) a gate write stays "fresh" before we decide the
 *  gate input is unpatched again. THE PRIMARY UNIT — the bridge's write cadence
 *  is wall-clock, not frames: the `gate` path replays on the ~25 ms scheduler
 *  tick (SCHEDULER_TICK_MS) and the per-frame `cv` path writes once per video
 *  frame. 500 ms is 20× the tick, so no plausible jitter or stall reads as
 *  "unpatched", and an actually-unpatched cable returns to live passthrough
 *  within half a second. */
export const GATE_PATCH_GRACE_MS = 500;

/** How long (WALL CLOCK, ms) a HIGH level must stand before it counts as a HELD
 *  GATE rather than the staircase echo of a TRIGGER pulse.
 *
 *  = **3 × the cross-domain gate bridge's replay cadence** (`SCHEDULER_TICK_MS`,
 *  25 ms — see PatchEngine.installGateDispatch). Two independent constraints
 *  fix this number, and the SECOND is why it is 3 ticks and not 2:
 *
 *  ── (1) THE FLOOR: ≥ 2 TICKS. ──
 *  The bridge re-reports the level once per tick and we hold the last report in
 *  between, so a 5 ms trigger that straddles a tick instant reads HIGH for up to
 *  ONE tick period. Two ticks means such an echo is always overwritten with 0
 *  before it can qualify, with a full tick of margin for a late Worker callback.
 *  It CANNOT be shorter than one tick and still be correct: until the next
 *  bridge write, a trigger and a just-opened gate are the same bytes.
 *
 *  ── (2) THE TIE-BREAK: STRICTLY > DEFAULT_GATE_LEN_S. ──
 *  `$lib/audio/gate-trigger` pins `DEFAULT_GATE_LEN_S = 0.05` — the width of a
 *  gate DERIVED from a trigger (GATEMAIDEN's trigger→gate widening). At 2 ticks
 *  the qualify window was EXACTLY 50 ms, i.e. exactly that width, and the
 *  arithmetic puts such a gate precisely ON the boundary:
 *
 *    a 50 ms gate opening at `g` is counted by the first tick `T ∈ [g, g+25)`
 *    (reports level 1), re-reported high by `T+25` (< g+50, always), and
 *    reported LOW by `T+50` (≥ g+50, always). So the module observes HIGH over
 *    exactly `[T, T+50)` — and `holdQualified` needs `now − T ≥ 50`. The only
 *    qualifying instant is the one instant the level is no longer high.
 *
 *  Behaviour therefore hung on sub-millisecond tick jitter: a late Worker
 *  callback leaves the stale HIGH report standing past T+50 and the gate
 *  suddenly qualifies, capturing a few extra frames. That is a coin flip, and a
 *  renderer-dependent one (how many frames land in the slop is fps-dependent).
 *
 *  DECISION (2026-08-01): resolve the tie DOWNWARD — a gate at the canonical
 *  derived width is a TRIGGER, deterministically. Three ticks puts the window
 *  strictly clear of `DEFAULT_GATE_LEN_S`, so:
 *
 *    **inserting GATEMAIDEN into the path does not change FREEZEFRAME's frame
 *    count** — trigger → FREEZEFRAME and trigger → GATEMAIDEN → FREEZEFRAME both
 *    update EXACTLY ONE frame.
 *
 *  That invariant is the reason to prefer this direction over widening the gate
 *  classification: the alternative (qualify at 1 tick so a 50 ms gate reads as
 *  HELD) makes the same patch produce 3 frames at 60 fps and 12 at 240 — a
 *  renderer-dependent result, the exact class this repo forbids — AND it spends
 *  the entire margin that constraint (1) exists to provide.
 *
 *  COST, stated plainly: a genuinely HELD gate goes continuous 25 ms later than
 *  before (there is no visible gap — the one-shot latch already refreshed the
 *  image at the rising edge), and the knee at which a square LFO stops reading
 *  as "continuous" and starts reading as a one-frame-per-cycle strobe moves from
 *  ~10 Hz to ~6.6 Hz. Both are already strobe territory, where one frame per
 *  cycle is the frame-rate-INDEPENDENT reading and arguably the better look.
 *
 *  NOT imported from `$lib/audio/scheduler-clock` on purpose — that module owns
 *  a Worker singleton and this def is loaded by the render-worker realm too.
 *  `freezeframe.test.ts` pins BOTH relationships (≥ 2 ticks, and STRICTLY
 *  greater than DEFAULT_GATE_LEN_S) plus the behaviour AT the boundary. */
export const HOLD_QUALIFY_MS = 75;

/** Frame-count floor, OR'd with the ms grace. Covers the opposite extreme from
 *  the one the ms grace covers: a renderer so slow that half a second passes
 *  between draws (CI's SwiftShader measures ~8 fps, i.e. 125 ms/frame, and a
 *  loaded 10-shard runner is slower still). NOT sufficient on its own — see
 *  gateIsPatched for why a pure frame grace breaks above 100 fps. */
export const GATE_PATCH_GRACE = 3;

export const freezeframeDef: VideoModuleDef = {
  type: 'freezeframe',
  palette: { top: 'Video modules', sub: 'Processors' },
  domain: 'video',
  label: 'freezeframe',
  category: 'effects',
  inputs: [
    { id: 'video_in', type: 'video' },
    // Gate input. paramTarget routes the gate CV through the cross-domain
    // bridge into setParam('gateLevel') while patched — that write is ALSO
    // how we detect the gate is connected at all.
    //
    // `edge: 'gate'` because the LEVEL is the primary reading (held high =
    // live passthrough, low = frozen; it reacts to BOTH edges). The module
    // ADDITIONALLY one-shots on each rising edge so a short trigger updates
    // exactly one frame — the same principled dual-reading exception
    // GATEMAIDEN's `in` port documents ("READS the input level ... while
    // internally also edge-detecting"). Declaring 'trigger' here would be
    // wrong: it would promise the hold is ignored, and it is not.
    { id: 'gate_in', type: 'gate', edge: 'gate', paramTarget: 'gateLevel' },
  ],
  outputs: [
    { id: 'video_out', type: 'video' },
    { id: 'r_out',     type: 'video' },
    { id: 'g_out',     type: 'video' },
    { id: 'b_out',     type: 'video' },
    { id: 'luma_out',  type: 'video' },
  ],
  params: [
    { id: 'quant_r',    label: 'QUANT R',    defaultValue: DEFAULTS.quant_r,    min: 0, max: 1, curve: 'linear' },
    { id: 'quant_g',    label: 'QUANT G',    defaultValue: DEFAULTS.quant_g,    min: 0, max: 1, curve: 'linear' },
    { id: 'quant_b',    label: 'QUANT B',    defaultValue: DEFAULTS.quant_b,    min: 0, max: 1, curve: 'linear' },
    { id: 'quant_luma', label: 'QUANT LUMA', defaultValue: DEFAULTS.quant_luma, min: 0, max: 1, curve: 'linear' },
    // Hidden synthetic gate param — the cv jack renders but no knob.
    { id: 'gateLevel',  label: 'GATE',       defaultValue: 0, min: 0, max: 1, curve: 'linear' },
  ],

  // docs-hash-ignore:start
  docs: {
    explanation: "FREEZEFRAME fuses two video effects in one card. First, a SAMPLE & HOLD \"freeze\": with nothing patched to GATE the source passes through live; patch a gate and the image FREEZES, and the GATE jack then honours both readings of the gate cable at once. Hold the gate HIGH (level >= 0.5) and it updates CONTINUOUSLY for as long as it stays high (so it looks live, and an LFO square plays while open then stutter-freezes the instant it closes); send a TRIGGER at it and each rising edge updates EXACTLY ONE frame, after which it is still again. Short pulses cannot be missed or double-counted — the rising edge is detected as the gate value arrives rather than sampled once per rendered frame, and the one-shot is a latch a single frame consumes. The first frame always captures so the buffer seeds with real content instead of black. Second, a PER-CHANNEL POSTERIZE: four QUANT knobs each reduce one channel's colour depth, mapping the sweep geometrically in log2 from 256 levels (full depth) at min, through 32 at midway, to 2 (on/off) at max — crank all four for a hard few-bit posterized look. The shader posterizes each channel with floor(c*levels)/(levels-1); the combined output also applies the QUANT-luma reduction as a hue-preserving luma ratio so that knob still shapes the main out. Five outputs let you tap the recombined image, each isolated channel as a grey intensity image, or the Rec.601 luma. Usage hint: drive GATE from an LFO or clock to strobe/freeze a video feed, then dial the QUANT knobs for VHS/8-bit colour crushing; fan the R/G/B/LUMA taps into separate processors for channel-split effects.",
    inputs: {
      video_in: "The source video frame fed into the sample-and-hold buffer and posterizer.",
      gate_in: "Sample-and-hold gate. Unpatched = continuous live passthrough. Patched, the image is FROZEN while the level is LOW; it updates CONTINUOUSLY for as long as the level is HELD HIGH (>= 0.5), reacting to both edges as a gate; and each RISING EDGE additionally updates EXACTLY ONE frame, so a short trigger pulse re-samples once and then holds still. Both readings come from this one jack — patch a held gate for live-while-open, or a clock/trigger for one frame per tick.",
    },
    outputs: {
      video_out: "The recombined R/G/B image with each channel's posterize applied, plus the QUANT-LUMA reduction as a hue-preserving luma ratio. The card's on-screen preview shows this output.",
      r_out: "The posterized RED channel alone, rendered as a grey intensity image (R copied to all three channels).",
      g_out: "The posterized GREEN channel alone, rendered as a grey intensity image.",
      b_out: "The posterized BLUE channel alone, rendered as a grey intensity image.",
      luma_out: "The Rec.601 luma (0.299R+0.587G+0.114B), posterized by QUANT LUMA, rendered as a grey intensity image.",
    },
    controls: {
      quant_r: "QUANT R — posterize amount for the red channel. min = 256 levels (full depth / passthrough), midway = 32 levels, max = 2 levels (on/off). Affects video_out and r_out.",
      quant_g: "QUANT G — posterize amount for the green channel, 256 levels at min down to 2 at max. Affects video_out and g_out.",
      quant_b: "QUANT B — posterize amount for the blue channel, 256 levels at min down to 2 at max. Affects video_out and b_out.",
      quant_luma: "QUANT LUMA — posterize amount for the Rec.601 luma, 256 levels at min down to 2 at max. Drives luma_out and applies an overall luma-depth reduction to video_out as a hue-preserving ratio.",
      gateLevel: "GATE — hidden synthetic param the cross-domain CV bridge writes from gate_in; it carries the live gate level into the sample-and-hold decision, is rising-edge detected on arrival for the one-shot trigger, and the fact that it is written at all is how the module detects the gate is patched. Exposed only as the gate cv jack, not as a knob.",
    },
  },
  // docs-hash-ignore:end
  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);
    const copyProgram = ctx.compileFragment(COPY_FRAG_SRC);

    const uTex        = gl.getUniformLocation(program, 'uTex');
    const uHasInput   = gl.getUniformLocation(program, 'uHasInput');
    const uMode       = gl.getUniformLocation(program, 'uMode');
    const uLevelsR    = gl.getUniformLocation(program, 'uLevelsR');
    const uLevelsG    = gl.getUniformLocation(program, 'uLevelsG');
    const uLevelsB    = gl.getUniformLocation(program, 'uLevelsB');
    const uLevelsLuma = gl.getUniformLocation(program, 'uLevelsLuma');

    const cTex = gl.getUniformLocation(copyProgram, 'uTex');
    const cHas = gl.getUniformLocation(copyProgram, 'uHasInput');

    // Hold buffer — the sample-&-hold frame store. We capture the input
    // into here while the gate is open (or always, when unpatched), then
    // all five output passes read FROM the hold buffer. Freezing is just
    // "skip the capture this frame".
    const hold = ctx.createFbo();

    // One FBO per output port.
    const fboCombined = ctx.createFbo();
    const fboR        = ctx.createFbo();
    const fboG        = ctx.createFbo();
    const fboB        = ctx.createFbo();
    const fboLuma     = ctx.createFbo();

    // 1×1 black sentinel for the unpatched-input case (so we never bind a
    // null sampler / our own output as input → GL feedback loop).
    const emptyTex = gl.createTexture();
    if (!emptyTex) throw new Error('FREEZEFRAME: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, emptyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const params: FreezeframeParams = { ...DEFAULTS, ...(node.params as Partial<FreezeframeParams>) };

    // Gate connection + level/edge tracking.
    //   gateWriteMs    : performance.now() at the last setParam('gateLevel').
    //                    THE PRIMARY freshness clock — see gateIsPatched.
    //   gateWriteFrame : the draw-frame index at the last gate write (the
    //                    low-frame-rate floor of the same test).
    //   currentFrame   : last frame index seen in draw() (so setParam,
    //                    which runs OUTSIDE draw, can stamp gateWriteFrame
    //                    with the right frame).
    //   gateEdgeState  : hysteresis rising-edge detector over the VALUE STREAM
    //                    arriving at setParam. NOT an AnalyserNode rescan —
    //                    there is no buffer here, values arrive one at a time,
    //                    so per-value `prev<TH && cur>=TH` (which is what
    //                    detectEdge is) is correct by construction and cannot
    //                    double-count the way a whole-buffer rescan does.
    //   triggerArmed   : the ONE-SHOT latch. Set by a rising edge, consumed
    //                    (cleared) by the next draw. Boolean, not a counter:
    //                    several edges inside one frame interval still update
    //                    exactly one frame.
    //   gateRiseMs     : wall clock of the rising edge that raised the CURRENT
    //                    level. -Infinity = "no rise ever observed", which
    //                    qualifies a high level immediately (nothing to confuse
    //                    it with). Feeds holdQualified().
    let gateWriteMs = Number.NEGATIVE_INFINITY;
    let gateRiseMs = Number.NEGATIVE_INFINITY;
    let gateWriteFrame = -1_000_000;
    let currentFrame = -1;
    let holdSeeded = false; // has the hold buffer ever been captured?
    const gateEdgeState: EdgeState = makeEdgeState();
    let triggerArmed = false;
    /** Monotonic count of frames actually captured into the hold buffer.
     *  Diagnostic only (read('captureCount')) — the shipped assertions count
     *  CHANGED RENDERED FRAMES, this is the cross-check. */
    let captureCount = 0;

    function levelsFor(knob: number): number {
      return quantLevels(knob);
    }

    /** Render one output pass into `target` with the given mode, reading
     *  from the hold buffer texture. */
    function renderPass(target: { fbo: WebGLFramebuffer }, mode: number, hasInput: boolean): void {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.viewport(0, 0, ctx.res.width, ctx.res.height);
      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, hasInput ? hold.texture : emptyTex);
      gl.uniform1i(uTex, 0);
      gl.uniform1f(uHasInput, hasInput ? 1.0 : 0.0);
      gl.uniform1f(uMode, mode);
      gl.uniform1f(uLevelsR,    levelsFor(params.quant_r));
      gl.uniform1f(uLevelsG,    levelsFor(params.quant_g));
      gl.uniform1f(uLevelsB,    levelsFor(params.quant_b));
      gl.uniform1f(uLevelsLuma, levelsFor(params.quant_luma));
      ctx.drawFullscreenQuad();
    }

    const surface: VideoNodeSurface = {
      fbo: fboCombined.fbo,
      texture: fboCombined.texture,
      draw(frame) {
        currentFrame = frame.frame;
        const inputTex = frame.getInputTexture(node.id, 'video_in');
        const hasInput = !!inputTex;

        // Deterministic test hook (e2e / VRT): when globalThis.
        // __freezeframeForceGate is a number, treat the gate as PATCHED and
        // use that number as the gate level. Mirrors NIBBLES'
        // __nibblesForceLength — lets the harness pin freeze-vs-live state
        // without a timing-flaky real LFO. No-op in production (global
        // unset). undefined / non-number means "use the real CV path".
        const forced = (globalThis as unknown as { __freezeframeForceGate?: number | undefined })
          .__freezeframeForceGate;
        const forcedGate = typeof forced === 'number' && Number.isFinite(forced)
          ? forced
          : null;

        // Is the gate patched? The CV bridge writes gateLevel while an edge
        // exists; if we've seen a write within the grace window, the gate is
        // connected. The forced-gate hook also counts as patched.
        const drawMs = nowMs();
        const gatePatched = forcedGate !== null
          || gateIsPatched({
            nowMs: drawMs,
            lastWriteMs: gateWriteMs,
            frame: currentFrame,
            lastWriteFrame: gateWriteFrame,
          });
        // Capture decision (see shouldCapture + the header's semantics rule):
        //   unpatched gate → always capture (live passthrough);
        //   rising edge    → capture EXACTLY ONE frame (the latch);
        //   level HIGH     → capture (continuous while held);
        //   otherwise      → freeze.
        //   Always capture the very first frame so a frozen-on-spawn gate
        //   still has SOMETHING in the hold buffer (else black).
        const gateLevel = forcedGate !== null ? forcedGate : params.gateLevel;
        // A forced test level is a DIRECT level assertion, not a bridge report,
        // so there is no staircase echo to disambiguate — it qualifies at once.
        const levelQualified = forcedGate !== null || holdQualified(drawMs, gateRiseMs);
        const capture = shouldCapture({ gatePatched, gateLevel, holdSeeded, triggerArmed, levelQualified });
        // CONSUME the one-shot latch unconditionally: a draw has happened, so
        // any edge banked before it has now had its frame. Clearing it only on
        // `capture` would let a stale arm fire a spurious update later (e.g.
        // after the cable is pulled).
        triggerArmed = false;

        // ---- HOLD pass: copy input → hold buffer (only when capturing) ----
        if (capture) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, hold.fbo);
          gl.viewport(0, 0, ctx.res.width, ctx.res.height);
          gl.useProgram(copyProgram);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, inputTex ?? emptyTex);
          gl.uniform1i(cTex, 0);
          gl.uniform1f(cHas, hasInput ? 1.0 : 0.0);
          ctx.drawFullscreenQuad();
          if (hasInput) { holdSeeded = true; captureCount++; }
        }

        // ---- OUTPUT passes: read hold buffer, posterize per mode ----
        // `hasInput` here means "the hold buffer carries real content" —
        // true once we've ever captured a real frame, even if the live
        // input later disconnects (we keep showing the frozen frame).
        const showContent = holdSeeded || hasInput;
        renderPass(fboCombined, MODE_COMBINED, showContent);
        renderPass(fboR,        MODE_R,        showContent);
        renderPass(fboG,        MODE_G,        showContent);
        renderPass(fboB,        MODE_B,        showContent);
        renderPass(fboLuma,     MODE_LUMA,     showContent);

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      },
      dispose() {
        for (const f of [hold, fboCombined, fboR, fboG, fboB, fboLuma]) {
          gl.deleteFramebuffer(f.fbo);
          gl.deleteTexture(f.texture);
        }
        gl.deleteTexture(emptyTex);
        gl.deleteProgram(program);
        gl.deleteProgram(copyProgram);
      },
    };

    return {
      domain: 'video',
      surface,
      setParam(paramId, value) {
        if (paramId === 'gateLevel') {
          params.gateLevel = value;
          // Stamp both freshness clocks so draw() can detect "patched".
          gateWriteFrame = currentFrame;
          gateWriteMs = nowMs();
          // RISING-EDGE ONE-SHOT. This runs on the BRIDGE's clock, not the
          // draw clock, which is the whole point: installGateDispatch replays
          // a counted trigger as `setParam(0); setParam(1); setParam(level)`
          // inside ONE scheduler tick, so the HIGH is gone long before the
          // next draw. Latching here is the only way a 5 ms pulse can produce
          // exactly one frame update. detectEdge's hysteresis (rise 0.6 /
          // fall 0.4) also stops a noisy CV hovering at the threshold from
          // machine-gunning the latch — deliberately WIDER than the 0.5 level
          // test used for the held case, which is the chatter-suppression
          // convention the repo's other CV-gate consumers use.
          if (detectEdge(gateEdgeState, value)?.pressed === true) {
            triggerArmed = true;
            // Restart the hold-qualification clock: this high is a CANDIDATE
            // trigger until it survives another bridge write.
            gateRiseMs = gateWriteMs;
          }
          return;
        }
        if (paramId in params) {
          (params as unknown as Record<string, number>)[paramId] = value;
        }
      },
      readParam(paramId) {
        return (params as unknown as Record<string, number>)[paramId];
      },
      read(key) {
        // Per-output texture lookup (multi-output escape hatch — see
        // VideoEngine.lookupInput). surface.texture already exposes
        // video_out for legacy single-texture consumers; the rest need
        // this hook.
        if (key === 'outputTexture:video_out') return fboCombined.texture;
        if (key === 'outputTexture:r_out')     return fboR.texture;
        if (key === 'outputTexture:g_out')     return fboG.texture;
        if (key === 'outputTexture:b_out')     return fboB.texture;
        if (key === 'outputTexture:luma_out')  return fboLuma.texture;
        // Test/diagnostic reads.
        if (key === 'gatePatched') {
          return gateIsPatched({
            nowMs: nowMs(),
            lastWriteMs: gateWriteMs,
            frame: currentFrame,
            lastWriteFrame: gateWriteFrame,
          });
        }
        if (key === 'holdSeeded')   return holdSeeded;
        // Monotonic count of frames written into the hold buffer. Cross-check
        // for the pixel-level "exactly N updates for N triggers" assertion.
        if (key === 'captureCount') return captureCount;
        if (key === 'triggerArmed') return triggerArmed;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
