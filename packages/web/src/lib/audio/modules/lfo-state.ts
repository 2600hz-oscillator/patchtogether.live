// packages/web/src/lib/audio/modules/lfo-state.ts
//
// Pure deterministic phase computation for the LFO module — extracted
// here so unit + ART tests can import it without dragging in the worklet
// `?url` asset that lfo.ts also imports (Node can't resolve `?url`).
//
// The worklet (packages/dsp/src/lfo.ts) implements the same math in
// sharedDerivedPhase() as a sanity-check anchor point. Two clients
// arriving at this function with the same (epoch_ms, t_shared, rate)
// produce identical phase values, which is the load-bearing property
// of Phase 1 of .myrobots/plans/shared-state-sync.md.

export interface LfoState {
  phase: number;
  phase90: number;
  phase180: number;
  phase270: number;
  // Index signature so this satisfies the SyncedModuleDef contract
  // (Record<string, number>) without each consumer casting.
  [k: string]: number;
}

export function computeLfoState(
  tMsSinceEpoch: number,
  params: { rate?: number },
): LfoState {
  const rate = params.rate ?? 1;
  const tSec = tMsSinceEpoch / 1000;
  let phase = (tSec * rate) % 1;
  if (phase < 0) phase += 1;
  return {
    phase,
    phase90: (phase + 0.25) % 1,
    phase180: (phase + 0.5) % 1,
    phase270: (phase + 0.75) % 1,
  };
}

const TWO_PI = Math.PI * 2;

/** Morph between sine, saw, and square for the given normalized phase [0,1).
 *  Mirrors the worklet's morph() (packages/dsp/src/lfo.ts) so unit tests can
 *  reproduce the emitted output amplitude without the AudioWorkletProcessor. */
export function morphLfo(phase: number, shape: number): number {
  const s = Math.max(0, Math.min(2, shape));
  const sine = Math.sin(TWO_PI * phase);
  const saw = phase * 2 - 1;
  const sq = phase < 0.5 ? 1 : -1;
  if (s < 1) {
    const m = s;
    return sine * (1 - m) + saw * m;
  }
  const m = s - 1;
  return saw * (1 - m) + sq * m;
}

/** depth → output amplitude gain. Mirrors the worklet:
 *  depth=0 → 0 (still), depth=0.5 → 1 (unity / legacy), depth=1 → 2 (2×,
 *  deliberately out of the normal [-1,1] range; NOT clamped). */
export function lfoDepthGain(depth: number): number {
  return Math.max(0, depth) * 2;
}

/** Instantaneous emitted output of one phase, with shape morph + depth gain
 *  applied. The bipolar resting/centre value of every shape is 0, so depth
 *  scales the swing magnitude: at depth=0 the output is the resting value
 *  (0 = "still"); depth is orthogonal to shape/polarity. */
export function computeLfoOutput(
  tMsSinceEpoch: number,
  params: { rate?: number; shape?: number; depth?: number },
): { phase0: number; phase90: number; phase180: number; phase270: number } {
  const { phase, phase90, phase180, phase270 } = computeLfoState(tMsSinceEpoch, params);
  const shape = params.shape ?? 0;
  const gain = lfoDepthGain(params.depth ?? 0.5);
  return {
    phase0: morphLfo(phase, shape) * gain,
    phase90: morphLfo(phase90, shape) * gain,
    phase180: morphLfo(phase180, shape) * gain,
    phase270: morphLfo(phase270, shape) * gain,
  };
}
