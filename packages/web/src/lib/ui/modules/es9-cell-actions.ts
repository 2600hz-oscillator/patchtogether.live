// packages/web/src/lib/ui/modules/es9-cell-actions.ts
//
// The ES-9 faceplate's two ACTION seams — CONNECT and DISCONNECT — kept out of
// `shell-cells.ts` so the shared registry imports one file per module rather
// than the module's whole world.
//
// ⚠ THE ACTIONS TAKE A `nodeId` AND RESOLVE THE ENGINE THEMSELVES. That is the
// shipped idiom, not a workaround: `ShellCellEnv.engine` is typed structurally
// as `{ write(...) }` with no `read`, and `shell-cells.ts` names `getActiveEngine()`
// twice as the reason an `action` cell needs no `env` at all. es9 barely needs
// even that — `bridge-owner`'s functions are keyed by node id — but the SAMPLE
// RATE does have to come off the live engine, and getting it wrong is not a
// cosmetic error: the bridge must be started at the SAME rate the worklet runs
// at or the ring is resampled by accident.
//
// ⚠ WHY THE OBSERVABLE IS THE AUDITION LEDGER. Neither gesture writes a param
// or a `node.data` key — the connection lives in a module-level registry keyed
// by node id (`$lib/audio/es9/bridge-owner`), on GRAPH lifetime — so
// `readParam` and `readData` are structurally blind to both. A `data` probe
// would pass on a dead button. The ledger records whether the press reached a
// callable at all, and `delivered: false` is RECORDED rather than dropped, so
// "never pressed" and "pressed and reached nothing" stay distinguishable.
//
// ⚠ AND `delivered` HERE MEANS "REACHED THE OWNER", NOT "THE HARDWARE ANSWERED".
// No CI runner has an es9-bridge process listening on ws://127.0.0.1:9209, and
// a probe that waited for a connection would be asserting the runner owns an
// Expert Sleepers interface. What is knowable synchronously is whether the
// engine is up and this node is in the graph, which is exactly the seam a dead
// button would fail at.

import { getActiveEngine } from '$lib/audio/engine-ref';
import { patch } from '$lib/graph/store';
import { recordAudition } from '$lib/ui/modules/audition-ledger';
import type { ModuleNode } from '$lib/graph/types';
import { es9BridgeConfig } from '$lib/audio/modules/es9';
import { restartEs9Bridge, stopEs9Bridge } from '$lib/audio/es9/bridge-owner';

/**
 * The engine's AudioContext rate, which is the ONLY rate the bridge may run
 * at. Falls back to 48 kHz when the engine is not up — the same default the
 * legacy card used, and unreachable in practice because a press that gets this
 * far has already resolved a live engine.
 */
function engineSampleRate(): number {
  const audio = getActiveEngine()?.getDomain?.('audio') as { ctx?: AudioContext } | undefined;
  return audio?.ctx?.sampleRate ?? 48000;
}

/** The node, or undefined when it has left the graph under the press. */
function es9Node(nodeId: string): ModuleNode | undefined {
  return patch.nodes[nodeId] as ModuleNode | undefined;
}

/**
 * Bring the hardware link up (or restart a live one at the current rate).
 *
 * `restartEs9Bridge` is deliberately not conditional on there BEING a
 * connection: on a node with no entry it calls `acquireEs9Bridge` instead,
 * because "Connect must CONNECT — silently doing nothing here is half of what
 * made the button look dead" (`bridge-owner.ts`).
 */
export function es9Connect(nodeId: string): boolean {
  const node = es9Node(nodeId);
  const engine = getActiveEngine();
  if (!node || !engine) {
    recordAudition({ nodeId, seam: 'engine-message', delivered: false });
    return false;
  }
  recordAudition({ nodeId, seam: 'engine-message', delivered: true });
  restartEs9Bridge(nodeId, engineSampleRate(), es9BridgeConfig(node.params));
  return true;
}

/**
 * Drop the link without deleting the node. Idempotent by construction —
 * `client.stop()` on an already-stopped client is a no-op — and it deliberately
 * does NOT release the owner entry, so the node still owns the connection and
 * CONNECT reaches the same client rather than opening a second one (the native
 * app accepts exactly one).
 */
export function es9Disconnect(nodeId: string): boolean {
  const node = es9Node(nodeId);
  const engine = getActiveEngine();
  if (!node || !engine) {
    recordAudition({ nodeId, seam: 'engine-message', delivered: false });
    return false;
  }
  recordAudition({ nodeId, seam: 'engine-message', delivered: true });
  stopEs9Bridge(nodeId);
  return true;
}
