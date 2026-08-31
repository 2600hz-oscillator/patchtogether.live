// packages/web/src/lib/ui/modules/backdraft-clocked-delay.ts
//
// THE ONE "is the DELAY CLOCK patched" predicate, shared by the legacy card's
// CLK badge and the faceplate's delay-fader override badge — the range-bound
// one-source rule applied to a graph fact: both surfaces must flip on exactly
// the same condition, or the two UIs disagree about whether the fader rules.
//
// The condition is EDGE EXISTENCE (the patch graph knows), which is also when
// the module's own freshness-window `clockPatched` flips: the bridge starts
// writing `delayClock` the moment the cable lands and stops when it is
// removed, so the UI badge and the engine's inert-fader behavior track the
// same cable within a bridge tick of each other.

import { patch } from '$lib/graph/store';

/** True iff any cable terminates on `nodeId`'s `delay_clock` input. Reads the
 *  LIVE store; callers needing reactivity pair it with a graph version signal
 *  (`edgesVersion()` from node-versions, or a Yjs observer). */
export function backdraftDelayClockPatched(nodeId: string): boolean {
  for (const edge of Object.values(patch.edges)) {
    if (edge && edge.target.nodeId === nodeId && edge.target.portId === 'delay_clock') return true;
  }
  return false;
}
