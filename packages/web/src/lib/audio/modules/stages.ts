// packages/web/src/lib/audio/modules/stages.ts
//
// STAGES — 6-segment cascadable function generator (Mutable Instruments
// Stages archetype, Émilie Gillet, 2017, MIT-licensed). Audio-domain
// module def + pure-math mirror import of the shared engine. Worklet at
// packages/dsp/src/stages.ts; engine math at packages/dsp/src/stages-engine.ts.
//
// v1 ships per-segment type selection (RAMP / HOLD / STEP) + per-segment
// TIME-or-LEVEL primary knob + SHAPE secondary knob + per-segment GATE
// input + adjacent-segment LINK toggles (5 boundary bits between the 6
// segments). Linked segments form chain groups: the first segment of a
// group fires on its gate; subsequent linked segments take over in
// sequence when the previous one completes. A global TRIG input fires
// every chain group's leader. Per-segment CV outputs mirror their
// chain's current value so any segment in the chain can be tapped.
//
// Stretch (deferred — flag in PR body):
//   - Outliner / chord mode (the all-STEP, no-link sequencer
//     interpretation that turns Stages into a 6-track tap-tempo grid).
//   - Loop bit for free-running LFO behavior with rate CV.
//   - Tap-LFO mode.
//
// Inputs:
//   gate0..gate5 (gate): per-segment gate inputs. Rising edge fires that segment (or the chain group's leader).
//   trig (gate): global trigger — fires every chain group's leader.
//   primary0..primary5_cv (cv, linear, paramTarget=primary{N}): per-segment primary CV (time-or-level).
//   shape0..shape5_cv (cv, linear, paramTarget=shape{N}): per-segment shape CV.
//
// Outputs:
//   out0..out5 (cv): per-segment CV output (mirrors the active chain value).
//
// Params:
//   type0..type5 (discrete 0..2, default 0): per-segment type (0 = RAMP, 1 = HOLD, 2 = STEP).
//   primary0..primary5 (linear -1..1, default 0.3): per-segment primary knob (TIME for RAMP, LEVEL for HOLD/STEP).
//   shape0..shape5 (linear 0..1, default 0.5): per-segment secondary SHAPE knob.
//   link0..link4 (discrete 0..1, default 0): 5 boundary "link" bits between the 6 segments (chains formation).

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/stages.js?url';

// Re-export the host-side mirror of the engine so the host tests + card
// UI share the same math + constants as the worklet. See stages-engine.ts
// for the "two copies" convention this follows.
export {
  STAGES_NUM_SEGMENTS,
  STAGES_NUM_LINKS,
  STAGES_NUM_TYPES,
  TYPE_RAMP,
  TYPE_HOLD,
  TYPE_STEP,
  TRIG_THRESHOLD,
  warpPhase,
  timeKnobToSeconds,
  computeChainLeaders,
  StagesEngine,
} from './stages-engine';

import {
  STAGES_NUM_SEGMENTS as _N,
  STAGES_NUM_LINKS as _NL,
  TYPE_RAMP as _TR,
  StagesEngine as _Engine,
} from './stages-engine';

const loadedContexts = new WeakSet<BaseAudioContext>();

export const STAGES_TYPE_NAMES = ['RAMP', 'HOLD', 'STEP'] as const;
export type StagesType = 0 | 1 | 2;

// ---------------------------------------------------------------------------
// Pure-math mirror — render N samples of the per-segment output for the
// given segment configurations, link bits, gate-rising-edge sample indices,
// and global-TRIG-rising-edge sample indices. Used by host-side tests +
// ART scenarios; numerically identical to the worklet because both call
// into the same StagesEngine.
// ---------------------------------------------------------------------------

export interface StagesSegmentConfig {
  type: number;     // 0=RAMP, 1=HOLD, 2=STEP
  primary: number;  // TIME (RAMP, 0..1) or LEVEL (HOLD/STEP, -1..+1)
  shape: number;    // 0..1
}

export interface StagesRenderOpts {
  /** Per-segment params. Length must equal STAGES_NUM_SEGMENTS (6). */
  segments: StagesSegmentConfig[];
  /** Link bits between adjacent segments. Length = STAGES_NUM_LINKS (5). */
  links: boolean[];
  /** Per-segment trigger sample indices (gate rises at these samples). */
  segmentTriggers?: number[][];
  /** Global TRIG rising-edge sample indices. */
  globalTriggers?: number[];
}

