// packages/web/src/lib/video/toybox-random.ts
//
// TOYBOX RANDOMIZE — the pure, seeded dice engine (#1576, workstream 4).
//
// `generateToyboxPatch(seed, context, assets, exclude)` is a PURE function:
// same seed + same context + same assets ⇒ byte-identical result. It never
// touches Yjs, never fetches, never reads the asset registry — the thin
// `rollToyboxPatch()` wrapper below threads the live provider lists in
// (listedContent()/listedModels(), the #1710 seam), and the CARD applies the
// returned blob through the existing preset machinery
// (applyDataBlobToNode → one LOCAL_ORIGIN transact ⇒ one Cmd-Z per roll).
//
// Design per the prior-art distillation (.myrobots/2026-08-13-random-preset-
// prior-art.md, R1–R25):
//
//   - CURATED, not uniform (R1): scalars roll from designer-tuned sub-ranges
//     (CURATED_OP_RANGES; content uniforms jitter around their manifest
//     default with an occasional full-range draw for heavy tails, R8).
//   - STRUCTURE first (R2): a weighted ARCHETYPE table hand-designs topology
//     families; content + scalars are drawn inside the chosen structure.
//   - LIVENESS by construction (R5): every archetype folds all of its active
//     layers into a single chain that terminates at OUT, so every active
//     layer is load-bearing; a bounded reject-and-retry loop re-rolls on any
//     validation failure and a known-good fallback build makes a press
//     structurally unable to fail (R24).
//   - CONTEXT-aware (R13): patched video inputs (inA/inB) become mandatory
//     live video layers in every roll; every patched cv port gets a route to
//     a param that exists in the result. Rack edges are never touched.
//   - EXCLUSIONS (R4): the blob carries ONLY `layers`, `combine`, `cvRoutes`.
//     `applyDataBlobToData` writes only the fields present in the blob, so a
//     roll structurally cannot touch node name, layout state, or the cvInputs
//     attenuverters.
//   - ANTI-REPEAT (R7): the caller passes recent archetype ids; the picker
//     excludes them (unless that would empty the table).
//
// Locks (workstream 3) are NOT built yet; the signature deliberately takes no
// lock argument so adding one is an extension, not a rebuild.

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
  opSlotXY,
  outputNode,
  topoSort,
  validateConnect,
  type ToyboxCombineGraph,
  type ToyboxGraphEdge,
  type ToyboxGraphNode,
  type ToyboxInPort,
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
  /** Which video input ports carry an inbound cable. */
  videoIn: { inA: boolean; inB: boolean };
  /** Patched generic cv ports (cv1..cv6) → the inbound edge's signal kind.
   *  Unpatched ports are ABSENT (never 'idle'). */
  cv: Record<string, 'cv' | 'gate' | 'audio'>;
}

/** The asset pools the dice draw from — the provider-seam lists. Passed in so
 *  the engine stays pure (tests use fixtures; the wrapper passes the live
 *  registry lists). */
export interface ToyboxRandomAssets {
  content: readonly ToyboxContent[];
  models: readonly ToyboxModel[];
}

/** The blob a roll produces — EXACTLY the three fields a roll may touch (R4/
 *  R25). applyDataBlobToData writes only fields present on the blob, so
 *  name/combineView/cvInputs/rack-edges are untouchable by construction. */
export interface ToyboxRollBlob {
  layers: ToyboxLayer[];
  combine: ToyboxCombineGraph;
  cvRoutes: CvRoutes;
  [key: string]: unknown; // structural compat with applyDataBlobToData
}

export interface ToyboxRollResult {
  blob: ToyboxRollBlob;
  /** Which archetype produced the patch (anti-repeat memory + tests). */
  archetypeId: string;
  /** The seed that produced it (replayable via __toyboxRoll(seed)). */
  seed: number;
  /** True when the seeded build failed validation `MAX_BUILD_ATTEMPTS` times
   *  and the known-good fallback build was used instead (R24). */
  fellBack: boolean;
}

export const EMPTY_TOYBOX_CONTEXT: ToyboxRandomContext = Object.freeze({
  videoIn: Object.freeze({ inA: false, inB: false }),
  cv: Object.freeze({}),
}) as ToyboxRandomContext;

