// packages/web/src/lib/video/cv-bridge-map.ts
//
// Pure value-mapping helper for the cross-domain cv → video bridge
// (engine.ts → tickCvBridges). Lives in its own file because it is pure
// and trivially unit-testable without dragging in a WebGL2 context.
//
// The bridge samples ONE audio-side AnalyserNode per video frame and
// writes the value into a target video module's setParam. There are two
// fundamentally different kinds of target, and the bridge MUST branch on
// which one it's driving:
//
//   1. GATE-style cv inputs (DOOM's cv_up/cv_down/...; VIDEOVARISPEED's
//      cv_start/cv_pause/...). The target module owns an edge detector
//      (see lib/doom/cv-gate-edge.ts) that turns a CV swing into a
//      key-down / key-up event. We must NOT "scale" a gate — we pass the
//      RAW cv value through and let the module's hysteresis detector
//      decide. A real bipolar (±1) or unipolar (0..1) swing crosses the
//      detector's rise/fall thresholds and triggers.
//
//   2. CONTINUOUS param targets (ACIDWARP speed, VIDEOVARISPEED speedCv,
//      a camera rot/zoom/pos). Here a bipolar ±1 source should sweep the
//      destination param across its FULL natural range, centered on the
//      param's current value — exactly like the AUDIO path in
//      lib/audio/cv-scale.ts. Without this, a ±1 LFO only exercises a
//      sub-range of (e.g.) a 0.3..3 zoom and clamps → "one quadrant".
//
// How we tell them apart: a continuous target declares a `cvScale` hint
// on its input PortDef (that's the project convention — see CvScaleHint).
// A gate-style input has NO cvScale and routes to a synthetic param the
// module edge-detects. So: cvScale present ⇒ scale across param range;
// cvScale absent ⇒ raw passthrough (gate semantics).

import type { CvScaleHint, ParamDef, PortDef } from '$lib/graph/types';
import { scaleCv } from '$lib/audio/cv-scale';

/** Everything the bridge needs, precomputed at addCvBridge time so the
 *  per-frame tick stays allocation-free + branch-cheap. */
export interface CvBridgeMapping {
  /** Resolved param id the value is written to (input.paramTarget ?? portId). */
  targetParamId: string;
  /** When set, the incoming cv is mapped across this param's range using
   *  the hint. When undefined, the raw cv value is passed straight to
   *  setParam (gate semantics). */
  scale?: {
    hint: CvScaleHint;
    min: number;
    max: number;
    /** The modulation centre (value cv=0 maps to), mirroring the audio path's
     *  knob. Normally the param's current stored value; for a `center: 'default'`
     *  hint (absolute-position params) it's the param's defaultValue so a cabled
     *  input tracks the source directly regardless of any stale saved base.
     *
     *  ⚠ MUTABLE, AND REFRESHED PER TICK BY THE ENGINE (#2236). Captured once at
     *  addCvBridge, this froze the centre at whatever the fader read when the
     *  CABLE was made: every later tick then wrote `staleKnob + cv·halfSpan`
     *  over the user's drag, so a CV-driven fader could not be repositioned at
     *  all — it snapped back to a position that bore no relation to the stick.
     *  See `cvBridgeKnobTracksBase`. */
    knob: number;
  };
}

/**
 * Decide how a cv → video bridge should map its sampled value, given the
 * target module's input PortDef + param defs + the node's current params.
 *
 * Returns the resolved param id and (for continuous targets) the scaling
 * context. A target is "continuous" iff its input declares a `cvScale`
 * hint; otherwise it's treated as a gate (raw passthrough).
 */
