// packages/web/src/lib/ui/media/node-hls.ts
//
// NODE-SCOPED hls.js ownership — the companion to node-media-registry for the
// two streaming players (PEERTUBE, TVLIBRARIAN).
//
// WHY IT IS NEEDED SEPARATELY FROM THE ELEMENT: moving the <video> into the
// node-owned registry keeps the element and its playback alive across a card
// unmount, but the hls.js instance FEEDING that element was a card-local
// `let hls`. Two consequences, both bugs:
//   1. the card's `onDestroy` called `teardownHls()`, destroying the demuxer
//      of a stream that was still playing — the same class of view-lifetime
//      teardown as revoking an object URL;
//   2. even with (1) removed, a REMOUNTED card comes up with `hls = null`,
//      so it cannot tell that an instance is already attached and would
//      happily attach a SECOND one to the same element.
// Keying the instance to the node id fixes both: a remount rehydrates, and
// teardown is registered with `nodeMedia.setDisposer` so it runs when the NODE
// dies rather than when a card moves.
//
// Typed structurally (`{ destroy(): void }`) rather than against `Hls` so this
// module carries no hls.js import and unit-tests with a fake.

/** The minimum this module needs of an hls.js instance. */
export interface DestroyableStream {
  destroy(): void;
}

const byNode = new Map<string, DestroyableStream>();

/** The instance currently attached for `nodeId`, if any. A remounting card
 *  reads this instead of assuming there is none. */
export function getNodeHls(nodeId: string): DestroyableStream | null {
  return byNode.get(nodeId) ?? null;
}

/**
 * Hand `inst` to the node. Any PREVIOUS instance for that node is destroyed
 * first — a channel/stream switch legitimately replaces the demuxer, and
 * leaking the old one would keep a socket and a worker alive per switch.
 * `null` destroys and clears.
 */
export function setNodeHls(nodeId: string, inst: DestroyableStream | null): void {
  const prev = byNode.get(nodeId);
  if (prev && prev !== inst) {
    try { prev.destroy(); } catch { /* already torn down */ }
  }
  if (inst) byNode.set(nodeId, inst);
  else byNode.delete(nodeId);
}

/** Destroy + forget the node's instance. Idempotent — safe to call from a
 *  registry disposer that may run more than once. */
export function destroyNodeHls(nodeId: string): void {
  setNodeHls(nodeId, null);
}

/** Inspection for tests. Returns the node ids holding a live instance — a
 *  PROPERTY source, never asserted on as a count. */
export function nodeHlsIds(): string[] {
  return [...byNode.keys()];
}
