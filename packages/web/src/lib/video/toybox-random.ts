// packages/web/src/lib/video/toybox-random.ts
//
// TOYBOX RANDOMIZE — the pure, seeded dice engine (#1576, workstreams 3+4).
//
// `generateToyboxPatch(seed, context, assets, exclude, current)` is a PURE
// function: same seed + same context + same assets + same current state ⇒
// byte-identical result. It never touches Yjs, never fetches, never reads the
// asset registry — the thin `rollToyboxPatch()` wrapper threads the live
// provider lists in (listedContent()/listedModels(), the #1710 seam), and the
// CARD applies the returned blob through the existing preset machinery
// (applyDataBlobToNode → one LOCAL_ORIGIN transact ⇒ one Cmd-Z per roll).
//
// Design per the prior-art distillation (.myrobots/2026-08-13-random-preset-
// prior-art.md, R1–R25):
//
//   - CURATED, not uniform (R1): scalars roll from designer-tuned sub-ranges
//     (CURATED_OP_RANGES; content uniforms jitter around their manifest
//     default with an occasional full-range draw for heavy tails, R8).
//     The owner-black review round (2026-08-20) measured the dead zones the
//     first pass missed and closed them here: feedback thresh/intensity,
//     datamosh decay, bitbend AND-with-small-mask, biocells dark edges, and
//     DIM_GEN_CONTENT (below).
//   - STRUCTURE first (R2): a weighted ARCHETYPE table hand-designs topology
//     families. Rolls restructure the COMBINE GRAPH itself (owner demand,
//     2026-08-20): branch-and-merge shapes, mid-chain transforms, feedback
//     taps — not just layer content.
//   - LIVENESS by construction (R5): every archetype folds all of its active
//     layers into a graph that terminates at OUT, so every active layer is
//     load-bearing; a bounded reject-and-retry loop re-rolls on any
//     validation failure and a known-good fallback build makes a press
//     structurally unable to fail (R24).
//   - CONTEXT-aware (R13): patched video inputs (inA/inB) become mandatory
//     live video layers; every patched cv port gets a route that resolves in
//     the result. Rack edges are never touched.
//   - LOCKS (R12, ws3): lock state RIDES the locked object itself
//     (`ToyboxLayer.locked` / `ToyboxGraphNode.locked` — synced, saved,
//     exported with it). The engine reads locks off `current` and treats
//     locked elements as fixed constraints: a locked layer is byte-copied to
//     its index; a locked combine node survives with its params, position and
//     UPSTREAM CLOSURE (the nodes + edges feeding it), which implies locks on
//     the source layers it consumes; existing cv routes that target locked
//     elements are preserved verbatim. Locks constrain the DICE only — manual
//     edits and runtime cv modulation of locked elements stay allowed.
//   - EXCLUSIONS (R4): the blob carries ONLY `layers`, `combine`, `cvRoutes`.
//   - ANTI-REPEAT (R7): the caller passes recent archetype ids; the picker
//     excludes them (unless that would empty the table).

import {
  LAYER_COUNT,
  MATCAP_STYLES,
  makeDefaultObjMaterial,
  type ToyboxContent,
  type ToyboxLayer,
  type ToyboxModel,
} from './toybox-content';
import {
  OP_PARAMS,
  isCombineGraph,
  nextNodeId,
  opSlotXY,
  outputNode,
  topoSort,
  validateConnect,
  type ToyboxCombineGraph,
  type ToyboxGraphEdge,
  type ToyboxGraphNode,
  type ToyboxInPort,
  type ToyboxNodeKind,
  type ToyboxOpKind,
} from './toybox-combine-graph';
import {
  CV_PORT_IDS,
  IMAGE_VIDEO_PARAMS,
  MATERIAL_PARAMS,
  type CvRouteTarget,
  type CvRoutes,
} from './toybox-cv-routes';
import { listedContent, listedModels } from './toybox-asset-registry';

// ---------------- Seeded PRNG ----------------

/** A seeded [0,1) generator. */
export type ToyboxRng = () => number;

