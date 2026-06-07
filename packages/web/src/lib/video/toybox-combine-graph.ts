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
  // ── Batch op nodes (#node-batch) ──────────────────────────────────────────
  // STATELESS single-pass (share COMBINE_FRAG_SRC uOp branches):
  | 'over'        // 2-input premultiplied source-over
  | 'tile'        // 1-input NxM (mirror/offset/rotate) tiler
  | 'mirror'      // 1-input flip / quad-fold / kaleidoscope
  | 'displace'    // 2-input UV displacement (in1 drives in0)
  | 'bitbend'     // 1-input per-channel integer bit-op vs mask
  | 'biocells'    // 1-input Voronoi cell quantiser
  // STATELESS multi-input (own program, up to 4 feeds):
  | 'exquisite'   // 2..4-input banded "exquisite corpse" splicer
  // STATEFUL frame-history (own program + per-node ring buffer):
  | 'framedelay'      // 1-input N-frame delay line + mix
  | 'channeldesync'   // 1-input per-channel frame-delay + offset
  | 'flowsmear'       // 1-input curl-noise flow smear (1-deep history)
  | 'dreammelt'       // 2-input melt-state dissolve (1-deep history)
  | 'datamosh'        // 1-input optical-flow advection + hold gate (1-deep history)
  | 'output';

/** The op-node kinds. The STATELESS single-pass blends map 1:1 to the combine
 *  shader's uOp index (fade 0, lumakey 1, chromakey 2, map 3, over 4, tile 5,
 *  mirror 6, displace 7, bitbend 8, biocells 9). FEEDBACK + the multi-input
 *  (exquisite) + the frame-history ops run their OWN program(s), so they use
 *  SENTINEL shader indices (>=100) and are never fed through combineStep. They
 *  are still "ops" everywhere else (deletable, have params, are CV targets,
 *  appear in the ADD menu). */
export type ToyboxOpKind =
  | 'fade'
  | 'lumakey'
  | 'chromakey'
  | 'map'
  | 'feedback'
  | 'over'
  | 'tile'
  | 'mirror'
  | 'displace'
  | 'bitbend'
  | 'biocells'
  | 'exquisite'
  | 'framedelay'
  | 'channeldesync'
  | 'flowsmear'
  | 'dreammelt'
  | 'datamosh';

export const OP_KINDS: readonly ToyboxOpKind[] = [
  'fade',
  'lumakey',
  'chromakey',
  'map',
  'over',
  'tile',
  'mirror',
  'displace',
  'bitbend',
  'biocells',
  'feedback',
  'exquisite',
  'framedelay',
  'channeldesync',
  'flowsmear',
  'dreammelt',
  'datamosh',
];

/** Sentinel uOp index for FEEDBACK: it never runs combineStep (it has its OWN
 *  program), so this index must NOT collide with a real COMBINE_FRAG_SRC case.
 *  The engine branches on the node KIND before any shader index lookup; the
 *  index exists only so OP_SHADER_INDEX stays a total map over OP_KINDS. */
export const FEEDBACK_SHADER_INDEX = 100;

/** Sentinel uOp index for EXQUISITE (own multi-input program). */
export const EXQUISITE_SHADER_INDEX = 101;

/** Sentinel uOp index shared by the STATEFUL frame-history ops (each runs its
 *  own program / ring buffer; the engine branches on KIND before any index). */
export const HISTORY_SHADER_INDEX = 102;

/** Combine-shader op index per op kind. The STATELESS single-pass ops match a
 *  COMBINE_FRAG_SRC uOp branch (0..9); feedback/exquisite/history ops are
 *  sentinels (their own programs). */
export const OP_SHADER_INDEX: Record<ToyboxOpKind, number> = {
  fade: 0,
  lumakey: 1,
  chromakey: 2,
  map: 3,
  over: 4,
  tile: 5,
  mirror: 6,
  displace: 7,
  bitbend: 8,
  biocells: 9,
  feedback: FEEDBACK_SHADER_INDEX,
  exquisite: EXQUISITE_SHADER_INDEX,
  framedelay: HISTORY_SHADER_INDEX,
  channeldesync: HISTORY_SHADER_INDEX,
  flowsmear: HISTORY_SHADER_INDEX,
  dreammelt: HISTORY_SHADER_INDEX,
  datamosh: HISTORY_SHADER_INDEX,
};

