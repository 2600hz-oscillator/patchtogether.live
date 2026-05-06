// Chaos Carl — Stage-1 personality. Picks weighted-random intents to drive
// the patch graph through legal-but-unusual states. Pure logic; emits
// Intents that the runner applies.
//
// Stage-1 scope is tighter than the full plan — no extreme-value param
// pushes, no near-Nyquist VCO frequencies, no stress bursts. Just legal
// random patches with periodic rewires + deletes. Once the framework is
// proven against current main, later iterations crank up the weirdness.

import type { Intent } from '../intent';
import type { PatchSnapshot } from '../state';
import type { SeededRng } from '../seed-rng';
import type { Catalog, CatalogModule } from '../catalog';
import { isChaosSpawnable } from '../catalog';

export interface CarlOptions {
  /** Hard cap on owned modules. Personality won't add more once at the cap. */
  maxOwnedNodes?: number;
  /** ID prefix so multi-personality runs don't collide. */
  idPrefix?: string;
}

export class ChaosCarl {
  readonly maxOwnedNodes: number;
  readonly idPrefix: string;
  readonly catalog: Catalog;
  /** Subset of catalog Carl will randomly add. Pre-filtered for speed. */
  private readonly spawnable: CatalogModule[];
  private nodeCounter = 0;
  private edgeCounter = 0;

  constructor(catalog: Catalog, options: CarlOptions = {}) {
    this.catalog = catalog;
    this.spawnable = catalog.filter(isChaosSpawnable);
    this.maxOwnedNodes = options.maxOwnedNodes ?? 6;
    this.idPrefix = options.idPrefix ?? 'carl';
    if (this.spawnable.length === 0) {
      throw new Error('ChaosCarl: catalog has no spawnable modules');
    }
  }

  /** Pick the next intent given current patch state and the seeded rng. */
  next(rng: SeededRng, patch: PatchSnapshot): Intent {
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

  private addEdgeIntent(rng: SeededRng, patch: PatchSnapshot): Intent {
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

  private setParamIntent(rng: SeededRng, ownedNodes: PatchSnapshot['nodes']): Intent {
    const node = rng.pick(ownedNodes);
    const def = this.catalog.find((m) => m.type === node.type);
    if (!def || def.params.length === 0) return { kind: 'sleep', ms: 20 };
    const p = rng.pick(def.params);
    const v = rng.float(p.min, p.max);
    return { kind: 'setParam', nodeId: node.id, paramId: p.id, value: v };
  }

  private deleteEdgeIntent(rng: SeededRng, edges: PatchSnapshot['edges']): Intent {
    return { kind: 'deleteEdge', id: rng.pick(edges).id };
  }

  private deleteNodeIntent(rng: SeededRng, nodes: PatchSnapshot['nodes']): Intent {
    return { kind: 'deleteNode', id: rng.pick(nodes).id };
  }

  private legalEdgeCandidates(patch: PatchSnapshot): Array<{
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
