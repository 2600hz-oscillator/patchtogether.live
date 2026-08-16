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

import type { ModuleNode, ParamDef, NoUserControlParam } from './types';
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
    /** #1726 — params the module gives the player no control over. Read here
     *  so the group bar never auto-exposes one. */
    noUserControl?: readonly NoUserControlParam[];
  } | undefined;
}

// #1726 — WHAT REPLACED `AUTO_EXPOSE_EXCLUDE_PARAM_IDS`.
//
// There used to be a module-blind excludelist here: a bare `Set` of five param
// ids (`camera_x` … `camera_pitch`, described as "wavesculpt persisted camera
// state") consulted for EVERY def in the repo. Two things were wrong with it,
// and the second is why it is gone rather than moved:
//
//   * It matched by BARE ID across every module. Any def that ever declared a
//     param called `camera_x` would have had it silently dropped from the group
//     bar, with the reason attached to a different module entirely.
//   * It named params NO LIVE DEF DECLARES — grepped 2026-08-15, all five ids
//     appear only in this file. It was a ledger entry naming a vanished
//     subject, and it had been excluding nothing for as long as that was true.
//
// The replacement is the DEF's own `noUserControl` declaration, which carries
// the `(module, param, why)` triple, is anchored to that def's params and ports
// in both directions, and cannot drift onto a module it was not written for.

/** Heuristic: does the ParamDef look like a 0/1 toggle? (Exported so the
 *  Toggle primitive + its detection can share the ONE definition.) */
export function looksLikeToggle(p: ParamDef): boolean {
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

  // #1726 — the def's OWN declaration, not a repo-wide id list. An explicit
  // `exposableControls` entry still wins (checked first, above): a module that
  // deliberately surfaces one under a custom label/kind is making a different,
  // louder claim than "no user control", and the explicit list is that claim.
  const noControl = new Set((def.noUserControl ?? []).map((e) => e.param));

  const auto: ExposableControl[] = [];
  for (const p of params) {
    if (coveredParamIds.has(p.id)) continue;
    if (noControl.has(p.id)) continue;
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