/** mulberry32 — tiny, fast, good-enough seeded PRNG (no dependency). */
export function mulberry32(seed: number): ToyboxRng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function rollRange(rng: ToyboxRng, lo: number, hi: number): number {
  return lerp(lo, hi, rng());
}
function rollInt(rng: ToyboxRng, lo: number, hi: number): number {
  return Math.floor(rollRange(rng, lo, hi + 1 - 1e-9));
}
function pick<T>(rng: ToyboxRng, arr: readonly T[]): T {
  if (arr.length === 0) throw new RollError('pick from empty pool');
  return arr[Math.min(arr.length - 1, Math.floor(rng() * arr.length))]!;
}
function pickWeighted<T>(rng: ToyboxRng, entries: ReadonlyArray<readonly [T, number]>): T {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let t = rng() * total;
  for (const [v, w] of entries) {
    t -= w;
    if (t <= 0) return v;
  }
  return entries[entries.length - 1]![0];
}
function shuffled<T>(rng: ToyboxRng, arr: readonly T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Internal reject signal — caught by the bounded retry loop. */
class RollError extends Error {}

// ---------------- Inputs / outputs ----------------

/** What the user has patched into the TOYBOX node — read off the rack graph by
 *  the caller (the card), NEVER written by the engine. Patched sources are
 *  locked-by-default inputs every roll builds ON (R13). */
export interface ToyboxRandomContext {
  videoIn: { inA: boolean; inB: boolean };
  /** Patched generic cv ports (cv1..cv6) → the inbound edge's signal kind.
   *  Unpatched ports are ABSENT (never 'idle'). */
  cv: Record<string, 'cv' | 'gate' | 'audio'>;
}

/** The asset pools the dice draw from — the provider-seam lists. */
export interface ToyboxRandomAssets {
  content: readonly ToyboxContent[];
  models: readonly ToyboxModel[];
}

/** The CURRENT node.data slice the engine may read (never write): lock flags
 *  ride the layer/node objects in here, and existing cvRoutes to locked
 *  targets are preserved from here. All optional — a fresh node rolls free. */
export interface ToyboxCurrentState {
  layers?: readonly ToyboxLayer[];
  combine?: unknown;
  cvRoutes?: CvRoutes;
}

/** The blob a roll produces — EXACTLY the three fields a roll may touch (R4/
 *  R25). applyDataBlobToData writes only fields present on the blob, so
 *  name/combineView/cvInputs/rack-edges are untouchable by construction. */
export interface ToyboxRollBlob {
  layers: ToyboxLayer[];
  combine: ToyboxCombineGraph;
  cvRoutes: CvRoutes;
  [key: string]: unknown;
}

export interface ToyboxRollResult {
  blob: ToyboxRollBlob;
  archetypeId: string;
  seed: number;
  /** True when the seeded build failed validation MAX_BUILD_ATTEMPTS times
   *  and the known-good fallback build was used instead (R24). */
  fellBack: boolean;
}

export const EMPTY_TOYBOX_CONTEXT: ToyboxRandomContext = Object.freeze({
  videoIn: Object.freeze({ inA: false, inB: false }),
  cv: Object.freeze({}),
}) as ToyboxRandomContext;

// ---------------- Curated ranges (R1 — the content-design half) ----------------

/**
 * GEN content that reads as a DEAD FRAME when it carries the composite alone —
 * usable as a blended/keyed TOP over a live base, never as the base or sole
 * layer. Named deny-by-default entries, each carrying its measured `why`; the
 * e2e catalog audit (toybox-randomize.spec.ts) renders every GEN solo and
 * asserts BOTH directions — every under-floor content is listed here, and
 * every listed content is actually under floor — so an entry can neither be
 * missing nor go stale.
 */
export const DIM_GEN_CONTENT: ReadonlyMap<string, string> = new Map([
  [
    'star-field',
    'sparse pinpoint stars on black: solo render measured mean 8.8/255 with ZERO pixels above 40/255 ' +
      '(2026-08-20, the owner-black screenshot) — as base/solo it is indistinguishable from a dead frame',
  ],
]);

/** Curated ABSOLUTE roll ranges per op param. A param listed here rolls
 *  uniformly inside this sub-range; an unlisted param jitters around its
 *  OP_PARAMS default (±25% of full range). These are the designed-out dead
 *  zones — the 2026-08-20 dud audit tightened feedback (thresh gating a dim
 *  input to black, wet-heavy intensity), datamosh (decay crush), biocells
 *  (dark edges over dark cells) and bitbend (AND with a small mask keeps a
 *  single bit plane). */
const CURATED_OP_RANGES: Partial<Record<ToyboxOpKind, Record<string, readonly [number, number]>>> = {
  fade: { amount: [0.35, 0.8] },
  over: { amount: [0.55, 1] },
  lumakey: { amount: [0.3, 0.65], soft: [0.15, 0.5] },
  map: { amount: [0.5, 1] },
  feedback: {
    zoom: [0.9, 0.99],
    rotate: [-0.35, 0.35],
    decay: [0.8, 0.95],
    intensity: [0.45, 0.8],
    gain: [0.95, 1.15],
    blur: [0, 1.5],
    thresh: [0.25, 0.55],
  },
  tile: { tilesX: [2, 6], tilesY: [2, 6], rotate: [-0.6, 0.6], offX: [-0.3, 0.3], offY: [-0.3, 0.3] },
  mirror: { segments: [4, 10] },
  displace: { amount: [0.05, 0.25] },
  bitbend: { mask: [64, 200] },
  biocells: { cellCount: [8, 40], lumaJitter: [0.2, 0.7], edgeWidth: [0.1, 0.4], edgeColor: [0.3, 1] },
  framedelay: { delay: [4, 24], mix: [0.4, 0.8] },
  channeldesync: { rDelay: [0, 16], gDelay: [0, 16], bDelay: [0, 16], offsetMag: [0.02, 0.15] },
  flowsmear: { flowStrength: [0.3, 0.8], noiseScale: [1, 6], persistence: [0.7, 0.92] },
  dreammelt: { meltAmount: [0.3, 0.7], dripSpeed: [0.15, 0.6], threshold: [0.3, 0.7] },
  datamosh: { flowScale: [0.5, 1], holdGate: [0.25, 0.55], decay: [0.85, 0.95] },
  exquisite: { bands: [3, 6], boundaryWarp: [0.1, 0.5], seamBlend: [0.05, 0.3] },
};

/** Op params that must land on integers. */
const INTEGRAL_OP_PARAMS = new Set([
  'tile.tilesX',
  'tile.tilesY',
  'mirror.segments',
  'bitbend.mask',
  'biocells.cellCount',
  'framedelay.delay',
  'channeldesync.rDelay',
  'channeldesync.gDelay',
  'channeldesync.bDelay',
  'feedback.mode',
  'exquisite.bands',
]);

/** Roll every param an op declares. */
function rollOpParams(
  rng: ToyboxRng,
  kind: ToyboxOpKind,
  overrides?: Record<string, readonly [number, number]>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const def of OP_PARAMS[kind]) {
    const curated = overrides?.[def.id] ?? CURATED_OP_RANGES[kind]?.[def.id];
    let v: number;
    if (def.options) {
      v = rollInt(rng, 0, def.options.length - 1);
    } else if (curated) {
      v = rollRange(rng, curated[0], curated[1]);
    } else {
      v = clamp(def.default + (rng() * 2 - 1) * 0.25 * (def.max - def.min), def.min, def.max);
    }
    if (INTEGRAL_OP_PARAMS.has(`${kind}.${def.id}`)) v = Math.round(v);
    out[def.id] = clamp(v, def.min, def.max);
  }
  if (kind === 'bitbend') {
    // AND keeps only masked bit-planes — dud-audit showed it crushing dim
    // input to a single dark band, so it is the RARE draw, not an equal one.
    out.op = pickWeighted(rng, [
      [0, 0.4], // XOR
      [3, 0.3], // ROTATE
      [2, 0.2], // OR
      [1, 0.1], // AND
    ]);
    out.perR = rng() < 0.7 ? 1 : 0;
    out.perG = rng() < 0.7 ? 1 : 0;
    out.perB = rng() < 0.7 ? 1 : 0;
    if (!out.perR && !out.perG && !out.perB) out.perG = 1;
  }
  if (kind === 'map') {
    // MULTIPLY of two dark-ish feeds compounds toward black; SCREEN brightens.
    out.mode = rng() < 0.7 ? 1 : 0;
  }
  if (kind === 'lumakey') out.invert = rng() < 0.25 ? 1 : 0;
  return out;
}

/** Roll a content entry's declared uniforms: default-centred jitter (±25% of
 *  range), with AT MOST ONE param per layer taking a full-range draw (R8 —
 *  rare gems). The tail is per-LAYER, not per-param, deliberately: a 10%
 *  per-param tail compounds (3 params → ~27% chance of at least one wild
 *  draw), and the 2026-08-20 flake-check caught exactly that — a content
 *  entry that measures BRIGHT at its defaults (warp-terrain, mean 71.9/255 in
 *  the catalog audit) rolled a param combination that rendered near-dark
 *  (lit40 0.004). One wild param on an otherwise default-centred layer keeps
 *  the surprises without compounding into dead frames. */
function rollContentParams(rng: ToyboxRng, content: ToyboxContent): Record<string, number> {
  const out: Record<string, number> = {};
  const wildIdx = content.params.length > 0 && rng() < 0.15 ? rollInt(rng, 0, content.params.length - 1) : -1;
  content.params.forEach((p, i) => {
    let v: number;
    if (i === wildIdx) v = rollRange(rng, p.min, p.max);
    else v = clamp(p.default + (rng() * 2 - 1) * 0.25 * (p.max - p.min), p.min, p.max);
    if (p.curve === 'discrete') v = Math.round(v);
    out[p.id] = clamp(v, p.min, p.max);
  });
  return out;
}

// ---------------- Asset pools ----------------