// ---------------- Curated ranges (R1 — the content-design half) ----------------

/** Curated ABSOLUTE roll ranges per op param. A param listed here rolls
 *  uniformly inside this sub-range; an unlisted param jitters around its
 *  OP_PARAMS default (±25% of full range). These are the designed-out dead
 *  zones: a fade at 0 erases its top layer, a feedback decay at 1.5 whites
 *  out, a lumakey threshold at 1 keys nothing. */
const CURATED_OP_RANGES: Partial<Record<ToyboxOpKind, Record<string, readonly [number, number]>>> = {
  fade: { amount: [0.35, 0.8] },
  over: { amount: [0.55, 1] },
  lumakey: { amount: [0.3, 0.65], soft: [0.15, 0.5] },
  map: { amount: [0.5, 1] },
  feedback: {
    zoom: [0.9, 0.99],
    rotate: [-0.35, 0.35],
    decay: [0.8, 0.97],
    intensity: [0.5, 0.9],
    gain: [0.9, 1.15],
    blur: [0, 2],
  },
  tile: { tilesX: [2, 6], tilesY: [2, 6], rotate: [-0.6, 0.6], offX: [-0.3, 0.3], offY: [-0.3, 0.3] },
  mirror: { segments: [4, 10] },
  displace: { amount: [0.05, 0.25] },
  bitbend: { mask: [32, 200] },
  biocells: { cellCount: [8, 40], lumaJitter: [0.2, 0.7], edgeWidth: [0.1, 0.5] },
  framedelay: { delay: [4, 24], mix: [0.4, 0.8] },
  channeldesync: { rDelay: [0, 16], gDelay: [0, 16], bDelay: [0, 16], offsetMag: [0.02, 0.15] },
  flowsmear: { flowStrength: [0.3, 0.8], noiseScale: [1, 6], persistence: [0.7, 0.92] },
  dreammelt: { meltAmount: [0.3, 0.8], dripSpeed: [0.15, 0.6], threshold: [0.3, 0.7] },
  datamosh: { flowScale: [0.5, 1], holdGate: [0.15, 0.5], decay: [0.85, 0.97] },
  exquisite: { bands: [3, 6], boundaryWarp: [0.1, 0.5], seamBlend: [0.05, 0.3] },
};

/** Op params that must land on integers (grid counts, frame delays, discrete
 *  masks). `options` params are integral by definition and handled separately. */
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

/** Roll every param an op declares: curated range when listed, options →
 *  uniform choice, otherwise default-centred jitter (±25% of range). Every
 *  param gets an explicit value so the result is deterministic + auditable
 *  (nothing silently rides an OP_PARAMS default that later changes). */
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
  // Ops whose 0/1 flags are effectively booleans: keep at least one bitbend
  // channel bent, or the op is an expensive identity.
  if (kind === 'bitbend') {
    out.perR = rng() < 0.7 ? 1 : 0;
    out.perG = rng() < 0.7 ? 1 : 0;
    out.perB = rng() < 0.7 ? 1 : 0;
    if (!out.perR && !out.perG && !out.perB) out.perG = 1;
  }
  if (kind === 'lumakey') out.invert = rng() < 0.25 ? 1 : 0;
  return out;
}

/** Roll a content entry's declared uniforms: mostly a default-centred jitter
 *  (±35% of range), with a 1-in-10 full-range draw (R8 — rare gems), discrete
 *  params on integers. */
function rollContentParams(rng: ToyboxRng, content: ToyboxContent): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of content.params) {
    let v: number;
    if (rng() < 0.1) {
      v = rollRange(rng, p.min, p.max);
    } else {
      v = clamp(p.default + (rng() * 2 - 1) * 0.35 * (p.max - p.min), p.min, p.max);
    }
    if (p.curve === 'discrete') v = Math.round(v);
    out[p.id] = clamp(v, p.min, p.max);
  }
  return out;
}

// ---------------- Asset pools ----------------

