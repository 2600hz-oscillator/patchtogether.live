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
//        level HELD HIGH    → the one-shot frame at the edge, then continuous
//                             update once the level has STOOD high for
//                             HOLD_QUALIFY_MS (75 ms — see below; a high
//                             shorter than that is a TRIGGER, by definition of
//                             what the bridge can tell us).
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
//   3. PHOSPHOR DECAY (owner request 2026-08-11). With the DECAY switch on, a
//      HELD frame fades exponentially toward black — or toward WHITE with the
//      INVERT switch on — over the DECAY TIME knob's seconds. See the
//      "PHOSPHOR DECAY" block below for the curve, the clock, and the two
//      things this deliberately is NOT (a per-frame multiply, and a feedback
//      pass over the hold buffer).
//
//      ⚠ IT IS ONLY OBSERVABLE WHILE FROZEN, and that is not a bug. Decay is
//      the age of the HELD frame, and a captured frame is age 0 — so with the
//      gate UNPATCHED (live passthrough), or held open, every frame is fresh
//      and the switch legitimately does nothing at all. A user who does not
//      know that reads it as a dead control, so the docs say it out loud.
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
//   decay (discrete 0/1, default 0): the phosphor-decay switch. OFF is
//     bit-for-bit today's behaviour — `uDecayK` is 1 and `uDecayTarget` is 0,
//     so the shader tail evaluates `0 + (rgb - 0) * 1`, exactly `rgb`.
//   decay_invert (discrete 0/1, default 0): decay toward WHITE instead of black.
//   decay_time (log, 0.05..2 s): how long a held frame takes to CLEAR. Not a
//     time CONSTANT — see decayEnvelope for why the knob reads as "gone by".
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
 * ⚠ THE IDENTITY CLAIM IS CONDITIONAL, AND THE CONDITION IS THE INPUT'S GRID.
 * At `levels = 256` this is EXACTLY identity for input already on the 8-bit
 * grid: for `v = k/255`, `v * 256 = k + k/255`, which floors to `k`, so the
 * result is `k/255 = v`. Verified over all 256 code values, 0 of which move.
 *
 * It is NOT identity for an input OFF that grid — and `posterizeChannel(0.5,
 * 256) = 0.5019607843137255` is the one-line demonstration. That mattered
 * because the combined-output branch fed it a LUMA (a weighted sum of three
 * 8-bit values, i.e. an arbitrary real), which is #1861: see
 * `quantizeCombined` below for the measurement and the fix.
 *
 * At `levels = 2` it is a hard threshold to {0, 1}.
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

/**
 * Is a luma level count at FULL DEPTH — i.e. has the player asked for no luma
 * reduction at all?
 *
 * `quantLevels(0)` is exactly `QUANT_MAX_LEVELS`, and the knob only ever
 * reduces from there, so this is true at the knob's minimum and nowhere else.
 * The epsilon absorbs float32 wobble in the uniform, not a range of knob
 * positions: the next representable knob value already asks for real
 * quantization and gets it.
 */
export function lumaIsFullDepth(levels: number): boolean {
  return levels >= QUANT_MAX_LEVELS - 0.5;
}

/**
 * THE COMBINED `video_out` PIXEL — the JS mirror of the shader's `uMode < 0.5`
 * branch, which until #1861 DID NOT EXIST.
 *
 * ⚠ THAT ABSENCE IS WHY THE DEFECT SHIPPED, and it is the more useful half of
 * this fix. `posterizeChannel` was unit-tested against the levels it is GIVEN,
 * and its identity claim was checked on the 8-bit grid where it holds. Nothing
 * joined that grid assumption to the combined branch's LUMA call site, whose
 * input is off-grid by construction — a gate reading one side of a two-sided
 * contract. The mirror is the missing side, so the claim is now checkable over
 * the whole cube (`freezeframe-quant.test.ts`).
 *
 * ── #1861, MEASURED ────────────────────────────────────────────────────────
 *
 * Before the guard below, at EVERY param's declared default (all four QUANT
 * knobs at 0, i.e. "full depth / passthrough" per the docs), over the entire
 * 8-bit RGB cube (16,777,216 triplets, comparing 8-bit code values in and out
 * — the FBO is RGBA8, so GL rounds to the same grid):
 *
 *   bit-exactly unchanged     10,291,489  (61.34 %)
 *   moved by >= 1 code value   6,485,727  (38.66 %)
 *   worst error                        8  code values, at src(0,0,8) -> (0,0,0)
 *   mean absolute error           0.4324  code values
 *   luma gain range           0.000000 .. 1.003922
 *   non-black inputs driven to EXACTLY black          25
 *
 *   by luma band:  < 1/256   n=26          96.15 % moved, worst 8
 *                  .0039-.05 n=19,337      77.71 %,       worst 8
 *                  .05-.25   n=1,830,720   62.20 %,       worst 8
 *                  .25-.75   n=13,077,016  35.40 %,       worst 3
 *                  .75-1     n=1,850,117   37.97 %,       worst 1
 *
 * The mechanism is the grid, not a rounding wobble. `lq / luma` is the gain,
 * and for `luma < 1/256` the floor takes `lq` to ZERO — so the gain is 0 and a
 * legitimate near-black like (0,0,8) is forced to (0,0,0). That is a
 * factor-of-256 effect, which is also why the float64-mirror /
 * float32-shader difference cannot explain it.
 *
 * ── THE FIX ────────────────────────────────────────────────────────────────
 *
 * At full depth the luma ratio is SKIPPED entirely, which is what the docs
 * have always claimed the knob's minimum does. Nothing changes at any other
 * knob position: once the player asks for luma quantization, crushing the
 * near-blacks toward black is the effect, not a bug.
 *
 * The alternative — making `posterizeChannel` round instead of floor — was
 * rejected: it would shift the bucket boundaries by half a step at EVERY
 * level, moving every posterized image on every patch, to fix a defect that
 * only exists at one end of one knob.
 */
