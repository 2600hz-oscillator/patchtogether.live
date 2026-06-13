// packages/web/src/lib/ui/matrixmix-grid.ts
//
// MATRIXMIX — PURE matrix-classification core (no Svelte / no Yjs).
//
// MATRIXMIX is an EMS-Synthi / Buchla-style patch MATRIX card. The user picks
// an X-axis module and a Y-axis module from the patch; the card draws a grid
// whose COLUMNS are every jack (input AND output) of the X-module and whose
// ROWS are every jack of the Y-module. Each CELL is the potential connection
// between that row-jack and that column-jack.
//
// This file is the framework-free brain: given two jacks + the live edge set,
// it classifies a cell into one of five kinds and (for a legal empty cell) tells
// the caller exactly which edge to create. It imports ONLY the data-model types
// + the SHARED type-compatibility rule (canConnectToPort) the drag-connect
// validator and the right-click patch cascade already use — it invents no
// parallel patch rule. Mirrors validate-edge.ts / port-patch-helpers.ts purity
// so it ports straight into the native core.

import type { CableType, Edge, PortDef } from '$lib/graph/types';
import { canConnectToPort } from '$lib/graph/types';

/** One jack on a matrixed module — an input OR an output port. */
export interface Jack {
  portId: string;
  direction: 'input' | 'output';
  type: CableType;
  /** Source-widening `accepts` list (input ports only — e.g. a SCOPE probe
   *  taking the CV family on an audio input). Honoured by canConnectToPort so
   *  matrix legality matches the drag validator exactly. */
  accepts?: readonly CableType[];
}

/** Every jack of a module = every input then every output, in def order. */
export function jacksForDef(
  def: { inputs: readonly PortDef[]; outputs: readonly PortDef[] } | undefined,
): Jack[] {
  if (!def) return [];
  const out: Jack[] = [];
  for (const p of def.inputs) out.push({ portId: p.id, direction: 'input', type: p.type, accepts: p.accepts });
  for (const p of def.outputs) out.push({ portId: p.id, direction: 'output', type: p.type });
  return out;
}

/** What a single matrix cell represents in the LIVE patch. */
export type CellKind =
  /** A direct cable ALREADY runs between these two matrixed jacks. Filled
   *  circle, coloured by the cable's content type. */
  | 'direct'
  /** The INPUT jack of this cell is already fed by a cable from a THIRD module.
   *  Clicking would REPLACE that source (destructive) → red ✕. */
  | 'inputTaken'
  /** The OUTPUT jack of this cell already feeds a THIRD module. Outputs fan out,
   *  so a patch here ADDS a cable (non-destructive) → gray ✕. */
  | 'outputFanout'
  /** One input + one output + compatible types, no conflict → clickable. */
  | 'legalEmpty'
  /** Not a materializable patch (input→input, output→output, or type mismatch)
   *  → red-✕ cursor, click does nothing. */
  | 'illegal';

export interface CellClassification {
  kind: CellKind;
  /** For 'direct': the existing cable's CONTENT type, for colouring (the
   *  source-emitted type). Absent for every other kind. */
  cableType?: CableType;
  /** For 'direct': the id of the SINGLE edge that spans these two matrixed
   *  jacks, so the card can REMOVE it on click (unpatch). There is at most one
   *  input←output cable per jack-pair (an input takes one cable), so this is
   *  unambiguous. Absent for every other kind. */
  edgeId?: string;
  /** For 'inputTaken' / 'outputFanout': the THIRD-party endpoint, for the
   *  hover tooltip ("sourceModuleName.portId"). */
  remote?: { name: string; port: string };
  /** For 'legalEmpty': the edge endpoints to create on click — the cable runs
   *  source(output) → target(input). The card builds the Edge id + types and
   *  writes it. Absent for every other kind. */
  patch?: {
    source: { nodeId: string; portId: string };
    target: { nodeId: string; portId: string };
  };
}

