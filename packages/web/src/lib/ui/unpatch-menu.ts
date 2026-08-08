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
import { legChannelOfEdge, siblingLegIds, type StereoDef } from '$lib/graph/stereo-autowire';
import { moduleDisplayName, type AnyDef } from './port-patch-helpers';

/** The patch point the user right-clicked. */
export interface UnpatchTarget {
  nodeId: string;
  portId: string;
  direction: 'input' | 'output';
}

/** One removable cable seated on the target port. */
export interface UnpatchItem {
  /** The SEED edge id — the leg actually seated on the clicked patch point.
   *  Identity for the menu row; use `edgeIds` to remove the cable. */
  edgeId: string;
  /**
   * EVERY edge the row removes — the whole LEG GROUP. A stereo cable is two
   * ordinary edges, and removing one of them would strand the other as a leg
   * the user can no longer see once PR-4 renders the pair as one cable. One
   * entry for an ordinary mono cable, two for a stereo one.
   */
  edgeIds: string[];
  /** The OTHER end, "<Module Display Name> <PORTID>". */
  remote: string;
  /** The full menu line ("Unpatch — X Y" for an input, "Unpatch → X Y" for an
   *  output — the arrow mirrors the ←/→ direction glyphs the jack fields use),
   *  suffixed " (L only)" / " (R only)" for a lone leg (owner decision Q5). */
  label: string;
  /**
   * `left`/`right` when this cable is a SINGLE leg of a stereo pair whose other
   * leg is NOT patched — the only-L/only-R case PR-4 also renders dashed. null
   * for a complete stereo group and for an ordinary mono cable; the two are
   * deliberately not distinguished here, because neither is missing anything.
   */
  soloChannel: 'left' | 'right' | null;
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
  const defForNode = (nodeId: string): StereoDef | undefined => {
    const n = (nodes as Record<string, ModuleNode | undefined>)[nodeId];
    return n ? (defLookup(n.type) as StereoDef | undefined) : undefined;
  };

  const items: UnpatchItem[] = [];
  // A LEG GROUP must produce ONE row, not one per leg. Both legs of a
  // stereo→mono cable land on the same input port, and both legs of a
  // mono→stereo cable leave the same output port, so the naive per-edge loop
  // would list the same cable twice on exactly those two patch points.
  const seenGroups = new Set<string>();

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

    const id = e.id ?? edgeId;
    const group = [id, ...siblingLegIds(e, edges, defForNode)];
    const groupKey = [...group].sort().join('|');
    if (seenGroups.has(groupKey)) continue;
    seenGroups.add(groupKey);

    const far = target.direction === 'input' ? src : dst;
    const remote = `${moduleDisplayName(far.nodeId, nodes, defLookup)} ${String(far.portId).toUpperCase()}`;
    // A lone leg is one that HAS a side but no sibling leg patched. A complete
    // group has a side too — so the suffix keys off the group SIZE, not merely
    // off "is this port paired".
    const soloChannel = group.length === 1 ? legChannelOfEdge(e, defForNode) : null;
    const base = target.direction === 'input' ? `Unpatch — ${remote}` : `Unpatch → ${remote}`;
    items.push({
      edgeId: id,
      edgeIds: group,
      remote,
      label: soloChannel ? `${base} (${soloChannel === 'left' ? 'L' : 'R'} only)` : base,
      soloChannel,
    });
  }
  items.sort((a, b) => (a.edgeId < b.edgeId ? -1 : a.edgeId > b.edgeId ? 1 : 0));
  return {
    title: `${moduleDisplayName(target.nodeId, nodes, defLookup)} ${target.portId.toUpperCase()}`,
    items,
    allLabel: items.length > 1 ? `Unpatch all (${items.length})` : null,
  };
}
