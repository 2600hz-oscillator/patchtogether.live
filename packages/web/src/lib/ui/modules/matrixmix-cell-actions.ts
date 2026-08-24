// packages/web/src/lib/ui/modules/matrixmix-cell-actions.ts
//
// The read/write halves of matrixMix's TWO faceplate cells — the X-axis and
// Y-axis module pickers.
//
// ⚠ EXTRACTED FROM THE CARD, NEVER RE-IMPLEMENTED. `MatrixMixCard.svelte` built
// this roster inline: every patch node with at least one jack, minus the matrix
// itself, sorted by display name, with a dangling selection dropped when its
// module is deleted. A second copy in the face would be the backdraft class in
// a new dress — two surfaces disagreeing about which modules are selectable,
// with every def-reading gate green because neither surface's roster comes from
// a def. The card now calls these same four functions, so the two surfaces
// cannot drift apart.
//
// ⚠ AND A RUNTIME ROSTER *IS* EXPRESSIBLE AS A FACE CELL, contrary to a shipped
// comment. `legacy-fallback.ts`'s cameraInput lineage note says of THAT module's
// device picker: "It is NOT a ParamDef, so no shell face can render it". Read as
// a general claim that is false — `ShellSelectorCell.options` is a FUNCTION
// evaluated per render, and a cell-actions module may reach the whole graph
// (kria-cell-actions imports `patch` from $lib/graph/store, exactly as the card
// does). The real constraint is WHERE THE ROSTER LIVES, not that it is derived
// at runtime: a roster derivable from the GRAPH is reachable; one living behind
// a browser API (`enumerateDevices()`) or on an engine handle is not. The
// cameraInput note is right about cameraInput and wrong as a rule.

import type { SelectorOption } from '$lib/ui/controls';
import type { ModuleNode } from '$lib/graph/types';
import { patch } from '$lib/graph/store';
import { getModuleDef } from '$lib/audio/module-registry';
import { getVideoModuleDef } from '$lib/video/module-registry';
import { getMetaModuleDef } from '$lib/meta/module-registry';
import { resolveDisplayName } from '$lib/multiplayer/module-naming';
import { readMatrixData, setXAxisModule, setYAxisModule } from '$lib/graph/matrixmix';

/** The any-domain def lookup — the SAME chain validate-edge / persistence use. */
function defLookup(type: string) {
  return getModuleDef(type) ?? getVideoModuleDef(type) ?? getMetaModuleDef(type);
}

/** One selectable axis module. */
export interface MatrixAxisChoice {
  nodeId: string;
  name: string;
}

/** The placeholder option — an unset axis is a real state, not an absence. */
export const MATRIXMIX_NO_AXIS = '';

// ── THE MEMO, AND WHY IT IS A REQUIREMENT RATHER THAN AN OPTIMISATION ────────
//
// `MatrixMixCard.svelte` invalidates on `docVersion()` — the WHOLE-DOC version —
// and its own comment already calls that "a known follow-up":
//
//   "MATRIXMIX is the one legitimately near-global card: moduleChoices scans
//    ALL nodes and the grid scans ALL edges, so it keeps per-transaction
//    invalidation for now."
//
// That was harmless while the card was DOCK-ONLY: the scan ran only when
// somebody opened the full view. After promotion the two selector cells live in
// the LANE TILE, always mounted, on every rack that contains a matrix node — so
// the roster re-derives on every Y.Doc transaction, including every cable move
// under CV modulation. That is a real repaint budget on a busy rack.
//
// The fix is not to cache harder, it is to cache on the RIGHT KEY. A cable
// moving changes `docVersion` and CANNOT change this roster; only a spawn, a
// delete or a rename can. So the memo is keyed on a NODE-SET SIGNATURE — the
// ids and display names that the roster is actually a function of — which makes
// the cache correct by construction rather than by timing.
//
// ⚠ THE SIGNATURE IS BUILT FROM THE SAME VALUES THE ROSTER RETURNS. A signature
// over a cheaper proxy (a node count, a version number) would be exactly the
// instrument that is invariant to the dimension under test: renaming a module
// leaves the count identical and would serve a stale roster forever, with
// nothing able to notice. Building it is O(nodes) — the same order as the scan
// it guards — so what the memo saves is the SORT and the allocation, not the
// walk. That is stated rather than implied because a reader will reasonably
// expect a memo to skip the walk, and this one cannot.
//
// `matrixmix-face-model.test.ts` measures it in both directions: spawning a node
// MUST move the roster, moving a cable must NOT.

interface RosterMemo {
  signature: string;
  choices: readonly MatrixAxisChoice[];
}
let memo: RosterMemo | null = null;