/** The STATELESS single-pass ops that run through combineStep (a uOp branch in
 *  COMBINE_FRAG_SRC). Used by the engine's opOf whitelist. */
export const COMBINE_OP_KINDS: readonly ToyboxOpKind[] = [
  'fade', 'lumakey', 'chromakey', 'map', 'over', 'tile', 'mirror', 'displace', 'bitbend', 'biocells',
];

/** True if `kind` is a STATELESS single-pass op (runs combineStep). */
export function isCombineOpKind(kind: ToyboxNodeKind | undefined): kind is ToyboxOpKind {
  return (COMBINE_OP_KINDS as readonly string[]).includes(kind as string);
}

/** The STATEFUL frame-history ops (each owns a per-node history ring buffer +
 *  its own program). Reset/reconcile keying widens over this SET (not just
 *  'feedback'). */
export const HISTORY_OP_KINDS: readonly ToyboxOpKind[] = [
  'framedelay', 'channeldesync', 'flowsmear', 'dreammelt', 'datamosh',
];

/** True if `kind` is a STATEFUL op needing a per-node frame-history buffer
 *  (feedback + the batch history ops). The engine reconciles a ping-pong/ring
 *  buffer for exactly these (keyed on kind, so no hard-coded name list in GL). */
export function isStatefulKind(kind: ToyboxNodeKind | string | undefined): boolean {
  return kind === 'feedback' || (HISTORY_OP_KINDS as readonly string[]).includes(kind as string);
}

/** True if `kind` stores its accumulating state in the ring's ALPHA channel
 *  (DREAMMELT keeps per-pixel melt-progress in `prev.a`). Such a ring MUST be
 *  cleared with alpha=0 (seed melt=0 → melts IN from in0) rather than the
 *  default opaque clearColor(0,0,0,1), which would seed melt=1 (fully melted to
 *  in1) from the very first frame (#82 / audit C1). Only DREAMMELT does this;
 *  the other history ops store state in RGB and want the opaque clear. */
export function isMeltStateKind(kind: ToyboxNodeKind | string | undefined): boolean {
  return kind === 'dreammelt';
}

/** How many frames of history a stateful op keeps (ring depth). feedback +
 *  flowsmear/dreammelt/datamosh need only the single previous frame (1-deep
 *  ping-pong). framedelay/channeldesync read a DELAYED tap, so they need an
 *  N-frame ring (its max `delay`-style param's max + 1, rounded up). */
export function opHistoryDepth(kind: ToyboxNodeKind | string | undefined): number {
  if (kind === 'framedelay' || kind === 'channeldesync') return MAX_HISTORY_FRAMES;
  if (isStatefulKind(kind)) return 1; // 1-deep ping-pong (feedback/flowsmear/dreammelt/datamosh)
  return 0;
}

/** Maximum frames an N-frame history ring holds (framedelay/channeldesync). Kept
 *  modest so the per-node float-FBO ring stays cheap (33 RGBA32F targets at
 *  engine res). The delay params clamp to MAX_HISTORY_FRAMES-1. */
export const MAX_HISTORY_FRAMES = 33;

/** The TOYBOX node.data schema version. The SINGLE source of truth — toyboxDef
 *  (modules/toybox.ts) references it, the preset SAVE/EXPORT stamps it into the
 *  blob, and the preset RESTORE path migrates a blob saved at an older version
 *  forward (audit M5). Lives here (a light, engine-free module the card already
 *  imports) so the card can stamp it without pulling the whole video engine. */
export const TOYBOX_SCHEMA_VERSION = 4;

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

/** Input port ids. Blend ops have 'in0' (base) + 'in1' (top); 1-input ops + the
 *  OUTPUT have 'in0'; EXQUISITE has up to 'in0'..'in3' (4 feeds). */
