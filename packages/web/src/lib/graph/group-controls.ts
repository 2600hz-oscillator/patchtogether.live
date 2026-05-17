// packages/web/src/lib/graph/group-controls.ts
//
// Module-grouping Phase 4 — exposed-controls helpers.
//
// Pure functions for:
//   - discovering the set of exposable controls per child module
//   - validating a `data.exposedControls` list against the live patch
//   - grouping the surviving entries by child for the renderer
//
// Lives in `lib/graph` (not `lib/ui`) so the schema-validation tests can
// import without dragging in any Svelte component.

import type { ModuleNode } from './types';
import type { ExposedControl, GroupData } from './group-projection';
import type { ExposableControl } from '$lib/audio/module-registry';

/**
 * Loose ModuleDef shape we care about for control discovery — accepts any
 * def that surfaces `exposableControls` (currently AudioModuleDef but the
 * future video registry can opt in by adding the same field). Kept narrow
 * so the helpers stay testable without a real module registry.
 */
export interface ControlDefLookup {
  (type: string): { exposableControls?: readonly ExposableControl[] } | undefined;
}

/**
 * For one child module, return its exposable controls list (or empty array
 * if the def doesn't declare any). Defensive: a missing def or undefined
 * field collapses to []. Never returns undefined.
 */
export function listExposableControls(
  childType: string,
  defLookup: ControlDefLookup,
): readonly ExposableControl[] {
  const def = defLookup(childType);
  return def?.exposableControls ?? [];
}

/**
 * Validate raw `exposedControls` entries against the live patch. An entry
 * survives iff:
 *   - `childId` references a node still present in the patch
 *   - that node's def declares an `exposableControls` entry whose `id`
 *     matches `controlId`
 *
 * Sister to the implicit "ExposedPort references existing child" check in
 * group-projection's projectGroups — without this, a stale entry from a
 * since-deleted child renders as an empty bounded box.
 */
export function validateExposedControls(
  raw: readonly ExposedControl[],
  args: {
    nodes: Record<string, ModuleNode | undefined>;
    defLookup: ControlDefLookup;
  },
): ExposedControl[] {
  const out: ExposedControl[] = [];
  for (const ec of raw) {
    const child = args.nodes[ec.childId];
    if (!child) continue;
    const controls = listExposableControls(child.type, args.defLookup);
    if (!controls.some((c) => c.id === ec.controlId)) continue;
    out.push({ childId: ec.childId, controlId: ec.controlId });
  }
  return out;
}

/** One bounded box on the group bar — a child module's exposed controls. */
export interface RenderableControlGroup {
  childId: string;
  /** Live ModuleNode for reading params + writing through the patch. */
  child: ModuleNode;
  /** Resolved control defs in the user-saved order. */
  controls: ExposableControl[];
  /** Display label (data.name when present, else def label, else type). */
  childLabel: string;
}

/**
 * Resolve a group's `data.exposedControls` into a render-ready list, one
 * entry per child that has at least one exposed control. Preserves the
 * order entries were added in (saved order = render order = visual stability
 * across re-renders).
 *
 * `defLabelLookup` returns the module def's display label (e.g. 'DRUMSEQZ').
 * Falls back to data.name (livecode auto-name PR #81) or the bare type.
 */
export function resolveExposedControls(
  group: { data?: unknown } | undefined,
  args: {
    nodes: Record<string, ModuleNode | undefined>;
    defLookup: ControlDefLookup;
    defLabelLookup?: (type: string) => string | undefined;
  },
): RenderableControlGroup[] {
  const data = group?.data as GroupData | undefined;
  const raw = data?.exposedControls ?? [];
  if (raw.length === 0) return [];

  const valid = validateExposedControls(raw, args);
  const byChild = new Map<string, ExposedControl[]>();
  for (const ec of valid) {
    const arr = byChild.get(ec.childId) ?? [];
    arr.push(ec);
    byChild.set(ec.childId, arr);
  }

  const out: RenderableControlGroup[] = [];
  for (const [childId, entries] of byChild) {
    const child = args.nodes[childId];
    if (!child) continue;
    const controlDefs = listExposableControls(child.type, args.defLookup);
    const resolved: ExposableControl[] = [];
    for (const ec of entries) {
      const def = controlDefs.find((c) => c.id === ec.controlId);
      if (def) resolved.push(def);
    }
    if (resolved.length === 0) continue;
    const dataName = (child.data as Record<string, unknown> | undefined)?.name;
    const childLabel =
      (typeof dataName === 'string' && dataName.length > 0
        ? dataName
        : args.defLabelLookup?.(child.type)) ?? child.type;
    out.push({ childId, child, controls: resolved, childLabel });
  }
  return out;
}
