// packages/web/src/lib/carl/driver.ts
//
// In-browser Intent applier. Mirrors e2e/chaos/lib/driver.ts but writes
// directly against the SyncedStore proxy (`patch`) inside a Y.Doc
// transaction so the mutation propagates through Yjs to all rack-mates.
//
// LOCAL_ORIGIN is intentionally used as the transact origin so Carl's
// writes flow through the same UndoManager-tracked code path the user
// would take from the palette. The leader tab can Cmd-Z Carl's
// mutations — which is the correct behavior since the leader is acting
// on behalf of the spawner.

import type * as Y from 'yjs';
import { LOCAL_ORIGIN } from '$lib/graph/store';
import type { ModuleNode, Edge } from '$lib/graph/types';
import { expandLegGroups, planAudioCommit, type StereoDef } from '$lib/graph/stereo-autowire';
import { getModuleDef } from '$lib/audio/module-registry';
import { getVideoModuleDef } from '$lib/video/module-registry';
import type { Intent } from './intent';
import type { PersonalityPatchView } from './personality';

/**
 * SyncedStore proxies expose properties as `T | undefined` (the inferred
 * MappedTypeDescription shape) rather than the raw `Record<string, T>`
 * we'd write to in plain JS. We use a structural alias so callers can
 * pass either the raw `PatchStore` (in tests via createPatch) or the
 * live proxy (in components via `patch` from `$lib/graph/store`).
 */
export interface PatchLike {
  nodes: Record<string, ModuleNode | undefined>;
  edges: Record<string, Edge | undefined>;
}

export interface DriverDeps {
  patch: PatchLike;
  ydoc: Y.Doc;
  /**
   * How an `addEdge` intent resolves a node's def, so the write goes through
   * the shared LEG-GROUP planner (`$lib/graph/stereo-autowire`) instead of
   * dropping a single edge. Omitted ⇒ the live audio+video registries, which
   * is what every app call site wants.
   *
   * ⚠ It is INJECTABLE for a reason. The registries are populated by the
   * `$lib/audio/modules` barrel's side effect, so a unit test that does not
   * import the barrel would resolve every def to `undefined`, quietly plan one
   * leg, and pass — a green test certifying the exact bug this parameter
   * exists to prevent. Tests pass their own resolver and assert real groups.
   */
  defForNode?: (nodeId: string) => StereoDef | undefined;
}

/** The default def resolver: the same audio-then-video chain the Canvas commit
 *  paths validate with. Meta/group nodes resolve to undefined → one leg. */
function registryDefForNode(patch: PatchLike, nodeId: string): StereoDef | undefined {
  const n = patch.nodes[nodeId];
  if (!n) return undefined;
  return (getModuleDef(n.type) ?? getVideoModuleDef(n.type)) as StereoDef | undefined;
}

/**
 * Read a snapshot of the current patch suitable for the personality's
 * next() call. Cheap; called once per tick.
 */
export function readPatchView(patch: PatchLike): PersonalityPatchView {
  return {
    nodes: Object.values(patch.nodes)
      .filter((n): n is NonNullable<typeof n> => !!n)
      .map((n) => ({ id: n.id, type: n.type })),
    edges: Object.values(patch.edges)
      .filter((e): e is NonNullable<typeof e> => !!e)
      .map((e) => ({
        id: e.id,
        source: { nodeId: e.source.nodeId, portId: e.source.portId },
        target: { nodeId: e.target.nodeId, portId: e.target.portId },
      })),
  };
}

/**
 * Apply one Intent. Returns the elapsed sleep duration in ms for `sleep`
 * intents (the controller awaits it externally so the tick loop stays
 * cancellable); other intents return 0.
 *
 * All non-sleep intents wrap in a single ydoc.transact for atomicity:
 * a deleteNode that drops 3 edges + the node is one CRDT update, one
 * undo entry.
 */