export type ToyboxInPort = 'in0' | 'in1' | 'in2' | 'in3';

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
  /** DISCRETE-enum params (e.g. mirror.mode 0..3): the labels for each integer
   *  value, index = value. When present the Configure popover renders a <select>
   *  instead of a continuous knob (a knob can't land cleanly on "OR"). Omitted
   *  for continuous params. The value still round-trips + is CV/MIDI-addressable
   *  identically (it's the same float param). */
  options?: readonly string[];
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
    { id: 'mode', label: 'MODE', min: 0, max: 1, default: 0, options: ['MULTIPLY', 'SCREEN'] },
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

  // ── Batch op nodes ──────────────────────────────────────────────────────
  // OVER (2-input): premultiplied source-over. amount scales the source (in1)
  // alpha — at 0 only the dest (in0) shows; at 1 a full over-composite.
  over: [{ id: 'amount', label: 'OPACITY', min: 0, max: 1, default: 1 }],
  // TILE (1-input): repeat across an NxM grid with offset + per-cell rotation;
  // mirror>0.5 reflects alternating cells instead of wrapping.
  tile: [
    { id: 'tilesX', label: 'TILES X', min: 1, max: 16, default: 3 },
    { id: 'tilesY', label: 'TILES Y', min: 1, max: 16, default: 3 },
    { id: 'mirror', label: 'MIRROR', min: 0, max: 1, default: 0 },
    { id: 'offX', label: 'OFFSET X', min: -1, max: 1, default: 0 },
    { id: 'offY', label: 'OFFSET Y', min: -1, max: 1, default: 0 },
    { id: 'rotate', label: 'ROTATE', min: -Math.PI, max: Math.PI, default: 0 },
  ],
  // MIRROR (1-input): MODE 0 H-flip, 1 V-flip, 2 quad-fold, 3 kaleidoscope.
  mirror: [
    { id: 'mode', label: 'MODE', min: 0, max: 3, default: 2, options: ['H-FLIP', 'V-FLIP', 'QUAD', 'KALEIDO'] },
    { id: 'segments', label: 'SEGMENTS', min: 2, max: 16, default: 6 },
    { id: 'rotation', label: 'ROTATION', min: -Math.PI, max: Math.PI, default: 0 },
  ],
  // DISPLACE (2-input): in1 displaces in0's UVs. amount = displacement scale;
  // channel 0 = luma-displace, 1 = RG-vector displace.
  displace: [
    { id: 'amount', label: 'AMOUNT', min: -0.5, max: 0.5, default: 0.1 },
    { id: 'channel', label: 'CHANNEL', min: 0, max: 1, default: 1, options: ['LUMA', 'RG-VEC'] },
  ],
  // BITBEND (1-input): per-channel integer bit-op vs a mask (0..255). op 0 XOR,
  // 1 AND, 2 OR, 3 bit-rotate. perR/perG/perB gate which channels are bent.
  bitbend: [
    { id: 'op', label: 'OP', min: 0, max: 3, default: 0, options: ['XOR', 'AND', 'OR', 'ROTATE'] },
    { id: 'mask', label: 'MASK', min: 0, max: 255, default: 85 },
    { id: 'perR', label: 'R', min: 0, max: 1, default: 1 },
    { id: 'perG', label: 'G', min: 0, max: 1, default: 1 },
    { id: 'perB', label: 'B', min: 0, max: 1, default: 1 },
  ],
  // BIOCELLS (1-input): Voronoi cell quantiser; cells jittered by hash + input
  // luma, filled with the input colour at the cell centre, edges drawn dark.
  biocells: [
    { id: 'cellCount', label: 'CELLS', min: 4, max: 64, default: 16 },
    { id: 'lumaJitter', label: 'LUMA JIT', min: 0, max: 1, default: 0.4 },
    { id: 'edgeWidth', label: 'EDGE', min: 0, max: 1, default: 0.3 },
    { id: 'edgeColor', label: 'EDGE COL', min: 0, max: 1, default: 0 },
  ],
  // EXQUISITE (2..4-input): split the frame into N bands; band i shows
  // input (i mod #inputs). boundaryWarp wobbles the seams; seamBlend feathers
  // them; hueShift tints alternating bands.
  exquisite: [
    { id: 'bands', label: 'BANDS', min: 2, max: 8, default: 4 },
    { id: 'boundaryWarp', label: 'WARP', min: 0, max: 1, default: 0.2 },
    { id: 'seamBlend', label: 'SEAM', min: 0, max: 1, default: 0.1 },
    { id: 'hueShift', label: 'HUE', min: 0, max: 1, default: 0 },
  ],
  // FRAMEDELAY (1-input): output = history[now - delay] mixed with current.
  // Default MIX < 1 (audit M2d): mix=1 is a PURE delay/echo that is invisible on
  // static / slow content (the delayed frame == the live frame); 0.7 crossfades
  // the live input with the delayed tap so the echo reads out of the box.
  framedelay: [
    { id: 'delay', label: 'DELAY', min: 0, max: MAX_HISTORY_FRAMES - 1, default: 12 },
    { id: 'mix', label: 'MIX', min: 0, max: 1, default: 0.7 },
  ],
  // CHANNELDESYNC (1-input): per-channel frame-delay + spatial offset (RGB drift).
  channeldesync: [
    { id: 'rDelay', label: 'R DELAY', min: 0, max: MAX_HISTORY_FRAMES - 1, default: 0 },
    { id: 'gDelay', label: 'G DELAY', min: 0, max: MAX_HISTORY_FRAMES - 1, default: 6 },
    { id: 'bDelay', label: 'B DELAY', min: 0, max: MAX_HISTORY_FRAMES - 1, default: 12 },
    { id: 'offsetMag', label: 'OFFSET', min: 0, max: 1, default: 0.05 },
  ],
  // FLOWSMEAR (1-input): curl-noise flow advects the previous output; persistence
  // mixes it with the live input (1-deep history).
  flowsmear: [
    { id: 'flowStrength', label: 'FLOW', min: 0, max: 1, default: 0.5 },
    { id: 'noiseScale', label: 'SCALE', min: 0.5, max: 8, default: 3 },
    { id: 'persistence', label: 'PERSIST', min: 0, max: 1, default: 0.85 },
  ],
  // DREAMMELT (2-input): per-pixel melt-state accumulates; pixels drip downward +
  // dissolve in0→in1 as melt progresses (1-deep history).
  dreammelt: [
    { id: 'meltAmount', label: 'MELT', min: 0, max: 1, default: 0.5 },
    { id: 'dripSpeed', label: 'DRIP', min: 0, max: 1, default: 0.3 },
    { id: 'threshold', label: 'THRESH', min: 0, max: 1, default: 0.5 },
  ],
  // DATAMOSH (1-input): approximate optical-flow advection of the previous
  // output + a HOLD gate that withholds new input (P-frame smear) + decay.
  // Stronger DEFAULTS (audit M2d): a HIGHER flow scale advects further per
  // frame, and a LOWER hold gate (gate = step(holdGate*0.5, motion)) trips the
  // P-frame smear at less motion → the mosh reads out of the box instead of
  // mostly accepting the live input.
  datamosh: [
    { id: 'flowScale', label: 'FLOW', min: 0, max: 1, default: 0.8 },
    { id: 'holdGate', label: 'HOLD', min: 0, max: 1, default: 0.3 },
    { id: 'decay', label: 'DECAY', min: 0, max: 1, default: 0.95 },
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
  over: 'OVER',
  tile: 'TILE',
  mirror: 'MIRR',
  displace: 'DISP',
  bitbend: 'BITB',
  biocells: 'BIO',
  exquisite: 'EXQ',
  framedelay: 'FDLY',
  channeldesync: 'DSYNC',
  flowsmear: 'FLOW',
  dreammelt: 'MELT',
  datamosh: 'MOSH',
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

/** A param value read off a node's params Record, defaulting to the schema
 *  default for `kind`.`id` when absent / non-finite. Pure. */
export function opParamVal(
  kind: ToyboxOpKind,
  params: Record<string, number> | undefined | null,
  id: string,
): number {
  const v = params && typeof params === 'object' ? params[id] : undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const def = OP_PARAMS[kind]?.find((p) => p.id === id);
  return def?.default ?? 0;
}

/** The generic combineStep "extra" channel for a STATELESS single-pass op: which
 *  of that op's params land in amount/mode/uP0..uP5. PURE (no GL) so the slot
 *  mapping is unit-testable and shared by the engine. Returns the amount + a
 *  CombineExtra-shaped record. fade/lumakey/chromakey/map keep their historical
 *  channels (soft/invert/keyR/G/B/mode); the batch ops pack their floats into
 *  uP0..uP5 (+ mode for the op/channel selector). */
export interface CombineStepExtra {
  amount: number;
  soft?: number;
  invert?: number;
  keyR?: number;
  keyG?: number;
  keyB?: number;
  mode?: number;
  p0?: number;
  p1?: number;
  p2?: number;
  p3?: number;
  p4?: number;
  p5?: number;
}

export function combineExtraFor(
  kind: ToyboxOpKind,
  params: Record<string, number> | undefined | null,
): CombineStepExtra {
  const v = (id: string) => opParamVal(kind, params, id);
  switch (kind) {
    case 'fade':
      return { amount: v('amount') };
    case 'lumakey':
      return { amount: v('amount'), soft: v('soft'), invert: v('invert') };
    case 'chromakey':
      return { amount: v('amount'), soft: v('soft'), keyR: v('keyR'), keyG: v('keyG'), keyB: v('keyB') };
    case 'map':
      return { amount: v('amount'), mode: v('mode') };
    case 'over':
      return { amount: v('amount') };
    case 'tile':
      // uP0 tilesX, uP1 tilesY, uP2 mirror, uP3 offX, uP4 offY, uP5 rotate.
      return {
        amount: 1,
        p0: v('tilesX'), p1: v('tilesY'), p2: v('mirror'),
        p3: v('offX'), p4: v('offY'), p5: v('rotate'),
      };
    case 'mirror':
      // uMode = mode, uP0 = segments, uP1 = rotation.
      return { amount: 1, mode: v('mode'), p0: v('segments'), p1: v('rotation') };
    case 'displace':
      // amount = displacement scale, uMode = channel.
      return { amount: v('amount'), mode: v('channel') };
    case 'bitbend':
      // uMode = op, uP0 = mask, uP3/uP4/uP5 = perR/perG/perB.
      return { amount: 1, mode: v('op'), p0: v('mask'), p3: v('perR'), p4: v('perG'), p5: v('perB') };
    case 'biocells':
      // uP0 cellCount, uP1 lumaJitter, uP2 edgeWidth, uP3 edgeColor.
      return { amount: 1, p0: v('cellCount'), p1: v('lumaJitter'), p2: v('edgeWidth'), p3: v('edgeColor') };
    default:
      // Non-combineStep ops (feedback/exquisite/history) never call this.
      return { amount: 1 };
  }
}

/** The 1-input op kinds: a SINGLE cable. FEEDBACK's loop is internal; tile/
 *  mirror/bitbend/biocells transform one feed; the 1-input history ops
 *  (framedelay/channeldesync/flowsmear/datamosh) carry their own frame ring. */
const ONE_INPUT_OP_KINDS: readonly ToyboxNodeKind[] = [
  'feedback', 'tile', 'mirror', 'bitbend', 'biocells',
  'framedelay', 'channeldesync', 'flowsmear', 'datamosh',
];

/** The clamped uniform set the EXQUISITE program reads, derived from a node's
 *  raw params. PURE (no GL) so the clamp is unit-testable. */
export interface ExquisiteUniforms {
  bands: number;
  boundaryWarp: number;
  seamBlend: number;
  hueShift: number;
}
export function exquisiteUniforms(
  params: Record<string, number> | undefined | null,
): ExquisiteUniforms {
  const clamp = (v: unknown, min: number, max: number, def: number) => {
    const n = typeof v === 'number' && Number.isFinite(v) ? v : def;
    return n < min ? min : n > max ? max : n;
  };
  const p = params && typeof params === 'object' ? params : {};
  return {
    bands: Math.round(clamp(p.bands, 2, 8, 4)),
    boundaryWarp: clamp(p.boundaryWarp, 0, 1, 0.2),
    seamBlend: clamp(p.seamBlend, 0, 1, 0.1),
    hueShift: clamp(p.hueShift, 0, 1, 0),
  };
}

/**
 * The named sentinel for a "LAYER INPUT" texture source. A texture-source param
 * (OBJ material.surfaceSource, VIDEO videoSource='layerIn', FRAG/shadertoy
 * iChannel='layer-input') set to this value means "sample whatever node output
 * is wired into this layer's SOURCE-node input port (src{i}.in0)". In Phase 1
 * the wired tap is always resolved to the PREVIOUS frame's OUT composite
 * (outTexture — the only already-retained tap), so a post-feedback OUT -> SURFACE
 * loop reads one frame late and stays stable. The wired in0 edge expresses the
 * INTENT + the loop; the sentinel selects it on the param side.
 *
 * Distinct from -1 (MATCAP / no source) and 0..LAYER_COUNT-1 (a sibling layer
 * index). Negative so it never collides with a real layer index, and a NAMED
 * constant so setLayerSurfaceSource can preserve it instead of flooring to -1.
 */
export const LAYER_INPUT_SOURCE = -2;

/**
 * True if edge `to`/`toPort` is a LAYER-INPUT (feedback-tap) edge: an in0 wire
 * into a SOURCE node. SOURCE nodes are emit-only in the forward eval; their in0
 * port exists ONLY to express a feedback tap that the render resolves one frame
 * late (prev-frame OUT). Such an edge is BY DEFINITION a cycle (OUT -> src ->
 * graph -> OUT), so it is exempted from cycle rejection (validateConnect) and
 * dropped from the same-frame dependency order (topoSort) — exactly the discipline
 * the shadertoy 'self' channel + propagateFreshness already use for a tap.
 */
export function isLayerInputEdge(
  g: ToyboxCombineGraph,
  to: string,
  toPort: ToyboxInPort,
): boolean {
  if (toPort !== 'in0') return false;
  const n = findNode(g, to);
  return n?.kind === 'source';
}

/** The input ports a node of `kind` exposes (left-side dots in the editor).
 *  SOURCE nodes expose a single 'in0' — the LAYER-INPUT (feedback-tap) port.
 *  It is emit-only in the forward eval (hasOutPort('source') stays true); the
 *  in0 port carries a feedback tap resolved one frame late at render, so wiring
 *  it never adds a same-frame dependency (topoSort drops the edge). An unwired
 *  in0 dot is a pure no-op (renders an unused port). */
export function inPortsFor(kind: ToyboxNodeKind): ToyboxInPort[] {
  if (kind === 'source') return ['in0'];
  if (kind === 'output') return ['in0'];
  // EXQUISITE splices up to FOUR feeds (band i shows input i mod #wired).
  if (kind === 'exquisite') return ['in0', 'in1', 'in2', 'in3'];
  // The 1-input ops (FEEDBACK loop is internal; the others transform one feed).
  if (ONE_INPUT_OP_KINDS.includes(kind)) return ['in0'];
  // The remaining blend ops (fade/lumakey/chromakey/map/over/displace/dreammelt)
  // take a base + top.
  return ['in0', 'in1'];
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

/** Generate a fresh node id not already used in `g`. MONOTONIC (audit M3): the
 *  new id is one past the HIGHEST `<prefix><n>` suffix ever seen in the graph,
 *  NOT the lowest free one. A lowest-free id reuses a DELETED node's id
 *  (delete op2 from op1,op2,op3 → next add mints op2 again), which makes the new
 *  op silently INHERIT the deleted op's stale MIDI / control-surface bindings
 *  (keyed `…:combine:op2:<param>`). A monotonic id is never reused, so a freed
 *  id's stale bindings resolve to a non-existent node and are dropped — the new
 *  op gets a clean id. (Still guaranteed-unique: it's strictly above every
 *  existing suffix; a non-matching id, e.g. a hand-authored one, is ignored for
 *  the max but the final uniqueness loop still skips any collision.) */
export function nextNodeId(g: ToyboxCombineGraph, prefix = 'n'): string {
  const used = new Set(g.nodes.map((n) => n.id));
  let max = 0;
  const re = new RegExp(`^${prefix}(\\d+)$`);
  for (const n of g.nodes) {
    const m = re.exec(n.id);
    if (m) max = Math.max(max, parseInt(m[1]!, 10));
  }
  let i = max + 1;
  let id = `${prefix}${i}`;
  while (used.has(id)) id = `${prefix}${++i}`; // defensive: skip any odd collision
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
    // Drop LAYER-INPUT (feedback-tap) edges: an in0 wire into a SOURCE node is
    // resolved one frame late at render, NOT a same-frame dependency. Keeping it
    // would give the SOURCE indegree>0 (no longer a root) and could form a cycle
    // (OUT -> src -> ... -> OUT) that strands the whole graph. Excluding it keeps
    // the eval a clean acyclic single pass (the SOURCE stays a root, indegree 0).
    if (isLayerInputEdge(g, e.to, e.toPort)) continue;
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
 * Per-node FRESHNESS propagation for the M2b history-ring dedup (PURE — the
 * engine-free decision the engine's evalGraph applies to gate the ring store).
 *
 * A SOURCE node is fresh iff its layer presented a new frame this engine frame
 * (`layerFresh[layer]` — true for animated/gen/shader/obj/image/patched layers;
 * false for a live VIDEO layer whose decode is slower than the engine rAF). An OP
 * node is fresh iff ANY wired input is fresh; an op with NO wired inputs is fresh
 * (it animates itself). A stateful history op only advances its ring when fresh,
 * so ring delays count DECODED frames, not engine frames (kills the ~50%
 * duplicate-slot aliasing live video otherwise produces). Returns a map id→fresh
 * over every node, computed in topo order (so an input is resolved before its op).
 */
export function propagateFreshness(
  g: ToyboxCombineGraph,
  layerFresh: readonly boolean[] | ((layer: number) => boolean),
): Map<string, boolean> {
  const layerFreshFn =
    typeof layerFresh === 'function' ? layerFresh : (l: number) => layerFresh[l] ?? true;
  const fresh = new Map<string, boolean>();
  const { order } = topoSort(g);
  for (const id of order) {
    const n = g.nodes.find((x) => x.id === id);
    if (!n) continue;
    if (n.kind === 'source') {
      const li = typeof n.layer === 'number' ? n.layer : -1;
      fresh.set(id, li >= 0 ? layerFreshFn(li) : true);
      continue;
    }
    if (n.kind === 'output') {
      const e = g.edges.find((ed) => ed.to === id);
      fresh.set(id, e ? fresh.get(e.from) ?? true : true);
      continue;
    }
    // op: fresh iff any wired input is fresh (unwired → fresh, animates itself).
    let any = false;
    let wired = false;
    for (const e of g.edges) {
      if (e.to !== id) continue;
      wired = true;
      if (fresh.get(e.from) ?? true) { any = true; break; }
    }
    fresh.set(id, wired ? any : true);
  }
  return fresh;
}

/**
 * A live VIDEO layer is FRESH this engine frame iff its frame uploader actually
 * uploaded a NEW decoded frame (its uploadCount advanced since last frame). PURE
 * (the engine threads the live uploadCount + the prior count). Extracted so the
 * M2b dedup decision is unit-testable without a WebGL context.
 */
export function videoLayerFresh(uploadCount: number, lastUploadCount: number): boolean {
  return uploadCount !== lastUploadCount;
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
  // A LAYER-INPUT edge (in0 into a SOURCE node) is BY DEFINITION a feedback tap
  // (e.g. OUT -> src0.in0), so it is EXEMPT from cycle rejection — the render
  // resolves it one frame late (prev-frame OUT), never a same-frame loop, and
  // topoSort drops it so the eval stays acyclic. The self-loop / no-out-port /
  // occupied guards above still apply. A non-SOURCE destination keeps cycle
  // rejection exactly as before.
  if (!isLayerInputEdge(g, to, toPort) && wouldCreateCycle(g, from, to)) {
    return { ok: false, error: 'cycle' };
  }
  return { ok: true, edge: { id: nextEdgeId(g), from, to, toPort } };
}

/** Pure: a new op node to insert (id + default params + a layout slot). The
 *  caller pushes it into the live array. Lays it out in the op column under the
 *  lowest existing op (cosmetic). */
export function makeOpNode(g: ToyboxCombineGraph, kind: ToyboxOpKind): ToyboxGraphNode {
  const ops = g.nodes.filter((n) => n.kind !== 'source' && n.kind !== 'output');
  // Place the new node in the first grid slot whose (x,y) is NOT already taken
  // by an existing op node. Using `opSlotXY(ops.length)` directly was a bug:
  // slot positions are assigned at create time by the then-current op count, so
  // after a delete (or any non-contiguous occupancy) the count no longer maps to
  // a free slot. A graph with a single op at slot 1 (e.g. `op2` left after `op1`
  // was deleted) made `opSlotXY(1)` return slot 1's position again — stacking the
  // new node EXACTLY on top of the existing one ("Add LUMAKEY lands on the
  // existing CHROMA"). The new node is still independent (fresh id), it was just
  // drawn on top. Scan for the first unoccupied slot instead.
  const occupied = new Set(ops.map((n) => `${n.x},${n.y}`));
  const maxSlots = OP_COLS_X.length * OP_ROWS;
  let slot = 0;
  while (slot < maxSlots) {
    const p = opSlotXY(slot);
    if (!occupied.has(`${p.x},${p.y}`)) break;
    slot++;
  }
  const xy = opSlotXY(slot); // all slots full (>8 ops) → wraps to slot 0; acceptable
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