function genPool(assets: ToyboxRandomAssets): ToyboxContent[] {
  return assets.content.filter((c) => c.family === 'GEN' && !c.inlineSource);
}
/** GEN entries that may CARRY a composite (base / solo / splice band). */
function baseGenPool(assets: ToyboxRandomAssets): ToyboxContent[] {
  return genPool(assets).filter((c) => !DIM_GEN_CONTENT.has(c.id));
}
function fxPool(assets: ToyboxRandomAssets): ToyboxContent[] {
  return assets.content.filter((c) => c.family === 'FX' && !c.inlineSource);
}
function fragPool(assets: ToyboxRandomAssets): ToyboxContent[] {
  return assets.content.filter((c) => c.family === 'FRAG' && !c.inlineSource);
}

function rollGenLayer(rng: ToyboxRng, pool: readonly ToyboxContent[]): ToyboxLayer {
  const content = pick(rng, pool);
  return {
    kind: content.family === 'FX' ? 'shader' : content.family === 'FRAG' ? 'frag' : 'gen',
    contentId: content.id,
    params: rollContentParams(rng, content),
  };
}

function rollObjLayer(rng: ToyboxRng, models: readonly ToyboxModel[]): ToyboxLayer {
  const model = pick(rng, models);
  const material = makeDefaultObjMaterial(model.id);
  material.rotX = rollRange(rng, -0.6, 0.6);
  material.rotY = rollRange(rng, -Math.PI, Math.PI);
  material.rotZ = rollRange(rng, -0.3, 0.3);
  material.scale = rollRange(rng, 0.7, 1.6);
  material.spin = rollRange(rng, 0.2, 1.2);
  material.matcap = typeof model.matcap === 'number' ? model.matcap : rollInt(rng, 0, MATCAP_STYLES - 1);
  material.tintR = rollRange(rng, 0.55, 1);
  material.tintG = rollRange(rng, 0.55, 1);
  material.tintB = rollRange(rng, 0.55, 1);
  return { kind: 'obj', contentId: null, params: {}, material };
}

function videoLayerFor(port: 'inA' | 'inB'): ToyboxLayer {
  return { kind: 'video', contentId: null, params: { opacity: 1, brightness: 1 }, videoSource: port };
}

const OFF_LAYER = (): ToyboxLayer => ({ kind: 'off', contentId: null, params: {} });

// ---------------- Locks (R12 / ws3) ----------------

/** Everything the CURRENT state pins for this roll, extracted once. */
interface LockPlan {
  /** Layer index → byte-copy that MUST appear at that index (explicit locks
   *  plus layers implied by the locked subgraph's source feeds). */
  layers: Map<number, ToyboxLayer>;
  /** Locked op nodes + their upstream op closure, byte-copied (ids, params,
   *  positions, flags preserved). */
  nodes: ToyboxGraphNode[];
  /** Closure edges: op→op inside the closure, and source→op feeds (source
   *  refs REWRITTEN to the canonical src{layer} ids). Layer-input taps whose
   *  `from` survives in the closure are kept too. */
  edges: ToyboxGraphEdge[];
  /** Closure node ids whose output no locked node consumes — the roll wires
   *  these INTO the new composite so the locked chain stays load-bearing. */
  terminals: string[];
  /** Existing cv routes that target a locked element — preserved verbatim. */
  routes: Array<readonly [string, CvRouteTarget]>;
}

const EMPTY_LOCKS: LockPlan = { layers: new Map(), nodes: [], edges: [], terminals: [], routes: [] };

function isOpNode(n: ToyboxGraphNode): boolean {
  return n.kind !== 'source' && n.kind !== 'output';
}

/** Extract the lock constraints off the CURRENT node state. PURE. */
function extractLocks(current: ToyboxCurrentState | undefined): LockPlan {
  if (!current) return EMPTY_LOCKS;
  const layers = new Map<number, ToyboxLayer>();
  const currentLayers = Array.isArray(current.layers) ? current.layers : [];
  currentLayers.forEach((l, i) => {
    if (l && l.locked === true && i < LAYER_COUNT) layers.set(i, clone(l));
  });

  const g = isCombineGraph(current.combine) ? (current.combine as ToyboxCombineGraph) : null;
  const nodes: ToyboxGraphNode[] = [];
  const edges: ToyboxGraphEdge[] = [];
  const terminals: string[] = [];
  if (g) {
    // Upstream closure of the explicitly locked op nodes.
    const byId = new Map(g.nodes.map((n) => [n.id, n] as const));
    const closure = new Set<string>();
    const queue = g.nodes.filter((n) => isOpNode(n) && n.locked === true).map((n) => n.id);
    while (queue.length) {
      const id = queue.pop()!;
      if (closure.has(id)) continue;
      closure.add(id);
      for (const e of g.edges) {
        if (e.to !== id) continue;
        const from = byId.get(e.from);
        if (!from) continue;
        if (isOpNode(from)) queue.push(e.from);
      }
    }
    for (const id of closure) nodes.push(clone(byId.get(id)!));
    for (const e of g.edges) {
      const toIn = closure.has(e.to);
      const from = byId.get(e.from);
      if (toIn && from) {
        if (isOpNode(from) && closure.has(e.from)) {
          edges.push(clone(e));
        } else if (from.kind === 'source' && typeof from.layer === 'number') {
          // Rewrite to the canonical source id for that layer, and IMPLY a
          // lock on the layer the locked op consumes — a locked op keeps
          // functioning only if its feed keeps its content (R12).
          const li = from.layer;
          edges.push({ ...clone(e), from: `src${li}` });
          if (!layers.has(li) && currentLayers[li]) layers.set(li, clone(currentLayers[li]!));
        }
        continue;
      }
      // A layer-input TAP out of a closure node into a source we imply-locked
      // stays too (it is part of what the locked chain "does").
      const toNode = byId.get(e.to);
      if (
        closure.has(e.from) &&
        toNode?.kind === 'source' &&
        typeof toNode.layer === 'number' &&
        e.toPort === 'in0'
      ) {
        edges.push({ ...clone(e), to: `src${toNode.layer}` });
        if (!layers.has(toNode.layer) && currentLayers[toNode.layer]) {
          layers.set(toNode.layer, clone(currentLayers[toNode.layer]!));
        }
      }
    }
    const consumed = new Set(edges.filter((e) => closure.has(e.to)).map((e) => e.from));
    for (const id of closure) if (!consumed.has(id)) terminals.push(id);
    terminals.sort(); // deterministic
  }

  // Existing routes that target a locked element survive the roll verbatim.
  const routes: Array<readonly [string, CvRouteTarget]> = [];
  const lockedNodeIds = new Set(nodes.map((n) => n.id));
  for (const port of Object.keys(current.cvRoutes ?? {})) {
    const r = current.cvRoutes?.[port];
    if (!r) continue;
    const lockedTarget =
      (r.target === 'layer' && typeof r.layer === 'number' && layers.has(r.layer)) ||
      (r.target === 'combine' && typeof r.nodeId === 'string' && lockedNodeIds.has(r.nodeId));
    if (lockedTarget) routes.push([port, clone(r)] as const);
  }
  return { layers, nodes, edges, terminals, routes };
}

// ---------------- Graph assembly ----------------