export function buildCvBridgeMapping(
  input: PortDef | undefined,
  targetPortId: string,
  paramDefs: readonly ParamDef[] | undefined,
  nodeParams: Record<string, number> | undefined,
): CvBridgeMapping {
  const targetParamId = input?.paramTarget ?? targetPortId;
  const hint = input?.cvScale;
  // No hint ⇒ gate-style. Pass the raw value through; the module
  // edge-detects. This is the DOOM cv_<port> path.
  if (!hint || hint.mode === 'passthrough') {
    return { targetParamId };
  }
  const def = paramDefs?.find((p) => p.id === targetParamId);
  if (!def) {
    // Hinted but we can't resolve the param range — degrade to raw
    // passthrough rather than guessing a range.
    return { targetParamId };
  }
  // Modulation centre. `center: 'default'` (absolute-position params like a
  // joystick's X/Y) IGNORES the stored value so a cabled input tracks the
  // source directly — a stale saved position can't offset a cable-driven value.
  // Otherwise centre on the stored knob (the bias-knob metaphor: base + wobble).
  const knob = hint.center === 'default'
    ? def.defaultValue
    : (nodeParams?.[targetParamId] ?? def.defaultValue);
  return {
    targetParamId,
    scale: { hint, min: def.min, max: def.max, knob },
  };
}

/**
 * Map one sampled cv value through a bridge mapping into the value to
 * hand setParam. Pure; identical inputs → identical output.
 *
 *  - gate target (no scale): return the raw sample unchanged.
 *  - continuous target: scaleCv across the param range (±1 ⇒ full sweep).
 */
export function mapCvBridgeValue(mapping: CvBridgeMapping, sample: number): number {
  if (!mapping.scale) return sample;
  const { hint, min, max, knob } = mapping.scale;
  return scaleCv(sample, knob, min, max, hint);
}

/**
 * Does this mapping's centre track the param's live manual base?
 *
 * TRUE for the ordinary bias-knob metaphor (base + wobble): the centre is
 * wherever the user last put the fader, so the engine refreshes it each tick
 * from `baseParams`.
 *
 * FALSE for a `center: 'default'` hint. Those are ABSOLUTE-POSITION params — a
 * joystick's X/Y — where a cabled input must track the source directly and a
 * stored value must never offset it. Refreshing those would reintroduce exactly
 * the stale-base bug that hint exists to prevent, so the distinction is load
 * bearing in both directions.
 */
export function cvBridgeKnobTracksBase(mapping: CvBridgeMapping): boolean {
  return !!mapping.scale && mapping.scale.hint.center !== 'default';
}

// ─────────────────────── CV ACTIVITY (idle / active) ───────────────────────
//
// "Is the stick moving?" — the explicit seam the record-CV-automation model
// (owner report, 2026-08: record the movement, loop it while the source is
// parked, live movement overrides) hangs off. The detector watches the RAW
// source sample the bridge reads from its analyser — NEVER the target param's
// uniform — so clip-automation playback writing the param can never look like
// live movement (the two channels stay distinguishable at this seam by
// construction; a feedback loop is structurally impossible).
//
// Semantics (value-change threshold + hold time, mirroring the MIDI CC-idle
// release in cc-commit.ts — a stream with no pointer-up needs a settle window
// to mean "hand off the control"):
//   - a sample moving ≥ `moveEps` from the last movement anchor ⇒ ACTIVE, and
//     the anchor re-seats (so a slow drift ACCUMULATES against the anchor and
//     still trips the threshold, instead of hiding under it per-tick);
//   - ACTIVE decays to IDLE only once BOTH hold legs pass with no such
//     movement: ≥ `idleHoldTicks` consecutive bridge ticks (renderer
//     independence) AND ≥ `idleHoldMs` wall-clock (real-time feel).
//
// TWO-LEG DECAY — the frames-not-ms rule applied to the detector. A wall-clock
// hold alone is a different number of bridge ticks on every renderer: on a
// contended SwiftShader shard ONE frame interval can exceed 300 ms, so a
// ms-only hold decays on every still tick — the state flaps per tick, each
// grab segment holds a single flat sample, and the recorder's MOVE_EPS gate
// correctly drops it (e2e shard 10, run 33268224303). Ticks alone would cut
// the other way: 60 fps delivers ~18 ticks inside 300 ms, so a small tick
// floor would release a briefly-hesitating hand mid-gesture. AND-ing the legs
// keeps the fast-renderer feel (the ms leg binds there) and the slow-renderer
// stability (the tick leg binds there) with no per-machine tuning.
//
// Time is INJECTED (`nowMs`) so the state machine is pure and unit-testable
// with a fake clock; the engine feeds performance.now(). Ticks need no
// injection: one update() call IS one bridge tick by construction — which is
// also why a STALLED bridge (throttled tab, contended shard) can never decay
// on wall-clock alone: no tick, no state change.

