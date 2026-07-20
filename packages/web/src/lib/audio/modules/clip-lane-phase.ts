// packages/web/src/lib/audio/modules/clip-lane-phase.ts
//
// Per-machine, IN-MEMORY per-lane audio-clock PHASE for the clip player — the
// data the KEYS recorder needs to project a pad event's own timestamp onto a
// fractional step (clip-record-capture.ts). Mirrors clip-playhead.ts /
// clip-audition.ts EXACTLY: the clipplayer factory PUBLISHES each lane's phase
// every scheduler tick; the launchpad binding (a global `.svelte.ts` singleton
// with no engine context) READS it at each keypress. It is render/timing state,
// NEVER a Y.Doc write (the cv-modulation-write-storm rule). Cleared on dispose.

import type { LaneCapturePhase } from './clip-record-capture';

const phases = new Map<string, (LaneCapturePhase | null)[]>();

/** Publish lane L's current capture phase for node `nodeId` (null = silent). */
export function setLanePhase(nodeId: string, lane: number, phase: LaneCapturePhase | null): void {
  let arr = phases.get(nodeId);
  if (!arr) {
    arr = [];
    phases.set(nodeId, arr);
  }
  arr[lane] = phase;
}

/** Lane L's current capture phase (null if none published / lane silent). */
export function getLanePhase(nodeId: string, lane: number): LaneCapturePhase | null {
  return phases.get(nodeId)?.[lane] ?? null;
}

/** Drop all lane-phase state for a node (call on factory dispose). */
export function clearLanePhases(nodeId: string): void {
  phases.delete(nodeId);
}
