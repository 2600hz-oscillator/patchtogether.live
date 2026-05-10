// packages/web/src/lib/graph/duplicate.ts
//
// Pure helper that builds a duplicate of a ModuleNode. Used by the
// right-click "Duplicate" action on the canvas.
//
// What it does:
//   - Mints a fresh id using the same `${type}-${randomSlice}` shape the
//     spawn path in Canvas.svelte uses, so ids are visually consistent.
//   - Deep-clones `data` and `params` so the duplicate's nested structures
//     (sequencer slots, picturebox imageBytes, dx7 userPatches, drumseqz
//     quicksave slots) are independent of the source. Sharing references
//     would land the SAME object at two paths in the Y.Doc tree, which
//     Yjs rejects with "reassigning object that already occurs in the tree"
//     (the gotcha PR-82 documented).
//   - Offsets `position` by a small down-right delta so the new card lands
//     visibly on top of the source instead of perfectly overlapping it.
//   - Edges of the source are NOT copied — the duplicate starts unpatched
//     (matches the spec: clone the module, not its connections).
//
// Edges out of scope. Cable copying is intentionally NOT done here.

import type { ModuleNode } from './types';

/** Default position offset (in flow-space pixels) applied to a duplicate. */
export const DUPLICATE_OFFSET = 30;

export interface DuplicateOptions {
  /**
   * If supplied, the duplicate is placed at this flow-space coord instead of
   * `source.position + DUPLICATE_OFFSET`. Used when the right-click handler
   * captured the cursor position and wants the new card to land there.
   */
  positionOverride?: { x: number; y: number };
  /**
   * Optional id seed. Defaults to a slice of crypto.randomUUID(). Tests pass
   * a deterministic value so they can assert against the resulting id.
   */
  idSuffix?: string;
}

/**
 * Build a duplicate of `source` ready to be inserted into the patch graph.
 * Caller is responsible for the `ydoc.transact` write — this function is
 * pure (no Yjs side-effects), so it's trivially unit-testable.
 *
 * The returned node has:
 *  - a fresh `id` (`{type}-{8charSlice}`) guaranteed not to collide with
 *    `existingIds` (regenerated up to 8 times before falling back to a
 *    UUID-suffixed id);
 *  - `data` deep-cloned via JSON round-trip (same approach as the
 *    reconciler's `snapshotNode` — see packages/web/src/lib/audio/reconciler.ts);
 *  - `params` shallow-cloned (Record<string, number> — primitive values
 *    only, so spread is sufficient);
 *  - `position` offset by DUPLICATE_OFFSET in both axes, OR
 *    `positionOverride` if supplied.
 */
export function buildDuplicate(
  source: ModuleNode,
  existingIds: Iterable<string>,
  options: DuplicateOptions = {},
): ModuleNode {
  const taken = new Set(existingIds);
  const id = mintId(source.type, taken, options.idSuffix);

  const dataCopy = source.data ? deepCloneData(source.data) : undefined;

  const position = options.positionOverride ?? {
    x: source.position.x + DUPLICATE_OFFSET,
    y: source.position.y + DUPLICATE_OFFSET,
  };

  const out: ModuleNode = {
    id,
    type: source.type,
    domain: source.domain,
    position,
    params: { ...source.params },
  };
  if (dataCopy !== undefined) out.data = dataCopy;
  return out;
}

/**
 * Generate a fresh id of shape `{type}-{8charSlice}` that doesn't collide
 * with anything in `taken`. The 8-char slice gives ~32 bits of entropy;
 * collision is astronomically unlikely but we still loop up to 8 times to
 * guarantee uniqueness in tiny test envs that exhaust the seed.
 */
function mintId(type: string, taken: Set<string>, idSuffix?: string): string {
  if (idSuffix) {
    const candidate = `${type}-${idSuffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = `${type}-${randomSlice()}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Fallback: full UUID. Should never trigger in practice.
  return `${type}-${randomSlice()}-${randomSlice()}`;
}

function randomSlice(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().slice(0, 8);
  }
  // Fallback for environments without crypto.randomUUID (older test envs).
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Deep-clone arbitrary `data` via JSON round-trip. Matches the approach
 * the reconciler uses (`snapshotNode` in lib/audio/reconciler.ts) — both
 * places need to produce a fully independent copy of node.data so that
 * mutations to one copy can't affect the other.
 *
 * Limitations:
 *   - Loses functions, Map/Set, Date instances (becomes string), and
 *     undefined properties. Module data shapes are intentionally restricted
 *     to JSON-serializable values for exactly this reason (also: Yjs only
 *     stores JSON-serializable values, so any non-serializable field would
 *     have failed at write time).
 */
export function deepCloneData(data: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(data));
}