function genPool(assets: ToyboxRandomAssets): ToyboxContent[] {
  return assets.content.filter((c) => c.family === 'GEN' && !c.inlineSource);
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
  // Bright-ish tints only — a near-black tint is a designed-out dead zone (R5).
  material.tintR = rollRange(rng, 0.55, 1);
  material.tintG = rollRange(rng, 0.55, 1);
  material.tintB = rollRange(rng, 0.55, 1);
  return { kind: 'obj', contentId: null, params: {}, material };
}

/** A live PATCHED-FEED video layer for a context port. Full opacity/brightness
 *  — the feed is the user's material and must be unmistakably present (R13). */
function videoLayerFor(port: 'inA' | 'inB'): ToyboxLayer {
  return { kind: 'video', contentId: null, params: { opacity: 1, brightness: 1 }, videoSource: port };
}

/** The context-mandated video layers, in stable port order. */
function contextVideoLayers(ctx: ToyboxRandomContext): ToyboxLayer[] {
  const out: ToyboxLayer[] = [];
  if (ctx.videoIn.inA) out.push(videoLayerFor('inA'));
  if (ctx.videoIn.inB) out.push(videoLayerFor('inB'));
  return out;
}

// ---------------- Graph assembly ----------------

/** Start a graph containing the four structural SOURCE nodes + OUTPUT (the
 *  same fixed ids/positions makeDefaultCombineGraph uses, so the editor and
 *  every id-keyed consumer see a familiar shape). */
function baseGraph(): ToyboxCombineGraph {
  const nodes: ToyboxGraphNode[] = [];
  for (let i = 0; i < LAYER_COUNT; i++) {
    nodes.push({ id: `src${i}`, kind: 'source', layer: i, x: 14, y: 14 + i * 52 });
  }
  nodes.push({ id: 'out', kind: 'output', x: 286, y: 66 });
  return { nodes, edges: [] };
}

/** Add an edge through validateConnect — the SAME gate the editor uses — so a
 *  generator bug (occupied port, cycle, bad port) is impossible to emit; it
 *  throws a RollError the retry loop converts into a re-roll. */
function connect(g: ToyboxCombineGraph, from: string, to: string, toPort: ToyboxInPort): void {
  const res = validateConnect(g, from, to, toPort);
  if (!res.ok || !res.edge) throw new RollError(`connect ${from}→${to}:${toPort} rejected (${res.error})`);
  g.edges.push(res.edge);
}

let opSeq = 0; // reset per build — ids only need uniqueness within one graph

function addOp(
  g: ToyboxCombineGraph,
  rng: ToyboxRng,
  kind: ToyboxOpKind,
  overrides?: Record<string, readonly [number, number]>,
): ToyboxGraphNode {
  const xy = opSlotXY(opSeq % 8);
  const node: ToyboxGraphNode = {
    id: `op${++opSeq}`,
    kind,
    x: xy.x,
    y: xy.y,
    params: rollOpParams(rng, kind, overrides),
  };
  g.nodes.push(node);
  return node;
}

interface ChainSpec {
  /** Ordered active layers; index in this array = layer index; [0] is the base. */
  slots: ToyboxLayer[];
  /** 2-input blend ops folding each subsequent layer over the accumulator. */
  blendPool: readonly ToyboxOpKind[];
  /** Curated overrides for the blend rolls (e.g. frag-post wants high fade). */
  blendOverrides?: Record<string, readonly [number, number]>;
  /** 1-input post ops applied to the folded composite before OUT. */
  postPool: readonly ToyboxOpKind[];
  postMin: number;
  postMax: number;
}

/** Fold `slots` into a left-to-right blend chain, then 0..N post ops, then
 *  OUT. Every active layer is wired into the chain ⇒ load-bearing by
 *  construction (the R5 liveness argument is structural, not statistical). */
