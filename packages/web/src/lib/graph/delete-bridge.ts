// packages/web/src/lib/graph/delete-bridge.ts
//
// BRIDGE-ON-DELETE (#1821) — deleting a pass-through module MAINTAINS the chain.
//
// Owner, 2026-08-17:
//
//   "if a module with both a single video in, and a single video out, is deleted
//    from a chain which has other modules -- we should make the patch. for now
//    only video output needs to support this. so if a backdraft is patched
//    through a video output into a sourcery, and i delete the video output, now
//    backdraft out is patched to sourcery."
//
// PURE. No Yjs, no DOM, no registry — it takes the node id, the live node/edge
// snapshots and a def resolver, and returns a PLAN. `mutate.ts` applies it. That
// split is what lets every case below (self-patch, fan-out, an illegal bridge)
// be pinned in the unit lane without a document.
//
// ── THE CONDITION IS DERIVED, THE SCOPE IS DECLARED ──────────────────────────
//
// Two separate questions, deliberately answered by two separate mechanisms:
//
//   * "IS this module a pass-through?" is DERIVED from its own ports —
//     exactly one video input and exactly one video output, read through
//     `videoPortsOf` (the same lattice-derived predicate the drop gesture
//     uses). No module name appears in that half. Widening the behaviour to
//     every 1-in/1-out module later is deleting a scope entry, not a rewrite.
//
//   * "MAY this module bridge?" is a NAMED, deny-by-default scope
//     (`BRIDGE_ON_DELETE`), because the owner scoped it: "for now only video
//     output needs to support this." Each entry carries its `why` in the TYPE,
//     so an undeclared entry does not compile, and `delete-bridge.test.ts`
//     anchors every name to a live def AND to the derived condition — an entry
//     whose module stops being 1-in/1-out is RED rather than silently inert.
//
// ── THE FOUR CASES THAT ARE NOT "JOIN THE TWO ENDS" ──────────────────────────
//
//  1. ONE SIDE FREE. The precondition is BOTH sides patched. Input patched and
//     output free (or the reverse) is an ORDINARY delete — there is no chain to
//     maintain, and inventing one would patch two modules the user never
//     connected.
//
//  2. SELF-PATCH (owner: "the only case where this doesn't work is a video
//     output module that is patched to itself. that's a silly edge case but we
//     need to make sure it is also handled"). The node's own `out` feeds its own
//     `in`. Both sides read as patched, but the upstream IS the node and so is
//     the downstream: joining them yields a self-edge on a node that no longer
//     exists, or an orphan. DETECTED and demoted to a plain delete. It is
//     detected on the EDGE, not on the port pair, so a node that is
//     simultaneously self-patched AND fed from upstream still bridges the real
//     pair (see the test — that combination is legal and not obviously so).
//
//  3. FAN-OUT. An output port may feed MANY targets. The bridge therefore
//     produces ONE new edge PER downstream target: it ADDS, and the siblings
//     that were already fed by the upstream source are untouched. (`removeEdges`
//     lists only the doomed node's own cables — the applicator deletes exactly
//     those, never a third party's.)
//
//  4. AN ILLEGAL BRIDGE. The joined pair must still satisfy the cable lattice
//     (mono ⊑ colour, still ⊑ animated, via `validateEdge` → `canConnectToPort`).
//     A pass-through can be WIDER than what its upstream emits — patch a
//     `mono-video` source through an OUTPUT into a `video`-only input and the
//     upcast happens at the OUTPUT, so joining the ends directly is a narrower
//     cable than the target accepts. Those candidates are REFUSED, kept in
//     `refused` with the validator's own reason, and the delete proceeds without
//     them. Refusing is not the same as silently dropping: the applicator
//     surfaces the reasons, and the node still goes away, which is what the user
//     asked for.

import type { Edge, ModuleNode } from '$lib/graph/types';
import { videoPortsOf, type DropDefLike, type DropPortLike } from '$lib/ui/patch-drop/drop-plan';
import { validateEdge, type ResolveDef, type ValidatorDef } from '$lib/graph/validate-edge';
import { audioEdgeId } from '$lib/graph/stereo-autowire';

/**
 * The def shape this planner needs: enough for `validateEdge` (declared ports,
 * with their cable types) AND enough for `videoPortsOf` (the same ports, read
 * as the drop layer reads them). ONE resolver parameter rather than two, so a
 * caller cannot hand the two halves disagreeing registries.
 */
export type BridgeDefLike = ValidatorDef & DropDefLike;

/** `(type) => def`, satisfying both readers. Callers pass the existing
 *  `getModuleDef(t) ?? getVideoModuleDef(t) ?? getMetaModuleDef(t)` chain. */
export type BridgeResolveDef = (type: string) => BridgeDefLike | undefined;