export function quantizeCombined(
  rgb: readonly [number, number, number],
  levels: { r: number; g: number; b: number; luma: number },
): [number, number, number] {
  const q: [number, number, number] = [
    posterizeChannel(rgb[0], levels.r),
    posterizeChannel(rgb[1], levels.g),
    posterizeChannel(rgb[2], levels.b),
  ];
  // #1861 — full depth means NO luma reduction, so there is no ratio to apply
  // and the per-channel result (which IS exact on the 8-bit grid) stands.
  if (lumaIsFullDepth(levels.luma)) return q;

  const luma = lumaOf(q[0], q[1], q[2]);
  const lq = posterizeChannel(luma, levels.luma);
  const gain = lq / Math.max(luma, 1e-5);
  return [
    Math.min(1, Math.max(0, q[0] * gain)),
    Math.min(1, Math.max(0, q[1] * gain)),
    Math.min(1, Math.max(0, q[2] * gain)),
  ];
}

// ----------------------------------------------------------------------
// PHOSPHOR DECAY — the pure math. All of it is exported and unit-tested;
// none of the numbers below appear as a literal in the GLSL or the card.
// ----------------------------------------------------------------------

/** DECAY TIME knob floor — 0.05 s (owner spec). */
export const DECAY_MIN_S = 0.05;
/** DECAY TIME knob ceiling — 2 s (owner spec). */
export const DECAY_MAX_S = 2;
/** DECAY TIME default. Only reachable with DECAY on, which is off by default,
 *  so this cannot change the shipped look; 0.5 s is a fade you can SEE without
 *  reading as a stuck frame. (The geometric centre of the log sweep is
 *  sqrt(0.05 × 2) = 0.316 s, so 0.5 s sits a little past 12 o'clock.) */
export const DECAY_DEFAULT_S = 0.5;

/**
 * The fraction of the starting distance-to-target at which an exponential is
 * declared "gone". 1 % is ~2.5 of 255 code values — below the point any viewer
 * calls it black (or white), and the classic engineering convention for a
 * settling time.
 */
export const DECAY_FLOOR = 0.01;

/** The exponential's rate in units of NORMALIZED progress: e^-DECAY_RATE = the
 *  floor, i.e. ln(100) ≈ 4.605. Derived, never typed. */
export const DECAY_RATE = Math.log(1 / DECAY_FLOOR);

/**
 * The decay envelope: NORMALIZED progress (0 = just captured, 1 = the knob's
 * DECAY TIME has fully elapsed) → the surviving fraction of the held frame.
 *
 * ── WHAT THE KNOB MEANS, and why this is a real decision ──────────────────
 * "Pseudo phosphor-decay" means EXPONENTIAL, and an exponential never reaches
 * its asymptote — so "DECAY TIME = 2 s" has to be given a meaning. The two
 * candidates and why this one:
 *
 *   · 1/e (the time CONSTANT τ). At the knob's time the image is still at
 *     **37 %** of its starting brightness — plainly still there. The knob would
 *     read as broken: you set 0.5 s, and half a second later a third of the
 *     picture is left.
 *   · **1 % (this one).** τ = T / ln(100), so at the knob's time the image has
 *     fallen to the floor. The knob reads as what a user means by it: *how long
 *     until the frame clears*.
 *
 * The exponential is then TRUNCATED AND RENORMALIZED — `(e^-rate·p − F)/(1 − F)`
 * — which buys two exact endpoints for free:
 *
 *   envelope(0) = 1  EXACTLY → a just-captured frame is untouched;
 *   envelope(1) = 0  EXACTLY → **the target is REACHED, not approached.**
 *
 * That second one is the acceptance criterion for this feature (see the 8-bit
 * note on the draw loop), and renormalizing is what makes it true by
 * construction instead of by tolerance. Without it there would be a 1 % step at
 * the end; with it the curve is continuous, monotonic, and still exponential in
 * shape (fast first, long tail).
 *
 * PURE and total: clamps, so a NaN/out-of-range progress can't leak a NaN
 * uniform into the shader.
 */
