// packages/web/src/lib/video/toybox-combine-graph.ts
//
// TOYBOX Phase 4 — the user-EDITABLE combine GRAPH (a DAG of nodes + edges).
//
// Phases 1-3 reduced the 4 layers with a FIXED linear chain (ToyboxCombine =
// { steps }). Phase 4 generalises that chain into a small node graph the card
// edits in place:
//
//   - SOURCE nodes  (one per layer, kind 'source', auto-present): each emits a
//                    layer texture. There is exactly one source per layer index.
//   - OP nodes      (kind 'fade' | 'lumakey' | 'chromakey' | 'map'): two inputs
//                    (base 'in0', top 'in1') → one output, blended by `op` using
//                    the SAME GLSL the linear chain used. Per-op params live on
//                    node.params.
//   - OUTPUT node   (kind 'output', exactly one): one input 'in0'; whatever is
//                    wired here is what the module emits.
//
// Edges connect an output port of one node to an input port of another:
//   { from: nodeId, to: nodeId, toPort: 'in0' | 'in1' }
// (every node has at most one output, so we only name the destination port.)
//
// The engine topo-sorts this DAG (Kahn) and evaluates each op node into a
// ping-pong scratch FBO, then samples the OUTPUT node's upstream texture. An
// invalid/disconnected output (no path from any source to OUTPUT) renders
// BLACK — never crashes. Cycles are rejected at edit time (connect()) AND
// defended at eval time (topo-sort drops any node it can't order).
//
// This file is PURE (no Yjs, no GL): the data shape + the mutation/validation
// helpers. The card's Yjs writes live in graph/toybox-combine.ts (mirroring
// the control-surface mutator split); the engine reads the shape in
// modules/toybox.ts. Unit-tested in toybox-combine-graph.test.ts.

import { LAYER_COUNT } from './toybox-content';

/** The op a combine node performs. SOURCE/OUTPUT are structural endpoints. */
export type ToyboxNodeKind =
  | 'source'
  | 'fade'
  | 'lumakey'
  | 'chromakey'
  | 'map'
  | 'feedback'
  | 'output';

/** The op-node kinds. The four STATELESS blends map 1:1 to the combine shader's
 *  uOp index (fade 0, lumakey 1, chromakey 2, map 3). FEEDBACK is the first
 *  STATEFUL op — it runs its OWN program (sampling its previous frame), so it
 *  uses a SENTINEL shader index (FEEDBACK_SHADER_INDEX) and is never fed through
 *  combineStep. It is still an "op" everywhere else (deletable, has params, is a
 *  CV target, appears in the ADD menu). */
export type ToyboxOpKind = 'fade' | 'lumakey' | 'chromakey' | 'map' | 'feedback';

export const OP_KINDS: readonly ToyboxOpKind[] = ['fade', 'lumakey', 'chromakey', 'map', 'feedback'];

/** Sentinel uOp index for FEEDBACK: it never runs combineStep (it has its OWN
 *  program), so this index must NOT collide with a real COMBINE_FRAG_SRC case
 *  (0..3). The engine branches on the node KIND before any shader index lookup;
 *  the index exists only so OP_SHADER_INDEX stays a total map over OP_KINDS. */
export const FEEDBACK_SHADER_INDEX = 100;

/** Combine-shader op index per op kind. fade/lumakey/chromakey/map match
 *  COMBINE_FRAG_SRC uOp; feedback is the sentinel (own program). */
export const OP_SHADER_INDEX: Record<ToyboxOpKind, number> = {
  fade: 0,
  lumakey: 1,
  chromakey: 2,
  map: 3,
  feedback: FEEDBACK_SHADER_INDEX,
};

/** A node in the combine graph. `params` holds the op's float params keyed by
 *  id (op nodes only); `layer` is the layer index a SOURCE node emits. */
