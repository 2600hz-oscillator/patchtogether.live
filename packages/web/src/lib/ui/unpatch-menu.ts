// unpatch-menu.ts
//
// Pure model for the RIGHT-CLICK → UNPATCH menu on a PATCH POINT.
//
// WHY: cables are only selectable objects on the FREE RACK edge layer. In the
// workflow lanes and on the flip side of a card (legacy back panel + the dock
// full-view RearCard) there is no cable to click, so a patch made FOR you (a
// lane's auto-wired POLY feed, say) had no removal affordance at all — the
// owner's report: "there's no way to break a patch right now if i put six strum
// in a lane and then want to unpatch poly".
//
// The fix is a menu on the HOLE itself, in every view that renders one. This
// module owns the DERIVATION only (which edges terminate on this port, what to
// call each of them); the surfaces dispatch a bubbling `patchpanel:jackcontextmenu`
// CustomEvent and Canvas owns the ONE menu + the ONE removal seam (the same
// LOCAL_ORIGIN `delete patch.edges[id]` transact the Backspace/edge-delete path
// uses, so undo + multiplayer convergence are inherited, not re-implemented).
//
// Framework-free (no Svelte/Yjs) so it unit-tests cleanly, exactly like
// port-patch-helpers.ts, whose moduleDisplayName it reuses so a menu line names
// a remote module the SAME way every other patch surface does.

import type { Edge, ModuleNode } from '$lib/graph/types';
import { moduleDisplayName, type AnyDef } from './port-patch-helpers';

/** The patch point the user right-clicked. */
export interface UnpatchTarget {
  nodeId: string;
  portId: string;
  direction: 'input' | 'output';
}

/** One removable cable seated on the target port. */
export interface UnpatchItem {
  /** The graph edge id — what the removal seam deletes. */
  edgeId: string;
  /** The OTHER end, "<Module Display Name> <PORTID>". */
  remote: string;
  /** The full menu line ("Unpatch — X Y" for an input, "Unpatch → X Y" for an
   *  output — the arrow mirrors the ←/→ direction glyphs the jack fields use). */
  label: string;
}

export interface UnpatchPlan {
  /** Menu header — the patch point itself, "<Module> <PORTID>". */
  title: string;
  /** One entry per seated cable, deterministically ordered by edge id (two
   *  peers, and two runs, list a fan-out in the same order). */
  items: UnpatchItem[];
  /** "Unpatch all (N)" — only for a fan-out (>1 cable); null otherwise. */
  allLabel: string | null;
}

type NodeMap = Partial<Record<string, ModuleNode>> | Record<string, ModuleNode>;
type EdgeMap = Partial<Record<string, Edge>> | Record<string, Edge>;

/**
 * Every edge terminating on `target`, as menu-ready lines.
 *
 * An INPUT normally holds ONE cable, but the list is built from the live edge
 * set rather than assuming that: a duplicate/race (or a hand-drawn cable racing
 * a reconciler-owned one) must still be fully removable, so each edge gets its
 * own line plus an "Unpatch all".
 *
 * An empty `items` means the point is UNPATCHED — callers must then show NO
 * unpatch affordance at all (the surfaces leave the right-click event
 * untouched so whatever that point already did on right-click still happens).
 */
export function buildUnpatchPlan(
  edges: EdgeMap,
  nodes: NodeMap,
  defLookup: (type: string) => AnyDef | undefined,
  target: UnpatchTarget,
): UnpatchPlan {
  const items: UnpatchItem[] = [];
  for (const [edgeId, e] of Object.entries(edges)) {
    if (!e) continue;
    const src = e.source;
    const dst = e.target;
    // Defensive: a half-formed edge must never throw here — this runs on a
    // user gesture over the LIVE store, mid-reconcile included.
    if (!src || !dst || typeof src.nodeId !== 'string' || typeof dst.nodeId !== 'string') {
      continue;
    }
    const near = target.direction === 'input' ? dst : src;
    if (near.nodeId !== target.nodeId || near.portId !== target.portId) continue;
    const far = target.direction === 'input' ? src : dst;
    const remote = `${moduleDisplayName(far.nodeId, nodes, defLookup)} ${String(far.portId).toUpperCase()}`;
    items.push({
      edgeId: e.id ?? edgeId,
      remote,
      label: target.direction === 'input' ? `Unpatch — ${remote}` : `Unpatch → ${remote}`,
    });
  }
  items.sort((a, b) => (a.edgeId < b.edgeId ? -1 : a.edgeId > b.edgeId ? 1 : 0));
  return {
    title: `${moduleDisplayName(target.nodeId, nodes, defLookup)} ${target.portId.toUpperCase()}`,
    items,
    allLabel: items.length > 1 ? `Unpatch all (${items.length})` : null,
  };
}
