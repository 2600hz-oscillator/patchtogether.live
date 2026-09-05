// packages/web/src/lib/audio/reconciler.ts
//
// Auto-reactive reconciler. Subscribes to the shared PatchSnapshot bus
// (`$lib/graph/snapshot`) and diffs the current snapshot against what the
// engine currently has materialized. Applies adds/removes/param-changes
// per pass.
//
// B3 (May 2026) — moved off `doc.on('update')` and `patchStore.nodes`
// direct reads to the snapshot bus, sharing one subscription with the
// Svelte UI. Both consumers see the same id-sorted ordering, eliminating
// the "heard but didn't see" divergence between two browser windows.
//
// Within-pass ordering is now id-sorted at every bucket (removed-edges,
// removed-nodes, added-nodes, added-edges, params) so two clients
// applying identical Yjs ops drive engine.addNode in identical order
// — the deterministic tiebreak that B3 calls for.

import type { Edge, ModuleNode } from '$lib/graph/types';
import type { PatchEngine } from './engine';
import {
  getDefaultSnapshotBus,
  type PatchSnapshot,
} from '$lib/graph/snapshot';
import { projectGroups } from '$lib/graph/group-projection';
import { planInertSlots } from '$lib/graph/device-slots';

interface ReconcilerHandle {
  /** Run a reconcile pass immediately against the current snapshot. */
  reconcile(): Promise<void>;
  /** Detach. */
  dispose(): void;
}

interface AttachOpts {
  /** Override the default snapshot bus. Tests use this to pass a doc-scoped bus. */
  bus?: ReturnType<typeof getDefaultSnapshotBus>;
}