export interface ToyboxGraphNode {
  /** Stable id, unique within the graph. */
  id: string;
  kind: ToyboxNodeKind;
  /** Layout column/row hint for the SVG editor (purely cosmetic). */
  x: number;
  y: number;
  /** SOURCE only: the layer index (0..LAYER_COUNT-1) this node emits. */
  layer?: number;
  /** OP nodes: per-op float params (see OP_PARAMS). Missing keys default. */
  params?: Record<string, number>;
}

/** An edge: connects the (single) output of `from` to input `toPort` of `to`. */
export interface ToyboxGraphEdge {
  id: string;
  from: string;
  to: string;
  /** Which input port on the destination node. */
  toPort: ToyboxInPort;
}

/** Input port ids. Op nodes have 'in0' (base) + 'in1' (top); OUTPUT has 'in0'. */
export type ToyboxInPort = 'in0' | 'in1';

export interface ToyboxCombineGraph {
  nodes: ToyboxGraphNode[];
  edges: ToyboxGraphEdge[];
}

// ---------------- Per-op param schema ----------------
//
// Each op node exposes its own float params (the card's side strip + later CV
// targets). `amount` is the blend amount/threshold/tolerance the combine
// shader already reads; the labels per op match the linear-chain semantics.

export interface ToyboxOpParamDef {
  id: string;
  label: string;
  min: number;
  max: number;
  default: number;
}

export const OP_PARAMS: Record<ToyboxOpKind, ToyboxOpParamDef[]> = {
  // FADE: crossfade base→top by t.
  fade: [{ id: 'amount', label: 'T', min: 0, max: 1, default: 1 }],
  // LUMAKEY: keep top where luma exceeds THRESHOLD (= amount); SHARPNESS (= soft)
  //          widens/tightens the edge; invert flips the test. THRESHOLD/SHARPNESS
  //          are the keyer-config popover's two controls (the keyer "Configure"
  //          menu surface is purely a relabelling of these existing params).
  lumakey: [
    { id: 'amount', label: 'THRESHOLD', min: 0, max: 1, default: 0.5 },
    { id: 'soft', label: 'SHARPNESS', min: 0, max: 1, default: 0.1 },
    { id: 'invert', label: 'INVERT', min: 0, max: 1, default: 0 },
  ],
  // CHROMAKEY: HSV key (ported from modules/chromakey.ts). amount = THRESHOLD
  //            (how close to the key hue counts as keyed), soft = SHARPNESS
  //            (edge feather), keyR/keyG/keyB = the key COLOUR (0..1 floats,
  //            green-screen default). The keyer-config popover edits all of
  //            these (a colour picker drives keyR/G/B). Replaces the old single
  //            `key` channel-select scalar (migrated forward — see
  //            migrateToyboxData).
  chromakey: [
    { id: 'amount', label: 'THRESHOLD', min: 0, max: 1, default: 0.3 },
    { id: 'soft', label: 'SHARPNESS', min: 0, max: 1, default: 0.1 },
    { id: 'keyR', label: 'KEY R', min: 0, max: 1, default: 0 },
    { id: 'keyG', label: 'KEY G', min: 0, max: 1, default: 1 },
    { id: 'keyB', label: 'KEY B', min: 0, max: 1, default: 0 },
  ],
  // MAP: top modulates base (multiply), mixed in by mix.
  map: [
    { id: 'amount', label: 'MIX', min: 0, max: 1, default: 1 },
    { id: 'mode', label: 'MODE', min: 0, max: 1, default: 0 },
  ],
  // FEEDBACK (the first STATEFUL op): a discrete MODE selector (0..11; rendered
  // as a <select>, NOT a knob — but exposed here so it round-trips + is a CV
  // target) PLUS the SUPERSET of per-mode floats. Only the params relevant to
  // the current mode actually affect the render, but ALL are listed so #611
  // auto-renders them as card knobs + makes each one CV-assignable for free.
  // Ranges/defaults MUST match toybox-feedback.ts feedbackUniforms() so a CV
  // write + a manual knob land identically. See FEEDBACK_MODES for the modes.
  feedback: [
    { id: 'mode', label: 'MODE', min: 0, max: 11, default: 0 },
    { id: 'zoom', label: 'ZOOM', min: 0.5, max: 1, default: 0.95 },
    { id: 'rotate', label: 'ROTATE', min: -Math.PI, max: Math.PI, default: 0 },
    { id: 'scaleP', label: 'SCALE', min: 0.5, max: 1.5, default: 1 },
    { id: 'tx', label: 'TX', min: -1, max: 1, default: 0 },
    { id: 'ty', label: 'TY', min: -1, max: 1, default: 0 },
    { id: 'decay', label: 'DECAY', min: 0, max: 1.5, default: 0.9 },
    { id: 'gain', label: 'GAIN', min: 0, max: 2, default: 1 },
    { id: 'thresh', label: 'THRESH', min: 0, max: 1, default: 0.5 },
    { id: 'hue', label: 'HUE', min: 0, max: 1, default: 0 },
    { id: 'blur', label: 'BLUR', min: 0, max: 4, default: 1 },
    { id: 'slitPos', label: 'SLIT POS', min: 0, max: 1, default: 0.5 },
    { id: 'slitWidth', label: 'SLIT W', min: 0, max: 1, default: 0.1 },
    { id: 'flow', label: 'FLOW', min: 0, max: 1, default: 0 },
    // INTENSITY — wet/dry mix between the live input (dry) and the recursive
    // feedback result (wet). At 1 the effect OWNS the output (opaque mirrors /
    // strong accumulation); at 0 it passes the input through. Added in
    // schemaVersion 4 (migrateToyboxData backfills the default for old saves).
    { id: 'intensity', label: 'INTENSITY', min: 0, max: 1, default: 0.5 },
  ],
};