export const stagesMath = {
  /** Render `n` samples per segment at sample rate `sr`. Returns a
   *  Float32Array[STAGES_NUM_SEGMENTS] of per-segment CV outputs. */
  render(n: number, sr: number, opts: StagesRenderOpts): Float32Array[] {
    const engine = new _Engine(sr);
    for (let i = 0; i < _N; i++) {
      const cfg = opts.segments[i] ?? { type: _TR, primary: 0.3, shape: 0.5 };
      engine.setSegmentType(i, cfg.type);
      engine.setSegmentPrimary(i, cfg.primary);
      engine.setSegmentShape(i, cfg.shape);
    }
    for (let i = 0; i < _NL; i++) {
      engine.setLink(i, opts.links[i] ?? false);
    }
    // Pre-compute trigger schedules.
    const segTrigSets: Array<Set<number>> = [];
    for (let s = 0; s < _N; s++) {
      segTrigSets.push(new Set(opts.segmentTriggers?.[s] ?? []));
    }
    const globalTrigSet = new Set(opts.globalTriggers ?? []);
    const outs: Float32Array[] = [];
    for (let s = 0; s < _N; s++) outs.push(new Float32Array(n));
    const gateLevels = new Float32Array(_N);
    for (let i = 0; i < n; i++) {
      // Encode rising-edge triggers as gate-high for this sample, then
      // back to zero on the next sample. This matches how the worklet
      // detects rising edges (level threshold-crossing).
      for (let s = 0; s < _N; s++) {
        gateLevels[s] = segTrigSets[s]!.has(i) ? 1 : 0;
      }
      const gt = globalTrigSet.has(i) ? 1 : 0;
      // Force a falling edge BEFORE each rising edge by checking i-1's
      // membership: if the previous sample was a trigger and the current
      // isn't, we want this sample at 0. The Set lookup already does that.
      const vals = engine.tick(gateLevels, gt);
      for (let s = 0; s < _N; s++) outs[s]![i] = vals[s] ?? 0;
    }
    return outs;
  },

  /** Human label for a knob, given the segment's TYPE. RAMP uses TIME
   *  for primary; HOLD/STEP use LEVEL. SHAPE is always shape. */
  knobLabels(type: number): { primary: string; shape: string } {
    if (type === 0) return { primary: 'TIME', shape: 'SHAPE' };
    if (type === 1) return { primary: 'LEVEL', shape: 'PORTA' };
    return { primary: 'LEVEL', shape: 'PORTA' };
  },
};

// ---------------------------------------------------------------------------
// Module def.
// ---------------------------------------------------------------------------