/**
 * How many times the roster has actually been RE-DERIVED (a memo MISS).
 *
 * ⚠ IT IS AN IN-PAGE ACCUMULATOR ON PURPOSE. The thing being measured is how
 * often a lane-mounted cell recomputes under Y.Doc traffic, and sampling that
 * with a Playwright poll loop would be one round-trip per sample ON THE SAME
 * MAIN THREAD AS THE SUBJECT — a loaded runner starves both, and "the roster
 * froze" and "the probe never looked" produce identical output. The page counts;
 * the test reads the total once and reports it with its units.
 *
 * ⚠ IT IS NOT RESET BY `__resetMatrixmixRosterMemo`. A reset that also zeroed
 * this would let a test clear the cache and then assert "no derivations", which
 * is a measurement of the reset rather than of the memo.
 */
let derivations = 0;

/** Total roster re-derivations since page load (memo misses). See `derivations`. */
export function matrixmixRosterDerivations(): number {
  return derivations;
}

/** Display name for a node — the EXISTING naming system, not a new one. */
function nameOf(nodeId: string): string {
  const n = patch.nodes[nodeId] as ModuleNode | undefined;
  if (!n) return nodeId;
  return resolveDisplayName(n, patch.nodes as Record<string, ModuleNode | undefined>);
}

/**
 * Every patch module that HAS at least one jack (so a chosen axis yields a
 * meaningful grid), EXCLUDING `selfNodeId`. Sorted by display name.
 *
 * Pure with respect to the live graph: same nodes + same names in, same list
 * out. `selfNodeId` is applied AFTER the memo so two matrix nodes on one rack
 * share the walk instead of thrashing each other's cache.
 */
export function matrixmixAxisChoices(selfNodeId: string | undefined): readonly MatrixAxisChoice[] {
  const all: MatrixAxisChoice[] = [];
  const sig: string[] = [];
  for (const [nodeId, n] of Object.entries(patch.nodes)) {
    if (!n) continue;
    const def = defLookup(n.type);
    if (!def) continue;
    if (def.inputs.length === 0 && def.outputs.length === 0) continue; // no jacks
    const name = nameOf(nodeId);
    all.push({ nodeId, name });
    sig.push(JSON.stringify([nodeId, name]));
  }
  // Sorted so the signature is insertion-order independent, and each pair is
  // JSON-encoded rather than concatenated: without a delimiter `[ab, c]` and
  // `[a, bc]` hash identically, and a rename could slip past the cache.
  const signature = sig.sort().join('\n');
  if (!memo || memo.signature !== signature) {
    all.sort((a, b) => a.name.localeCompare(b.name));
    memo = { signature, choices: all };
    derivations += 1;
  }
  return selfNodeId ? memo.choices.filter((c) => c.nodeId !== selfNodeId) : memo.choices;
}

/** Drop the memo. Test seam ONLY — the signature makes the cache correct at
 *  runtime, and a production caller reaching for this would be papering over a
 *  signature that is missing a dimension. */
export function __resetMatrixmixRosterMemo(): void {
  memo = null;
}

/** The SelectorOption roster both axis cells render. */
function axisOptions(selfNodeId: string | undefined): SelectorOption<string>[] {
  const opts: SelectorOption<string>[] = [
    { value: MATRIXMIX_NO_AXIS, label: '— pick a module —' },
  ];
  for (const c of matrixmixAxisChoices(selfNodeId)) {
    opts.push({ value: c.nodeId, label: c.name });
  }
  return opts;
}

export function matrixmixXAxisOptions(node: ModuleNode | undefined): SelectorOption<string>[] {
  return axisOptions(node?.id);
}

export function matrixmixYAxisOptions(node: ModuleNode | undefined): SelectorOption<string>[] {
  return axisOptions(node?.id);
}

/**
 * The selected axis id, with a DANGLING selection dropped.
 *
 * ⚠ THE DROP IS THE INTERESTING HALF, and it is why this cannot be a bare
 * `node.data.xAxisModuleId` read. When a matrixed module is deleted the id
 * persists on the node; without this the cell would render a value that is not
 * in its own option roster (a selector showing a state it cannot be set to) and
 * the grid would dangle instead of emptying cleanly. The card has always done
 * this; the cells inherit it rather than re-deciding it.
 */
export function matrixmixXAxisValue(node: ModuleNode | undefined): string {
  const sel = readMatrixData(node).xAxisModuleId;
  return sel && patch.nodes[sel] ? sel : MATRIXMIX_NO_AXIS;
}

export function matrixmixYAxisValue(node: ModuleNode | undefined): string {
  const sel = readMatrixData(node).yAxisModuleId;
  return sel && patch.nodes[sel] ? sel : MATRIXMIX_NO_AXIS;
}

/** Write the X axis. The SAME writer the card's `<select>` calls — one
 *  LOCAL_ORIGIN transaction, so it rides the Y.Doc to rack-mates and lands on
 *  the undo stack. */
export function matrixmixSetXAxis(nodeId: string, value: string): void {
  setXAxisModule(nodeId, value || undefined);
}

/** Write the Y axis. See matrixmixSetXAxis. */
export function matrixmixSetYAxis(nodeId: string, value: string): void {
  setYAxisModule(nodeId, value || undefined);
}