/** Op kinds that are KEYERS (have a "Configure keyer" popover): lumakey +
 *  chromakey. Used by the card's right-click menu to gate the action. */
export const KEYER_OP_KINDS: readonly ToyboxOpKind[] = ['lumakey', 'chromakey'];

/** True if `kind` is a keyer op (lumakey/chromakey) — i.e. it has a keyer
 *  config popover. SOURCE/OUTPUT/fade/map are not keyers. */
export function isKeyerKind(kind: ToyboxNodeKind | undefined): kind is 'lumakey' | 'chromakey' {
  return kind === 'lumakey' || kind === 'chromakey';
}

// ---------------- Unique per-node display names (#58) ----------------
//
// Two LUMAKEY nodes used to render the same raw "LUMAK" glyph (and the same CV
// target label), so they were indistinguishable. Each OP node gets a unique
// ORDINAL display name within its kind — the N-th lumakey is "LUMA N", the N-th
// chromakey "CHROMA N", etc. — assigned in stable graph order. SOURCE nodes are
// "L1".."L4" (1-based label; the layer INDEX stays 0-based), OUTPUT is "OUT".

/** Human display prefix per op kind (the ordinal is appended: "LUMA 1"). */
const OP_DISPLAY_PREFIX: Record<ToyboxOpKind, string> = {
  fade: 'FADE',
  lumakey: 'LUMA',
  chromakey: 'CHROMA',
  map: 'MAP',
  feedback: 'FBK',
};

/**
 * Build a stable map of nodeId → unique display name for every node in `g`.
 *   - SOURCE: "L{layer+1}" (1-based LABEL; the index stays 0-based, #56).
 *   - OUTPUT: "OUT".
 *   - OP:     "{PREFIX} {ordinal}" where ordinal counts that kind in graph
 *             order (1-based): the first lumakey is "LUMA 1", the second
 *             "LUMA 2", a chromakey "CHROMA 1", etc.
 * Pure over the node list; recomputes whenever nodes are added/removed/retyped.
 */
export function combineDisplayNames(g: ToyboxCombineGraph): Map<string, string> {
  const out = new Map<string, string>();
  const counts: Partial<Record<ToyboxOpKind, number>> = {};
  for (const n of g.nodes) {
    if (n.kind === 'source') {
      out.set(n.id, `L${(typeof n.layer === 'number' ? n.layer : 0) + 1}`);
    } else if (n.kind === 'output') {
      out.set(n.id, 'OUT');
    } else {
      const kind = n.kind as ToyboxOpKind;
      const next = (counts[kind] ?? 0) + 1;
      counts[kind] = next;
      out.set(n.id, `${OP_DISPLAY_PREFIX[kind] ?? kind.toUpperCase()} ${next}`);
    }
  }
  return out;
}