/** Start a graph containing the four structural SOURCE nodes + OUTPUT (the
 *  same fixed ids/positions makeDefaultCombineGraph uses). */
function baseGraph(): ToyboxCombineGraph {
  const nodes: ToyboxGraphNode[] = [];
  for (let i = 0; i < LAYER_COUNT; i++) {
    nodes.push({ id: `src${i}`, kind: 'source', layer: i, x: 14, y: 14 + i * 52 });
  }
  nodes.push({ id: 'out', kind: 'output', x: 286, y: 66 });
  return { nodes, edges: [] };
}

/** Add an edge through validateConnect — the SAME gate the editor uses. */
function connect(g: ToyboxCombineGraph, from: string, to: string, toPort: ToyboxInPort): void {
  const res = validateConnect(g, from, to, toPort);
  if (!res.ok || !res.edge) throw new RollError(`connect ${from}→${to}:${toPort} rejected (${res.error})`);
  g.edges.push(res.edge);
}

/** Add a fresh op node with rolled params. Ids mint through nextNodeId so a
 *  LOCKED node's preserved id (op3 etc.) can never collide with a new one. */
function addOp(
  g: ToyboxCombineGraph,
  rng: ToyboxRng,
  kind: ToyboxOpKind,
  overrides?: Record<string, readonly [number, number]>,
): ToyboxGraphNode {
  const opCount = g.nodes.filter(isOpNode).length;
  const xy = opSlotXY(opCount % 8);
  const node: ToyboxGraphNode = {
    id: nextNodeId(g, 'op'),
    kind,
    x: xy.x,
    y: xy.y,
    params: rollOpParams(rng, kind, overrides),
  };
  g.nodes.push(node);
  return node;
}

interface FoldSpec {
  /** 2-input blend ops folding each subsequent input over the accumulator. */
  blendPool: readonly ToyboxOpKind[];
  blendOverrides?: Record<string, readonly [number, number]>;
  /** Probability of inserting a 1-input transform BETWEEN two folds — the
   *  mid-chain restructuring that keeps rolled graphs from all being the
   *  same ladder (owner demand: randomize the GRAPH). */
  midPool?: readonly ToyboxOpKind[];
  midChance?: number;
}

/** Fold `inputs` (node ids: sources and/or locked-terminal ops) left-to-right
 *  into one accumulator id. Every input ends up load-bearing (R5 structural). */
function foldInputs(g: ToyboxCombineGraph, rng: ToyboxRng, inputs: readonly string[], spec: FoldSpec): string {
  if (inputs.length === 0) throw new RollError('fold of zero inputs');
  let acc = inputs[0]!;
  for (let i = 1; i < inputs.length; i++) {
    if (spec.midPool && spec.midPool.length > 0 && rng() < (spec.midChance ?? 0)) {
      const mid = addOp(g, rng, pick(rng, spec.midPool));
      connect(g, acc, mid.id, 'in0');
      acc = mid.id;
    }
    const op = addOp(g, rng, pick(rng, spec.blendPool), spec.blendOverrides);
    connect(g, acc, op.id, 'in0');
    connect(g, inputs[i]!, op.id, 'in1');
    acc = op.id;
  }
  return acc;
}

/** Apply 0..n 1-input post ops to `acc`, then wire OUT. */
function finishChain(
  g: ToyboxCombineGraph,
  rng: ToyboxRng,
  acc0: string,
  postPool: readonly ToyboxOpKind[],
  postMin: number,
  postMax: number,
): void {
  let acc = acc0;
  const postCount = postPool.length > 0 ? rollInt(rng, postMin, postMax) : 0;
  for (let i = 0; i < postCount; i++) {
    const op = addOp(g, rng, pick(rng, postPool));
    connect(g, acc, op.id, 'in0');
    acc = op.id;
  }
  connect(g, acc, 'out', 'in0');
}

// ---------------- Slot planning (index-aware, lock-respecting) ----------------

interface SlotPlan {
  /** The full LAYER_COUNT array (locked layers at their index, rolled content
   *  in free slots, OFF elsewhere). */
  layers: ToyboxLayer[];
  /** Node-id inputs for the fold, in composite order (base first): src ids of
   *  active layers not already consumed by the locked subgraph, then the
   *  locked subgraph's terminal ops. */
  inputs: string[];
}

/** Place locked layers, then context video, then `want` rolled content layers
 *  into free indexes; order the fold base-first (live base preferred). */
function planSlots(
  rng: ToyboxRng,
  ctx: ToyboxRandomContext,
  locks: LockPlan,
  content: ToyboxLayer[],
): { layers: ToyboxLayer[]; activeIdxs: number[] } {
  const layers: (ToyboxLayer | null)[] = Array.from({ length: LAYER_COUNT }, () => null);
  for (const [i, l] of locks.layers) layers[i] = clone(l);

  const freeIdx = (): number => layers.findIndex((l) => l === null);

  // Context video ports: satisfied by an existing LOCKED video layer on that
  // port, else claim a free slot. When locks fill every slot, honoring the
  // lock wins over the claim (R25 — locks are absolute) and the validator
  // relaxes accordingly.
  for (const port of ['inA', 'inB'] as const) {
    if (!ctx.videoIn[port]) continue;
    const already = layers.some((l) => l?.kind === 'video' && l.videoSource === port);
    if (already) continue;
    const idx = freeIdx();
    if (idx >= 0) layers[idx] = videoLayerFor(port);
  }

  for (const c of content) {
    const idx = freeIdx();
    if (idx < 0) break;
    layers[idx] = c;
  }

  const activeIdxs: number[] = [];
  layers.forEach((l, i) => {
    if (l && l.kind !== 'off') activeIdxs.push(i);
  });
  if (activeIdxs.length === 0) throw new RollError('no active layers to compose');

  // Base-first ordering: prefer a SELF-LIVE, non-DIM base (video feeds and
  // dim gens read black when they carry the frame alone — the owner-black
  // class), then shuffle the rest for variety.
  const score = (i: number): number => {
    const l = layers[i]!;
    if (l.kind === 'gen' && l.contentId && !DIM_GEN_CONTENT.has(l.contentId)) return 0;
    if (l.kind === 'obj') return 1;
    if (l.kind === 'shader' || l.kind === 'frag') return 2;
    if (l.kind === 'gen') return 3; // dim gen
    return 4; // video feeds — live only if the far end is
  };
  const ordered = [...activeIdxs].sort((a, b) => score(a) - score(b));
  const base = ordered[0]!;
  const rest = shuffled(rng, ordered.slice(1));
  return {
    layers: layers.map((l) => l ?? OFF_LAYER()),
    activeIdxs: [base, ...rest],
  };
}

/** Seed a graph with the base sources + the locked subgraph, and compute the
 *  fold inputs (src ids for active layers not consumed by the locked closure,
 *  then the closure terminals). */
