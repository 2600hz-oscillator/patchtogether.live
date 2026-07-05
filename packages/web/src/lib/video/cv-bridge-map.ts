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
     *  input tracks the source directly regardless of any stale saved base. */
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
