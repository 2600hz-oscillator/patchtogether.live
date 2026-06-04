// packages/web/src/lib/graph/toybox-cv-routes.ts
//
// TOYBOX Phase 5 — Yjs mutator for the CV routing map (node.data.cvRoutes).
//
// The card's CV tab edits which addressed param each generic cv pool port
// (cv1..cv8) drives. Every edit writes node.data.cvRoutes through the patch
// proxy inside a single LOCAL_ORIGIN transaction; the video factory reads the
// live map each time a cv sample arrives (modules/toybox.ts → applyCvRoute).
//
// CRITICAL (same in-place trap as toybox-combine.ts / control-surface /
// [[yjs-save-load-real-ydoc]]): mutate cvRoutes IN PLACE — SET a single key on
// the live map object, never rebuild-and-reassign the whole map (which would
// re-integrate already-synced Y types → Yjs "Type already integrated"). The
// cvRoutes map is a flat Record<portId, target|null>; setting one port's value
// to a fresh plain object (or null to clear) integrates cleanly.

import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
import type { CvRoutes, CvRouteTarget } from '$lib/video/toybox-cv-routes';

/** Run `fn` against the node's live cvRoutes map inside a Yjs transaction,
 *  creating an empty map in place first if absent. */
function mutateCvRoutes(nodeId: string, fn: (routes: CvRoutes) => void): void {
  ydoc.transact(() => {
    const target = patch.nodes[nodeId];
    if (!target) return;
    if (!target.data) (target as { data: Record<string, unknown> }).data = {};
    const data = target.data as { cvRoutes?: CvRoutes };
    if (!data.cvRoutes || typeof data.cvRoutes !== 'object') {
      data.cvRoutes = {} as CvRoutes;
    }
    fn(data.cvRoutes);
  }, LOCAL_ORIGIN);
}

/** Read a node's live cvRoutes map (empty object when absent). */
export function readCvRoutes(node: { data?: unknown } | undefined): CvRoutes {
  const d = node?.data as { cvRoutes?: CvRoutes } | undefined;
  return d?.cvRoutes && typeof d.cvRoutes === 'object' ? d.cvRoutes : {};
}

/**
 * Set the route for one generic cv port (cv1..cv8). Pass a target to route it,
 * or null to clear it. Writes a NEW plain object for the value (in place) so the
 * Yjs map integrates a fresh entry rather than reassigning a live Y type.
 */
export function setCvRoute(
  nodeId: string,
  portId: string,
  target: CvRouteTarget | null,
): void {
  mutateCvRoutes(nodeId, (routes) => {
    if (target === null) {
      routes[portId] = null; // clear in place
      return;
    }
    // Set a fresh plain object (never spread an existing live Y entry).
    routes[portId] = {
      target: target.target,
      ...(target.layer !== undefined ? { layer: target.layer } : {}),
      ...(target.nodeId !== undefined ? { nodeId: target.nodeId } : {}),
      param: target.param,
    };
  });
}

/** Clear a generic cv port's route (in place). */
export function clearCvRoute(nodeId: string, portId: string): void {
  setCvRoute(nodeId, portId, null);
}