/** The unique display name for a single node id within `g` (convenience wrapper
 *  over {@link combineDisplayNames}; falls back to the id when not found). */
export function combineNodeDisplayName(g: ToyboxCombineGraph, nodeId: string): string {
  return combineDisplayNames(g).get(nodeId) ?? nodeId;
}

/** Default params for a freshly-inserted op node of `kind`. */
export function defaultOpParams(kind: ToyboxOpKind): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of OP_PARAMS[kind]) out[p.id] = p.default;
  return out;
}

/** The input ports a node of `kind` exposes (left-side dots in the editor). */
export function inPortsFor(kind: ToyboxNodeKind): ToyboxInPort[] {
  if (kind === 'source') return [];
  if (kind === 'output') return ['in0'];
  // FEEDBACK has a SINGLE input: the feedback loop is INTERNAL (its own previous
  // frame), NOT a second cable. The blend ops (fade/lumakey/chromakey/map) take
  // a base + top.
  if (kind === 'feedback') return ['in0'];
  return ['in0', 'in1']; // blend op nodes
}

/** Whether a node of `kind` has an output port (right-side dot). */
export function hasOutPort(kind: ToyboxNodeKind): boolean {
  return kind !== 'output';
}

// ---------------- Layout constants (editor + default graph) ----------------
//
// Cosmetic only — the editor honours each node's stored x/y. SOURCE nodes sit in
// the left column, OUTPUT on the right, and op nodes tile the middle band in a
// 2-wide grid that WRAPS (so adding many ops doesn't run them off the bottom of
// the editor's viewBox). Sizes are SVG user units matching ToyboxCard's G_W/G_H.

const COL_SOURCE = 14;
const COL_OUTPUT = 286;
const ROW_STEP = 52;
const ROW_TOP = 14;
// Op grid: two columns inside the middle band, wrapping every OP_ROWS rows.
const OP_COLS_X = [120, 196];
const OP_ROWS = 4;

/** Editor position for the `slot`-th op node (0-based) in the wrapping 2-column
 *  middle grid. Cosmetic; honoured by the editor + persisted. */
export function opSlotXY(slot: number): { x: number; y: number } {
  const col = Math.floor(slot / OP_ROWS) % OP_COLS_X.length;
  const row = slot % OP_ROWS;
  return { x: OP_COLS_X[col]!, y: ROW_TOP + row * ROW_STEP };
}

/** Build the default combine graph: 4 SOURCE nodes (one per layer) feeding a
 *  left-folding chain of FADE ops into the OUTPUT — i.e. the SAME composite the
 *  Phase-1..3 linear default produced (base = layer 0, each later layer faded
 *  over it). A fresh card starts here when node.data.combine is empty. */
export function makeDefaultCombineGraph(): ToyboxCombineGraph {
  const nodes: ToyboxGraphNode[] = [];
  const edges: ToyboxGraphEdge[] = [];
  for (let i = 0; i < LAYER_COUNT; i++) {
    nodes.push({ id: `src${i}`, kind: 'source', layer: i, x: COL_SOURCE, y: ROW_TOP + i * ROW_STEP });
  }
  const output: ToyboxGraphNode = { id: 'out', kind: 'output', x: COL_OUTPUT, y: ROW_TOP + ROW_STEP };
  // Build a fade chain: acc starts at src0; fold src1..src3 each at amount 0
  // (base passes through, matching makeDefaultCombine()'s zero-amount default).
  let acc = 'src0';
  for (let i = 1; i < LAYER_COUNT; i++) {
    const opId = `op${i}`;
    const xy = opSlotXY(i - 1);
    nodes.push({ id: opId, kind: 'fade', x: xy.x, y: xy.y, params: { amount: 0 } });
    edges.push({ id: `e_${acc}_${opId}_in0`, from: acc, to: opId, toPort: 'in0' });
    edges.push({ id: `e_src${i}_${opId}_in1`, from: `src${i}`, to: opId, toPort: 'in1' });
    acc = opId;
  }
  nodes.push(output);
  edges.push({ id: `e_${acc}_out_in0`, from: acc, to: 'out', toPort: 'in0' });
  return { nodes, edges };
}

