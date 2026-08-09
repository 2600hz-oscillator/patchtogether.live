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
import { siblingLegIds, type StereoDef } from '$lib/graph/stereo-autowire';
import { stereoPairForPort, type PortDirection, type StereoPairDefLike } from '$lib/graph/stereo-pairs';
import { collapsedPairLabel } from './stereo-jack-collapse';
import { imageChannelOfEdge } from './cable-leg-groups';
import { moduleDisplayName, type AnyDef } from './port-patch-helpers';

/**
 * THE PORT LABEL THIS MENU PRINTS — the same name the JACK shows.
 *
 * A collapsed stereo jack is named from its pair's shared STEM
 * (`out_l`+`out_r` → OUT), and this menu describes cables seated on that jack,
 * so it has to agree. It used to print the raw leg id and read
 * `TIDY VCO OUT_L` / `Unpatch → cloudseed IN_L` for a COMPLETE stereo group —
 * one surface saying OUT while the jack a click away said OUT, differing only in
 * the menu. That is the card-vs-def divergence class: two surfaces, one truth,
 * no gate comparing them. `unpatch-menu.test.ts` now asserts the two agree.
 *
 * It calls `collapsedPairLabel` — the SAME function the jack uses — rather than
 * re-deriving a stem, so there is one implementation and not two that happen to
 * match today.
 *
 * ⚠ SCOPE, stated so a green run is not read as more than it is: for a port that
 * is NOT in a derived pair this returns the raw uppercased id, exactly as
 * before. That still differs from the jack for ids the verbose-label table
 * expands (a `cv_in` port renders `CV` on the jack and `CV_IN` here). Left
 * alone deliberately — it predates this menu, is not what the owner reported,
 * and changing every mono label is a wider behaviour change than this fix. The
 * test ratchets that remaining divergence rather than ignoring it.
 */
export function unpatchPortLabel(
  def: StereoDef | undefined,
  portId: string,
  direction: PortDirection,
): string {
  const pair = def ? stereoPairForPort(def as StereoPairDefLike, portId, direction) : null;
  return pair ? collapsedPairLabel(pair) : String(portId).toUpperCase();
}

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
  /**
   * The cable's CURRENT stereo mode, or null when it carries no stereo image
   * (an ordinary mono / cv / gate cable, or `rings`' timbre taps) and the
   * channel rows must not appear.
   *
   * WHY IT LIVES ON THE UNPATCH MENU. Right-clicking a PATCHED output opened
   * only this menu — `PatchPanel.onPortRowContextMenu` returns as soon as the
   * unpatch menu claims the event — so "patch only L / only R" was reachable
   * ONLY on an unpatched output. The owner's expectation (right-click an output,
   * get the option) is the correct one, so the rows come HERE for a live cable
   * rather than the patched case being special-cased away.
   *
   * `both` for a complete leg group, `left`/`right` for a lone leg — the same
   * fact as `soloChannel`, expressed as the control's current value so the menu
   * can render a radio group without re-deriving it.
   */
  channelMode: 'both' | 'left' | 'right' | null;
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
    const farDirection: PortDirection = target.direction === 'input' ? 'output' : 'input';
    const remote = `${moduleDisplayName(far.nodeId, nodes, defLookup)} ${unpatchPortLabel(
      defForNode(far.nodeId),
      far.portId,
      farDirection,
    )}`;
    // A lone leg is one that HAS a side but no sibling leg patched. A complete
    // group has a side too — so the suffix keys off the group SIZE, not merely
    // off "is this port paired".
    //
    // ⚠ AND the side must be a real stereo IMAGE — `imageChannelOfEdge`, NOT
    // `legChannelOfEdge`. The latter reads the WIRING pair list, so a lone
    // `rings.odd` cable (odd/even is a declared pair but COLLAPSE_EXEMPT — two
    // different timbre taps) comes back 'left' and would be labelled "(L only)"
    // about a jack the UI calls ODD. The shared helper is the SAME one the
    // dashed only-L/R cable uses, so the two surfaces cannot drift.
    const imageChannel = imageChannelOfEdge(e, defForNode);
    const soloChannel = group.length === 1 ? imageChannel : null;
    // The control's current value: a complete group is `both`, a lone leg is
    // the side it carries, and a cable with no stereo image gets no rows.
    const channelMode: UnpatchItem['channelMode'] =
      imageChannel === null ? null : group.length > 1 ? 'both' : imageChannel;
    const base = target.direction === 'input' ? `Unpatch — ${remote}` : `Unpatch → ${remote}`;
    items.push({
      edgeId: id,
      edgeIds: group,
      remote,
      label: soloChannel ? `${base} (${soloChannel === 'left' ? 'L' : 'R'} only)` : base,
      soloChannel,
      channelMode,
    });
  }
  items.sort((a, b) => (a.edgeId < b.edgeId ? -1 : a.edgeId > b.edgeId ? 1 : 0));
  return {
    // The header names the JACK, so it uses the same collapsed label the jack
    // itself shows — it read `TIDY VCO OUT_L` for a port whose jack says `OUT`.
    title: `${moduleDisplayName(target.nodeId, nodes, defLookup)} ${unpatchPortLabel(
      defForNode(target.nodeId),
      target.portId,
      target.direction,
    )}`,
    items,
    allLabel: items.length > 1 ? `Unpatch all (${items.length})` : null,
  };
}