export function attachReconciler(
  engine: PatchEngine,
  opts: AttachOpts = {},
): ReconcilerHandle {
  const bus = opts.bus ?? getDefaultSnapshotBus();

  const appliedNodes = new Map<string, ModuleNode>();
  const appliedEdges = new Map<string, Edge>();
  /**
   * Nodes whose `engine.addNode` THREW. Kept OUT of `appliedNodes` on purpose:
   * a failed node has no engine binding, so recording it as applied would make
   * step 5 push params at a node that does not exist and the removal path later
   * call `engine.removeNode` on it.
   *
   * Its two jobs: warn ONCE per node id rather than on every pass, and stop us
   * re-attempting a factory that will throw identically every time (the module
   * registry is static for the life of the build, so a retry cannot succeed).
   *
   * ⚠ KEYED BY id → TYPE, NOT BY id ALONE. That stated rationale — "the same
   * factory throws identically every time" — is about the TYPE, so the mark has
   * to be. Step 2 now re-materializes a node whose type changed at a reused id,
   * which makes an id-only mark actively wrong: a failed type A at id X would
   * blacklist the ADDRESS, and the DIFFERENT module the operator puts there next
   * would silently never appear with no second warning to explain it.
   */
  const failedNodes = new Map<string, string>();
  // The LIVE data reference each applied node was last cloned from. The
  // snapshot leaks the live SyncedStore proxy as `node.data` (snapshot.ts
  // `data: n.data`), whose identity is STABLE for a given node — so an
  // unchanged reference means the data object was not wholly replaced and
  // the existing clone can be kept. See step 5 for why this is safe.
  const appliedDataRefs = new Map<string, unknown>();

  let latest: PatchSnapshot = bus.current();
  let scheduled = false;
  let inFlight: Promise<void> = Promise.resolve();

  function enqueue(): Promise<void> {
    const next = inFlight.then(() => doReconcile(latest));
    inFlight = next.catch((err) => {
      console.error('[reconciler] reconcile failed:', err);
    });
    return next;
  }

  async function doReconcile(rawSnap: PatchSnapshot): Promise<void> {
    // Module-grouping Phase 1 — project the snapshot through any GROUP!
    // nodes BEFORE the reconciler reads it. Edge endpoints that name a
    // group's exposed port are rewritten to point at the real child port,
    // so the engine never knows groups exist. Empty fast-path: when no
    // group nodes are present, projectGroups returns the snapshot
    // unchanged (same reference) → zero overhead for the common case.
    const snap = projectGroups(rawSnap);

    // Meta-domain nodes (e.g. STICKY notes, GROUP! collapses) are pure-UI
    // cards with no engine binding. Filter them out of every map this
    // reconciler builds so PatchEngine.addNode + setParam never see them
    // — there's no DomainEngine registered for 'meta' and the dispatch
    // would throw. Edges referencing meta nodes are dropped too; the type
    // system already forbids cables to/from sticky (no ports), and
    // projectGroups has already rewritten edges to/from groups.
    const isMeta = (n: ModuleNode): boolean => n.domain === 'meta';
    // INERT DEVICE SLOTS — the same "present as a card, absent from the engine"
    // treatment, for the same reason, on a different axis (graph/device-slots.ts).
    //
    // A reserved slot node exists in every rack so the id is reserved and the
    // operator has something to bind; but a slot with nothing bound and nothing
    // patched has nothing to RUN, and eight idle video engines per rack is a
    // measured main-thread cost. Filtering it here means it mounts on first use
    // — bind a camera or cable something in and the very next snapshot carries
    // it through this filter as an ordinary new node, so the existing add path
    // brings it up with no special casing anywhere else.
    //
    // ⚠ AND THE REVERSE IS DELIBERATE TOO: unbinding makes a slot inert again,
    // which reaches the engine as a `removeNode` — i.e. the device is released.
    // That is exactly what unbind means, and it is why this filter is recomputed
    // per pass rather than latched.
    const inertSlots = planInertSlots(snap.nodes, snap.edges);
    const currentNodes = new Map<string, ModuleNode>();
    for (const n of snap.nodes) {
      if (isMeta(n) || inertSlots.has(n.id)) continue;
      currentNodes.set(n.id, n);
    }
    const currentEdges = new Map<string, Edge>();
    for (const e of snap.edges) currentEdges.set(e.id, e);

    // Within-pass id-sorted iteration so two clients run identical ops in
    // identical order. The snapshot is already sorted, but applied* maps
    // are insertion-order; we explicitly sort the key sets we iterate.

    // Helper: pick an edge's transport domain from its source node's
    // domain. The source's engine owns the routing primitives. The first
    // generation of this code hardcoded 'audio'; the Phase-0 video spike
    // introduced a second
    // domain so we now look it up. Cross-domain edges (e.g. audio CV
    // feeding a video module's param input) keep the source-side dispatch
    // — the bridge module on the audio side handles the rate conversion.
    function edgeDomain(edge: Edge): string {
      const sourceNode = currentNodes.get(edge.source.nodeId)
        ?? appliedNodes.get(edge.source.nodeId);
      return sourceNode?.domain ?? 'audio';
    }

    /** Target node's domain. Mirrors edgeDomain but for the destination
     *  endpoint. PatchEngine.addEdge uses this to detect cross-domain
     *  cv → video param bridges. */
    function edgeTargetDomain(edge: Edge): string {
      const targetNode = currentNodes.get(edge.target.nodeId)
        ?? appliedNodes.get(edge.target.nodeId);
      return targetNode?.domain ?? 'audio';
    }

    // 1. Removed edges first (release node references).
    const removedEdgeIds = [...appliedEdges.keys()]
      .filter((id) => !currentEdges.has(id))
      .sort();
    for (const id of removedEdgeIds) {
      const prev = appliedEdges.get(id)!;
      engine.removeEdge(prev, edgeDomain(prev));
      appliedEdges.delete(id);
    }

    // 2. Removed nodes — BY ID ABSENCE **OR BY IDENTITY CHANGE**.
    //
    // ⚠ AN ID IS NOT AN IDENTITY. This pass used to remove only ids that had
    // LEFT the snapshot, and step 3 skips any id it already holds, so a node
    // whose `type` (or `domain`) changed AT A REUSED ID was invisible to the
    // reconciler: no removeNode, no addNode, and the PREVIOUS module's engine
    // handle stayed bound to that id forever. `engine.read(node, key)` is keyed
    // by node id with no type check, so the new module's card/face is then
    // handed the OLD module's snapshot and throws on the shape mismatch —
    // MODTRIS reading `state.well[…]` (modtris.ts) or SYNESTHESIA passing a
    // missing `levelsA` into `drawVuMeters`, whose `levels[c] ?? 0` throws on
    // the index read before the `??` can apply. Every module that answers the
    // shared `read('snapshot')` key with its own shape is exposed: pong,
    // frogger, scope, dockscope, nibbles, skifree, gamepad, featurecv, cube,
    // synesthesia, modtris.
    //
    // Letting step 3 "just re-add" is NOT an alternative fix: AudioEngine.addNode
    // is idempotent per node id (engine.ts — `if (this.nodes.has(node.id)) return`),
    // so the stale handle can only be repaired by removing it FIRST. That is why
    // this belongs in the removal pass and not the add pass.
    //
    // ── WHY IT IS REACHABLE AT ALL, given a delete and an add ──────────────
    // Both writers that re-use an id delete-then-add inside ONE Y.Doc
    // transaction (`loadEnvelopeIntoStore` swapping the live store; the e2e
    // `spawnPatch` helper clearing and rebuilding the rack), and one
    // transaction is one snapshot — the empty intermediate state never exists
    // to be observed. Even when the clear IS a separate transaction, `enqueue`
    // reads `latest` when its chained pass RUNS, not when it is queued, so a
    // slow in-flight pass (an awaited factory) coalesces the empty state away
    // under contention. Both routes land here as "same id, different type".
    const removedNodeIds = [...appliedNodes.keys()]
      .filter((id) => {
        const cur = currentNodes.get(id);
        return !cur || identityChanged(appliedNodes.get(id)!, cur);
      })
      .sort();
    for (const id of removedNodeIds) {
      const prev = appliedNodes.get(id)!;
      engine.removeNode(prev);
      appliedNodes.delete(id);
      appliedDataRefs.delete(id);
    }
    // Drop the failed mark for any node no longer in the snapshot, so the map
    // cannot grow without bound across a long session and so a node that is
    // deleted and re-added gets a genuine second attempt.
    if (failedNodes.size > 0) {
      const live = new Set(snap.nodes.map((n) => n.id));
      for (const id of [...failedNodes.keys()]) if (!live.has(id)) failedNodes.delete(id);
    }

    // 3. Added nodes (await — async factories). Snapshot is sorted; we
    // iterate it directly, skipping ids we already have, any meta-domain
    // nodes (which carry no engine binding) AND any INERT device slot.
    //
    // ⚠ THIS LOOP READS `snap.nodes`, NOT `currentNodes`, so every exclusion
    // the map above applies has to be repeated here or it only half-works:
    // the node would be absent from the map (and so removed the moment it
    // was ever applied) while still being added by this pass — a node that
    // is added and removed on alternating passes. That is exactly what a
    // filter applied in only one of the two places produces.
    for (const node of snap.nodes) {
      if (isMeta(node) || inertSlots.has(node.id)) continue;
      if (appliedNodes.has(node.id)) continue;
      // already known bad AT THIS TYPE — do not retry or re-warn
      if (failedNodes.get(node.id) === node.type) continue;
      // engine.addNode THROWS on an unknown/removed module type or a factory
      // that blows up. Unguarded, ONE bad node aborted the rest of THIS pass —
      // every later node, every edge, and every param below it — and on a live
      // relay that aborted pass REPLAYS IDENTICALLY ON EVERY PEER, so a single
      // stale node type wedges the whole rackspace for everyone, permanently.
      // Same per-item containment the edge loop below already has: log it once,
      // remember it, and let all the VALID work in the pass still land.
      try {
        await engine.addNode(node);
      } catch (err) {
        failedNodes.set(node.id, node.type);
        console.warn(
          `[reconciler] skipping node ${node.id} (type ${node.type}): ${(err as Error).message}`,
        );
        continue;
      }
      appliedNodes.set(node.id, snapshotNode(node));
      appliedDataRefs.set(node.id, node.data);
    }

    // 4. Added edges. Skip edges whose source or target is a meta node —
    // sticky notes have no ports so legitimate edges never reference
    // them, but defending against corrupt envelopes keeps the reconciler
    // robust.
    for (const edge of snap.edges) {
      if (appliedEdges.has(edge.id)) continue;
      const src = currentNodes.get(edge.source.nodeId);
      const dst = currentNodes.get(edge.target.nodeId);
      if (!src || !dst) continue;
      // engine.addEdge THROWS on a missing/mismatched port (a stale portId, an
      // output-as-target, an incompatible cable type). Without this guard, ONE
      // bad edge would abort the rest of THIS pass — every remaining edge AND
      // every param change below — and in multiuser that aborted pass replays
      // identically on every peer. Imports are now structurally validated
      // up-front (persistence.ts validateEdge drop-invalid), so a throw here is
      // belt-and-suspenders: log it, mark the edge applied so we don't retry it
      // every pass, and keep going so all the VALID work in the pass still lands.
      try {
        engine.addEdge(edge, edgeDomain(edge), edgeTargetDomain(edge));
      } catch (err) {
        console.warn(
          `[reconciler] skipping edge ${edge.id} (${edge.source.nodeId}.${edge.source.portId} → ${edge.target.nodeId}.${edge.target.portId}): ${(err as Error).message}`,
        );
      }
      appliedEdges.set(edge.id, { ...edge });
    }

    // 5. Param changes on existing nodes.
    for (const node of snap.nodes) {
      if (isMeta(node)) continue;
      const prev = appliedNodes.get(node.id);
      if (!prev) continue;
      const paramKeys = Object.keys(node.params).sort();
      let paramsChanged = false;
      for (const paramId of paramKeys) {
        const value = node.params[paramId];
        if (prev.params[paramId] !== value) {
          engine.setParam(node, paramId, value);
          paramsChanged = true;
        }
      }
      // Refresh the applied snapshot WITHOUT the old unconditional
      // snapshotNode() deep-clone. JSON round-tripping EVERY node's data
      // blob (sequencer 128-step arrays, toybox base64 image layers) on
      // EVERY pass was the rank-1 per-transaction amplifier under
      // high-rate param writes (the MIDI-CC render-starvation fix) — a
      // param-only diff never needs the data re-clone.
      //
      // `node.data` in the snapshot is the LIVE SyncedStore proxy
      // (snapshot.ts `data: n.data`) with a stable identity per node: a
      // CHANGED identity means the whole data object was replaced → re-
      // clone; an UNCHANGED identity keeps the existing clone. In-place
      // data mutations therefore no longer refresh the clone — safe,
      // because this reconciler never diffs `data`: `prev` is only read
      // for the params diff above and by removeNode/edgeDomain (id/domain
      // only). If proxy identity were ever unstable this degrades to the
      // old always-clone behavior, never to a missed update.
      if (appliedDataRefs.get(node.id) !== node.data) {
        appliedNodes.set(node.id, snapshotNode(node));
        appliedDataRefs.set(node.id, node.data);
      } else if (
        paramsChanged
        || paramKeys.length !== Object.keys(prev.params).length
      ) {
        // Keep the params snapshot exact (including key removals) so the
        // next pass diffs against what the engine actually has.
        prev.params = { ...node.params };
      }
    }
  }

  function schedule(snap: PatchSnapshot) {
    latest = snap;
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      enqueue().catch(() => {});
    });
  }

  // The bus calls our listener synchronously with the current snapshot
  // immediately, then again on each Yjs update. We schedule a microtask
  // reconcile each time; the inFlight chain serializes them.
  const unsubscribe = bus.subscribe((snap) => schedule(snap));

  return {
    reconcile: enqueue,
    dispose() {
      unsubscribe();
    },
  };
}

/** Is the node now at this id a DIFFERENT MODULE from the one the engine bound
 *  there? An id is an address, not an identity — see step 2. */
function identityChanged(prev: ModuleNode, cur: ModuleNode): boolean {
  return prev.type !== cur.type || prev.domain !== cur.domain;
}

function snapshotNode(node: ModuleNode): ModuleNode {
  let dataCopy: Record<string, unknown> | undefined;
  if (node.data) {
    try {
      dataCopy = JSON.parse(JSON.stringify(node.data));
    } catch {
      dataCopy = undefined;
    }
  }
  return {
    id: node.id,
    type: node.type,
    domain: node.domain,
    position: { ...node.position },
    params: { ...node.params },
    data: dataCopy,
  };
}