function buildChain(rng: ToyboxRng, spec: ChainSpec): { layers: ToyboxLayer[]; combine: ToyboxCombineGraph } {
  if (spec.slots.length === 0 || spec.slots.length > LAYER_COUNT) {
    throw new RollError(`chain wants ${spec.slots.length} slots`);
  }
  opSeq = 0;
  const g = baseGraph();
  let acc = 'src0';
  for (let i = 1; i < spec.slots.length; i++) {
    const op = addOp(g, rng, pick(rng, spec.blendPool), spec.blendOverrides);
    connect(g, acc, op.id, 'in0');
    connect(g, `src${i}`, op.id, 'in1');
    acc = op.id;
  }
  const postCount = rollInt(rng, spec.postMin, spec.postMax);
  for (let i = 0; i < postCount && spec.postPool.length > 0; i++) {
    const op = addOp(g, rng, pick(rng, spec.postPool));
    connect(g, acc, op.id, 'in0');
    acc = op.id;
  }
  connect(g, acc, 'out', 'in0');

  const layers: ToyboxLayer[] = [];
  for (let i = 0; i < LAYER_COUNT; i++) {
    layers.push(spec.slots[i] ?? { kind: 'off', contentId: null, params: {} });
  }
  return { layers, combine: g };
}

/** Merge the context's mandatory video layers with the archetype's rolled
 *  content slots (video first ~half the time, capped at LAYER_COUNT, video
 *  never dropped). */
function mergeSlots(rng: ToyboxRng, videos: ToyboxLayer[], content: ToyboxLayer[]): ToyboxLayer[] {
  const keepContent = content.slice(0, Math.max(1, LAYER_COUNT - videos.length));
  const videoFirst = rng() < 0.5;
  const merged = videoFirst ? [...videos, ...keepContent] : [keepContent[0]!, ...videos, ...keepContent.slice(1)];
  return merged.slice(0, LAYER_COUNT);
}

// ---------------- The archetype table (R2 — structure first) ----------------

interface RolledStructure {
  layers: ToyboxLayer[];
  combine: ToyboxCombineGraph;
}

export interface ToyboxArchetype {
  id: string;
  /** REQUIRED — why this family earns its place (the shape-in-the-type
   *  pattern; tsc refuses an undeclared entry). */
  why: string;
  weight: number;
  build(rng: ToyboxRng, ctx: ToyboxRandomContext, assets: ToyboxRandomAssets): RolledStructure;
}

