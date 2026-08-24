// packages/web/src/lib/ui/modules/midiclock-cell-actions.ts
//
// THE CONNECT GESTURE, as a face cell — and the reason it is a cell rather than
// a body control.
//
// MIDICLOCK does nothing at all until the browser grants Web MIDI: no device is
// even VISIBLE before the grant, so all four jacks sit at rest and the module is
// inert. Until this face, the only route to that grant was the legacy card's
// button — and under the default shell an un-migrated module renders a
// `moduleShellPlaceholder` in the lane, so granting access meant opening the
// dock full view first. An `action` cell is not dock-restricted (only `panel`
// is), so ranking this key puts the gesture on the lane tile, which is where a
// player meets the module.
//
// ⚠ IT TAKES A nodeId AND RESOLVES THE ENGINE ITSELF, and that is the shipped
// idiom rather than a workaround. `ShellCellEnv.engine` is typed structurally as
// `{ write(...) }` — there is NO `read` on it — and this gesture needs a read
// (`read(node, 'card-api')`). `getActiveEngine()` is the general route and is
// already consumed from plain `.ts` by four sibling action files;
// `shell-cells.ts` names it twice as the reason an action does not need `env` at
// all. Recorded here because a platform ask to give SELECTORS the same `env`
// was drafted on the belief that `env` could read: it cannot, and the capability
// it asked for already exists.
//
// ⚠ THE LEDGER RECORD IS WRITTEN SYNCHRONOUSLY, BEFORE THE AWAIT. `connect()`
// returns a promise that can sit for up to MIDI_PROMPT_TIMEOUT_MS (8 s) when the
// browser quietly suppresses its own permission prompt — the case `midi-access`
// exists to name. `delivered` is not about that OUTCOME, it is about whether the
// press reached a callable at all, which is knowable the instant the handle
// answers the read key. A probe that waited for the grant would be asserting
// "this CI runner has MIDI hardware", which no runner does.

import { getActiveEngine } from '$lib/audio/engine-ref';
import { patch } from '$lib/graph/store';
import { recordAudition } from '$lib/ui/modules/audition-ledger';
import type { ModuleNode } from '$lib/graph/types';
import type { MidiclockApi } from '$lib/audio/modules/midiclock';

/** The live card-api handle for a midiclock node, or null when the engine is not
 *  up / the node is gone / the handle does not answer the read key. */
export function midiclockApi(nodeId: string): MidiclockApi | null {
  const engine = getActiveEngine();
  if (!engine) return null;
  const node = patch.nodes[nodeId] as ModuleNode | undefined;
  if (!node) return null;
  return (engine.read(node, 'card-api') as MidiclockApi | undefined) ?? null;
}

/**
 * Ask the browser for Web MIDI on this node's behalf.
 *
 * ⚠ RETURNS WHETHER THE SEAM WAS REACHED, and records it, for the same reason
 * `clearCloudseedTail` does: an ACTION cell writes nothing to the graph, so
 * `readParam` / `readData` are structurally blind to it and a click on a dead
 * button is indistinguishable from a click on a live one. `delivered: false` is
 * recorded, never dropped.
 */
export function midiclockConnect(nodeId: string): boolean {
  const api = midiclockApi(nodeId);
  if (!api) {
    recordAudition({ nodeId, seam: 'engine-message', delivered: false });
    return false;
  }
  recordAudition({ nodeId, seam: 'engine-message', delivered: true });
  // Fire-and-forget: `connect()` owns its own outcome reporting through the
  // subscriber, and MUST be called synchronously from the user gesture — an
  // `await` above `requestMIDIAccess` spends the user activation and Chromium
  // then refuses to prompt at all.
  void api.connect();
  return true;
}
