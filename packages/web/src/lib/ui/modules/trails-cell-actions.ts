// packages/web/src/lib/ui/modules/trails-cell-actions.ts
//
// THE BELA TRAILS' NON-PARAM GESTURES, as one plain-TypeScript seam called by
// BOTH surfaces — the ranked `trails-connect-{n}` action cell, the shell
// extension's pad body, and the legacy `TrailsCard.svelte`.
//
// ⚠ WHY CONNECT IS A CELL AND NOT A BODY BUTTON. trails is INERT until this
// gesture: Web MIDI publishes no port at all until the browser consents, so a
// fresh spawn is three knobs over twenty-one jacks that emit a flat zero. An
// `action` cell is NOT dock-restricted (only `panel` is, by `panelCellKeys`),
// so ranking the key puts the gesture on the LANE TILE where the module is met.
// `faceTierCap` caps a glyph-less compact tile at 3 cells
// (`LANE_ROW_MAX_CELLS`), so the RANK is load-bearing rather than cosmetic: a
// rank below 3 puts the only gesture that makes the module work at all behind
// the dock full view, which is the exact defect midiclock's promotion (#2187)
// existed to fix.
//
// ⚠ IT TAKES A nodeId AND RESOLVES THE ENGINE ITSELF — the shipped idiom, not a
// workaround. `ShellCellEnv.engine` is typed structurally as `{ write(...) }`
// with no `read`, and this gesture needs `read(node, 'card-api')`.
// `getActiveEngine()` is the general route, and `ptzcam-cell-actions.ts` is the
// file this one is modelled on.
//
// ⚠ THE FALLBACK BRANCH IS NOT COSMETIC, and it is the ptzcam measurement
// applying unchanged here: `connectTrails()` is APP-LEVEL — one Web MIDI access
// for the whole app, fanned out to every `trails` node — so when this node's
// engine handle is not built yet (a click can race the reconciler) the gesture
// must still reach the browser. Dropping the click instead is the measured
// "frozen at idle forever" bug, because nothing else in the rack ever asks for
// access. So: use the handle when it exists, fall through to the app-level
// connect when it does not, and record the audition HONESTLY on both branches —
// `delivered: false` on the fallback, because the press did not reach THIS
// node's own seam even though it did reach the browser.
//
// ⚠ CALLED SYNCHRONOUSLY FROM THE PRESS. An `await` above `requestMIDIAccess`
// spends the user activation and Chromium then refuses to prompt at all — the
// constraint `TrailsCard.svelte:96-104` and `trails-device.ts` both state. Both
// branches are fire-and-forget for that reason; the outcome is reported through
// the `trailsMidiVersion` store, which both bodies subscribe to.

import { getActiveEngine } from '$lib/audio/engine-ref';
import { patch } from '$lib/graph/store';
import { recordAudition } from '$lib/ui/modules/audition-ledger';
import { connectTrails } from '$lib/midi/trails-device';
import type { ModuleNode } from '$lib/graph/types';
import type { TrailsCardApi } from '$lib/audio/modules/trails';

/** The live card-api handle for a trails node, or null when the engine is not
 *  up / the node is gone / the handle does not answer the read key. */
export function trailsApi(nodeId: string): TrailsCardApi | null {
  const engine = getActiveEngine();
  if (!engine) return null;
  const node = patch.nodes[nodeId] as ModuleNode | undefined;
  if (!node) return null;
  return (engine.read(node, 'card-api') as TrailsCardApi | undefined) ?? null;
}

/**
 * Grant Web MIDI and bind every attached Bela Trails.
 *
 * Returns whether the press reached THIS NODE's own seam. `false` means the
 * app-level fallback ran instead — the browser was still asked, so the gesture
 * is not lost, but the node's handle was not there to bind through and the
 * ledger says so rather than claiming a delivery it cannot prove.
 */
export function trailsConnect(nodeId: string): boolean {
  const api = trailsApi(nodeId);
  if (!api) {
    recordAudition({ nodeId, seam: 'engine-message', delivered: false });
    // ⚠ NOT A NO-OP ON THE FALLBACK BRANCH — see the header.
    void connectTrails();
    return false;
  }
  recordAudition({ nodeId, seam: 'engine-message', delivered: true });
  void api.connect();
  return true;
}

/**
 * Zero the MIDI monitor's tallies for this node.
 *
 * ⚠ IT ZEROES THE LOOP COUNTERS TOO, and that is deliberate rather than a side
 * effect: the `loops N · edges a/b/c/d` line is read as a RATIO between two
 * counters that must advance together, and a ratio against a vanished baseline
 * is worse than no reset at all. `createTrailsMonitor().reset()` and the
 * factory's own counters are cleared in one call, which is what gives a player
 * a clean window to count a single gesture over.
 *
 * NOT a cell: it is meaningful only while the MON panel is open, so it lives on
 * the dock body beside the panel it clears (§4.3 of the spec package — the
 * lane's 112 px body budget cannot carry the panel, and a reset button with no
 * readout beside it clears something the player cannot see).
 */
export function trailsResetMonitor(nodeId: string): boolean {
  const api = trailsApi(nodeId);
  if (!api) return false;
  api.resetMonitor();
  return true;
}
