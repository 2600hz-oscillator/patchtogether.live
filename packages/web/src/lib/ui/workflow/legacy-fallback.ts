// packages/web/src/lib/ui/workflow/legacy-fallback.ts
//
// THE LEGACY-FALLBACK MIGRATION BRIDGE (P0.3b) — the PURE decision that lets the
// whole workflow rig ship on day one with ZERO module reskins.
//
// It GENERALIZES the existing card↔dock-stub swap in Canvas.svelte's flowNodes
// derivation (`emittedType = dockEntry ? 'dockStub' : n.type`). Today the only
// swap trigger is "the user docked this node". This adds the workflow-shell
// triggers, so a module renders as one of four things in its lane:
//
//   • 'stub'        — the user explicitly docked it (unchanged P2.5a path):
//                     a DockStubCard in the lane, real card in the dock rail.
//   • 'shell'       — a MIGRATED module (has a curated `face` / is in
//                     STRICT_FACES): the new RACKLINE <ModuleShell> curated LOD
//                     face in the lane; Expand opens its full faceplate.
//   • 'placeholder' — an UN-MIGRATED module under the shell preview: a uniform
//                     styled <ModuleShellPlaceholder> in the lane + its verbatim
//                     legacy card reachable in the dock full-view.
//   • 'legacy'      — the module's own *Card.svelte, verbatim (dawless always;
//                     workflow when the preview is OFF, or for the snowflakes
//                     below). This is the CURRENT behaviour, byte-for-byte.
//
// This is a PURE render-time derivation: it reads only the mode, the preview
// flag, whether the user has docked the node, and whether the type is MIGRATED
// (the caller passes `migrated(n.type)` from ./strict-faces — injected as a
// boolean so this stays registry-free + trivially testable). It is NEVER
// persisted to the Y.Doc / dockStore entries (the un-migrated auto-fallback is
// transient view furniture, exactly like the pinned drawer — persisting it would
// storm the CRDT / desync peers; see the cv-modulation-live-store-write +
// transient-dock disciplines). Zero-flake.

/** What a module renders as in its workflow lane (see the file header). */
export type LaneRenderKind = 'legacy' | 'shell' | 'placeholder' | 'stub';

/**
 * Node TYPES that are NOT swapped to the shell/placeholder even under the
 * preview — they keep rendering their real in-lane card:
 *   - organizational chrome with no "module card" to dock (group / sticky),
 *   - the CADILLAC roaming sprite (already filtered from flowNodes upstream),
 *   - clipplayer + the MIDI control surfaces — SNOWFLAKES whose lane face is a
 *     grid / launcher / mapper, not a ranked-knob skeleton (plan §6): they get
 *     bespoke faces in a later spike, and stay on the verbatim legacy card until
 *     then rather than a lossy placeholder.
 * Everything else with a resolvable card swaps.
 */
export const NON_SHELL_LANE_TYPES: ReadonlySet<string> = new Set<string>([
  'group',
  'sticky',
  'cadillac',
  'clipplayer',
  'controlSurface',
  'electraControl',
  'launchpadControl',
]);

/** Inputs to the pure lane-render decision. */
export interface LaneRenderInput {
  /** True in workflow mode (dawless always renders the legacy card). */
  workflowMode: boolean;
  /** The `?shell=1` opt-in preview flag (default off ⇒ zero behaviour change). */
  shellPreview: boolean;
  /** The user has an explicit persisted dock ENTRY for this node. */
  userDocked: boolean;
  /** The module type id (n.type). */
  type: string;
  /** The type resolves to a real card AND is not a NON_SHELL_LANE_TYPE. */
  hasCard: boolean;
  /** STRICT_FACES membership for this type — `migrated(type)`, injected by the
   *  caller so this stays pure/registry-free. Un-migrated ⇒ placeholder. */
  migrated: boolean;
}

/**
 * The core bridge decision. Order matters:
 *   1. an explicit user dock ALWAYS wins → 'stub' (the P2.5a contract is
 *      unchanged; a user who docked a module still sees the stub + rail card,
 *      preview on or off);
 *   2. dawless, preview-off, or a non-card/snowflake type → 'legacy' (the
 *      exact current render — this is why preview-off is a perfect no-op);
 *   3. otherwise the workflow shell: 'shell' for a migrated type, else
 *      'placeholder'.
 * PURE — same inputs, same output, no side effects.
 */
export function laneRenderKind(i: LaneRenderInput): LaneRenderKind {
  if (i.userDocked) return 'stub';
  if (!i.workflowMode || !i.shellPreview || !i.hasCard) return 'legacy';
  return i.migrated ? 'shell' : 'placeholder';
}

/** The xyflow node TYPE to emit for a decided lane-render kind. `'legacy'`
 *  emits the module's own type (its glob-resolved *Card.svelte). */
export function emittedTypeFor(kind: LaneRenderKind, legacyType: string): string {
  switch (kind) {
    case 'stub':
      return 'dockStub';
    case 'shell':
      return 'moduleShell';
    case 'placeholder':
      return 'moduleShellPlaceholder';
    case 'legacy':
    default:
      return legacyType;
  }
}

/** True when a type is eligible for the shell/placeholder swap: it resolves to a
 *  real card AND is not an excluded snowflake. `hasResolvableCard` is the
 *  caller's `type in nodeTypes` check (kept out of here so this module stays
 *  registry-free + pure). */
export function isShellSwappable(type: string, hasResolvableCard: boolean): boolean {
  return hasResolvableCard && !NON_SHELL_LANE_TYPES.has(type);
}