export const TOYBOX_ARCHETYPES: readonly ToyboxArchetype[] = [
  {
    id: 'soft-collage',
    why: 'gentle fade/over stack of 2-3 generators — the safe, always-valid family (and the fallback build)',
    weight: 1.4,
    build(rng, ctx, assets) {
      const gens = genPool(assets);
      const vids = contextVideoLayers(ctx);
      const n = rollInt(rng, 2, 3);
      const content = Array.from({ length: n }, () => rollGenLayer(rng, gens));
      return buildChain(rng, {
        slots: mergeSlots(rng, vids, content),
        blendPool: ['fade', 'over'],
        postPool: [],
        postMin: 0,
        postMax: 0,
      });
    },
  },
  {
    id: 'feedback-tunnel',
    why: 'a generator (or the patched feed) driven through FEEDBACK — the classic video-synth infinite-tunnel family',
    weight: 1.2,
    build(rng, ctx, assets) {
      const gens = genPool(assets);
      const vids = contextVideoLayers(ctx);
      const content = [rollGenLayer(rng, gens)];
      if (rng() < 0.4) content.push(rollGenLayer(rng, gens));
      const spec: ChainSpec = {
        slots: mergeSlots(rng, vids, content),
        blendPool: ['fade', 'over'],
        postPool: rng() < 0.5 ? ['mirror', 'tile'] : [],
        postMin: 0,
        postMax: 1,
      };
      const built = buildChain(rng, spec);
      // FEEDBACK is the family's signature — always present, wired between the
      // chain's last op and OUT (re-wire the final edge through it).
      const g = built.combine;
      const outEdge = g.edges.find((e) => e.to === 'out');
      if (!outEdge) throw new RollError('feedback-tunnel: no out edge');
      const fb = addOp(g, rng, 'feedback');
      const prev = outEdge.from;
      g.edges.splice(g.edges.indexOf(outEdge), 1);
      connect(g, prev, fb.id, 'in0');
      connect(g, fb.id, 'out', 'in0');
      return built;
    },
  },
  {
    id: 'keyed-collage',
    why: 'layers cut into each other with LUMAKEY — hard-edged video-collage looks the fade family cannot make',
    weight: 1.1,
    build(rng, ctx, assets) {
      const gens = genPool(assets);
      const fx = fxPool(assets);
      const vids = contextVideoLayers(ctx);
      const n = rollInt(rng, 2, 3);
      const content: ToyboxLayer[] = [rollGenLayer(rng, gens)];
      for (let i = 1; i < n; i++) {
        const pool = fx.length > 0 && rng() < 0.3 ? fx : gens;
        content.push(rollGenLayer(rng, pool));
      }
      return buildChain(rng, {
        slots: mergeSlots(rng, vids, content),
        blendPool: ['lumakey', 'lumakey', 'over'],
        postPool: ['mirror', 'tile'],
        postMin: 0,
        postMax: 1,
      });
    },
  },
  {
    id: 'obj-scene',
    why: 'a matcap 3D mesh over a generative backdrop — the only family that shows the OBJ bank',
    weight: 1.0,
    build(rng, ctx, assets) {
      if (assets.models.length === 0) throw new RollError('obj-scene: no models');
      const gens = genPool(assets);
      const vids = contextVideoLayers(ctx);
      // Backdrop (video feed if patched, else a generator), mesh on top.
      const base = vids.length > 0 ? vids : [rollGenLayer(rng, gens)];
      const slots = [...base, rollObjLayer(rng, assets.models)].slice(0, LAYER_COUNT);
      return buildChain(rng, {
        slots,
        blendPool: ['over'],
        blendOverrides: { amount: [0.75, 1] },
        postPool: ['mirror', 'flowsmear'],
        postMin: 0,
        postMax: 1,
      });
    },
  },
  {
    id: 'glitch-chain',
    why: 'bitbend/desync/datamosh corruption over a live source — the datamosh-a-feed look, unreachable by blends alone',
    weight: 0.9,
    build(rng, ctx, assets) {
      const gens = genPool(assets);
      const vids = contextVideoLayers(ctx);
      const content = [rollGenLayer(rng, gens)];
      if (vids.length === 0 && rng() < 0.4) content.push(rollGenLayer(rng, gens));
      return buildChain(rng, {
        slots: mergeSlots(rng, vids, content),
        blendPool: ['fade', 'over'],
        postPool: ['bitbend', 'channeldesync', 'datamosh', 'biocells'],
        postMin: 1,
        postMax: 2,
      });
    },
  },
  {
    id: 'frag-post',
    why: 'a FRAG (scene-input Shadertoy) layer post-processing the stack — exercises the FRAG bank the other families never touch',
    weight: 1.0,
    build(rng, ctx, assets) {
      const frags = fragPool(assets);
      if (frags.length === 0) throw new RollError('frag-post: no FRAG content');
      const gens = genPool(assets);
      const vids = contextVideoLayers(ctx);
      const base = vids.length > 0 ? vids : [rollGenLayer(rng, gens)];
      const frag = rollGenLayer(rng, frags); // kind 'frag' via family
      const slots = [...base, frag].slice(0, LAYER_COUNT);
      return buildChain(rng, {
        slots,
        blendPool: ['fade'],
        blendOverrides: { amount: [0.65, 1] },
        postPool: ['mirror', 'tile'],
        postMin: 0,
        postMax: 1,
      });
    },
  },
  {
    id: 'exquisite-splice',
    why: 'the multi-input EXQUISITE band splicer over 3-4 sources — the one non-chain topology in the table',
    weight: 0.8,
    build(rng, ctx, assets) {
      const gens = genPool(assets);
      const vids = contextVideoLayers(ctx);
      const n = rollInt(rng, 3, 4);
      const content = Array.from(
        { length: Math.max(2 - vids.length, n - vids.length) },
        () => rollGenLayer(rng, gens),
      );
      const slots = [...vids, ...content].slice(0, LAYER_COUNT);
      opSeq = 0;
      const g = baseGraph();
      const ex = addOp(g, rng, 'exquisite');
      for (let i = 0; i < slots.length; i++) {
        connect(g, `src${i}`, ex.id, `in${i}` as ToyboxInPort);
      }
      connect(g, ex.id, 'out', 'in0');
      const layers: ToyboxLayer[] = [];
      for (let i = 0; i < LAYER_COUNT; i++) {
        layers.push(slots[i] ?? { kind: 'off', contentId: null, params: {} });
      }
      return { layers, combine: g };
    },
  },
];

