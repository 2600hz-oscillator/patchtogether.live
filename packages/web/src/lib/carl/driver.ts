// packages/web/src/lib/carl/driver.ts
//
// In-browser Intent applier. Mirrors e2e/chaos/lib/driver.ts but writes
// directly against the SyncedStore proxy (`patch`) inside a Y.Doc
// transaction so the mutation propagates through Yjs to all rack-mates.
//
// LOCAL_ORIGIN is intentionally used as the transact origin so Carl's
// writes flow through the same UndoManager-tracked code path the user
// would take from the palette. The spawning user can Cmd-Z Carl's
// mutations — which is the correct behavior since "spawn carl" is
// a deliberate user action and his patch changes are imputed to them.

import type * as Y from 'yjs';
import { LOCAL_ORIGIN } from '$lib/graph/store';
import type { ModuleNode, Edge } from '$lib/graph/types';
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
        patch.edges[intent.id] = {
          id: intent.id,
          source: { nodeId: intent.sourceNodeId, portId: intent.sourcePortId },
          target: { nodeId: intent.targetNodeId, portId: intent.targetPortId },
          sourceType: intent.sourceCableType,
          targetType: intent.targetCableType,
        };
        return;
      }
      case 'setParam': {
        const n = patch.nodes[intent.nodeId];
        if (n) n.params[intent.paramId] = intent.value;
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
        delete patch.edges[intent.id];
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
