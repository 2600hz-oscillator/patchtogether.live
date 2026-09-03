// packages/web/src/lib/ui/modules/samsloop/samsloop-rec-refusal.svelte.ts
//
// WHY THE REC BUTTON NEEDED SOMEWHERE TO FAIL.
//
// `startSamsloopTake` REFUSES rather than arming when the engine is not up or
// the rack's sample budget is spent — that refusal is the module's own hard-won
// correctness (it replaced a truncation that cut 8 % off every take without
// saying so, and it re-reads the ledger FRESH so a peer's sample landing between
// render and press cannot be raced past). The legacy card painted the sentence
// in `samsloop-rec-error`. The faceplate had nowhere to put it: an `action`
// shell cell is a `<Button>` and nothing else, so `toggleSamsloopRecord`
// recorded `delivered: false` in the audition ledger and the player saw NOTHING
// happen. A REC button that silently does nothing is indistinguishable from a
// dead one, and the ledger is a test instrument, not a surface.
//
// ⚠ WHY A NODE-KEYED REGISTRY AND NOT COMPONENT STATE. The press happens in a
// SHELL CELL (`SHELL_CELLS.samsloop['samsloop-rec-{n}'].onFire`, a plain
// callback with no component around it) and the sentence is painted by a
// DIFFERENT component (`SamsloopOutputBody`, the `fullViewBody`). There is no
// component the two share, so the refusal has to rest somewhere neither owns —
// the same argument `clipplayer-face-selection.svelte.ts` makes for a selection
// two independent cells both drive, and the #1531/#1574/#1583 rule that a
// mount must not own state that outlives it.
//
// ⚠ IT IS VIEW-LOCAL AND NEVER SYNCED. A refusal is the answer to THIS client's
// press. Writing it to `node.data` would paint a collaborator's faceplate with
// a sentence about a button they did not touch, and would put a Y.Doc write on
// a failed gesture.
//
// ⚠ WHAT IT DELIBERATELY DOES NOT DO: expire on a timer. The card's `recError`
// persisted until the next attempt, and the refusal is still TRUE until then —
// the rack is still full, the engine is still down. A self-clearing message is
// one the player can miss entirely.

import { SvelteMap } from 'svelte/reactivity';
import { patch } from '$lib/graph/store';

const refusals = new SvelteMap<string, string>();

/** The last REC refusal for `nodeId`, or null when the last press armed (or
 *  there has not been one). */
export function samsloopRecRefusal(nodeId: string): string | null {
  return refusals.get(nodeId) ?? null;
}

/**
 * Record — or clear — this node's REC refusal. `null` clears, which is what a
 * press that ARMS and a press that STOPS both do: the sentence describes the
 * last attempt, so a successful one must retire it or the face keeps showing a
 * complaint about a take that is now running.
 */
export function setSamsloopRecRefusal(nodeId: string, text: string | null): void {
  // ⚠ PRUNE FIRST, THEN WRITE — never the other way round. A prune that runs
  // AFTER the write deletes the entry it was just handed whenever the refusing
  // node is not (yet) in the store, which is a silent no-op wearing a tidy
  // name: the surface would paint nothing and the press would look dead again,
  // which is the exact defect this file exists to remove.
  pruneDeletedNodes();
  if (text === null || text.length === 0) {
    refusals.delete(nodeId);
    return;
  }
  refusals.set(nodeId, text);
}

/** Drop refusals for nodes that no longer exist.
 *
 * ⚠ ON WRITE, not as an exported hook a caller has to remember — the sibling
 * registry's note records that `dx7ForgetSelection` has never been called
 * anywhere in the tree, so an unwired cleanup export is a leak wearing a tidy
 * name. Refusing is the only event that can grow this map, so it is the only
 * place that needs to bound it. */
function pruneDeletedNodes(): void {
  for (const id of refusals.keys()) {
    if (!patch.nodes[id]) refusals.delete(id);
  }
}
