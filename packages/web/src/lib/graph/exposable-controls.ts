// packages/web/src/lib/graph/exposable-controls.ts
//
// WHICH OF A MODULE'S CONTROLS ANOTHER SURFACE MAY OFFER — the one definition,
// shared by every surface that proxies somebody else's knobs.
//
// Pure functions for:
//   - the 0/1-discrete TOGGLE heuristic (`looksLikeToggle`)
//   - discovering the exposable-control set for a module type
//     (`listExposableControls`)
//
// Lives in `lib/graph` (not `lib/ui`) so tests can import it without dragging
// in any Svelte component.
//
// ⚠ THIS FILE WAS `graph/group-controls.ts` AND THE RENAME IS THE POINT. It was
// authored for the GROUP! bar (Module-grouping Phase 4) and its three
// group-shaped exports — `validateExposedControls`, `resolveExposedControls`
// and `RenderableControlGroup`, all typed on `GroupData` / `ExposedControl` —
// went with that module when it was deleted. What did NOT go is the pair below,
// which had quietly become the fleet's canonical answer with FIVE importers
// that have nothing to do with groups: `ui/controls/toggle-model`,
// `ui/workflow/shell-control-kind`, `control/push2/push-card-schema`, and two
// face-model tests. Deleting the file wholesale would have taken the shared
// definition with the retired one; keeping the old NAME would have left the
// tree asserting a module that no longer exists.

import type { ParamDef, NoUserControlParam } from './types';
import type { ExposableControl } from '$lib/audio/module-registry';
import { momentaryIds } from '$lib/audio/momentary-params';

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
    /** The face's declared PRESS pads. Read here for the same reason as
     *  `noUserControl`: the group bar must never auto-expose one. See
     *  `listExposableControls`. */
    face?: { momentary?: readonly string[] };
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

  // ── A PRESS PAD IS NOT AN EXPOSABLE CONTROL (2026-09-02) ──────────────────
  //
  // ⚠ THE GROUP BAR HAS NO RELEASE EDGE, so a `face.momentary` param rendered
  // here is a LATCH by construction. `GroupExposedControls.svelte`'s
  // `togglePlay` is `setNodeParam(child.id, paramId, playing ? 0 : 1)` — one
  // DURABLE Y.Doc write per click, no pointerup path, nothing that falls back
  // to rest — which is exactly the persisted-stuck-pad bug
  // `$lib/audio/momentary-params` exists to end, re-entered through a
  // different surface.
  //
  // It became REACHABLE for moog956 in this diff and that is why it is fixed
  // here: `looksLikeToggle` is `discrete && 0..1`, so correcting `gate`'s
  // mis-declared `linear` curve promoted it from a (harmless, wrong) knob into
  // that latching ▶/■ button. But the hazard is NOT moog956's — tomtom
  // `strike`, clap `trigger`, tidyVco `hold` and bluebox's pads are all
  // `0..1 discrete` momentary and have been rendering as latching group-bar
  // buttons all along. Filtering at the seam is the fix; filtering moog956
  // alone would be a special case for a shared defect.
  //
  // The precedent is `push-card-schema.ts`, which skips momentary ids in all
  // three of its tiers for the same reason: a surface that cannot send the
  // release edge must not offer the press.
  //
  // ⚠ AN EXPLICIT `exposableControls` ENTRY STILL WINS — it is checked above
  // and never reaches this loop. A module that deliberately surfaces its pad
  // under a custom kind is making a louder claim than this default, exactly as
  // `noUserControl` treats it.
  const momentary = momentaryIds(def);

  const auto: ExposableControl[] = [];
  for (const p of params) {
    if (coveredParamIds.has(p.id)) continue;
    if (noControl.has(p.id)) continue;
    if (momentary.has(p.id)) continue;
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