function seedGraph(
  locks: LockPlan,
  activeIdxs: readonly number[],
): { g: ToyboxCombineGraph; inputs: string[] } {
  const g = baseGraph();
  for (const n of locks.nodes) g.nodes.push(clone(n));
  for (const e of locks.edges) g.edges.push(clone(e));
  const consumedSrcs = new Set(
    locks.edges.filter((e) => e.from.startsWith('src') && e.toPort !== undefined).map((e) => e.from),
  );
  const inputs: string[] = [];
  for (const i of activeIdxs) {
    if (!consumedSrcs.has(`src${i}`)) inputs.push(`src${i}`);
  }
  inputs.push(...locks.terminals);
  if (inputs.length === 0) {
    // Every active layer feeds the locked subgraph and the subgraph has no
    // terminal (it loops into taps) — nothing rollable reaches OUT. Refuse;
    // the fallback still runs and the validator explains.
    throw new RollError('locked subgraph consumes every input and exposes no terminal');
  }
  return { g, inputs };
}

// ---------------- The archetype table (R2 — structure first) ----------------

interface RolledStructure {
  layers: ToyboxLayer[];
  combine: ToyboxCombineGraph;
}

export interface ToyboxArchetype {
  id: string;
  /** REQUIRED — why this family earns its place. */
  why: string;
  weight: number;
  build(
    rng: ToyboxRng,
    ctx: ToyboxRandomContext,
    assets: ToyboxRandomAssets,
    locks: LockPlan,
  ): RolledStructure;
}

const MID_POOL: readonly ToyboxOpKind[] = ['tile', 'mirror', 'biocells'];

/** Shared chain family: plan slots → fold → posts. */
function buildChainFamily(
  rng: ToyboxRng,
  ctx: ToyboxRandomContext,
  locks: LockPlan,
  content: ToyboxLayer[],
  fold: FoldSpec,
  postPool: readonly ToyboxOpKind[],
  postMin: number,
  postMax: number,
): RolledStructure {
  const { layers, activeIdxs } = planSlots(rng, ctx, locks, content);
  const { g, inputs } = seedGraph(locks, activeIdxs);
  const acc = foldInputs(g, rng, inputs, fold);
  finishChain(g, rng, acc, postPool, postMin, postMax);
  return { layers, combine: g };
}

export const TOYBOX_ARCHETYPES: readonly ToyboxArchetype[] = [
  {
    id: 'soft-collage',
    why: 'gentle fade/over stack of 2-3 generators with occasional mid-chain tiling — the safe, always-valid family (and the fallback build)',
    weight: 1.3,
    build(rng, ctx, assets, locks) {
      const base = baseGenPool(assets);
      const any = genPool(assets);
      const n = rollInt(rng, 2, 3);
      const content = [rollGenLayer(rng, base)];
      for (let i = 1; i < n; i++) content.push(rollGenLayer(rng, any.length ? any : base));
      return buildChainFamily(
        rng, ctx, locks, content,
        { blendPool: ['fade', 'over'], midPool: MID_POOL, midChance: 0.3 },
        ['mirror', 'tile'], 0, 1,
      );
    },
  },
  {
    id: 'feedback-tunnel',
    why: 'a generator (or the patched feed) driven through FEEDBACK — the classic video-synth infinite-tunnel family',
    weight: 1.2,
    build(rng, ctx, assets, locks) {
      const base = baseGenPool(assets);
      const content = [rollGenLayer(rng, base)];
      if (rng() < 0.4) content.push(rollGenLayer(rng, base));
      const built = buildChainFamily(
        rng, ctx, locks, content,
        { blendPool: ['fade', 'over'], midPool: ['tile', 'mirror'], midChance: 0.25 },
        [], 0, 0,
      );
      // FEEDBACK is the family's signature — re-wire the final edge through it.
      const g = built.combine;
      const outEdge = g.edges.find((e) => e.to === 'out');
      if (!outEdge) throw new RollError('feedback-tunnel: no out edge');
      const prev = outEdge.from;
      g.edges.splice(g.edges.indexOf(outEdge), 1);
      const fb = addOp(g, rng, 'feedback');
      connect(g, prev, fb.id, 'in0');
      if (rng() < 0.5) {
        const post = addOp(g, rng, pick(rng, ['mirror', 'tile'] as const));
        connect(g, fb.id, post.id, 'in0');
        connect(g, post.id, 'out', 'in0');
      } else {
        connect(g, fb.id, 'out', 'in0');
      }
      return built;
    },
  },
  {
    id: 'keyed-collage',
    why: 'layers cut into each other with LUMAKEY — hard-edged video-collage looks the fade family cannot make',
    weight: 1.1,
    build(rng, ctx, assets, locks) {
      const base = baseGenPool(assets);
      const fx = fxPool(assets);
      const n = rollInt(rng, 2, 3);
      const content: ToyboxLayer[] = [rollGenLayer(rng, base)];
      for (let i = 1; i < n; i++) {
        const pool = fx.length > 0 && rng() < 0.3 ? fx : base;
        content.push(rollGenLayer(rng, pool));
      }
      return buildChainFamily(
        rng, ctx, locks, content,
        { blendPool: ['lumakey', 'lumakey', 'over'], midPool: MID_POOL, midChance: 0.25 },
        ['mirror', 'tile'], 0, 1,
      );
    },
  },
  {
    id: 'obj-scene',
    why: 'a matcap 3D mesh over a generative backdrop — the only family that shows the OBJ bank',
    weight: 1.0,
    build(rng, ctx, assets, locks) {
      if (assets.models.length === 0) throw new RollError('obj-scene: no models');
      const base = baseGenPool(assets);
      const content: ToyboxLayer[] = [];
      // Backdrop only when no live feed will claim the base slot.
      if (!ctx.videoIn.inA && !ctx.videoIn.inB) content.push(rollGenLayer(rng, base));
      content.push(rollObjLayer(rng, assets.models));
      return buildChainFamily(
        rng, ctx, locks, content,
        { blendPool: ['over'], blendOverrides: { amount: [0.75, 1] } },
        ['mirror', 'flowsmear'], 0, 1,
      );
    },
  },
  {
    id: 'glitch-chain',
    why: 'bitbend/desync/datamosh corruption over a live source — the datamosh-a-feed look, unreachable by blends alone',
    weight: 0.9,
    build(rng, ctx, assets, locks) {
      const base = baseGenPool(assets);
      const content = [rollGenLayer(rng, base)];
      if (rng() < 0.4) content.push(rollGenLayer(rng, base));
      return buildChainFamily(
        rng, ctx, locks, content,
        { blendPool: ['fade', 'over'] },
        ['bitbend', 'channeldesync', 'datamosh', 'biocells'], 1, 2,
      );
    },
  },
  {
    id: 'frag-post',
    why: 'a FRAG (scene-input Shadertoy) layer post-processing the stack — with a 1-in-4 LAYER-INPUT feedback-tap variant that processes the PREVIOUS frame',
    weight: 1.0,
    build(rng, ctx, assets, locks) {
      const frags = fragPool(assets);
      if (frags.length === 0) throw new RollError('frag-post: no FRAG content');
      const base = baseGenPool(assets);
      const frag = rollGenLayer(rng, frags);
      const tapped = rng() < 0.25;
      if (tapped) frag.sceneInputSource = 'layer-input';
      const content: ToyboxLayer[] = [];
      if (!ctx.videoIn.inA && !ctx.videoIn.inB) content.push(rollGenLayer(rng, base));
      content.push(frag);
      const built = buildChainFamily(
        rng, ctx, locks, content,
        { blendPool: ['fade'], blendOverrides: { amount: [0.6, 0.9] } },
        ['mirror', 'tile'], 0, 1,
      );
      if (tapped) {
        // Wire the pre-OUT composite into the FRAG layer's source-node tap:
        // resolved ONE FRAME LATE by the renderer (a legal layer-input edge,
        // dropped from same-frame cycle checks by design).
        const g = built.combine;
        const fragIdx = built.layers.findIndex((l) => l.kind === 'frag' && l.sceneInputSource === 'layer-input');
        const outEdge = g.edges.find((e) => e.to === 'out');
        if (fragIdx >= 0 && outEdge) connect(g, outEdge.from, `src${fragIdx}`, 'in0');
      }
      return built;
    },
  },
  {
    id: 'branch-merge',
    why: 'TWO sub-chains merged by a 2-input op (displace/melt/screen) — the diamond topology a single ladder can never roll, and the flagship of graph-restructuring',
    weight: 1.0,
    build(rng, ctx, assets, locks) {
      const base = baseGenPool(assets);
      const any = genPool(assets);
      const n = rollInt(rng, 3, 4);
      const content = [rollGenLayer(rng, base)];
      for (let i = 1; i < n; i++) content.push(rollGenLayer(rng, any.length ? any : base));
      const { layers, activeIdxs } = planSlots(rng, ctx, locks, content);
      const { g, inputs } = seedGraph(locks, activeIdxs);
      if (inputs.length < 2) {
        // A diamond needs two arms — degrade to a plain fold (still valid).
        finishChain(g, rng, foldInputs(g, rng, inputs, { blendPool: ['fade', 'over'] }), [], 0, 0);
        return { layers, combine: g };
      }
      const split = Math.max(1, Math.min(inputs.length - 1, rollInt(rng, 1, inputs.length - 1)));
      const armA = foldInputs(g, rng, inputs.slice(0, split), {
        blendPool: ['fade', 'over'],
        midPool: MID_POOL,
        midChance: 0.3,
      });
      const armB = foldInputs(g, rng, inputs.slice(split), {
        blendPool: ['fade', 'over', 'lumakey'],
        midPool: MID_POOL,
        midChance: 0.3,
      });
      const merge = addOp(g, rng, pick(rng, ['displace', 'over', 'dreammelt', 'map'] as const));
      connect(g, armA, merge.id, 'in0');
      connect(g, armB, merge.id, 'in1');
      finishChain(g, rng, merge.id, ['mirror', 'tile'], 0, 1);
      return { layers, combine: g };
    },
  },
  {
    id: 'exquisite-splice',
    why: 'the multi-input EXQUISITE band splicer over 3-4 sources — the one N-ary topology in the table',
    weight: 0.8,
    build(rng, ctx, assets, locks) {
      const base = baseGenPool(assets);
      const n = rollInt(rng, 3, 4);
      const content = Array.from({ length: n }, () => rollGenLayer(rng, base));
      const { layers, activeIdxs } = planSlots(rng, ctx, locks, content);
      const { g, inputs } = seedGraph(locks, activeIdxs);
      const feeds = inputs.slice(0, 4);
      if (feeds.length < 2) throw new RollError('exquisite needs 2+ feeds');
      const ex = addOp(g, rng, 'exquisite');
      feeds.forEach((f, i) => connect(g, f, ex.id, `in${i}` as ToyboxInPort));
      // Any inputs beyond four still must be load-bearing — fold them over.
      let acc: string = ex.id;
      for (const extra of inputs.slice(4)) {
        const op = addOp(g, rng, 'over');
        connect(g, acc, op.id, 'in0');
        connect(g, extra, op.id, 'in1');
        acc = op.id;
      }
      finishChain(g, rng, acc, [], 0, 0);
      return { layers, combine: g };
    },
  },
];