export function decayEnvelope(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  const p = Math.min(1, Math.max(0, progress));
  const raw = (Math.exp(-DECAY_RATE * p) - DECAY_FLOOR) / (1 - DECAY_FLOOR);
  return Math.min(1, Math.max(0, raw));
}

/**
 * Advance the normalized decay progress by `dtSec` of REAL elapsed time.
 *
 * ── WHY PROGRESS, AND NOT AN AGE OR A PER-FRAME FACTOR ────────────────────
 * The repo's single most-repeated rule is that a renderer-dependent quantity
 * must never be expressed in FRAMES (CI's SwiftShader runs ~7.9 fps against
 * ~60 on a real GPU — a per-frame decay factor is a 7.6× different time
 * constant, i.e. a different instrument per machine). So the accumulator is
 * seconds-driven. Between knob moves `Σ dtᵢ/T` is exactly `elapsed/T`, so the
 * result depends ONLY on elapsed time and NOT on how many draws it arrived in —
 * that is renderer-independence by construction, not by tuning, and it is
 * asserted directly (`freezeframe.test.ts`, "same elapsed time, 1 step vs 600").
 *
 * Accumulating PROGRESS rather than storing an age is what makes the knob
 * behave when it MOVES: `p` is already-travelled distance, so changing T
 * changes the rate from here on and leaves the past alone. Recomputing
 * `age / T` instead would rewrite history and jump the brightness mid-fade.
 *
 * Clamped at 1 (fully decayed) so the accumulator can't drift off to infinity
 * during a long freeze, and floored at 0 dt so a non-monotonic clock (the
 * determinism hook being toggled mid-run) can't run the decay BACKWARDS.
 */
export function advanceDecayProgress(
  progress: number,
  dtSec: number,
  decayTimeS: number,
): number {
  const t = Math.min(DECAY_MAX_S, Math.max(DECAY_MIN_S, decayTimeS));
  const dt = Number.isFinite(dtSec) ? Math.max(0, dtSec) : 0;
  const prev = Number.isFinite(progress) ? Math.max(0, progress) : 0;
  return Math.min(1, prev + dt / t);
}

/**
 * The CPU mirror of the shader's decay tail: `target + (value − target) · k`.
 *
 * Written as the affine form rather than `mix()` deliberately — at k = 1 with
 * target 0 it is `0 + value·1`, which is `value` BIT-EXACTLY, so DECAY-off is
 * provably not a rounding perturbation of today's output.
 */
export function applyDecay(value: number, k: number, target: number): number {
  return target + (value - target) * k;
}

/** The decay target as the shader wants it: 0 = fade to black, 1 = to white. */
export function decayTargetValue(invert: boolean): number {
  return invert ? 1 : 0;
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
uniform float uDecayK;      // surviving fraction of the held frame; 1 = no decay
uniform float uDecayTarget; // what it decays TO: 0 = black, 1 = white

// Posterize one normalized channel to N levels. Matches posterizeChannel().
float posterize(float c, float levels) {
  float n = max(2.0, levels);
  float idx = min(n - 1.0, floor(c * n));
  return idx / (n - 1.0);
}

// FULL DEPTH — INJECTED from QUANT_MAX_LEVELS rather than re-typed, so the
// shader's #1861 guard and its JS mirror (lumaIsFullDepth) cannot drift
// apart. A literal here would be a second copy of the same number in a string
// no typechecker reads.
//
// (No backticks in this comment on purpose: the whole shader is a template
// literal, so one would end it. esbuild is the only gate that sees that.)
const float FULL_DEPTH_LEVELS = ${QUANT_MAX_LEVELS.toFixed(1)};

// PHOSPHOR PERSISTENCE — the CPU mirror is applyDecay().
//
// Applied LAST, i.e. AFTER posterize, and the order is a decision: posterize is
// a reduction of the SIGNAL's colour depth, decay is the DISPLAY's persistence,
// and a real chain quantizes before it lights a phosphor. It also keeps the
// control honest — decay BEFORE the posterizer would send a fading image down
// through fixed buckets, so at QUANT max (2 levels) the "fade" would be a hard
// cut from full white to black and the DECAY switch would look broken exactly
// where the module is at its most extreme.
//
// Affine, not mix(): at uDecayK = 1 / uDecayTarget = 0 (the DECAY-off uniforms)
// this is 0.0 + (rgb - 0.0) * 1.0 = rgb, bit-exact on any driver, so turning
// the feature off is provably a no-op rather than a 1-ULP perturbation.
// (No backticks in here — this whole shader lives in a JS template literal.)
vec4 persist(vec3 rgb) {
  return vec4(uDecayTarget + (rgb - uDecayTarget) * uDecayK, 1.0);
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
    //
    // #1861 — AT FULL DEPTH THERE IS NO REDUCTION, SO THERE IS NO RATIO.
    // posterize() is exact only for input already on the 8-bit grid, and a
    // luma is a weighted sum of three 8-bit values, so it is off-grid by
    // construction. Applying the ratio at full depth moved 38.66 % of the RGB
    // cube (worst 8 code values) and, because floor() takes lq to ZERO below
    // luma 1/256, forced 25 legitimate near-blacks to exactly black — while
    // every doc string promised the knob's minimum was a passthrough. Skipping
    // it here IS that passthrough. Every other knob position is untouched:
    // once luma quantization is asked for, crushing toward black is the
    // effect. Mirrored exactly by quantizeCombined() / lumaIsFullDepth().
    vec3 outRgb;
    if (uLevelsLuma >= FULL_DEPTH_LEVELS - 0.5) {
      outRgb = q;
    } else {
      float luma = dot(q, vec3(0.299, 0.587, 0.114));
      float lumaSafe = max(luma, 1e-5);
      float lq = posterize(luma, uLevelsLuma);
      outRgb = clamp(q * (lq / lumaSafe), 0.0, 1.0);
    }
    outColor = persist(outRgb);
    return;
  }
  if (uMode < 1.5) {
    float r = posterize(src.r, uLevelsR);
    outColor = persist(vec3(r));
    return;
  }
  if (uMode < 2.5) {
    float g = posterize(src.g, uLevelsG);
    outColor = persist(vec3(g));
    return;
  }
  if (uMode < 3.5) {
    float b = posterize(src.b, uLevelsB);
    outColor = persist(vec3(b));
    return;
  }
  // luma
  float luma = dot(src, vec3(0.299, 0.587, 0.114));
  float lq = posterize(luma, uLevelsLuma);
  outColor = persist(vec3(lq));
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
  /** Phosphor-decay switch (0/1). OFF = today's behaviour, bit for bit. */
  decay: number;
  /** Decay toward WHITE instead of black (0/1). */
  decay_invert: number;
  /** Seconds until a held frame has fully cleared. See decayEnvelope. */
  decay_time: number;
  /** Hidden synthetic param driven by the gate CV bridge. */
  gateLevel: number;
}