/** One module type the owner has scoped INTO bridge-on-delete. */
export interface BridgeOnDeleteEntry {
  /** The registered module type id. Anchored to a live def by the test. */
  type: string;
  /**
   * WHY this type bridges. Required BY THE TYPE, so the undeclared form does
   * not compile — the `why`-in-the-type shape, not a comment a later edit can
   * drift away from.
   */
  why: string;
}

/**
 * THE SCOPE — deny by default, one entry, the owner's own words as its `why`.
 *
 * ⚠ This is NOT the condition. A type listed here still has to SATISFY the
 * derived 1-video-in / 1-video-out shape before anything bridges; the list only
 * says which of the modules that DO satisfy it are allowed to. Widening is
 * deleting the filter, not writing new logic.
 */
export const BRIDGE_ON_DELETE: readonly BridgeOnDeleteEntry[] = [
  {
    type: 'videoOut',
    why:
      'the MONITOR in the middle of a chain. Owner 2026-08-17: "for now only video output needs to '
      + 'support this" — it is the module a player drops in to LOOK at a signal and pulls back out, '
      + 'so deleting it should leave the chain it was auditing intact rather than cut in two.',
  },
] as const;

const SCOPED_TYPES: ReadonlySet<string> = new Set(BRIDGE_ON_DELETE.map((e) => e.type));

/** A bridge candidate that the cable lattice refuses, with the validator's own
 *  reason — surfaced rather than silently dropped. */
export interface RefusedBridge {
  /** The upstream endpoint that would have fed it. */
  source: { nodeId: string; portId: string };
  /** The downstream endpoint that would have received it. */
  target: { nodeId: string; portId: string };
  /** `validateEdge`'s reason string, verbatim. */
  reason: string;
}

/** The plan `removePatchNodeBridging` applies, in ONE transaction. */
export interface DeleteBridgePlan {
  /**
   * Exactly the doomed node's own cables — the edges the delete will remove.
   *
   * ⚠ IT IS AN OBSERVABLE, NOT AN INSTRUCTION. No applicator reads it: both
   * delete paths remove edges themselves (`removePatchNode`'s brute scan, and
   * `handleDelete`'s own loop), because there must be ONE delete primitive
   * rather than a second list that can disagree with it. What it is FOR is the
   * assertion `delete-bridge.test.ts` makes with it — that a bridge never
   * claims a THIRD PARTY's cable, which is the fan-out failure mode and is
   * invisible from `bridgeEdges` alone.
   */
  removeEdgeIds: string[];
  /** New edges joining upstream directly to each downstream target. */
  bridgeEdges: Edge[];
  /** Candidates the lattice refused (the chain is cut there, deliberately). */
  refused: RefusedBridge[];
}

/** The single video input + single video output of a pass-through, or null. */
function passThroughPorts(
  def: DropDefLike | undefined,
): { input: DropPortLike; output: DropPortLike } | null {
  if (!def) return null;
  const ins = videoPortsOf(def, 'inputs');
  const outs = videoPortsOf(def, 'outputs');
  // DERIVED, and both halves matter: exactly one of each. A module with two
  // video inputs has no unambiguous "the" upstream to re-home.
  //
  // ⚠ WIDENING HAZARD, stated because the header claims widening is cheap. This
  // counts VIDEO ports only, so a future `BRIDGE_ON_DELETE` entry for a module
  // with 1 video-in / 1 video-out PLUS an audio or gate port would qualify — and
  // its non-video cables would be dropped by the delete with no bridge and no
  // `refused` entry to say so. "Deleting a scope entry, not a rewrite" holds for
  // a video-PURE def (videoOut is one: `inputs` and `outputs` are each a single
  // video port). Anything else needs this predicate widened first.
  if (ins.length !== 1 || outs.length !== 1) return null;
  return { input: ins[0]!, output: outs[0]! };
}

/**
 * Is `type` eligible to bridge on delete?
 *
 * BOTH halves, in this order: the DECLARED scope, then the DERIVED shape. The
 * test asserts both directions — a scoped type that stops being a pass-through
 * reddens, and so does a `BRIDGE_ON_DELETE` name with no live def.
 */
export function bridgesOnDelete(type: string, def: DropDefLike | undefined): boolean {
  if (!SCOPED_TYPES.has(type)) return false;
  return passThroughPorts(def) !== null;
}

/**
 * Plan the delete of `nodeId`.
 *
 * Returns `null` when the delete is ORDINARY — the caller falls through to the
 * plain `removePatchNode` path with no behaviour change at all. `null` covers:
 * an out-of-scope type, a node that is not a 1-in/1-out pass-through, either
 * side unpatched, and the SELF-PATCH case.
 *
 * A non-null plan always removes the node's own edges; `bridgeEdges` may be
 * empty when every candidate was refused by the lattice, and `refused` says why.
 */