/**
 * The LEGAL-PATCH predicate the matrix shares with the rest of the UI: a pair
 * of jacks is materializable iff exactly ONE is an input and ONE is an output
 * AND the cable type is compatible (canConnectToPort — the SAME rule the
 * drag-connect validator + patch-to cascade use). Returns the resolved
 * input/output roles when legal, else null.
 *
 * NB the same module can sit on BOTH axes (X === Y). A cell on the diagonal
 * pairs a jack with ITSELF (same portId, same direction) — never one input +
 * one output — so it is always illegal here, which is correct (you can't patch
 * a jack to itself).
 */
export function resolvePatchRoles(
  rowJack: Jack,
  colJack: Jack,
): { input: Jack; output: Jack } | null {
  // Need exactly one input and one output.
  if (rowJack.direction === colJack.direction) return null;
  const input = rowJack.direction === 'input' ? rowJack : colJack;
  const output = rowJack.direction === 'output' ? rowJack : colJack;
  // Type compatibility: cable runs output.type → input.type. Honour the input
  // port's `accepts` widening (canConnectToPort), exactly like the drag path.
  if (!canConnectToPort(output.type, { type: input.type, accepts: input.accepts })) return null;
  return { input, output };
}

/**
 * Find the edge (if any) that DIRECTLY connects the two matrixed jacks — i.e.
 * runs between (xModuleId, colJack) and (yModuleId, rowJack) in either
 * direction. Returns the edge or undefined.
 */
export function findDirectEdge(
  rowJack: Jack,
  colJack: Jack,
  edges: Iterable<Edge | undefined>,
  xModuleId: string,
  yModuleId: string,
): Edge | undefined {
  // rowJack lives on the Y module, colJack on the X module.
  for (const e of edges) {
    if (!e) continue;
    const s = e.source;
    const t = e.target;
    const sIsCol = s.nodeId === xModuleId && s.portId === colJack.portId;
    const sIsRow = s.nodeId === yModuleId && s.portId === rowJack.portId;
    const tIsCol = t.nodeId === xModuleId && t.portId === colJack.portId;
    const tIsRow = t.nodeId === yModuleId && t.portId === rowJack.portId;
    // The cable directly spans this cell's two jacks (output endpoint → input
    // endpoint), in whichever orientation.
    if ((sIsCol && tIsRow) || (sIsRow && tIsCol)) return e;
  }
  return undefined;
}

/**
 * Find the edge terminating on a given INPUT jack, if any (the occupant). One
 * input takes at most one cable — patching a second replaces it. Same
 * semantics as port-patch-helpers.findOccupant, restated here so the pure core
 * carries no UI-helper import.
 */
function findInputOccupant(
  nodeId: string,
  portId: string,
  edges: Iterable<Edge | undefined>,
): Edge | undefined {
  for (const e of edges) {
    if (!e) continue;
    if (e.target.nodeId === nodeId && e.target.portId === portId) return e;
  }
  return undefined;
}

/**
 * Find any edge that the given OUTPUT jack already feeds (it fans out, so there
 * may be several — return the FIRST for the tooltip). Returns undefined if the
 * output drives nothing.
 */
function findOutputConsumer(
  nodeId: string,
  portId: string,
  edges: Iterable<Edge | undefined>,
): Edge | undefined {
  for (const e of edges) {
    if (!e) continue;
    if (e.source.nodeId === nodeId && e.source.portId === portId) return e;
  }
  return undefined;
}

/** Module-id of a jack within a cell. rowJack lives on Y, colJack on X. */
function jackNodeId(jack: Jack, rowJack: Jack, xModuleId: string, yModuleId: string): string {
  return jack === rowJack ? yModuleId : xModuleId;
}