const DEFAULTS: FreezeframeParams = {
  quant_r: 0,
  quant_g: 0,
  quant_b: 0,
  quant_luma: 0,
  decay: 0,
  decay_invert: 0,
  decay_time: DECAY_DEFAULT_S,
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
 *  ── (3) THE CEILING: STRICTLY < 4 TICKS. ──
 *  The window is pure added latency on a held gate, so it also needs an UPPER
 *  bound — and for a while it had none, which is its own defect: every held-gate
 *  test derived its frame counts FROM this constant, so the suite stayed green
 *  at 300 ms, 5 s and 60 s (measured). At 4 ticks (100 ms) a 5 Hz square LFO —
 *  whose HIGH phase is exactly 100 ms — collapses to one captured frame per
 *  cycle, i.e. the "plays while open" reading this module documents stops
 *  existing. `freezeframe.test.ts` now pins that structurally AND behaviourally
 *  (the 5 Hz sweep), so the window can no longer grow unobserved.
 *
 *  Floor (≥ 2 ticks) + tie-break (> 50 ms) + ceiling (< 100 ms) leave exactly one
 *  value on the 25 ms tick grid.
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
 *  classification. MEASURED, 20 derived gates of exactly DEFAULT_GATE_LEN_S,
 *  captured frames at 60 / 120 / 240 fps:
 *
 *      no window at all   59 / 120 / 241     (≈ 3, 6, 12 frames per gate)
 *      1 tick  (25 ms)    52 /  80 / 141     (≈ 2.6, 4, 7 per gate)
 *      3 ticks (75 ms)    20 /  20 /  20     ← one frame per gate, on every renderer
 *
 *  A fixed-width gate producing a frame count that scales with the DISPLAY is
 *  the class of result this repo forbids; a 1-tick window does not fix it and
 *  spends the whole margin constraint (1) exists to provide.
 *
 *  ⚠ NOT a general renderer-independence claim. Below the strobe knee a square
 *  LFO's capture count is still fps-proportional — that is what "live while
 *  open" MEANS, exactly as unpatched passthrough is. Measured, 20 cycles at
 *  60 / 240 fps with this window: 6 Hz → 30 / 62 (proportional), 8 Hz → 20 / 20,
 *  10 Hz → 20 / 20. The window RAISES the frequency above which the count is
 *  renderer-independent (10 Hz at 2 ticks → 8 Hz at 3); it does not make every
 *  gate patch renderer-independent, and an earlier version of this note implied
 *  it did.
 *
 *  COST, stated plainly and MEASURED AGAINST `main` — i.e. against what users
 *  actually have, not against the earlier commit on this same branch (an earlier
 *  version of this note quoted the 50 → 75 delta, a baseline that never shipped):
 *
 *    · every gate opening now waits 75 ms before it reads as HELD, where main
 *      waited 0. There is no visible gap — the one-shot latch already refreshed
 *      the image at the rising edge — but the latency is 75 ms, not 25.
 *    · main had NO strobe knee at all (any high level captured); there is now
 *      one at ~6.6 Hz. Measured captures over 20 cycles at 60 fps, no-window vs
 *      shipped: 1 Hz 600→533, 2 Hz 301→227, 4 Hz 147→80, 6 Hz 102→30,
 *      10 Hz 60→20. Above the knee one frame per cycle is the frame-rate-
 *      INDEPENDENT reading and arguably the better look — but it IS a change.
 *    · main's actual behaviour for the case that motivated all of this — a
 *      patched TRIGGER — was ZERO frames, which is the bug.
 *
 *  NOT imported from `$lib/audio/scheduler-clock` on purpose — that module owns
 *  a Worker singleton and this def is loaded by the render-worker realm too.
 *  `freezeframe.test.ts` pins ALL THREE relationships (≥ 2 ticks, STRICTLY
 *  greater than DEFAULT_GATE_LEN_S, STRICTLY less than 4 ticks) plus the
 *  behaviour AT the boundary. */
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
    // PHOSPHOR DECAY. `curve: 'discrete', min 0, max 1` is the repo's canonical
    // switch shape (looksLikeToggle, $lib/graph/exposable-controls) — the card
    // renders these with <Toggle>, the Push generic tier demotes them below the
    // continuous params, and the auto-expose bar agrees with both.
    { id: 'decay',        label: 'DECAY',      defaultValue: DEFAULTS.decay,        min: 0, max: 1, curve: 'discrete' },
    { id: 'decay_invert', label: 'INVERT',     defaultValue: DEFAULTS.decay_invert, min: 0, max: 1, curve: 'discrete' },
    // Log, like every other time knob in the repo (adsr A/D/R, delay time,
    // cofefve delayTime) — a 40:1 sweep on a linear knob wastes its bottom half.
    { id: 'decay_time',   label: 'DECAY TIME', defaultValue: DEFAULTS.decay_time,
      min: DECAY_MIN_S, max: DECAY_MAX_S, curve: 'log', units: 's' },
    // Hidden synthetic gate param — the cv jack renders but no knob.
    { id: 'gateLevel',  label: 'GATE',       defaultValue: 0, min: 0, max: 1, curve: 'linear' },
  ],

  // #1726 — the one param here that exists so the GRAPH has somewhere to write,
  // not so a player has something to turn. The def's own comment above already
  // said "the cv jack renders but no knob"; this is that sentence in a form the
  // face rules can read, and it is anchored in both directions (a 'cv-port'
  // entry asserts a port targeting the param EXISTS, so renaming `gate_in`'s
  // target reddens rather than quietly leaving a rotary over a gate swing).
  noUserControl: [
    {
      param: 'gateLevel',
      writer: 'cv-port',
      why: "written by the gate_in bridge as a raw 0..1 swing; the module reads its LEVEL for the freeze and edge-detects it for the one-frame update, so a player sets it with a cable and never with a dial",
    },
  ],

  // ── THE FACEPLATE (PF-20) ────────────────────────────────────────────────
  //
  // WHAT FREEZEFRAME IS FOR. It is the rack's SAMPLE & HOLD for pictures: a
  // gate decides WHEN the image updates, and everything else decides what the
  // held image looks like while it sits there. The verb is CLOCK IT — patch a
  // trigger or an LFO at GATE and the module becomes a strobe whose every
  // other control is about the still frame between updates.
  //
  // THE RANKING. Two ideas, and the measurement says which one leads.
  //
  //   1 quant_luma  ⚠ RANKED FIRST BECAUSE IT IS THE ONE THAT WAS BROKEN.
  //                 It is the only QUANT knob that touches the COMBINED output
  //                 through a path the other three do not (a hue-preserving
  //                 luma ratio rather than a per-channel posterize), and that
  //                 asymmetry is exactly where #1861 lived: at its own
  //                 declared minimum it was moving 38.66 % of the 8-bit RGB
  //                 cube and crushing 25 near-blacks to black, while every doc
  //                 string called it a passthrough. It is also the knob with
  //                 the widest reach — it scales all three channels at once,
  //                 where R/G/B each move a third of the picture.
  //   2 decay       the module's second engine, and the only control that is
  //                 about TIME rather than colour. It is a switch, so it reads
  //                 at a glance, and it is what turns a freeze into a trail.
  //   3 decay_time  the number DECAY needs to mean anything (0.05..2 s, log).
  //   4 quant_r
  //   5 quant_g     the three per-channel posterizers. They rank BELOW the
  //   6 quant_b     luma knob and below decay because each reaches exactly one
  //                 channel, and because — unlike quant_luma — they are
  //                 bit-exact identity at their defaults, so a fresh module
  //                 shows nothing for them until they are moved.
  //   7 decay_invert  the smallest idea on the module: which colour DECAY
  //                 fades TO. It qualifies rank 2 and is meaningless without
  //                 it, so it sits last rather than beside it.
  //
  // ⚠ `gateLevel` IS NOT RANKED, and that is a declaration rather than an
  // omission — see `noUserControl` above. It is the gate cable's landing site;
  // ranking it would paint a continuous rotary over a raw gate swing.
  //
  // WHY `order` AND `pages` DISAGREE. `order` is PRIORITY, so it interleaves
  // the two engines (luma, decay, decay_time, then the three channels). `pages`
  // is the SIGNAL PATH — a frame is quantized and then persisted, which is also
  // the order the shader applies them — so the tier showing everything reads
  // `colour depth` then `phosphor decay`. Two bands of 4 + 3 cells, which packs
  // to one row and stays well under DOCK_TAB_MIN_BANDS, so the hints render.
  //
  // NOT CONTROL-HEAVY per the tabbed-face ruling: seven controls across two
  // shapes (four faders, two switches, one time fader) and two honest ideas.
  // No tab rail.
  //
  // ⚠ GLYPH IS `'none'`, AND IT IS FORCED RATHER THAN CHOSEN. Every output on
  // this def is `type: 'video'`, so `primaryAudioOutPortId` returns null and
  // any other glyph kind falls through to `{ kind: 'static' }` — the #1692
  // dead-glyph shape the lint refuses by name. The picture arrives from a
  // different seam entirely (`hasVideoSurface`, which mounts VideoTileThumb),
  // so `'none' + blank tile` and `'none' + live thumb` are indistinguishable
  // from this declaration alone. The face-model test asserts `hasVideoSurface`
  // rather than trusting the word `'none'`.
  face: {
    order: [
      'quant_luma',
      'decay',
      'decay_time',
      'quant_r',
      'quant_g',
      'quant_b',
      'decay_invert',
    ],

    pages: [
      {
        id: 'depth',
        label: 'colour depth',
        hint: '256 levels at min, 32 at midway, 2 at max',
        controls: ['quant_luma', 'quant_r', 'quant_g', 'quant_b'],
      },
      {
        id: 'decay',
        label: 'phosphor decay',
        hint: 'only visible while the frame is HELD',
        controls: ['decay', 'decay_time', 'decay_invert'],
      },
    ],

    glyph: 'none',

    // ⚠ THE SCREEN ON/OFF SWITCH ARRIVES THROUGH THIS SLOT, AND IT HAD TO
    // (#1934, the #1928 class). The 2026-08-18 owner ruling gives every video
    // module a screen on/off toggle. This module shipped one — on
    // `FreezeframeCard.svelte` — in the SAME change that promoted it into
    // STRICT_FACES, and promotion is precisely what stops both surfaces from
    // rendering that card (`migrated()` becomes true;
    // `DockFullView.svelte:319` mounts `<ModuleShell>` instead). The required
    // control was therefore deleted by the promotion meant to keep it.
    //
    // ⚠ AND THE SPEC THAT PROVED IT WORKED COULD NOT HAVE CAUGHT THAT: it was
    // pinned to `/rack?shell=legacy`, the one surface promotion does not
    // change, so it passed and would have gone on passing while the shipping UI
    // had no toggle at all. Both halves are covered now —
    // `freezeframe-screen-toggle.spec.ts` exercises the legacy CARD and the
    // faced DOCK surface, and `video-face-screen-source.test.ts` (#1935)
    // refuses this shape by name so the next module cannot repeat it.
    //
    // There is no generic affordance to fall back on — `previewCollapsed`
    // appears in ZERO shell files — so it comes through `fullViewBody`, the
    // route `backdraft`, `videoOut`, `spirographs` and `mirrorpool` take.
    //
    // Contract-transparent: `face.extension` is a STRING, not a component, so
    // the shell never imports a freezeframe file, and a def's own top-level
    // `face` is stripped from the attest basis — declaring it costs no
    // re-attest and no contract-lock line.
    extension: 'freezeframe',

  },

  docs: {
    explanation: "FREEZEFRAME fuses two video effects in one card. First, a SAMPLE & HOLD \"freeze\": with nothing patched to GATE the source passes through live; patch a gate and the image FREEZES, and the GATE jack then honours both readings of the gate cable at once. Send a TRIGGER at it and each rising edge updates EXACTLY ONE frame, after which it is still again. Hold the gate HIGH (level >= 0.5) and you get that same one-frame update at the edge, and then — once the level has STOOD high for about 75 ms — continuous live updating for as long as it stays high. That 75 ms is deliberate and is the shortest honest answer available: the patch bridge does not stream the gate waveform to a video module, it re-reports the level roughly every 25 ms, so for the first tick or two a 5 ms trigger and a gate that has just opened are literally the same bytes. Anything held shorter than the window is therefore classified as a TRIGGER and updates exactly one frame — including a gate DERIVED from a trigger by GATEMAIDEN, whose default width is 50 ms, so inserting GATEMAIDEN into the path does not change the frame count. In practice a square LFO below roughly 6.6 Hz plays while open and stutter-freezes the instant it closes (at 1 Hz about 44 percent of frames update, at 4 Hz about 26 percent); faster than that knee each cycle contributes only its one edge frame and the module reads as a strobe, which is the frame-rate-independent reading anyway. Short pulses cannot be missed or double-counted — the rising edge is detected as the gate value arrives rather than sampled once per rendered frame, and the one-shot is a latch a single frame consumes. The first frame always captures so the buffer seeds with real content instead of black. Second, a PER-CHANNEL POSTERIZE: four QUANT knobs each reduce one channel's colour depth, mapping the sweep geometrically in log2 from 256 levels (full depth) at min, through 32 at midway, to 2 (on/off) at max — crank all four for a hard few-bit posterized look. The shader posterizes each channel with floor(c*levels)/(levels-1); the combined output also applies the QUANT-luma reduction as a hue-preserving luma ratio so that knob still shapes the main out. Third, PHOSPHOR DECAY: switch DECAY on and a held frame no longer just sits there — it fades exponentially to black over the DECAY TIME knob's 0.05 to 2 seconds, the way a CRT phosphor gives up once the beam stops refreshing it, and INVERT sends it to white instead. DECAY TIME reads as \"gone by\": at the time you dial in the frame has reached the target exactly and stays there, rather than the 37 percent a 1/e time constant would leave behind. It is only visible WHILE THE IMAGE IS FROZEN, which is not a limitation but what the effect IS — decay is the age of the held frame, so with GATE unpatched (live passthrough) or held open every frame is brand new and the switch legitimately does nothing. The fade is evaluated from elapsed TIME rather than accumulated per frame, so it takes the same real half-second whether the renderer is managing 8 frames a second or 240, and it is applied after the posterizer (a signal is quantized, then a display persists it) so it still fades smoothly even with all four QUANT knobs at max. Five outputs let you tap the recombined image, each isolated channel as a grey intensity image, or the Rec.601 luma. Usage hint: drive GATE from an LFO or clock to strobe/freeze a video feed, then dial the QUANT knobs for VHS/8-bit colour crushing; add DECAY for trailing strobe ghosts; fan the R/G/B/LUMA taps into separate processors for channel-split effects.",
    inputs: {
      video_in: "The source video frame fed into the sample-and-hold buffer and posterizer.",
      gate_in: "Sample-and-hold gate. Unpatched = continuous live passthrough. Patched, the image is FROZEN while the level is LOW. Each RISING EDGE updates EXACTLY ONE frame, so a trigger pulse re-samples once and then holds still. A gate HELD HIGH gets that edge frame too, and then updates CONTINUOUSLY once the level has stood high for about 75 ms — three reports of the ~25 ms patch bridge, which is the soonest a held gate can be told apart from a trigger at all, since until the level is re-reported the two are identical. A high shorter than that window reads as a TRIGGER: notably a 50 ms gate derived from a trigger by GATEMAIDEN, which is why inserting GATEMAIDEN does not change the frame count. Both readings come from this one jack — patch a held gate or slow square LFO for live-while-open, or a clock/trigger for one frame per tick.",
    },
    outputs: {
      video_out: "The recombined R/G/B image with each channel's posterize applied, plus the QUANT-LUMA reduction as a hue-preserving luma ratio. The faceplate\'s on-screen preview shows this output.",
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
      decay: "DECAY — phosphor persistence, OFF by default. Switch it on and a HELD frame fades away instead of sitting there: the image drops exponentially toward black over the DECAY TIME you set, the way a CRT phosphor gives up after the beam stops refreshing it. It only does anything WHILE THE IMAGE IS FROZEN, and that is the honest behaviour rather than a limitation — decay is the AGE of the held frame, and a frame that was just captured is zero seconds old. So with nothing patched to GATE (live passthrough), or with the gate held open, every frame is fresh and this switch changes nothing you can see. Patch a gate, let it close, and the fade begins. Turning DECAY off restores the previous output exactly, not approximately.",
      decay_invert: "INVERT — flip the decay TARGET from black to white, so a held frame blooms out to a white field instead of sinking to a black one. Same curve and the same DECAY TIME, measured as distance-to-white rather than distance-to-black, so the two directions clear at exactly the same moment. Does nothing unless DECAY is on.",
      decay_time: "DECAY TIME — how long a held frame takes to CLEAR, from 0.05 s (a fast strobe-trail flicker) to 2 s (a long smear). Read it as \"gone by\": at the time you dial in, the frame has reached the target exactly and stays there — it is not a 1/e time constant, which would still leave 37 percent of the picture on screen when the clock ran out. The shape between the ends is exponential, so most of the brightness goes early and the last of it lingers, which is what phosphor actually does. Moving the knob mid-fade changes the rate from that moment on and leaves the part already faded alone, so it will not jump. Does nothing unless DECAY is on.",
      gateLevel: "GATE — hidden synthetic param the cross-domain CV bridge writes from gate_in; it carries the live gate level into the sample-and-hold decision, is rising-edge detected on arrival for the one-shot trigger, and the fact that it is written at all is how the module detects the gate is patched. The wall clock of the last rising edge is what the 75 ms hold-qualification window is measured from, so a level that has not yet stood that long counts as a trigger rather than a hold. Exposed only as the gate cv jack, not as a knob.",
    },
  },
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
    const uDecayK      = gl.getUniformLocation(program, 'uDecayK');
    const uDecayTarget = gl.getUniformLocation(program, 'uDecayTarget');

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

    // ---- PHOSPHOR DECAY state ----
    //   decayProgress   : normalized 0..1 age of the CURRENTLY HELD frame (see
    //                     advanceDecayProgress). 0 on every captured frame.
    //   lastFrameTimeSec: previous draw's `frame.time`, to difference for dt.
    //                     null = no draw yet, so the first dt is 0.
    //   decayK          : this frame's surviving fraction — the uniform. Kept as
    //                     a field so read('decayK') can expose it to tests
    //                     WITHOUT re-deriving the value (a re-typed copy in a
    //                     probe is how the last blind gate went blind).
    //
    // ⚠ THE CLOCK IS `frame.time`, NOT `nowMs()` AND NOT `frame.timeDelta`, and
    // all three are different quantities here:
    //
    //   · `nowMs()` (performance.now) is right for the GATE-freshness test above
    //     because that measures the CV BRIDGE's wall-clock write cadence, which
    //     keeps ticking on its Worker timer whether or not the renderer draws.
    //     Decay is a property of the RENDER, so it must not use it: under the
    //     render-smoke determinism hook (`__videoEngineFreezeTime`) a pinned
    //     render would still fade, and every DRS baseline that ever turns this
    //     feature on would be a moving target.
    //   · `frame.time` IS the engine clock: real elapsed seconds in production,
    //     and PINNED by that same determinism hook — so a frozen render frame is
    //     genuinely frozen, and a test can advance the decay by exactly the
    //     interval it chooses. That is what makes the renderer-independence
    //     assertion in the e2e deterministic rather than a timing race.
    //   · `frame.timeDelta` is real wall clock AND clamped to 0.1 s (see
    //     VideoEngine.step), so a 3-second backgrounded-tab stall would advance
    //     the fade by 0.1 s and the frame would still be sitting there when you
    //     came back. Differencing `frame.time` reports the truth: three seconds
    //     passed, the phosphor is out.
    let decayProgress = 0;
    let lastFrameTimeSec: number | null = null;
    let decayK = 1;
    // 0 = black, 1 = white. FORCED to 0 while DECAY is off even if INVERT is
    // left on, so the off-state uniforms are (k=1, target=0) — the pair the
    // shader tail collapses to `rgb` bit-exactly. INVERT alone must not be able
    // to perturb the output by so much as a ULP.
    let decayTarget = 0;

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
      gl.uniform1f(uDecayK, decayK);
      gl.uniform1f(uDecayTarget, decayTarget);
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

        // ---- PHOSPHOR DECAY: advance the held frame's age ----
        //
        // Deliberately NOT a feedback pass over the hold buffer, and that
        // avoids two whole failure modes rather than working around them:
        //
        //  (1) THE 8-BIT RESIDUE. `ctx.createFbo()` allocates RGBA8
        //      (VideoEngine.createFboImpl), and GL rounds a float write to the
        //      NEAREST code value. An iterative `v ← v·k` therefore STALLS
        //      wherever `round(v·k) == v`, i.e. at every v ≤ 0.5/(1−k): the
        //      image fades to a dark ghost and sits there FOREVER. Worse, the
        //      residue is a function of the FRAME RATE, because k is — 13/255
        //      at 60 fps, 26 at 120, 52 at 240 for a 2 s decay (measured in
        //      freezeframe.test.ts, which keeps that simulation as a permanent
        //      negative control of this design choice). Evaluating the envelope
        //      CLOSED-FORM into a uniform never accumulates, so the endpoint is
        //      whatever the curve says it is: envelope(1) is exactly 0, and
        //      `target + (v − target)·0` is exactly the target for all 256
        //      input code values.
        //  (2) THE FEEDBACK LOOP. Sampling `hold` while rendering into it is
        //      undefined in GL; doing it properly would need a ping-pong pair
        //      plus a swap threaded through all five output passes. A uniform
        //      needs neither, so `hold` stays a single FBO and the five
        //      consumers below are untouched.
        //
        // A CAPTURED frame is age zero — which is why decay is invisible while
        // the module is passing live video, and why the docs say so.
        const frameTimeSec = Number.isFinite(frame.time) ? frame.time : 0;
        const dtSec = lastFrameTimeSec === null ? 0 : frameTimeSec - lastFrameTimeSec;
        lastFrameTimeSec = frameTimeSec;
        const decayOn = params.decay >= 0.5;
        decayProgress = capture || !decayOn
          ? 0
          : advanceDecayProgress(decayProgress, dtSec, params.decay_time);
        decayK = decayOn ? decayEnvelope(decayProgress) : 1;
        decayTarget = decayOn ? decayTargetValue(params.decay_invert >= 0.5) : 0;

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
        // PHOSPHOR DECAY probes. These return the LIVE fields the shader was
        // actually handed this frame — they do NOT recompute the envelope, so a
        // probe cannot agree with a broken draw loop by accident.
        if (key === 'decayProgress') return decayProgress;
        if (key === 'decayK')        return decayK;
        if (key === 'decayTarget')   return decayTarget;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