const FALLBACK_ARCHETYPE_ID = 'soft-collage';

/** The known-good build (R24): fixed-shape soft collage — used after
 *  MAX_BUILD_ATTEMPTS validation failures so a press can never fail. Honors
 *  locks and context exactly like a normal build. */
function buildFallback(
  rng: ToyboxRng,
  ctx: ToyboxRandomContext,
  assets: ToyboxRandomAssets,
  locks: LockPlan,
): RolledStructure {
  const base = baseGenPool(assets);
  if (base.length === 0 && locks.layers.size === 0 && !ctx.videoIn.inA && !ctx.videoIn.inB) {
    // Nothing can carry a frame: no carrier-grade content, no locked layers,
    // no patched feed. Refuse LOUDLY — a black patch is worse than an error.
    throw new Error('TOYBOX randomize: no content assets available');
  }
  const content: ToyboxLayer[] = [];
  if (base.length > 0) content.push(rollGenLayer(rng, base), rollGenLayer(rng, base));
  const { layers, activeIdxs } = planSlots(rng, ctx, locks, content);
  const { g, inputs } = seedGraph(locks, activeIdxs);
  const acc = foldInputs(g, rng, inputs, {
    blendPool: ['fade'],
    blendOverrides: { amount: [0.5, 0.5] },
  });
  finishChain(g, rng, acc, [], 0, 0);
  return { layers, combine: g };
}

// ---------------- CV routing (context R13) ----------------

interface RouteCandidate {
  route: CvRouteTarget;
  key: string;
}

/** Params a cv port could drive, enumerated from the ENGINE's own knowledge.
 *  LOCKED elements are excluded — the user pinned them to stay as they are,
 *  so the dice must not point a NEW modulation at them (existing routes to
 *  locked targets are preserved separately). */
function routeCandidates(
  layers: readonly ToyboxLayer[],
  combine: ToyboxCombineGraph,
  assets: ToyboxRandomAssets,
  locks: LockPlan,
): RouteCandidate[] {
  const out: RouteCandidate[] = [];
  const lockedNodeIds = new Set(locks.nodes.map((n) => n.id));
  for (const n of combine.nodes) {
    if (!isOpNode(n) || lockedNodeIds.has(n.id)) continue;
    for (const def of OP_PARAMS[n.kind as ToyboxOpKind] ?? []) {
      if (def.options || def.id === 'mode') continue;
      out.push({ route: { target: 'combine', nodeId: n.id, param: def.id }, key: `combine:${n.id}:${def.id}` });
    }
  }
  layers.forEach((layer, i) => {
    if (locks.layers.has(i)) return;
    if (layer.kind === 'obj' && layer.material) {
      for (const p of MATERIAL_PARAMS) {
        out.push({ route: { target: 'layer', layer: i, param: p.id }, key: `layer:${i}:${p.id}` });
      }
      return;
    }
    if (layer.kind === 'video' || layer.kind === 'image') {
      for (const p of IMAGE_VIDEO_PARAMS) {
        out.push({ route: { target: 'layer', layer: i, param: p.id }, key: `layer:${i}:${p.id}` });
      }
      return;
    }
    if (layer.kind === 'gen' || layer.kind === 'shader' || layer.kind === 'frag') {
      const meta = assets.content.find((c) => c.id === layer.contentId);
      for (const p of meta?.params ?? []) {
        if (p.curve === 'discrete') continue;
        out.push({ route: { target: 'layer', layer: i, param: p.id }, key: `layer:${i}:${p.id}` });
      }
    }
  });
  return out;
}

