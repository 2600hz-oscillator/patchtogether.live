// packages/web/src/lib/ui/modules/ptzcam-cell-actions.ts
//
// THE PTZ CAMERA'S NON-PARAM GESTURES, as one plain-TypeScript seam called by
// BOTH surfaces — the ranked `ptzcam-connect-{n}` action cell, the shell
// extension's device body, and the legacy card.
//
// ⚠ WHY CONNECT IS A CELL AND NOT A BODY BUTTON. ptzcam is inert twice over
// before this gesture: Web MIDI publishes no port until the browser consents,
// and the PT-PTZ helper is what publishes the virtual pair a camera lives
// behind. So a fresh spawn is four knobs that send nothing. An `action` cell is
// NOT dock-restricted (only `panel` is, by `panelCellKeys`), so ranking the key
// puts the gesture on the LANE TILE where the module is met — which on a module
// that does nothing until it is pressed is the single biggest thing promotion
// changes for a player. This is midiclock's argument (#2187) with a stronger
// premise, and it is why the compact rank matters: `faceTierCap` caps a
// glyph-less compact tile at 3, so a rank below 3 loses the gesture from the
// tile entirely.
//
// ⚠ IT TAKES A nodeId AND RESOLVES THE ENGINE ITSELF — the shipped idiom, not a
// workaround. `ShellCellEnv.engine` is typed structurally as `{ write(...) }`
// with no `read`, and this gesture needs `read(node, 'card-api')`.
// `getActiveEngine()` is the general route; `shell-cells.ts` names it twice as
// the reason an action does not need `env` at all.
//
// ⚠ THIS IS NOT A COPY OF `midiclockConnect`, and the difference is a MEASURED
// bug, recorded at `PtzcamCard.svelte:89-98`. `connectPtzMidi()` is APP-LEVEL —
// one sysex MIDI access for the whole app, fanned out into per-camera bindings
// — so when the engine handle for THIS node is not built yet (a click can race
// the reconciler) the gesture must still reach it. Dropping the click instead
// left the surface frozen at `idle` forever, because nothing else ever asks for
// access. So: use the handle when it exists, fall through to the app-level
// connect when it does not, and record the audition HONESTLY on both branches —
// `delivered: false` on the fallback, because the press did not reach this
// node's own seam even though it did reach the browser.
//
// ⚠ CALLED SYNCHRONOUSLY FROM THE PRESS. An `await` above `requestMIDIAccess`
// spends the user activation and Chromium then refuses to prompt at all. Both
// branches are fire-and-forget for that reason; the outcome is reported through
// the `ptzMidiVersion` store, which the body subscribes to.

import { getActiveEngine } from '$lib/audio/engine-ref';
import { patch } from '$lib/graph/store';
import { recordAudition } from '$lib/ui/modules/audition-ledger';
import { connectPtzMidi } from '$lib/audio/ptz-midi';
import type { ModuleNode } from '$lib/graph/types';
import type { PtzcamCardApi } from '$lib/audio/modules/ptzcam';

/** The live card-api handle for a ptzcam node, or null when the engine is not
 *  up / the node is gone / the handle does not answer the read key. */
export function ptzcamApi(nodeId: string): PtzcamCardApi | null {
  const engine = getActiveEngine();
  if (!engine) return null;
  const node = patch.nodes[nodeId] as ModuleNode | undefined;
  if (!node) return null;
  return (engine.read(node, 'card-api') as PtzcamCardApi | undefined) ?? null;
}

/**
 * Grant sysex Web MIDI and resolve this node's PT-PTZ binding.
 *
 * Returns whether the press reached THIS NODE's own seam. `false` means the
 * app-level fallback ran instead — the browser was still asked, so the gesture
 * is not lost, but the node's handle was not there to bind through and the
 * ledger says so rather than claiming a delivery it cannot prove.
 */
export function ptzcamConnect(nodeId: string): boolean {
  const api = ptzcamApi(nodeId);
  if (!api) {
    recordAudition({ nodeId, seam: 'engine-message', delivered: false });
    // ⚠ NOT A NO-OP ON THE FALLBACK BRANCH. `connectPtzMidi()` is app-level and
    // `resolveAll()` re-resolves every binding the moment access lands, so the
    // node's own binding comes up as soon as its handle exists. Returning early
    // here is the measured "frozen at idle forever" bug.
    void connectPtzMidi();
    return false;
  }
  recordAudition({ nodeId, seam: 'engine-message', delivered: true });
  void api.connect();
  return true;
}

/**
 * Point this node at one PT-PTZ camera pair by port NAME (`null` = the auto
 * default: whichever `PT-PTZ-…` pair resolves first).
 *
 * ⚠ THE WRITE LIVES IN THE FACTORY, not here. `selectPort` persists the choice
 * on `node.data.device` inside a LOCAL_ORIGIN transaction and re-acquires the
 * binding in one step, so the pick is undoable, syncs to rack-mates, and takes
 * effect with no UI mounted — which matters because the sysex send loop runs
 * from the scheduler tick whether or not any surface exists.
 */
export function ptzcamSelectPort(nodeId: string, name: string | null): boolean {
  const api = ptzcamApi(nodeId);
  if (!api) return false;
  api.selectPort(name);
  return true;
}
