// packages/web/src/lib/mike/driver.ts
//
// Mike's driver. Re-uses Carl's `applyIntent` for the actual Yjs writes —
// the only Mike-specific behavior is that after every `addNode` we run a
// pure `organizeLayout` pass over the patch and write back the new
// positions in the SAME ydoc.transact so the canvas stays tidy without
// flicker. This mirrors the user-visible "Organize" palette tool: Mike
// keeps the rack organized as he builds.
//
// We import Carl's driver functions rather than duplicating them because
// the underlying patch shape and the Yjs transact semantics are identical.
// Mike adds layout management on top.

import type * as Y from 'yjs';
import { LOCAL_ORIGIN } from '$lib/graph/store';
import {
  applyIntent as carlApplyIntent,
  readPatchView,
  type DriverDeps,
  type PatchLike,
} from '$lib/carl/driver';
import type { Intent } from '$lib/carl/intent';
import { organizeLayout, type Box } from '$lib/ui/canvas/organize';

export type { DriverDeps, PatchLike };
export { readPatchView };

/** Default card size used when we don't have a DOM measurement (Mike's
 *  driver runs in the leader tab BEFORE the new card has rendered, so
 *  we estimate based on the average rack card). */
const DEFAULT_CARD_W = 240;
const DEFAULT_CARD_H = 200;

/**
 * Apply one of Mike's intents. Delegates to Carl's driver for the
 * actual mutation, then for `addNode` intents runs an organize pass
 * inside the SAME ydoc.transact so the layout stays tidy without an
 * extra CRDT update.
 *
 * Returns the sleep-ms hint from the upstream applyIntent (sleep
 * intents only).
 */
export function applyIntent(deps: DriverDeps, intent: Intent): number {
  const sleep = carlApplyIntent(deps, intent);
  if (intent.kind === 'addNode') {
    organizeAll(deps);
  }
  return sleep;
}

/**
 * Run an organize pass over EVERY node in the patch (not just Mike's
 * own — the user manually calling "Organize" affects the whole rack,
 * and Mike's behavior should mirror that). Pure layout: positions
 * recomputed from current sizes via the same `organizeLayout` the
 * palette uses.
 *
 * We don't have a viewport here (driver runs outside the Canvas
 * component) so the layout falls back to its self-estimated bounding
 * box — fine for organize-as-you-build since the user is free to pan
 * the canvas afterward to see Mike's tidy column.
 */
export function organizeAll(deps: DriverDeps): void {
  const { patch, ydoc } = deps;
  const boxes: Box[] = [];
  for (const n of Object.values(patch.nodes)) {
    if (!n) continue;
    boxes.push({
      id: n.id,
      x: n.position.x,
      y: n.position.y,
      w: DEFAULT_CARD_W,
      h: DEFAULT_CARD_H,
    });
  }
  if (boxes.length === 0) return;
  const next = organizeLayout(boxes);
  const byId = new Map(next.map((p) => [p.id, p]));
  ydoc.transact(() => {
    for (const b of boxes) {
      const p = byId.get(b.id);
      if (!p) continue;
      if (Math.abs(p.x - b.x) < 0.5 && Math.abs(p.y - b.y) < 0.5) continue;
      const target = patch.nodes[b.id];
      if (target) target.position = { x: p.x, y: p.y };
    }
  }, LOCAL_ORIGIN);
}

/**
 * Bulk wipe of all of Mike's own nodes + edges. Called on "86 mike".
 * Mirror of Carl's evictCarlPatch, parameterized on idPrefix.
 */
export function evictMikePatch(deps: DriverDeps, idPrefix: string = 'mike'): void {
  const { patch, ydoc } = deps;
  const prefix = `${idPrefix}-`;
  ydoc.transact(() => {
    for (const [eid, e] of Object.entries(patch.edges)) {
      if (!e) continue;
      if (
        e.id.startsWith(prefix) ||
        e.source.nodeId.startsWith(prefix) ||
        e.target.nodeId.startsWith(prefix)
      ) {
        delete patch.edges[eid];
      }
    }
    for (const id of Object.keys(patch.nodes)) {
      if (id.startsWith(prefix)) delete patch.nodes[id];
    }
  }, LOCAL_ORIGIN);
}