function buildCvRoutes(
  rng: ToyboxRng,
  ctx: ToyboxRandomContext,
  layers: readonly ToyboxLayer[],
  combine: ToyboxCombineGraph,
  assets: ToyboxRandomAssets,
  locks: LockPlan,
): CvRoutes {
  const routes: CvRoutes = {};
  for (const [port, route] of locks.routes) routes[port] = clone(route);
  const ports = CV_PORT_IDS.filter((p) => ctx.cv[p] !== undefined && routes[p] === undefined);
  if (ports.length === 0) return routes;
  const candidates = shuffled(rng, routeCandidates(layers, combine, assets, locks));
  if (candidates.length === 0) throw new RollError('no cv route candidates in rolled result');
  let cursor = 0;
  for (const port of ports) {
    const cand = candidates[cursor % candidates.length]!;
    cursor++;
    routes[port] = { ...cand.route };
  }
  return routes;
}

// ---------------- Validation (R5/R23 — generate-and-test) ----------------

const SELF_ALIVE_KINDS: ReadonlySet<string> = new Set(['gen', 'shader', 'frag', 'obj']);

/** True for a layer that can carry the frame alone: self-alive AND not a
 *  DIM generator (the owner-black class). */
function layerCarries(layer: ToyboxLayer | undefined, ctx: ToyboxRandomContext): boolean {
  if (!layer) return false;
  if (layer.kind === 'gen' || layer.kind === 'shader' || layer.kind === 'frag') {
    return !(layer.contentId && DIM_GEN_CONTENT.has(layer.contentId));
  }
  if (layer.kind === 'obj') return true;
  if (layer.kind === 'video') {
    return (
      (layer.videoSource === 'inA' && ctx.videoIn.inA) ||
      (layer.videoSource === 'inB' && ctx.videoIn.inB)
    );
  }
  return false;
}

function isLayerInputEdgeIn(g: ToyboxCombineGraph, e: ToyboxGraphEdge): boolean {
  if (e.toPort !== 'in0') return false;
  const to = g.nodes.find((n) => n.id === e.to);
  return to?.kind === 'source';
}

/** Node ids that can reach OUT over the same-frame edge set (taps excluded —
 *  they are resolved a frame late and must not fake reachability). */
function reachesOut(g: ToyboxCombineGraph): Set<string> {
  const into = new Map<string, string[]>();
  for (const e of g.edges) {
    if (isLayerInputEdgeIn(g, e)) continue;
    if (!into.has(e.to)) into.set(e.to, []);
    into.get(e.to)!.push(e.from);
  }
  const seen = new Set<string>();
  const stack = ['out'];
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const prev of into.get(cur) ?? []) stack.push(prev);
  }
  return seen;
}

function routeResolves(
  route: CvRouteTarget,
  layers: readonly ToyboxLayer[],
  combine: ToyboxCombineGraph,
  assets: ToyboxRandomAssets,
): boolean {
  if (route.target === 'combine') {
    const n = combine.nodes.find((x) => x.id === route.nodeId);
    if (!n || !isOpNode(n)) return false;
    return (OP_PARAMS[n.kind as ToyboxOpKind] ?? []).some((p) => p.id === route.param);
  }
  const layer = layers[route.layer ?? -1];
  if (!layer) return false;
  if (layer.kind === 'obj') return MATERIAL_PARAMS.some((p) => p.id === route.param);
  if (layer.kind === 'video' || layer.kind === 'image') {
    return IMAGE_VIDEO_PARAMS.some((p) => p.id === route.param);
  }
  if (layer.kind === 'gen' || layer.kind === 'shader' || layer.kind === 'frag') {
    const meta = assets.content.find((c) => c.id === layer.contentId);
    return (meta?.params ?? []).some((p) => p.id === route.param);
  }
  return false;
}

function assertValidRoll(
  blob: ToyboxRollBlob,
  ctx: ToyboxRandomContext,
  assets: ToyboxRandomAssets,
  locks: LockPlan,
): void {
  const { layers, combine, cvRoutes } = blob;
  if (!Array.isArray(layers) || layers.length !== LAYER_COUNT) {
    throw new RollError(`layers.length ${layers?.length} !== LAYER_COUNT`);
  }
  if (!outputNode(combine)) throw new RollError('no output node');
  const sorted = topoSort(combine);
  if (!sorted.ok) throw new RollError('combine graph has a cycle / stranded node');
  const replay: ToyboxCombineGraph = { nodes: combine.nodes, edges: [] };
  for (const e of combine.edges as ToyboxGraphEdge[]) {
    const res = validateConnect(replay, e.from, e.to, e.toPort);
    if (!res.ok) throw new RollError(`edge ${e.id} replays as ${res.error}`);
    replay.edges.push(e);
  }
  // Liveness: at least one CARRIER layer reaches OUT (dim gens and dead feeds
  // cannot be the only thing on screen — the owner-black class).
  const reach = reachesOut(combine);
  const carrierReaches = combine.nodes.some(
    (n) => n.kind === 'source' && reach.has(n.id) && layerCarries(layers[n.layer ?? -1], ctx),
  );
  if (!carrierReaches) throw new RollError('no carrier layer reaches OUT');
  // Context: every patched video port is a live, load-bearing layer source —
  // unless LOCKS made that claim impossible (locks are absolute, R25). The
  // feasibility rule mirrors the planner's claiming exactly: a locked video
  // layer on the port satisfies it outright; otherwise it needs one of the
  // slots locks left free, consumed in inA→inB order.
  let freeSlots = LAYER_COUNT - locks.layers.size;
  for (const port of ['inA', 'inB'] as const) {
    if (!ctx.videoIn[port]) continue;
    const satisfiedByLock = [...locks.layers.values()].some(
      (l) => l.kind === 'video' && l.videoSource === port,
    );
    const required = satisfiedByLock || freeSlots > 0;
    if (!satisfiedByLock && freeSlots > 0) freeSlots--;
    if (!required) continue;
    const claimed = combine.nodes.some((n) => {
      if (n.kind !== 'source' || !reach.has(n.id)) return false;
      const layer = layers[n.layer ?? -1];
      return layer?.kind === 'video' && layer.videoSource === port;
    });
    if (!claimed) throw new RollError(`patched ${port} not load-bearing in roll`);
  }
  // Context: every patched cv port routes to a param that exists.
  for (const port of CV_PORT_IDS) {
    if (ctx.cv[port] === undefined) continue;
    const route = cvRoutes[port];
    if (!route) throw new RollError(`patched ${port} has no route`);
    if (!routeResolves(route, layers, combine, assets)) {
      throw new RollError(`route for ${port} does not resolve`);
    }
  }
  for (const [port, route] of Object.entries(cvRoutes)) {
    if (route && !routeResolves(route, layers, combine, assets)) {
      throw new RollError(`route for ${port} is orphaned at birth`);
    }
  }
  // LOCK invariants (R12 — absolute, not advisory):
  for (const [i, lockedLayer] of locks.layers) {
    if (JSON.stringify(layers[i]) !== JSON.stringify(lockedLayer)) {
      throw new RollError(`locked layer ${i} changed across the roll`);
    }
  }
  for (const lockedNode of locks.nodes) {
    const got = combine.nodes.find((n) => n.id === lockedNode.id);
    if (!got || JSON.stringify(got) !== JSON.stringify(lockedNode)) {
      throw new RollError(`locked node ${lockedNode.id} changed across the roll`);
    }
  }
  for (const le of locks.edges) {
    const present = (combine.edges as ToyboxGraphEdge[]).some(
      (e) => e.from === le.from && e.to === le.to && e.toPort === le.toPort,
    );
    if (!present) throw new RollError(`locked edge ${le.from}→${le.to}:${le.toPort} lost`);
  }
  for (const [port, route] of locks.routes) {
    if (JSON.stringify(cvRoutes[port]) !== JSON.stringify(route)) {
      throw new RollError(`locked route on ${port} changed across the roll`);
    }
  }
}

