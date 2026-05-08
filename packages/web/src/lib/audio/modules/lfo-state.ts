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
