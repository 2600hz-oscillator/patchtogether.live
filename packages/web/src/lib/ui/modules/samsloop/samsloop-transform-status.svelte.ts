// WHERE A NORMALIZE / DENOISE PRESS SAYS WHAT IT DID — or why it did not.
//
// The sibling of `samsloop-rec-refusal.svelte.ts`, and a SEPARATE map rather
// than a second writer into that one, for two reasons the REC seam's own
// header makes unavoidable: it holds ONE string per node and EVERY REC press
// (arm or stop) clears it — so "sample is silent" would be wiped by an
// unrelated REC press while still true, and a REC refusal would overwrite a
// transform's. Same node-keyed, view-local, prune-first shape; same argument
// for why it is not component state (the press is a shell cell, the paint is
// the dock body, and nothing is shared between them).
//
// ⚠ EVERY ENTRY IS SIG-STAMPED, and the read takes the CURRENT signature. A
// success line describes the record it wrote; a refusal describes the sample
// that was pressed. When the sample changes underneath either — a new upload,
// a REC take, a peer's write — the line is stale by definition, and a stale
// "normalized +12 dB" over a fresh take is worse than no line. So the body
// reads `samsloopTransformStatus(nodeId, currentSig)` and the entry only
// paints while the signature it was stamped with is still the live one.
// `busy` is the one phase exempt from the check: it names an in-flight press
// on whatever the sample was, and its own completion retires it.
//
// ⚠ NOT SYNCED, NO TIMER — the REC seam's reasons, unchanged: a refusal is
// this client's answer to this client's press, and a self-clearing line is
// one the player can miss.

import { SvelteMap } from 'svelte/reactivity';
import { patch } from '$lib/graph/store';

export type SamsloopTransformPhase = 'busy' | 'done' | 'refused';

export interface SamsloopTransformStatusEntry {
  phase: SamsloopTransformPhase;
  /** The sentence the body paints. */
  text: string;
  /** `resolveSamsloopSource(d)?.signature ?? 'empty'` — of the record WRITTEN
   *  for `done`, of the sample PRESSED for `refused` / `busy`. */
  sig: string;
}

const entries = new SvelteMap<string, SamsloopTransformStatusEntry>();

/** The entry for `nodeId` if it is still about the live sample, else null. */
export function samsloopTransformStatus(
  nodeId: string,
  currentSig: string,
): SamsloopTransformStatusEntry | null {
  const e = entries.get(nodeId);
  if (!e) return null;
  if (e.phase === 'busy') return e;
  return e.sig === currentSig ? e : null;
}

/** Record — or clear (`null`) — this node's transform status. Prune FIRST,
 *  then write (the REC seam's ordering rule: a prune after the write deletes
 *  the entry it was just handed when the node is not yet in the store). */
export function setSamsloopTransformStatus(
  nodeId: string,
  entry: SamsloopTransformStatusEntry | null,
): void {
  for (const id of entries.keys()) {
    if (!patch.nodes[id]) entries.delete(id);
  }
  if (entry === null) {
    entries.delete(nodeId);
    return;
  }
  entries.set(nodeId, entry);
}