export function planDeleteBridge(
  nodeId: string,
  nodes: readonly ModuleNode[],
  edges: readonly (Edge | undefined)[],
  resolveDef: BridgeResolveDef,
): DeleteBridgePlan | null {
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) return null;

  const def = resolveDef(node.type);
  if (!bridgesOnDelete(node.type, def)) return null;
  const ports = passThroughPorts(def);
  if (!ports) return null;

  // The doomed node's own cables — every edge with either endpoint on it. This
  // is the same brute scan `removePatchNode` does, hoisted so the plan owns it
  // and the applicator writes exactly one set.
  const own: Edge[] = [];
  for (const e of edges) {
    if (!e) continue;
    if (e.source.nodeId === nodeId || e.target.nodeId === nodeId) own.push(e);
  }

  // ⚠ SELF-PATCH IS DETECTED ON THE EDGE. A cable whose BOTH endpoints are this
  // node is the owner's silly case; it makes "upstream" and "downstream" name
  // the node itself, so there is no pair to join. Fall back to a plain delete.
  const selfPatched = own.some((e) => e.source.nodeId === nodeId && e.target.nodeId === nodeId);
  if (selfPatched) return null;

  // UPSTREAM: the cable arriving at the one video input. An input holds at most
  // one cable (single-owner occupancy is enforced by every writer), so `find`
  // is the whole story; if a second ever appeared, taking the first is still
  // the same choice the engine makes.
  const upstream = own.find(
    (e) => e.target.nodeId === nodeId && e.target.portId === ports.input.id,
  );
  // DOWNSTREAM: every cable leaving the one video output. FAN-OUT lives here.
  const downstream = own.filter(
    (e) => e.source.nodeId === nodeId && e.source.portId === ports.output.id,
  );

  // BOTH sides patched, or this is an ordinary delete.
  if (!upstream || downstream.length === 0) return null;

  const removeEdgeIds = own.map((e) => e.id);
  const bridgeEdges: Edge[] = [];
  const refused: RefusedBridge[] = [];
  // The node is GONE by the time the bridge lands, so validate against the
  // surviving set — otherwise a candidate could "pass" against a graph the
  // applicator is about to change out from under it.
  const survivors = nodes.filter((n) => n.id !== nodeId);
  const seen = new Set<string>();

  // ⚠ THE CABLE TYPES ARE RE-DERIVED FROM THE LIVE DEFS, not carried off the
  // two edges being replaced — the discipline `commitConvenienceEdges` already
  // follows. `validateEdge` re-derives them for the LEGALITY check regardless,
  // so carrying them would only affect what is STORED; and a stored type is
  // exactly the thing that goes stale when a saved patch is loaded against a def
  // whose port type has since changed. Falls back to the old edge's value when a
  // port cannot be resolved, so a graph this planner does not fully understand
  // degrades rather than writing `undefined`.
  const upDef = resolveDef(nodes.find((n) => n.id === upstream.source.nodeId)?.type ?? '');
  const upPortType =
    upDef?.outputs?.find((o) => o.id === upstream.source.portId)?.type ?? upstream.sourceType;

  for (const dn of downstream) {
    // ⚠ THE SELF-PATCH CLASS IS TWO CASES, NOT ONE, and the guard above only
    // catches the first. A 1-node cycle (`OUT.out → OUT.in`) is the owner's
    // "silly edge case" and is refused up there. A 2-NODE cycle is not:
    // `A.out → B.in` and `B.out → A.in`, delete A, and the ends to be joined are
    // `B.out` and `B.in` — neither cable has both endpoints on A, so the guard
    // above sees nothing. `validateEdge` does not reject a self-edge either (it
    // resolves the two endpoints and asks the cable lattice, which is happy), so
    // the bridge would land B SELF-PATCHED by a delete that never asked to
    // rewire it. Refused per candidate, because in a fan-out only SOME targets
    // may be the upstream itself.
    if (dn.target.nodeId === upstream.source.nodeId) {
      refused.push({
        source: { ...upstream.source },
        target: { ...dn.target },
        reason: `bridging would self-patch ${dn.target.nodeId} (the chain is a cycle through the deleted node)`,
      });
      continue;
    }
    const dnDef = resolveDef(nodes.find((n) => n.id === dn.target.nodeId)?.type ?? '');
    const dnPortType =
      dnDef?.inputs?.find((i) => i.id === dn.target.portId)?.type ?? dn.targetType;
    const candidate: Edge = {
      id: audioEdgeId(upstream.source.nodeId, upstream.source.portId, dn.target.nodeId, dn.target.portId),
      source: { ...upstream.source },
      target: { ...dn.target },
      sourceType: upPortType as Edge['sourceType'],
      targetType: dnPortType as Edge['targetType'],
    };
    // A fan-out that lands twice on the same target port would write the same
    // deterministic id twice — dedupe rather than emit a duplicate.
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);

    const verdict = validateEdge(candidate, survivors, resolveDef);
    if (verdict.ok) {
      bridgeEdges.push(candidate);
    } else {
      refused.push({
        source: candidate.source,
        target: candidate.target,
        reason: verdict.reason ?? 'refused',
      });
    }
  }

  return { removeEdgeIds, bridgeEdges, refused };
}