// ---------------- Validation + lookups ----------------

/** True if `g` looks like a combine GRAPH (vs the legacy linear { steps }). */
export function isCombineGraph(g: unknown): g is ToyboxCombineGraph {
  return (
    !!g &&
    typeof g === 'object' &&
    Array.isArray((g as { nodes?: unknown }).nodes) &&
    Array.isArray((g as { edges?: unknown }).edges)
  );
}

export function findNode(g: ToyboxCombineGraph, id: string): ToyboxGraphNode | undefined {
  return g.nodes.find((n) => n.id === id);
}

/** The single OUTPUT node, if present. */
export function outputNode(g: ToyboxCombineGraph): ToyboxGraphNode | undefined {
  return g.nodes.find((n) => n.kind === 'output');
}

/** Generate a fresh node id not already used in `g`. */
export function nextNodeId(g: ToyboxCombineGraph, prefix = 'n'): string {
  let i = 1;
  let id = `${prefix}${i}`;
  const used = new Set(g.nodes.map((n) => n.id));
  while (used.has(id)) id = `${prefix}${++i}`;
  return id;
}

export function nextEdgeId(g: ToyboxCombineGraph): string {
  let i = 1;
  let id = `e${i}`;
  const used = new Set(g.edges.map((e) => e.id));
  while (used.has(id)) id = `e${++i}`;
  return id;
}

// ---------------- Topo-sort (Kahn) + cycle detection ----------------

/**
 * Kahn topological sort of the op/output nodes by their data-dependency edges.
 * Sources have no inputs (always orderable first). Returns the node ids in an
 * order where every node appears AFTER all nodes feeding its inputs. If a cycle
 * exists, the nodes inside it are simply OMITTED from the result (defensive:
 * the engine then treats their downstream as "no input" → contributes nothing,
 * rather than looping forever). `ok` reports whether every node was ordered.
 */
export function topoSort(g: ToyboxCombineGraph): { order: string[]; ok: boolean } {
  const indeg = new Map<string, number>();
  const out = new Map<string, string[]>();
  for (const n of g.nodes) {
    indeg.set(n.id, 0);
    out.set(n.id, []);
  }
  for (const e of g.edges) {
    // Skip edges referencing missing endpoints (robust to stale data).
    if (!indeg.has(e.from) || !indeg.has(e.to)) continue;
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    out.get(e.from)!.push(e.to);
  }
  const queue: string[] = [];
  for (const [id, d] of indeg) if (d === 0) queue.push(id);
  // Deterministic: process in stable graph order.
  queue.sort((a, b) => nodeOrderIndex(g, a) - nodeOrderIndex(g, b));
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const nxt of out.get(id) ?? []) {
      const d = (indeg.get(nxt) ?? 0) - 1;
      indeg.set(nxt, d);
      if (d === 0) {
        // Insert keeping deterministic order.
        const oi = nodeOrderIndex(g, nxt);
        let lo = 0;
        while (lo < queue.length && nodeOrderIndex(g, queue[lo]!) <= oi) lo++;
        queue.splice(lo, 0, nxt);
      }
    }
  }
  return { order, ok: order.length === g.nodes.length };
}

function nodeOrderIndex(g: ToyboxCombineGraph, id: string): number {
  return g.nodes.findIndex((n) => n.id === id);
}

/**
 * Would adding edge `from → to` create a cycle? True if `to` already reaches
 * `from` (so the new edge would close a loop). Pure — does NOT mutate `g`.
 */