const FALLBACK_ARCHETYPE_ID = 'soft-collage';

/** The known-good build (R24): soft-collage shape with FIXED safe params —
 *  used after MAX_BUILD_ATTEMPTS validation failures so a press can never
 *  fail. Still honors the context (patched feeds placed, cv ports routed). */
function buildFallback(rng: ToyboxRng, ctx: ToyboxRandomContext, assets: ToyboxRandomAssets): RolledStructure {
  const gens = genPool(assets);
  const vids = contextVideoLayers(ctx);
  const base: ToyboxLayer[] =
    vids.length > 0 ? vids : gens.length > 0 ? [rollGenLayer(rng, gens)] : [];
  if (base.length === 0) throw new Error('TOYBOX randomize: no content assets available');
  const top = gens.length > 0 ? [rollGenLayer(rng, gens)] : [];
  const slots = [...base, ...top].slice(0, LAYER_COUNT);
  opSeq = 0;
  const g = baseGraph();
  let acc = 'src0';
  if (slots.length > 1) {
    const fadeOp: ToyboxGraphNode = {
      id: `op${++opSeq}`,
      kind: 'fade',
      x: opSlotXY(0).x,
      y: opSlotXY(0).y,
      params: { amount: 0.5 },
    };
    g.nodes.push(fadeOp);
    connect(g, acc, fadeOp.id, 'in0');
    connect(g, 'src1', fadeOp.id, 'in1');
    acc = fadeOp.id;
  }
  connect(g, acc, 'out', 'in0');
  const layers: ToyboxLayer[] = [];
  for (let i = 0; i < LAYER_COUNT; i++) {
    layers.push(slots[i] ?? { kind: 'off', contentId: null, params: {} });
  }
  return { layers, combine: g };
}

// ---------------- CV routing (context R13) ----------------

interface RouteCandidate {
  route: CvRouteTarget;
  /** Dedup key so two ports never share one param. */
  key: string;
}

/** Every param the rolled result exposes that a cv port could sensibly drive:
 *  continuous op params (mode/option selectors excluded — modulating a
 *  discrete selector at cv rate is chaos, not modulation), the active layers'
 *  content uniforms, OBJ material fields, video opacity/brightness. Enumerated
 *  from the ENGINE's own knowledge (assets + static tables) so the engine
 *  stays pure; the unit suite proves agreement with the app-side resolveRoute
 *  by registering the same fixtures in the runtime provider. */