/** Raw-sample movement threshold (source units — cv is bipolar ±1, so this is
 *  0.5% of the span; the gamepad module's deadzone already zeroes a parked
 *  stick, and 7-bit CC steps ≈ 0.016 clear it comfortably). */
export const CV_ACTIVITY_MOVE_EPS = 0.01;

/** Wall-clock leg of the idle hold. Longer than the MIDI CC settle (200 ms,
 *  cc-commit.ts) on purpose: an analyser-sampled stream has no discrete
 *  message cadence, and the window must cover a gentle stick turn-around. On a
 *  fast renderer this leg binds (~18 bridge ticks at 60 fps), preserving the
 *  real-time release feel. NEVER the sole gate — see CV_ACTIVITY_IDLE_TICKS
 *  for why a wall-clock-only hold flaps under load. */
export const CV_ACTIVITY_IDLE_MS = 300;

/** Tick-count leg of the idle hold: consecutive bridge ticks with no
 *  qualifying movement before ACTIVE may decay. A bridge tick is one delivered
 *  sample whatever the frame rate, so this leg is renderer-independent by
 *  construction — on a contended SwiftShader shard one frame interval can
 *  exceed the wall-clock hold, and a ms-only hold then decays on EVERY still
 *  tick (measured: e2e shard 10, run 33268224303 — one-sample flat grab
 *  segments, all MOVE_EPS-dropped). 3 because a gentle turn-around reads
 *  still for 1–2 ticks at any frame rate; on a fast renderer the ms leg
 *  binds long before this one. */
export const CV_ACTIVITY_IDLE_TICKS = 3;

/**
 * Idle/active state machine for ONE cv bridge's source stream. Feed it the
 * raw sample (cv/gate tail sample, or the envelope value for an `audio`
 * source) once per bridge tick; read back whether the source is live.
 */
export class CvActivityDetector {
  private readonly moveEps: number;
  private readonly idleHoldMs: number;
  private readonly idleHoldTicks: number;
  private anchor: number | null = null; // value at the last detected movement
  private lastMoveAt = -Infinity;
  private stillTicks = 0; // consecutive update() calls with no qualifying movement
  private isActive = false;

  constructor(opts: { moveEps?: number; idleHoldMs?: number; idleHoldTicks?: number } = {}) {
    this.moveEps = opts.moveEps ?? CV_ACTIVITY_MOVE_EPS;
    this.idleHoldMs = opts.idleHoldMs ?? CV_ACTIVITY_IDLE_MS;
    this.idleHoldTicks = opts.idleHoldTicks ?? CV_ACTIVITY_IDLE_TICKS;
  }

  /** Feed one sample at `nowMs` — one call per bridge tick. Returns the
   *  (possibly updated) active state. The FIRST sample seats the anchor
   *  without counting as movement OR stillness — a cable patched to a parked
   *  source starts IDLE rather than announcing a phantom gesture. Decay needs
   *  BOTH legs (see the module comment): `idleHoldTicks` consecutive still
   *  ticks AND `idleHoldMs` of wall-clock since the last movement. */
  update(value: number, nowMs: number): boolean {
    if (this.anchor === null) {
      this.anchor = value;
      return this.isActive;
    }
    if (Math.abs(value - this.anchor) >= this.moveEps) {
      this.anchor = value;
      this.lastMoveAt = nowMs;
      this.stillTicks = 0;
      this.isActive = true;
    } else {
      this.stillTicks += 1;
      if (
        this.isActive &&
        this.stillTicks >= this.idleHoldTicks &&
        nowMs - this.lastMoveAt >= this.idleHoldMs
      ) {
        this.isActive = false;
      }
    }
    return this.isActive;
  }

  get active(): boolean {
    return this.isActive;
  }
}
