// packages/web/src/lib/ui/modules/vst-cell-actions.ts
//
// The VST BRIDGE faceplates' two ACTION seams — CONNECT and DISCONNECT — kept
// out of `shell-cells.ts` so the shared registry imports one file per module
// rather than the module's whole world. ONE file serves BOTH `vstInstrument`
// and `vstFx`: the gestures are identical and the only thing that differs
// between them (`sendPlanes`) is derived from the node's own type.
//
// ⚠ THE ACTIONS TAKE A `nodeId` AND RESOLVE THE ENGINE THEMSELVES. That is the
// shipped idiom, not a workaround: `ShellCellEnv.engine` is typed structurally
// as `{ write(...) }` with no `read`, and `shell-cells.ts` names
// `getActiveEngine()` twice as the reason an `action` cell needs no `env` at
// all. The SAMPLE RATE has to come off the live engine, and getting it wrong is
// not cosmetic: `bridge-owner` starts the bridge at the rate passed here and the
// helper renders at `hello.rate`, so a mismatch resamples the ring by accident.
//
// ⚠ WHY THE OBSERVABLE IS THE AUDITION LEDGER. Neither gesture writes a param or
// a `node.data` key — the connection lives in a module-level registry keyed by
// node id (`$lib/audio/vst/bridge-owner`), on GRAPH lifetime — so `readParam`
// and `readData` are structurally blind to both. A `data` probe would pass on a
// dead button. The ledger records whether the press reached a callable at all,
// and `delivered: false` is RECORDED rather than dropped, so "never pressed" and
// "pressed and reached nothing" stay distinguishable.
//
// ⚠ AND `delivered` HERE MEANS "REACHED THE OWNER", NOT "THE HELPER ANSWERED".
// No CI runner has a vst-bridge process listening on ws://127.0.0.1:9309, and a
// probe that waited for a connection would be asserting the runner owns a macOS
// helper app and a library of AU plugins. What is knowable synchronously is
// whether the engine is up and this node is in the graph, which is exactly the
// seam a dead button would fail at.

import { getActiveEngine } from '$lib/audio/engine-ref';
import { patch } from '$lib/graph/store';
import { recordAudition } from '$lib/ui/modules/audition-ledger';
import type { ModuleNode } from '$lib/graph/types';
import { vstSendPlanesForType } from '$lib/audio/modules/vst-bridge-shared';
import { restartVstBridge, stopVstBridge } from '$lib/audio/vst/bridge-owner';

/**
 * The engine's AudioContext rate, which is the ONLY rate this bridge may run
 * at. Falls back to 48 kHz when the engine is not up — the same default
 * `VstInstrumentCard` / `VstFxCard` use, and unreachable in practice because a
 * press that gets this far has already resolved a live engine.
 */
function engineSampleRate(): number {
  const audio = getActiveEngine()?.getDomain?.('audio') as { ctx?: AudioContext } | undefined;
  return audio?.ctx?.sampleRate ?? 48000;
}

/** The node, or undefined when it has left the graph under the press. */
function vstNode(nodeId: string): ModuleNode | undefined {
  return patch.nodes[nodeId] as ModuleNode | undefined;
}

/**
 * Open this card's connection to the vst-bridge helper (or restart a live one at
 * the current rate).
 *
 * `restartVstBridge` is deliberately not conditional on there BEING a
 * connection: on a node with no entry it calls `acquireVstBridge` instead,
 * because "Connect must CONNECT — silently doing nothing here is half of what
 * made the es9 button look dead" (`bridge-owner.ts`). It is also the documented
 * recovery path from `evicted`, which is the state another tab's hello puts this
 * card in.
 *
 * ⚠ `clientId` IS THE NODE ID, and that is load-bearing rather than a
 * convenience: it is what lets the helper PARK this card's plugin instance and
 * re-adopt it on the next page load, so a reconnect from this button recovers
 * the running plugin instead of opening an empty second one.
 */
export function vstConnect(nodeId: string): boolean {
  const node = vstNode(nodeId);
  const engine = getActiveEngine();
  if (!node || !engine) {
    recordAudition({ nodeId, seam: 'engine-message', delivered: false });
    return false;
  }
  recordAudition({ nodeId, seam: 'engine-message', delivered: true });
  restartVstBridge(nodeId, engineSampleRate(), {
    clientId: nodeId,
    sendPlanes: vstSendPlanesForType(node.type),
  });
  return true;
}

/**
 * Drop this card's link without deleting the node. Idempotent by construction —
 * `client.stop()` on an already-stopped client is a no-op — and it deliberately
 * does NOT release the owner entry, so the node still owns the connection and
 * CONNECT reaches the same client (and therefore the same SharedArrayBuffer
 * rings the worklet already holds) rather than opening a second one.
 */
export function vstDisconnect(nodeId: string): boolean {
  const node = vstNode(nodeId);
  const engine = getActiveEngine();
  if (!node || !engine) {
    recordAudition({ nodeId, seam: 'engine-message', delivered: false });
    return false;
  }
  recordAudition({ nodeId, seam: 'engine-message', delivered: true });
  stopVstBridge(nodeId);
  return true;
}
