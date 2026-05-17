// packages/web/src/lib/carl/personality.ts
//
// Rackspace Carl personality — in-browser port of chaos Stage-1 / Stage-2
// Carl (see e2e/chaos/lib/personalities/carl.ts). Plays *music* by trying
// to assemble full signal chains the way a human patcher would:
//     timelorde (clock) → sequencer → vco → vca ← adsr
// plus drum kit, plus video sinks.
//
// Behavior parity with chaos PR #150 is the goal — same role roster,
// same weights, same edge-scoring shape. We use the Stage-1 weights here
// (chaos PR #150 is still open at the time of writing) and document the
// minor delta so syncing back is mechanical.
//
// Per project memory ("If existing Carl's intent layer needs to be
// touched to extract it, prefer creating an adapter / wrapper rather
// than refactoring PR #150's open code"), this file is a COPY of the
// chaos Stage-1 personality rather than an import — so PR #150 can
// land without merge pain. Once PR #150 is merged, a follow-up can
// hoist a single shared module from here.

import type { Intent } from './intent';
import { type Catalog, type CatalogModule, isCarlSpawnable } from './catalog';
import type { SeededRng } from './rng';

export interface PersonalityPatchView {
  nodes: ReadonlyArray<{ id: string; type: string }>;
  edges: ReadonlyArray<{
    id: string;
    source: { nodeId: string; portId: string };
    target: { nodeId: string; portId: string };
  }>;
}

export interface CarlOptions {
  /** Hard cap on owned modules. Default 6 (musician-mode caps at 12 in
   *  chaos PR #150; here we stay conservative because the rackspace cap
   *  is 4 humans + Carl). */
  maxOwnedNodes?: number;
  /** ID prefix so multi-personality runs (or a re-spawned Carl in the
   *  same rackspace) don't collide. Default 'carl'. */
  idPrefix?: string;
}

export class RackspaceCarl {
  readonly maxOwnedNodes: number;
  readonly idPrefix: string;
  readonly catalog: Catalog;
  /** Subset of the catalog Carl will spawn from. */
  private readonly spawnable: CatalogModule[];
  private nodeCounter = 0;
  private edgeCounter = 0;

  constructor(catalog: Catalog, options: CarlOptions = {}) {
    this.catalog = catalog;
    this.spawnable = catalog.filter(isCarlSpawnable);
    this.maxOwnedNodes = options.maxOwnedNodes ?? 6;
    this.idPrefix = options.idPrefix ?? 'carl';
    if (this.spawnable.length === 0) {
      throw new Error('RackspaceCarl: catalog has no spawnable modules');
    }
  }

  /** Pick the next intent given current patch view and a seeded rng. */
  next(rng: SeededRng, patch: PersonalityPatchView): Intent {
    const ownedNodes = patch.nodes.filter((n) => n.id.startsWith(this.idPrefix + '-'));
    const ownedEdges = patch.edges.filter((e) => e.id.startsWith(this.idPrefix + '-'));

    const canAdd = ownedNodes.length < this.maxOwnedNodes;
    const canEdge = patch.nodes.length >= 2;
    const canDelete = ownedNodes.length > 0;

    const weights: [string, number][] = [
      ['addNode',    canAdd ? 40 : 0],
      ['addEdge',    canEdge ? 25 : 0],
      ['setParam',   ownedNodes.length > 0 ? 15 : 0],
      ['deleteEdge', ownedEdges.length > 0 ? 8 : 0],
      ['deleteNode', canDelete ? 7 : 0],
      ['sleep',      5],
    ];
    const kind = rng.weighted(weights.filter(([, w]) => w > 0));

    switch (kind) {
      case 'addNode':    return this.addNodeIntent(rng);
      case 'addEdge':    return this.addEdgeIntent(rng, patch);
      case 'setParam':   return this.setParamIntent(rng, ownedNodes);
      case 'deleteEdge': return this.deleteEdgeIntent(rng, ownedEdges);
      case 'deleteNode': return this.deleteNodeIntent(rng, ownedNodes);
      default:           return { kind: 'sleep', ms: rng.int(20, 80) };
    }
  }

  private addNodeIntent(rng: SeededRng): Intent {
    const mod = rng.pick(this.spawnable);
    return {
      kind: 'addNode',
      id: `${this.idPrefix}-n${this.nodeCounter++}-${mod.type}`,
      type: mod.type,
    };
  }

  private addEdgeIntent(rng: SeededRng, patch: PersonalityPatchView): Intent {
    const candidates = this.legalEdgeCandidates(patch);
    if (candidates.length === 0) {
      return { kind: 'sleep', ms: rng.int(20, 60) };
    }
    const c = rng.pick(candidates);
    return {
      kind: 'addEdge',
      id: `${this.idPrefix}-e${this.edgeCounter++}`,
      sourceNodeId: c.sourceNodeId,
      sourcePortId: c.sourcePortId,
      targetNodeId: c.targetNodeId,
      targetPortId: c.targetPortId,
      sourceCableType: c.cableType,
      targetCableType: c.cableType,
    };
  }

  private setParamIntent(
    rng: SeededRng,
    ownedNodes: ReadonlyArray<{ id: string; type: string }>,
  ): Intent {
    const node = rng.pick(ownedNodes);
    const def = this.catalog.find((m) => m.type === node.type);
    if (!def || def.params.length === 0) return { kind: 'sleep', ms: 20 };
    const p = rng.pick(def.params);
    const v = rng.float(p.min, p.max);
    return { kind: 'setParam', nodeId: node.id, paramId: p.id, value: v };
  }

  private deleteEdgeIntent(
    rng: SeededRng,
    edges: PersonalityPatchView['edges'],
  ): Intent {
    return { kind: 'deleteEdge', id: rng.pick(edges).id };
  }

  private deleteNodeIntent(
    rng: SeededRng,
    nodes: ReadonlyArray<{ id: string; type: string }>,
  ): Intent {
    return { kind: 'deleteNode', id: rng.pick(nodes).id };
  }

  private legalEdgeCandidates(patch: PersonalityPatchView): Array<{
    sourceNodeId: string;
    sourcePortId: string;
    targetNodeId: string;
    targetPortId: string;
    cableType: string;
  }> {
    const occupiedTargets = new Set<string>();
    for (const e of patch.edges) {
      occupiedTargets.add(`${e.target.nodeId}::${e.target.portId}`);
    }
    const out: Array<{
      sourceNodeId: string;
      sourcePortId: string;
      targetNodeId: string;
      targetPortId: string;
      cableType: string;
    }> = [];
    for (const src of patch.nodes) {
      const srcDef = this.catalog.find((m) => m.type === src.type);
      if (!srcDef) continue;
      for (const sport of srcDef.outputs) {
        for (const tgt of patch.nodes) {
          if (tgt.id === src.id) continue;
          const tgtDef = this.catalog.find((m) => m.type === tgt.type);
          if (!tgtDef) continue;
          for (const tport of tgtDef.inputs) {
            if (sport.cableType !== tport.cableType) continue;
            if (occupiedTargets.has(`${tgt.id}::${tport.id}`)) continue;
            out.push({
              sourceNodeId: src.id,
              sourcePortId: sport.id,
              targetNodeId: tgt.id,
              targetPortId: tport.id,
              cableType: sport.cableType,
            });
          }
        }
      }
    }
    return out;
  }
}