export function applyIntent(deps: DriverDeps, intent: Intent): number {
  const { patch, ydoc } = deps;
  if (intent.kind === 'sleep') return intent.ms;

  ydoc.transact(() => {
    switch (intent.kind) {
      case 'addNode': {
        if (patch.nodes[intent.id]) return; // idempotent
        patch.nodes[intent.id] = {
          id: intent.id,
          type: intent.type,
          domain: 'audio',
          position: { x: 100 + Math.random() * 600, y: 100 + Math.random() * 400 },
          params: {},
        };
        return;
      }
      case 'addEdge': {
        if (patch.edges[intent.id]) return;
        // AI patching writes through the SAME leg-group planner as every human
        // gesture. Before this it wrote a single edge, so an AI patch of a
        // stereo module was permanently half-connected — the one commit path
        // that bypassed Canvas entirely, and the easiest one to forget.
        const defForNode =
          deps.defForNode ?? ((nodeId: string) => registryDefForNode(patch, nodeId));
        const plan = planAudioCommit({
          fromNodeId: intent.sourceNodeId,
          fromPortId: intent.sourcePortId,
          fromDef: defForNode(intent.sourceNodeId),
          toNodeId: intent.targetNodeId,
          toPortId: intent.targetPortId,
          toDef: defForNode(intent.targetNodeId),
          edges: patch.edges,
          sourceType: intent.sourceCableType,
          targetType: intent.targetCableType,
        });
        // The intent's OWN id is kept for the clicked leg: `deleteEdge` intents
        // address it by id, and the evict-by-prefix sweep matches on it. Sibling
        // legs take the endpoint-derived id (their node ids still carry the
        // bot's prefix, so eviction still reaches them).
        //
        // `plan.replaceEdgeIds` is deliberately NOT applied. An intent stream is
        // generative, not a user gesture: `addEdge` has always been purely
        // additive + idempotent, and having a bot silently evict cables it did
        // not place is a different feature from the leg-group write.
        //
        // ⚠ DEDUPE ON ENDPOINTS, not on the id. An intent id is a counter
        // (`carl-e7`), NOT endpoint-derived, so the two ids for one cable do
        // not collide: replaying the MIRRORED intent (`out_r → in_r` after
        // `out_l → in_l`) would otherwise write the same two cables a second
        // time under counter ids and leave FOUR edges for one stereo patch.
        // The Canvas paths are immune because their ids are endpoint-derived;
        // this path is the one that needs the check.
        const alreadyPatched = (fromPortId: string, toPortId: string): boolean => {
          for (const e of Object.values(patch.edges)) {
            if (!e) continue;
            if (
              e.source.nodeId === intent.sourceNodeId &&
              e.source.portId === fromPortId &&
              e.target.nodeId === intent.targetNodeId &&
              e.target.portId === toPortId
            ) {
              return true;
            }
          }
          return false;
        };
        for (const leg of plan.legs) {
          const id = leg.clicked ? intent.id : leg.id;
          if (patch.edges[id]) continue;
          if (alreadyPatched(leg.fromPortId, leg.toPortId)) continue;
          patch.edges[id] = {
            id,
            source: { nodeId: intent.sourceNodeId, portId: leg.fromPortId },
            target: { nodeId: intent.targetNodeId, portId: leg.toPortId },
            sourceType: leg.sourceType,
            targetType: leg.targetType,
          };
        }
        return;
      }
      case 'setParam': {
        const n = patch.nodes[intent.nodeId];
        if (n) n.params[intent.paramId] = intent.value; // guard:allow-raw-write — bot-driven (Carl) programmatic intent, must NOT land on the human's undo stack
        return;
      }
      case 'deleteNode': {
        for (const [eid, e] of Object.entries(patch.edges)) {
          if (!e) continue;
          if (e.source.nodeId === intent.id || e.target.nodeId === intent.id) {
            delete patch.edges[eid];
          }
        }
        delete patch.nodes[intent.id];
        return;
      }
      case 'deleteEdge': {
        // Expand to the whole leg group, for the same reason Canvas's Backspace
        // path does: removing one leg of a stereo cable the bot placed as a pair
        // would leave the other feeding a module nothing else references.
        // (deleteNode + the evict-by-prefix sweep already take whole groups,
        // because they match on the NODE, not the edge id.)
        const defForNode =
          deps.defForNode ?? ((nodeId: string) => registryDefForNode(patch, nodeId));
        for (const id of expandLegGroups([intent.id], patch.edges, defForNode)) {
          delete patch.edges[id];
        }
        return;
      }
    }
  }, LOCAL_ORIGIN);

  return 0;
}

/**
 * Bulk wipe of all of Carl's own nodes + edges. Called on "86 carl".
 * Identifies Carl-owned by `idPrefix` prefix. Idempotent.
 */
export function evictCarlPatch(deps: DriverDeps, idPrefix: string): void {
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
