// packages/web/src/lib/graph/cap.ts
//
// SINGLE SOURCE OF TRUTH for type-level module instance counting.
//
// Every spawn route in Canvas.svelte (palette / drag-drop / keyboard,
// right-click Duplicate, duplicate-group, insert-saved-group, the dev
// auto-spawn hook) independently re-implemented the same two operations:
//
//   1. "how many nodes of this module `type` are already in the patch?"
//   2. "would adding one more exceed this def's `maxInstances` cap?"
//
// Five hand-rolled copies of `for (node of nodes) if (node.type === type)
// existing++` drifted apart over time (some iterate `Object.values`, some
// build a `Map`, some compare `>=`, some `>`). This module collapses them to
// ONE pair of pure functions so every layer — and the upcoming Phase 4c
// singleton-cleanup pass — counts identically.
//
// SCOPE: type-level `def.maxInstances` ONLY. The per-user / per-rackspace
// PICTUREBOX + camera + SAMSLOOP caps live in their own helpers
// (video/picturebox-limits.ts etc.) — they key off currentUserId and a
// per-rackspace budget, NOT the flat type count, so they are deliberately
// NOT folded in here.
//
// PURE + framework-free: no Svelte, no Yjs, no `$lib` imports (the one
// relative import below is the equally-pure workflow-pins spec table).
// Typed against minimal structural shapes so it accepts a live SyncedStore
// `patch.nodes` record, a plain `{ id: node }` map, or any record of
// node-likes — and ports verbatim to the native core.

import { WORKFLOW_PINNED_SURFACES } from './workflow-pins';

/** Minimal shape this module needs from a patch node: its module type +
 *  (optionally) the cross-cutting `data.pinned` flag (workflow-mode pinned
 *  singletons — see graph/workflow-pins.ts). */
export interface TypedNode {
  type: string;
  data?: { pinned?: unknown } | null;
}

/** Types whose PINNED instance DOES consume the `maxInstances` budget.
 *
 * These are the presence-by-TYPE workflow surface pins (today: TIMELORDE).
 * For a rack singleton, the always-on pinned instance IS the rack's one
 * instance — letting a canvas copy spawn beside it would give the rack two
 * competing system clocks. Multi-instance pins (audioIn / audioOut /
 * midiclock) and the drawer trio keep the P1 rule: pinned instances live
 * OUTSIDE the cap economy ("additional instances spawn as normal canvas
 * cards"). */
const PINNED_COUNTS_TOWARD_CAP: ReadonlySet<string> = new Set(
  WORKFLOW_PINNED_SURFACES.filter((s) => s.presence === 'type').map((s) => s.type),
);

/** Minimal shape this module needs from a module def: its type + (optional)
 *  instance cap. `maxInstances` undefined ⇒ no cap. */
export interface CapDef {
  type: string;
  /** Type-level instance cap. `undefined` ⇒ unbounded (no cap). */
  maxInstances?: number;
}

/**
 * Count how many nodes in the patch are of module `type`.
 *
 * `nodes` is a record keyed by node id (the live `patch.nodes` shape) whose
 * values are node-likes carrying a `.type`. Null/undefined holes (a key whose
 * value was deleted but not yet pruned) are skipped — matching the
 * `if (!node) continue` guard every call-site already had.
 *
 * Counts by `type` value alone, so a custom / non-prefixed node id (e.g. a
 * saved-group child whose id doesn't start with its type) is still counted
 * correctly.
 *
 * PINNED nodes (`data.pinned === true` — the workflow-mode always-on
 * drawer singletons, graph/workflow-pins.ts) are EXCLUDED: they live
 * outside the canvas economy (drawer-only, undeletable, auto-spawned), so
 * they must not consume a type's `maxInstances` budget — "additional
 * instances spawn as normal canvas cards" (e.g. the pinned ELECTRA CONTROL
 * plus the one user-spawnable canvas instance its `maxInstances: 1`
 * allows). Dawless racks never contain pinned nodes, so this is inert
 * there.
 *
 * EXCEPTION (P2): presence-by-TYPE surface pins (PINNED_COUNTS_TOWARD_CAP
 * — today just TIMELORDE) DO count. The pinned TIMELORDE is the rack's one
 * system clock; excluding it would let the palette spawn a second,
 * competing clock beside the hidden one.
 */
export function instanceCount(
  nodes: Record<string, TypedNode | null | undefined>,
  type: string,
): number {
  const pinnedCounts = PINNED_COUNTS_TOWARD_CAP.has(type);
  let n = 0;
  for (const node of Object.values(nodes)) {
    if (!node || node.type !== type) continue;
    if (node.data?.pinned === true && !pinnedCounts) continue;
    n++;
  }
  return n;
}

/**
 * Would adding ONE more node of `def.type` exceed `def.maxInstances`?
 *
 *   - `false` when `def.maxInstances` is undefined (no cap — unbounded).
 *   - `true`  when the current count is already AT or OVER the cap (i.e.
 *     `count >= maxInstances`), because the prospective add would make it
 *     `count + 1 > maxInstances`.
 *   - `false` while strictly under the cap.
 *
 * This is the exact predicate the single-add spawn gates used
 * (`existing >= def.maxInstances`), expressed once.
 */
export function wouldExceedCap(
  nodes: Record<string, TypedNode | null | undefined>,
  def: CapDef | null | undefined,
): boolean {
  if (def == null) return false; // no def ⇒ no cap to apply
  const cap = def.maxInstances;
  if (cap === undefined) return false; // no cap ⇒ never exceeds
  return instanceCount(nodes, def.type) >= cap;
}