function routeCandidates(
  layers: readonly ToyboxLayer[],
  combine: ToyboxCombineGraph,
  assets: ToyboxRandomAssets,
): RouteCandidate[] {
  const out: RouteCandidate[] = [];
  for (const n of combine.nodes) {
    if (n.kind === 'source' || n.kind === 'output') continue;
    for (const def of OP_PARAMS[n.kind as ToyboxOpKind] ?? []) {
      if (def.options || def.id === 'mode') continue;
      out.push({
        route: { target: 'combine', nodeId: n.id, param: def.id },
        key: `combine:${n.id}:${def.id}`,
      });
    }
  }
  layers.forEach((layer, i) => {
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

/** Route every PATCHED cv port to a distinct param of the rolled result, in
 *  stable port order (cv1..cv6) so the assignment is deterministic. Unpatched
 *  ports get NO entry (the roll does not touch their routing). */
function buildCvRoutes(
  rng: ToyboxRng,
  ctx: ToyboxRandomContext,
  layers: readonly ToyboxLayer[],
  combine: ToyboxCombineGraph,
  assets: ToyboxRandomAssets,
): CvRoutes {
  const ports = CV_PORT_IDS.filter((p) => ctx.cv[p] !== undefined);
  const routes: CvRoutes = {};
  if (ports.length === 0) return routes;
  const candidates = shuffled(rng, routeCandidates(layers, combine, assets));
  if (candidates.length === 0) throw new RollError('no cv route candidates in rolled result');
  let cursor = 0;
  for (const port of ports) {
    // Distinct while supplies last; reuse (wrapped) only when the result has
    // fewer continuous params than the user has patched cables.
    const cand = candidates[cursor % candidates.length]!;
    cursor++;
    routes[port] = { ...cand.route };
  }
  return routes;
}

// ---------------- Validation (R5/R23 — generate-and-test) ----------------

/** Layer kinds that are alive WITHOUT any external feed. */
const SELF_ALIVE_KINDS: ReadonlySet<string> = new Set(['gen', 'shader', 'frag', 'obj']);

/** Node ids that can reach OUT, walked backward over the same-frame edge set. */
function reachesOut(g: ToyboxCombineGraph): Set<string> {
  const into = new Map<string, string[]>();
  for (const e of g.edges) {
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

/** Resolve a route against the ENGINE's knowledge (assets + static tables) —
 *  the pure mirror of toybox-cv-routes' resolveRoute, used as the in-engine
 *  postcondition. The unit suite pins the two against each other through the
 *  runtime provider so they cannot silently drift. */
function routeResolves(
  route: CvRouteTarget,
  layers: readonly ToyboxLayer[],
  combine: ToyboxCombineGraph,
  assets: ToyboxRandomAssets,
): boolean {
  if (route.target === 'combine') {
    const n = combine.nodes.find((x) => x.id === route.nodeId);
    if (!n || n.kind === 'source' || n.kind === 'output') return false;
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

/** Every postcondition a roll must satisfy — throws RollError (caught by the
 *  retry loop) so a defective candidate is invisible to the user (R23). */
function assertValidRoll(
  blob: ToyboxRollBlob,
  ctx: ToyboxRandomContext,
  assets: ToyboxRandomAssets,
): void {
  const { layers, combine, cvRoutes } = blob;
  if (!Array.isArray(layers) || layers.length !== LAYER_COUNT) {
    throw new RollError(`layers.length ${layers?.length} !== LAYER_COUNT`);
  }
  // Structural graph validity: sources for every layer, single OUT, acyclic,
  // and the whole edge set replays cleanly through validateConnect.
  if (!outputNode(combine)) throw new RollError('no output node');
  const sorted = topoSort(combine);
  if (!sorted.ok) throw new RollError('combine graph has a cycle / stranded node');
  const replay: ToyboxCombineGraph = { nodes: combine.nodes, edges: [] };
  for (const e of combine.edges as ToyboxGraphEdge[]) {
    const res = validateConnect(replay, e.from, e.to, e.toPort);
    if (!res.ok) throw new RollError(`edge ${e.id} replays as ${res.error}`);
    replay.edges.push(e);
  }
  // Liveness: at least one SELF-ALIVE (or patched-feed video) source layer
  // must reach OUT.
  const reach = reachesOut(combine);
  const aliveReaches = combine.nodes.some((n) => {
    if (n.kind !== 'source' || !reach.has(n.id)) return false;
    const layer = layers[n.layer ?? -1];
    if (!layer) return false;
    if (SELF_ALIVE_KINDS.has(layer.kind)) return true;
    return (
      layer.kind === 'video' &&
      ((layer.videoSource === 'inA' && ctx.videoIn.inA) ||
        (layer.videoSource === 'inB' && ctx.videoIn.inB))
    );
  });
  if (!aliveReaches) throw new RollError('no alive source layer reaches OUT');
  // Context: every patched video port is a live, load-bearing layer source.
  for (const port of ['inA', 'inB'] as const) {
    if (!ctx.videoIn[port]) continue;
    const claimed = combine.nodes.some((n) => {
      if (n.kind !== 'source' || !reach.has(n.id)) return false;
      const layer = layers[n.layer ?? -1];
      return layer?.kind === 'video' && layer.videoSource === port;
    });
    if (!claimed) throw new RollError(`patched ${port} not load-bearing in roll`);
  }
  // Context: every patched cv port routes to a param that exists in the result.
  for (const port of CV_PORT_IDS) {
    if (ctx.cv[port] === undefined) continue;
    const route = cvRoutes[port];
    if (!route) throw new RollError(`patched ${port} has no route`);
    if (!routeResolves(route, layers, combine, assets)) {
      throw new RollError(`route for ${port} does not resolve`);
    }
  }
  // No route may point at nothing (the findOrphanedRoutes invariant, engine-side).
  for (const [port, route] of Object.entries(cvRoutes)) {
    if (route && !routeResolves(route, layers, combine, assets)) {
      throw new RollError(`route for ${port} is orphaned at birth`);
    }
  }
}

// ---------------- Generate ----------------

/** Bounded generate-and-test: how many seeded candidates are tried before the
 *  known-good fallback build is used (R24 — a press never fails, never hangs). */
export const MAX_BUILD_ATTEMPTS = 8;

/** How many recent archetype ids the card remembers (anti-repeat, R7). */
export const ANTI_REPEAT_MEMORY = 2;

function pickArchetype(rng: ToyboxRng, exclude: readonly string[]): ToyboxArchetype {
  const filtered = TOYBOX_ARCHETYPES.filter((a) => !exclude.includes(a.id));
  const table = filtered.length > 0 ? filtered : TOYBOX_ARCHETYPES;
  const total = table.reduce((s, a) => s + a.weight, 0);
  let t = rng() * total;
  for (const a of table) {
    t -= a.weight;
    if (t <= 0) return a;
  }
  return table[table.length - 1]!;
}

/**
 * PURE seeded generator: `(seed, context, assets, exclude) → result`.
 * Deterministic for identical inputs; bounded cost; never returns an invalid
 * patch (throws only when `assets` cannot express one at all, e.g. an empty
 * content bank).
 */
export function generateToyboxPatch(
  seed: number,
  ctx: ToyboxRandomContext = EMPTY_TOYBOX_CONTEXT,
  assets: ToyboxRandomAssets,
  exclude: readonly string[] = [],
): ToyboxRollResult {
  const rng = mulberry32(seed);
  for (let attempt = 0; attempt < MAX_BUILD_ATTEMPTS; attempt++) {
    const archetype = pickArchetype(rng, exclude);
    try {
      const structure = archetype.build(rng, ctx, assets);
      const cvRoutes = buildCvRoutes(rng, ctx, structure.layers, structure.combine, assets);
      const blob: ToyboxRollBlob = { layers: structure.layers, combine: structure.combine, cvRoutes };
      assertValidRoll(blob, ctx, assets);
      return { blob, archetypeId: archetype.id, seed, fellBack: false };
    } catch (err) {
      if (!(err instanceof RollError)) throw err;
      // reject-and-retry: invisible to the caller (R23); rng advances, so the
      // next attempt explores a different candidate deterministically.
    }
  }
  const structure = buildFallback(rng, ctx, assets);
  const cvRoutes = buildCvRoutes(rng, ctx, structure.layers, structure.combine, assets);
  const blob: ToyboxRollBlob = { layers: structure.layers, combine: structure.combine, cvRoutes };
  assertValidRoll(blob, ctx, assets); // the fallback failing IS a bug — let it throw
  return { blob, archetypeId: FALLBACK_ARCHETYPE_ID, seed, fellBack: true };
}

// ---------------- The registry-backed wrapper (what the card calls) ----------------

export interface ToyboxRollOptions {
  /** Omit for a fresh random seed (recorded in the result for replay). */
  seed?: number;
  context?: ToyboxRandomContext;
  /** Recent archetype ids to avoid (anti-repeat memory). */
  exclude?: readonly string[];
  /** Override the asset pools (tests); defaults to the live provider lists. */
  assets?: ToyboxRandomAssets;
}

/**
 * Roll a new TOYBOX patch off the LIVE asset registry (the #1710 provider
 * seam — bundled manifest + any session-registered runtime assets). The
 * caller must have awaited `ensureToyboxCatalog()` once (the card does at
 * mount) or the pools are empty and this throws.
 */
export function rollToyboxPatch(opts: ToyboxRollOptions = {}): ToyboxRollResult {
  const seed = opts.seed ?? Math.floor(Math.random() * 0x7fffffff);
  const assets: ToyboxRandomAssets = opts.assets ?? {
    content: listedContent(),
    models: listedModels(),
  };
  return generateToyboxPatch(seed, opts.context ?? EMPTY_TOYBOX_CONTEXT, assets, opts.exclude ?? []);
}
