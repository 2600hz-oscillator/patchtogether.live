// Chaos Carl — Stage-2 personality. Now plays *music* instead of fuzzing.
//
// Carl tries to assemble full signal chains the way a human patcher would:
//     timelorde (clock) → sequencer → vco → vca ← adsr
// plus drum kit:
//     timelorde → drumseqz/riotgirls → mixer → audioOut
// plus video sinks:
//     audio outputs → scope/wavviz/vizvco
//
// Behavior:
//   - addNode prefers "next missing slot" in a kit roster (clock first,
//     then a pitched sequencer, then a voice, then a VCA, then an ADSR,
//     then effects/video). Once the kit is full, picks any spawnable
//     module at random.
//   - addEdge scores legal candidates by port-semantic completion (a clock
//     output→sequencer.clock input is worth a lot more than a random
//     CV→param edge), then weighted-picks from the top candidates.
//   - setParam still wanders but is weighted lower than building chains.
//   - delete intents are rare so the patch grows into something that
//     actually sounds, rather than churning.
//
// Pacing happens in the runner (2-3s after each addNode + organize pass).

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

/** Roles in the "music kit" roster. Order = spawn priority (low → high). */
type Role =
  | 'clock'      // master clock source
  | 'sequencer'  // pitched sequencer feeding the synth voice
  | 'voice'      // pitched VCO / synth voice
  | 'envelope'   // ADSR for the voice's VCA
  | 'vca'        // amplifier the envelope opens
  | 'drumSeq'    // drum sequencer
  | 'drumVoice'  // drum voice fed by drumSeq
  | 'effect'     // optional FX on the audio path
  | 'mixer'      // glue node + final mix
  | 'videoSink'  // viz tied to audio output
  | 'other';

/** Module-type → role mapping. Modules not listed default to 'other'. */
const ROLE_BY_TYPE: Record<string, Role> = {
  timelorde:   'clock',
  sequencer:   'sequencer',
  polyseqz:    'sequencer',
  cartesian:   'sequencer',
  drumseqz:    'drumSeq',
  riotgirls:   'drumVoice',
  drummergirl: 'drumVoice',
  meowbox:     'drumVoice',
  analogVco:   'voice',
  wavetableVco:'voice',
  swolevco:    'voice',
  dx7:         'voice',
  noise:       'voice',
  adsr:        'envelope',
  vca:         'vca',
  stereovca:   'vca',
  filter:      'effect',
  reverb:      'effect',
  destroy:     'effect',
  charlottesEchos: 'effect',
  wavecel:     'effect',
  warrenspectrum: 'effect',
  qbrt:        'effect',
  mixer:       'mixer',
  mixmstrs:    'mixer',
  scope:       'videoSink',
  wavviz:      'videoSink',
  vizvco:      'videoSink',
};

function roleOf(type: string): Role {
  return ROLE_BY_TYPE[type] ?? 'other';
}

/** Role roster — Carl tries to spawn one of each in this order. */
const ROLE_PRIORITY: Role[] = [
  'clock',
  'sequencer',
  'voice',
  'envelope',
  'vca',
  'drumSeq',
  'drumVoice',
  'mixer',
  'effect',
  'videoSink',
];

/** Port-id keyword hints used by the edge scorer. Lowercase contains-match. */
const PORT_KEYWORDS = {
  clock:  ['clock', 'tick', 'beat'],
  gate:   ['gate', 'trig'],
  pitch:  ['pitch', '_v_oct', 'pitch_cv'],
  env:    ['env', 'strength', 'amount', 'cv'],
  audio:  ['audio', 'out_l', 'out_r', 'in_l', 'in_r', 'in', 'out'],
  video:  ['video', 'viz'],
};

function portMatches(portId: string, keywords: readonly string[]): boolean {
  const p = portId.toLowerCase();
  return keywords.some((k) => p.includes(k));
}

export class ChaosCarl {
  readonly maxOwnedNodes: number;
  readonly idPrefix: string;
  readonly catalog: Catalog;
  /** Subset of catalog Carl will spawn from. Pre-filtered for speed. */
  private readonly spawnable: CatalogModule[];
  /** Modules grouped by role for the kit-builder picker. */
  private readonly byRole: Map<Role, CatalogModule[]>;
  private nodeCounter = 0;
  private edgeCounter = 0;

  constructor(catalog: Catalog, options: CarlOptions = {}) {
    this.catalog = catalog;
    this.spawnable = catalog.filter(isChaosSpawnable);
    this.byRole = new Map();
    for (const m of this.spawnable) {
      const role = roleOf(m.type);
      const bucket = this.byRole.get(role) ?? [];
      bucket.push(m);
      this.byRole.set(role, bucket);
    }
    this.maxOwnedNodes = options.maxOwnedNodes ?? 12;
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

    // Bias: once we have ANY nodes, prefer wiring over more spawning so
    // the patch actually becomes connected. Spawn rate stays low; delete
    // rate stays very low so the chain doesn't churn.
    const haveAnything = ownedNodes.length > 0;
    const weights: [string, number][] = [
      ['addNode',    canAdd ? (haveAnything ? 15 : 60) : 0],
      ['addEdge',    canEdge ? 55 : 0],
      ['setParam',   ownedNodes.length > 0 ? 18 : 0],
      ['deleteEdge', ownedEdges.length > 0 ? 4 : 0],
      ['deleteNode', canDelete ? 2 : 0],
      ['sleep',      6],
    ];
    const kind = rng.weighted(weights.filter(([, w]) => w > 0));

    switch (kind) {
      case 'addNode':    return this.addNodeIntent(rng, ownedNodes);
      case 'addEdge':    return this.addEdgeIntent(rng, patch);
      case 'setParam':   return this.setParamIntent(rng, ownedNodes);
      case 'deleteEdge': return this.deleteEdgeIntent(rng, ownedEdges);
      case 'deleteNode': return this.deleteNodeIntent(rng, ownedNodes);
      default:           return { kind: 'sleep', ms: rng.int(60, 200) };
    }
  }