export const stagesDef: AudioModuleDef = {
  type: 'stages',
  palette: { top: 'Ports', sub: 'Mutable' },
  domain: 'audio',
  label: 'STAGES',
  category: 'modulation',
  schemaVersion: 1,
  ossAttribution: { author: 'Émilie Gillet' },
  // Inputs are written out as a literal array (6 GATE inputs + 1 global
  // TRIG + 12 CV inputs) so the docs/module-manifest.ts regex parser can
  // discover them without a synthesizer special-case.
  inputs: [
    { id: 'gate0', type: 'gate' },
    { id: 'gate1', type: 'gate' },
    { id: 'gate2', type: 'gate' },
    { id: 'gate3', type: 'gate' },
    { id: 'gate4', type: 'gate' },
    { id: 'gate5', type: 'gate' },
    // Global TRIG — fires every chain group's leader at once.
    { id: 'trig',  type: 'gate' },
    // Per-segment CV → primary (TIME / LEVEL) AudioParam, linear scaling.
    { id: 'primary0_cv', type: 'cv', paramTarget: 'primary0', cvScale: { mode: 'linear' } },
    { id: 'primary1_cv', type: 'cv', paramTarget: 'primary1', cvScale: { mode: 'linear' } },
    { id: 'primary2_cv', type: 'cv', paramTarget: 'primary2', cvScale: { mode: 'linear' } },
    { id: 'primary3_cv', type: 'cv', paramTarget: 'primary3', cvScale: { mode: 'linear' } },
    { id: 'primary4_cv', type: 'cv', paramTarget: 'primary4', cvScale: { mode: 'linear' } },
    { id: 'primary5_cv', type: 'cv', paramTarget: 'primary5', cvScale: { mode: 'linear' } },
    // Per-segment CV → SHAPE AudioParam, linear.
    { id: 'shape0_cv', type: 'cv', paramTarget: 'shape0', cvScale: { mode: 'linear' } },
    { id: 'shape1_cv', type: 'cv', paramTarget: 'shape1', cvScale: { mode: 'linear' } },
    { id: 'shape2_cv', type: 'cv', paramTarget: 'shape2', cvScale: { mode: 'linear' } },
    { id: 'shape3_cv', type: 'cv', paramTarget: 'shape3', cvScale: { mode: 'linear' } },
    { id: 'shape4_cv', type: 'cv', paramTarget: 'shape4', cvScale: { mode: 'linear' } },
    { id: 'shape5_cv', type: 'cv', paramTarget: 'shape5', cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'out0', type: 'cv' },
    { id: 'out1', type: 'cv' },
    { id: 'out2', type: 'cv' },
    { id: 'out3', type: 'cv' },
    { id: 'out4', type: 'cv' },
    { id: 'out5', type: 'cv' },
  ],
  params: [
    // Per-segment TYPE (discrete: 0=RAMP, 1=HOLD, 2=STEP).
    { id: 'type0', label: 'T1', defaultValue: 0, min: 0, max: 2, curve: 'discrete' },
    { id: 'type1', label: 'T2', defaultValue: 0, min: 0, max: 2, curve: 'discrete' },
    { id: 'type2', label: 'T3', defaultValue: 0, min: 0, max: 2, curve: 'discrete' },
    { id: 'type3', label: 'T4', defaultValue: 0, min: 0, max: 2, curve: 'discrete' },
    { id: 'type4', label: 'T5', defaultValue: 0, min: 0, max: 2, curve: 'discrete' },
    { id: 'type5', label: 'T6', defaultValue: 0, min: 0, max: 2, curve: 'discrete' },
    // Per-segment PRIMARY knob — TIME (RAMP, 0..1 log-mapped) or LEVEL (HOLD/STEP, -1..+1).
    { id: 'primary0', label: 'P1', defaultValue: 0.3, min: -1, max: 1, curve: 'linear' },
    { id: 'primary1', label: 'P2', defaultValue: 0.3, min: -1, max: 1, curve: 'linear' },
    { id: 'primary2', label: 'P3', defaultValue: 0.3, min: -1, max: 1, curve: 'linear' },
    { id: 'primary3', label: 'P4', defaultValue: 0.3, min: -1, max: 1, curve: 'linear' },
    { id: 'primary4', label: 'P5', defaultValue: 0.3, min: -1, max: 1, curve: 'linear' },
    { id: 'primary5', label: 'P6', defaultValue: 0.3, min: -1, max: 1, curve: 'linear' },
    // Per-segment SHAPE — phase warp (RAMP) or portamento (HOLD/STEP).
    { id: 'shape0', label: 'S1', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 'shape1', label: 'S2', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 'shape2', label: 'S3', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 'shape3', label: 'S4', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 'shape4', label: 'S5', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 'shape5', label: 'S6', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    // 5 link bits between adjacent segments (0=segs 0↔1, 4=segs 4↔5).
    { id: 'link0', label: 'L1', defaultValue: 0, min: 0, max: 1, curve: 'discrete' },
    { id: 'link1', label: 'L2', defaultValue: 0, min: 0, max: 1, curve: 'discrete' },
    { id: 'link2', label: 'L3', defaultValue: 0, min: 0, max: 1, curve: 'discrete' },
    { id: 'link3', label: 'L4', defaultValue: 0, min: 0, max: 1, curve: 'discrete' },
    { id: 'link4', label: 'L5', defaultValue: 0, min: 0, max: 1, curve: 'discrete' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }
    const workletNode = new AudioWorkletNode(ctx, 'stages', {
      // STAGES_NUM_SEGMENTS gate inputs + 1 global trig = 7 input slots.
      numberOfInputs: _N + 1,
      numberOfOutputs: _N,
      outputChannelCount: new Array(_N).fill(1),
    });

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of stagesDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    const inputsMap = new Map<string, { node: AudioNode; input: number; param?: AudioParam }>();
    for (let i = 0; i < _N; i++) {
      inputsMap.set(`gate${i}`, { node: workletNode, input: i });
    }
    inputsMap.set('trig', { node: workletNode, input: _N });
    // CV→AudioParam routings reuse input slot 0; the engine recognizes
    // the `param` field and routes via AudioParam connect.
    for (let i = 0; i < _N; i++) {
      inputsMap.set(`primary${i}_cv`, { node: workletNode, input: 0, param: params.get(`primary${i}`)! });
      inputsMap.set(`shape${i}_cv`,   { node: workletNode, input: 0, param: params.get(`shape${i}`)! });
    }

    const outputsMap = new Map<string, { node: AudioNode; output: number }>();
    for (let i = 0; i < _N; i++) {
      outputsMap.set(`out${i}`, { node: workletNode, output: i });
    }

    return {
      domain: 'audio',
      inputs: inputsMap,
      outputs: outputsMap,
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        try { workletNode.disconnect(); } catch { /* */ }
      },
    };
  },
};
