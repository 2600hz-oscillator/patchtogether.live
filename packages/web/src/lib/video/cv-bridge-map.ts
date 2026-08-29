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
//   - ACTIVE decays to IDLE after `idleHoldMs` with no such movement.
//
// Time is INJECTED (`nowMs`) so the state machine is pure and unit-testable
// with a fake clock; the engine feeds performance.now().

/** Raw-sample movement threshold (source units — cv is bipolar ±1, so this is
 *  0.5% of the span; the gamepad module's deadzone already zeroes a parked
 *  stick, and 7-bit CC steps ≈ 0.016 clear it comfortably). */
export const CV_ACTIVITY_MOVE_EPS = 0.01;

/** How long the source must sit still before it counts as IDLE. Longer than
 *  the MIDI CC settle (200 ms, cc-commit.ts) on purpose: an analyser-sampled
 *  stream has no discrete message cadence, and the window must cover a gentle
 *  stick turn-around plus ≥2 bridge ticks under SwiftShader (~127 ms/tick at
 *  7.9 fps) so a slow renderer can't flap the state per frame. */
export const CV_ACTIVITY_IDLE_MS = 300;

/**
 * Idle/active state machine for ONE cv bridge's source stream. Feed it the
 * raw sample (cv/gate tail sample, or the envelope value for an `audio`
 * source) once per bridge tick; read back whether the source is live.
 */
export class CvActivityDetector {
  private readonly moveEps: number;
  private readonly idleHoldMs: number;
  private anchor: number | null = null; // value at the last detected movement
  private lastMoveAt = -Infinity;
  private isActive = false;

  constructor(opts: { moveEps?: number; idleHoldMs?: number } = {}) {
    this.moveEps = opts.moveEps ?? CV_ACTIVITY_MOVE_EPS;
    this.idleHoldMs = opts.idleHoldMs ?? CV_ACTIVITY_IDLE_MS;
  }

  /** Feed one sample at `nowMs`. Returns the (possibly updated) active state.
   *  The FIRST sample seats the anchor without counting as movement — a cable
   *  patched to a parked source starts IDLE rather than announcing a phantom
   *  gesture. */
  update(value: number, nowMs: number): boolean {
    if (this.anchor === null) {
      this.anchor = value;
      return this.isActive;
    }
    if (Math.abs(value - this.anchor) >= this.moveEps) {
      this.anchor = value;
      this.lastMoveAt = nowMs;
      this.isActive = true;
    } else if (this.isActive && nowMs - this.lastMoveAt >= this.idleHoldMs) {
      this.isActive = false;
    }
    return this.isActive;
  }

  get active(): boolean {
    return this.isActive;
  }
}