  private addNodeIntent(rng: SeededRng, ownedNodes: PatchSnapshot['nodes']): Intent {
    // Find the next-priority role that's not yet filled in the owned set.
    const ownedRoles = new Set<Role>(ownedNodes.map((n) => roleOf(n.type)));
    let pick: CatalogModule | undefined;
    for (const role of ROLE_PRIORITY) {
      if (ownedRoles.has(role)) continue;
      const bucket = this.byRole.get(role);
      if (!bucket || bucket.length === 0) continue;
      pick = rng.pick(bucket);
      break;
    }
    // Kit is full → pick any spawnable. Heavier weight on effects/video
    // so the bot keeps adding texture rather than another VCO.
    if (!pick) {
      const textureRoles: Role[] = ['effect', 'videoSink', 'mixer'];
      const candidates = this.spawnable.filter((m) => textureRoles.includes(roleOf(m.type)));
      pick = rng.pick(candidates.length > 0 ? candidates : this.spawnable);
    }
    return {
      kind: 'addNode',
      id: `${this.idPrefix}-n${this.nodeCounter++}-${pick.type}`,
      type: pick.type,
    };
  }

  private addEdgeIntent(rng: SeededRng, patch: PatchSnapshot): Intent {
    const candidates = this.legalEdgeCandidates(patch);
    if (candidates.length === 0) {
      return { kind: 'sleep', ms: rng.int(60, 200) };
    }
    // Weighted pick by chain-completion score.
    type EdgeCandidate = typeof candidates[number];
    const weighted = candidates.map((c): [EdgeCandidate, number] => [c, c.score]);
    const c = rng.weighted(weighted);
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
    // Bias param values toward the middle of the range so the bot doesn't
    // immediately push everything to extremes (e.g. zero gain, infinite
    // feedback). Random pick in the middle 60% of [min, max].
    const lo = p.min + (p.max - p.min) * 0.2;
    const hi = p.min + (p.max - p.min) * 0.8;
    const v = rng.float(lo, hi);
    return { kind: 'setParam', nodeId: node.id, paramId: p.id, value: v };
  }

  private deleteEdgeIntent(rng: SeededRng, edges: PatchSnapshot['edges']): Intent {
    return { kind: 'deleteEdge', id: rng.pick(edges).id };
  }

  private deleteNodeIntent(rng: SeededRng, nodes: PatchSnapshot['nodes']): Intent {
    return { kind: 'deleteNode', id: rng.pick(nodes).id };
  }

  /** Score how musically-sensible an edge between two ports would be. */
  private scoreEdge(
    srcType: string, srcPortId: string,
    tgtType: string, tgtPortId: string,
    cableType: string,
  ): number {
    const srcRole = roleOf(srcType);
    const tgtRole = roleOf(tgtType);

    // Strong shapes — these are exactly the chains the user asked for.
    if (cableType === 'gate' && srcRole === 'clock' && portMatches(tgtPortId, PORT_KEYWORDS.clock)) return 50;
    if (cableType === 'gate' && srcRole === 'clock' && (tgtRole === 'sequencer' || tgtRole === 'drumSeq')) return 50;
    if (cableType === 'gate' && (srcRole === 'sequencer' || srcRole === 'drumSeq') && tgtRole === 'envelope') return 40;
    if (cableType === 'gate' && srcRole === 'drumSeq' && tgtRole === 'drumVoice') return 45;
    if (cableType === 'pitch' && srcRole === 'sequencer' && tgtRole === 'voice') return 50;
    if (cableType === 'cv' && srcRole === 'envelope' && tgtRole === 'vca') return 45;
    if (cableType === 'audio' && srcRole === 'voice' && tgtRole === 'vca') return 40;
    if (cableType === 'audio' && srcRole === 'vca' && (tgtRole === 'effect' || tgtRole === 'mixer')) return 30;
    if (cableType === 'audio' && srcRole === 'effect' && tgtRole === 'mixer') return 25;
    if (cableType === 'audio' && (srcRole === 'vca' || srcRole === 'effect' || srcRole === 'mixer')
        && tgtType === 'audioOut') return 35;
    if (cableType === 'audio' && tgtRole === 'videoSink') return 35;

    // Generic same-shape matches. These are still plausible but lower-priority.
    if (cableType === 'gate' && portMatches(tgtPortId, PORT_KEYWORDS.gate)) return 10;
    if (cableType === 'audio' && portMatches(tgtPortId, PORT_KEYWORDS.audio)) return 6;
    if (cableType === 'cv') return 3;

    return 1;
  }

  private legalEdgeCandidates(patch: PatchSnapshot): Array<{
    sourceNodeId: string;
    sourcePortId: string;
    targetNodeId: string;
    targetPortId: string;
    cableType: string;
    score: number;
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
      score: number;
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
            const score = this.scoreEdge(src.type, sport.id, tgt.type, tport.id, sport.cableType);
            out.push({
              sourceNodeId: src.id,
              sourcePortId: sport.id,
              targetNodeId: tgt.id,
              targetPortId: tport.id,
              cableType: sport.cableType,
              score,
            });
          }
        }
      }
    }
    return out;
  }
}