/**
 * Classify ONE matrix cell against the live patch.
 *
 * @param rowJack    the Y-module jack for this row
 * @param colJack    the X-module jack for this column
 * @param edges      the live edge set (any iterable of Edge)
 * @param xModuleId  the X-axis module's node id
 * @param yModuleId  the Y-axis module's node id
 * @param nameOf     resolve a node id → its user-facing display name (the
 *                   card passes a resolveDisplayName-backed lookup); used only
 *                   for the inputTaken / outputFanout tooltip.
 *
 * Decision order:
 *   1. DIRECT — a cable already spans these exact two jacks → 'direct'
 *      (cableType = the source-emitted content type). Checked first so an
 *      already-patched cell never reads as "taken/fanout" against itself.
 *   2. ILLEGAL — not a legal input/output + compatible-type pair → 'illegal'.
 *   3. INPUT-TAKEN — the legal pair's INPUT jack is already fed by a THIRD
 *      module → 'inputTaken' (+ remote tooltip). Re-patching would replace it.
 *   4. OUTPUT-FANOUT — the legal pair's OUTPUT jack already feeds a THIRD
 *      module → 'outputFanout' (+ remote tooltip). Patching only ADDS a cable.
 *      (If BOTH apply, INPUT-TAKEN wins — it's the destructive one the user
 *      most needs warned about.)
 *   5. LEGAL-EMPTY — clickable; carries the {source, target} to create.
 */
export function classifyCell(
  rowJack: Jack,
  colJack: Jack,
  edges: Iterable<Edge | undefined>,
  xModuleId: string,
  yModuleId: string,
  nameOf: (nodeId: string) => string,
): CellClassification {
  // Re-usable snapshot so multiple passes don't re-consume a one-shot iterator.
  const edgeList = [...edges].filter((e): e is Edge => !!e);

  // 1) DIRECT connection already spans this cell.
  const direct = findDirectEdge(rowJack, colJack, edgeList, xModuleId, yModuleId);
  if (direct) {
    // The cell's cable colour follows the SOURCE-emitted content type (what the
    // output puts on the wire) — same as the canvas cables. Carry the edge id
    // so a click can REMOVE exactly this cable (unpatch) — there is at most one
    // input←output cable per jack-pair, so the id is unambiguous.
    return { kind: 'direct', cableType: direct.sourceType, edgeId: direct.id };
  }

  // 2) Legal input/output + compatible-type pair?
  const roles = resolvePatchRoles(rowJack, colJack);
  if (!roles) return { kind: 'illegal' };

  const inputNodeId = jackNodeId(roles.input, rowJack, xModuleId, yModuleId);
  const outputNodeId = jackNodeId(roles.output, rowJack, xModuleId, yModuleId);

  // 3) INPUT already fed by a THIRD module (destructive re-patch) — red ✕.
  const occ = findInputOccupant(inputNodeId, roles.input.portId, edgeList);
  if (occ) {
    return {
      kind: 'inputTaken',
      remote: { name: nameOf(occ.source.nodeId), port: occ.source.portId },
    };
  }

  // 4) OUTPUT already feeds a THIRD module (non-destructive add) — gray ✕.
  const consumer = findOutputConsumer(outputNodeId, roles.output.portId, edgeList);
  if (consumer) {
    return {
      kind: 'outputFanout',
      remote: { name: nameOf(consumer.target.nodeId), port: consumer.target.portId },
    };
  }

  // 5) Legal + empty → clickable. The cable runs output → input.
  return {
    kind: 'legalEmpty',
    patch: {
      source: { nodeId: outputNodeId, portId: roles.output.portId },
      target: { nodeId: inputNodeId, portId: roles.input.portId },
    },
  };
}

/** Stable, deterministic id for the edge a legal cell creates — mirrors the
 *  Canvas/patch-to edge-id convention `e-<src>-<srcPort>-<dst>-<dstPort>` so the
 *  matrix and the drag/patch-to paths address the SAME edge (idempotent
 *  re-patch, and a direct-cell read recognises an edge made by EITHER path). */
export function matrixEdgeId(
  source: { nodeId: string; portId: string },
  target: { nodeId: string; portId: string },
): string {
  return `e-${source.nodeId}-${source.portId}-${target.nodeId}-${target.portId}`;
}