export function wouldCreateCycle(g: ToyboxCombineGraph, from: string, to: string): boolean {
  if (from === to) return true;
  const adj = new Map<string, string[]>();
  for (const e of g.edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push(e.to);
  }
  // DFS from `to`: if we reach `from`, the new from→to edge closes a cycle.
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === from) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const nxt of adj.get(cur) ?? []) stack.push(nxt);
  }
  return false;
}

// ---------------- Pure mutation helpers ----------------
//
// These RETURN the entity to add / a boolean verdict; they do NOT touch Yjs.
// The card's Yjs mutators (graph/toybox-combine.ts) call validate* then
// push/splice the live array in place. Unit tests drive these directly on a
// plain { nodes, edges } object (mirroring how topoSort is tested).

/** Why a connect was rejected (for UI feedback + test assertions). */
export type ConnectError =
  | 'missing-node'
  | 'no-out-port'
  | 'bad-in-port'
  | 'self-loop'
  | 'cycle'
  | 'occupied';

export interface ConnectResult {
  ok: boolean;
  error?: ConnectError;
  /** The edge to add (only when ok). */
  edge?: ToyboxGraphEdge;
}

/**
 * Validate connecting `from`'s output → `to`'s input `toPort`. Rejects:
 *   - either endpoint missing,
 *   - `from` having no output port (OUTPUT nodes don't emit),
 *   - `toPort` not a valid input on `to`,
 *   - a self-loop,
 *   - an edge that would create a cycle (the eval is a DAG),
 *   - the destination port already being occupied (one cable per input).
 * On success returns the edge to add (with a fresh id).
 */
export function validateConnect(
  g: ToyboxCombineGraph,
  from: string,
  to: string,
  toPort: ToyboxInPort,
): ConnectResult {
  const fromNode = findNode(g, from);
  const toNode = findNode(g, to);
  if (!fromNode || !toNode) return { ok: false, error: 'missing-node' };
  if (from === to) return { ok: false, error: 'self-loop' };
  if (!hasOutPort(fromNode.kind)) return { ok: false, error: 'no-out-port' };
  if (!inPortsFor(toNode.kind).includes(toPort)) return { ok: false, error: 'bad-in-port' };
  if (g.edges.some((e) => e.to === to && e.toPort === toPort)) {
    return { ok: false, error: 'occupied' };
  }
  if (wouldCreateCycle(g, from, to)) return { ok: false, error: 'cycle' };
  return { ok: true, edge: { id: nextEdgeId(g), from, to, toPort } };
}

/** Pure: a new op node to insert (id + default params + a layout slot). The
 *  caller pushes it into the live array. Lays it out in the op column under the
 *  lowest existing op (cosmetic). */
export function makeOpNode(g: ToyboxCombineGraph, kind: ToyboxOpKind): ToyboxGraphNode {
  const ops = g.nodes.filter((n) => n.kind !== 'source' && n.kind !== 'output');
  const xy = opSlotXY(ops.length);
  return {
    id: nextNodeId(g, 'op'),
    kind,
    x: xy.x,
    y: xy.y,
    params: defaultOpParams(kind),
  };
}

/** Pure: the index of an edge by id (or -1). */
export function edgeIndex(g: ToyboxCombineGraph, edgeId: string): number {
  return g.edges.findIndex((e) => e.id === edgeId);
}

/** Pure: the index of a node by id (or -1). */
export function nodeIndex(g: ToyboxCombineGraph, nodeId: string): number {
  return g.nodes.findIndex((n) => n.id === nodeId);
}

/** Whether a node may be deleted (SOURCE + OUTPUT nodes are structural and
 *  cannot be removed — they always map to the 4 layers + the single output). */
export function canDeleteNode(g: ToyboxCombineGraph, nodeId: string): boolean {
  const n = findNode(g, nodeId);
  if (!n) return false;
  return n.kind !== 'source' && n.kind !== 'output';
}

/** Pure: the edge ids touching `nodeId` (in or out) — deleted alongside it. */
export function edgesTouching(g: ToyboxCombineGraph, nodeId: string): string[] {
  return g.edges.filter((e) => e.from === nodeId || e.to === nodeId).map((e) => e.id);
}
