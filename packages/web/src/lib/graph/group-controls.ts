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

import type { ModuleNode, ParamDef } from './types';
import type { ExposedControl, GroupData } from './group-projection';
import type { ExposableControl } from '$lib/audio/module-registry';

/**
 * Loose ModuleDef shape we care about for control discovery — accepts any
 * def that surfaces `exposableControls` and/or `params` (currently
 * AudioModuleDef but the future video registry can opt in by adding the
 * same fields). Kept narrow so the helpers stay testable without a real
 * module registry.
 */
export interface ControlDefLookup {
  (type: string): {
    exposableControls?: readonly ExposableControl[];
    params?: readonly ParamDef[];
  } | undefined;
}

/**
 * Per-param-id excludelist: params we never expose to the group bar even
 * though `def.params` lists them. These are either internal state
 * (e.g. wavesculpt camera persistence) or input-CV proxies the bar can't
 * meaningfully display. Modules can still declare an explicit
 * `exposableControls` entry referencing the same param if they want it
 * surfaced under a custom label/kind.
 */
const AUTO_EXPOSE_EXCLUDE_PARAM_IDS: ReadonlySet<string> = new Set([
  // wavesculpt persisted camera state — not a user-facing knob
  'camera_x', 'camera_y', 'camera_z', 'camera_yaw', 'camera_pitch',
]);

/** Heuristic: does the ParamDef look like a 0/1 toggle? */
function looksLikeToggle(p: ParamDef): boolean {
  return p.curve === 'discrete' && p.min === 0 && p.max === 1;
}

/**
 * For one child module, return its exposable controls list — explicit
 * entries from `def.exposableControls` first (so custom labels/kinds win),
 * then auto-synthesized knob/button entries for every other param in
 * `def.params`. This is the "all controls are exposable" Instruments-v2
 * default: a module that doesn't curate its own list still surfaces every
 * knob and toggle the user might want on the instrument bar.
 *
 * Stable id rule: synthesized entries use `param-${param.id}` so they
 * don't collide with explicit ids (which are author-chosen, e.g.
 * 'playStop'). Renaming an underlying param will invalidate any saved
 * `exposedControls` entries that referenced it (treated as data migration).
 */
export function listExposableControls(
  childType: string,
  defLookup: ControlDefLookup,
): readonly ExposableControl[] {
  const def = defLookup(childType);
  if (!def) return [];
  const explicit = def.exposableControls ?? [];
  const params = def.params ?? [];

  // Track which paramIds the explicit list already covers so we don't
  // duplicate them in the auto-synthesized tail.
  const coveredParamIds = new Set<string>();
  for (const ec of explicit) coveredParamIds.add(ec.paramId);

  const auto: ExposableControl[] = [];
  for (const p of params) {
    if (coveredParamIds.has(p.id)) continue;
    if (AUTO_EXPOSE_EXCLUDE_PARAM_IDS.has(p.id)) continue;
    auto.push({
      id: `param-${p.id}`,
      label: p.label,
      kind: looksLikeToggle(p) ? 'button' : 'knob',
      paramId: p.id,
    });
  }

  if (auto.length === 0) return explicit;
  return [...explicit, ...auto];
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