// ---------------- Generate ----------------

export const MAX_BUILD_ATTEMPTS = 8;
export const ANTI_REPEAT_MEMORY = 2;

function pickArchetype(rng: ToyboxRng, exclude: readonly string[]): ToyboxArchetype {
  const filtered = TOYBOX_ARCHETYPES.filter((a) => !exclude.includes(a.id));
  const table = filtered.length > 0 ? filtered : TOYBOX_ARCHETYPES;
  return pickWeighted(rng, table.map((a) => [a, a.weight] as const));
}

/**
 * PURE seeded generator. `current` carries the lock constraints (flags riding
 * the layer/node objects) and the existing cvRoutes; omit it to roll free.
 */
export function generateToyboxPatch(
  seed: number,
  ctx: ToyboxRandomContext = EMPTY_TOYBOX_CONTEXT,
  assets: ToyboxRandomAssets,
  exclude: readonly string[] = [],
  current?: ToyboxCurrentState,
): ToyboxRollResult {
  const rng = mulberry32(seed);
  const locks = extractLocks(current);
  for (let attempt = 0; attempt < MAX_BUILD_ATTEMPTS; attempt++) {
    const archetype = pickArchetype(rng, exclude);
    try {
      const structure = archetype.build(rng, ctx, assets, locks);
      const cvRoutes = buildCvRoutes(rng, ctx, structure.layers, structure.combine, assets, locks);
      const blob: ToyboxRollBlob = { layers: structure.layers, combine: structure.combine, cvRoutes };
      assertValidRoll(blob, ctx, assets, locks);
      return { blob, archetypeId: archetype.id, seed, fellBack: false };
    } catch (err) {
      if (!(err instanceof RollError)) throw err;
    }
  }
  const structure = buildFallback(rng, ctx, assets, locks);
  const cvRoutes = buildCvRoutes(rng, ctx, structure.layers, structure.combine, assets, locks);
  const blob: ToyboxRollBlob = { layers: structure.layers, combine: structure.combine, cvRoutes };
  assertValidRoll(blob, ctx, assets, locks);
  return { blob, archetypeId: FALLBACK_ARCHETYPE_ID, seed, fellBack: true };
}

// ---------------- The registry-backed wrapper (what the card calls) ----------------

export interface ToyboxRollOptions {
  seed?: number;
  context?: ToyboxRandomContext;
  exclude?: readonly string[];
  assets?: ToyboxRandomAssets;
  /** The node's current data slice — locks + preserved routes come from here. */
  current?: ToyboxCurrentState;
}

export function rollToyboxPatch(opts: ToyboxRollOptions = {}): ToyboxRollResult {
  const seed = opts.seed ?? Math.floor(Math.random() * 0x7fffffff);
  const assets: ToyboxRandomAssets = opts.assets ?? {
    content: listedContent(),
    models: listedModels(),
  };
  return generateToyboxPatch(
    seed,
    opts.context ?? EMPTY_TOYBOX_CONTEXT,
    assets,
    opts.exclude ?? [],
    opts.current,
  );
}

// ---------------- Revert-with-locks (the card's REVERT semantics) ----------------

/**
 * Merge a PRE-ROLL snapshot with the CURRENT state so that REVERT honors
 * locks exactly like a roll does (locks constrain the whole dice loop, not
 * just the forward direction — documented owner-facing in PR #2031):
 *
 *   - unlocked scope returns to the snapshot;
 *   - a LOCKED layer keeps its CURRENT content at its index;
 *   - a LOCKED node (+ closure) survives: byte-kept when the restored graph
 *     still contains its id, otherwise carried over with its feeds appended
 *     (visible in the editor, reconnectable — never silently dropped);
 *   - cv routes targeting locked elements survive.
 *
 * PURE — returns the blob for restoreToyboxRollScope-style application (null
 * `pre` fields mean "delete that key", matching the scoped-restore contract).
 */
export function mergeRevertWithLocks(
  pre: Record<string, unknown> | null,
  current: ToyboxCurrentState | undefined,
): Record<string, unknown> | null {
  const locks = extractLocks(current);
  if (locks.layers.size === 0 && locks.nodes.length === 0 && locks.routes.length === 0) return pre;
  const out: Record<string, unknown> = pre ? clone(pre) : {};

  if (locks.layers.size > 0) {
    const layers: ToyboxLayer[] = Array.isArray(out.layers)
      ? (out.layers as ToyboxLayer[]).slice(0, LAYER_COUNT)
      : [];
    while (layers.length < LAYER_COUNT) layers.push(OFF_LAYER());
    for (const [i, l] of locks.layers) layers[i] = clone(l);
    out.layers = layers;
  }

  if (locks.nodes.length > 0) {
    const g: ToyboxCombineGraph = isCombineGraph(out.combine)
      ? (out.combine as ToyboxCombineGraph)
      : baseGraph();
    for (const n of locks.nodes) {
      const idx = g.nodes.findIndex((x) => x.id === n.id);
      if (idx >= 0) g.nodes[idx] = clone(n);
      else g.nodes.push(clone(n));
    }
    for (const e of locks.edges) {
      const clash = g.edges.some((x) => x.to === e.to && x.toPort === e.toPort && !(x.from === e.from));
      const present = g.edges.some((x) => x.from === e.from && x.to === e.to && x.toPort === e.toPort);
      if (!present && !clash) g.edges.push(clone(e));
    }
    out.combine = g;
  }

  if (locks.routes.length > 0) {
    const routes: CvRoutes = (out.cvRoutes as CvRoutes | undefined) ?? {};
    for (const [port, route] of locks.routes) routes[port] = clone(route);
    out.cvRoutes = routes;
  }
  return out;
}
