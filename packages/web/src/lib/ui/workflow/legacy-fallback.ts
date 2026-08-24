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
//   • 'legacy'      — the module's own *Card.svelte, verbatim: what
//                     `?shell=legacy` selects, and what the snowflakes below
//                     get unconditionally.
//
// This is a PURE render-time derivation: it reads only the faces flag, whether
// the user has docked the node, and whether the type is MIGRATED (the caller
// passes `migrated(n.type)` from ./strict-faces — injected as a boolean so this
// stays registry-free + trivially testable). It is NEVER
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
 *     then rather than a lossy placeholder,
 *   ⚠ videoOut USED TO BE IN THIS SET and is not any more (#1821). Its entry
 *     read: "the VIDEO SURFACE snowflake: its legacy card BODY IS the live,
 *     freely-resizable output screen … swapping it for a placeholder tile
 *     removed the ONLY user-viewable video output from the shell (the
 *     owner-reported ?shell=1 regression)". That reasoning was about a
 *     PLACEHOLDER, and it was right: a tile with no picture is not a monitor.
 *     It is no longer the alternative. videoOut now carries a real `face`, so
 *     its lane tile is a `ModuleShell` painting the LIVE `VideoTileThumb`, and
 *     the big picture moved to where the owner asked for it — right-click →
 *     DETACH DISPLAY, a free-floating resizable window with no patch wires
 *     (owner 2026-08-17: *"the card does not need the arbitrary resizing on the
 *     card, but i want to be able to right-click -> detach display"*).
 *     ⚠ The picture survives the swap only because the face ranks NOTHING:
 *     `laneBodyPlan`'s ROW branch returns `glyph: hasGlyph` unconditionally, and
 *     it is the PLATE branch — reached only by a face with more controls than a
 *     row holds — where ranked cells evict the glyph (#1785). A future param on
 *     this def would walk it toward that branch; `videoout-face-model.test.ts`
 *     asserts the tile keeps its picture at every tier so the day that happens
 *     is a red test rather than a silent regression.
 *   ⚠ cameraInput USED TO BE IN THIS SET and is not any more. Its entry named
 *     two things that lived ONLY on its card:
 *       (a) the live SOURCE — the card owns getUserMedia + the `<video>` element
 *           and hands it to the engine via `attachExternalSource` (see
 *           ./dom-source-modules). "Swapped for a tile, camera → OUTPUT is
 *           patched-but-black, and switching an already-running rack INTO the
 *           shell actively DETACHES the live camera on the card's onDestroy";
 *       (b) the DEVICE PICKER — a `<select>` populated from
 *           `enumerateDevices()`, persisted to `node.data.deviceId`. It is NOT
 *           a ParamDef, so no shell face CELL can render it (a `static` face
 *           cell is a dead dashed label by design — ModuleShell's controlCell).
 *           ⚠ THIS CLAUSE USED TO READ "no shell FACE can render it", AND THAT
 *           IS FALSE AS A GENERAL STATEMENT — the one word does real damage.
 *           A face is not only its cells: the `fullViewBody` extension slot is
 *           a plain Svelte component that can call `getActiveEngine()` and
 *           `enumerateDevices()` and render whatever it likes, which is exactly
 *           where cameraInput's picker went and where `midiclock`'s MIDI-input
 *           picker went after it. The true constraint is narrower and worth
 *           stating precisely: a runtime roster cannot be a `ParamDef`'s
 *           `options` (a roster is a fixed set known when the def is authored,
 *           and this one differs per machine), so it needs a SURFACE rather
 *           than a cell. Two agents in a row read the old sentence and
 *           concluded a platform change was required before a binder could be
 *           promoted; neither was.
 *     ⚠ (a) IS NO LONGER TRUE AT ALL, and it was already not true when this
 *     entry was last read. The claim describes the world BEFORE
 *     `<HeadlessSourceHost>` existed: cameraInput is in
 *     `DOM_SOURCE_LANE_TYPES` ⊂ `HEADLESS_MOUNT_LANE_TYPES`, and
 *     `needsHeadlessSourceMount` returns true for kind 'shell', so the shell
 *     keeps the real card mounted off-screen and the source is never orphaned.
 *     The onDestroy detach it feared was removed for the same reason (the
 *     `<video>` and its stream are NODE-owned — $lib/ui/media/node-media-registry).
 *     ⚠ (b) IS STILL TRUE and is answered rather than dodged: the picker moved
 *     into the faceplate's EXTENSION BODY
 *     ($lib/ui/modules/cameraInput/CameraInputOutputBody.svelte), which is the
 *     one slot that can hold a control no `ParamDef` can express.
 *     ⚠ AND THE REST OF THE CARD IS REACHED BY A NAMED SEAM, which is the part
 *     that had to be BUILT rather than merely re-argued. An off-screen host is
 *     `pointer-events: none`, so the card's "Request access" gesture — the only
 *     path to `getUserMedia` for a first-time visitor — and its recovery text
 *     become unclickable. `$lib/ui/media/camera-status-registry` publishes the
 *     card's capture state and registers its acquire command so the faceplate
 *     can show and drive them, WITHOUT a second getUserMedia owner existing.
 *     Parity was preserved first; the promotion followed.
 * Everything else with a resolvable card swaps.
 */
export const NON_SHELL_LANE_TYPES: ReadonlySet<string> = new Set<string>([
  'group',
  'sticky',
  'cadillac',
  'clipplayer',
  'controlSurface',
  'electraControl',
  // ⚠ The REGISTERED id — `launchpadControlLeft`, not `launchpadControl`
  // (#1579). The def keeps the Left-suffixed type so saved LEFT nodes load
  // (launchpad-control.ts LAUNCHPAD_CONTROL_TYPE); this list once named the
  // unsuffixed id, which resolves to NO def, so the carve-out silently never
  // fired and the pad-mapping surface rendered as a placeholder tile. This
  // file is deliberately registry-free, so the string is anchored in
  // legacy-fallback.test.ts: every member of this set must resolve to a
  // registered def, and this entry must equal the def's own exported type.
  'launchpadControlLeft',
]);

/** Inputs to the pure lane-render decision. */
export interface LaneRenderInput {
  /** Render FACEPLATES in the lane — the default. False only under the
   *  `?shell=legacy` escape hatch, which renders the verbatim legacy cards
   *  inside the same shell. (This was `shellPreview`, an opt-in `?shell=1`
   *  flag, until faceplates became the product.) */
  shellFaces: boolean;
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
 *      faces on or off);
 *   2. `?shell=legacy`, or a non-card/snowflake type → 'legacy' (the verbatim
 *      module card);
 *   3. otherwise the faceplate: 'shell' for a migrated type, else
 *      'placeholder'.
 * PURE — same inputs, same output, no side effects.
 */
export function laneRenderKind(i: LaneRenderInput): LaneRenderKind {
  if (i.userDocked) return 'stub';
  if (!i.shellFaces || !i.hasCard) return 'legacy';
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

// ── THE DOCK RAIL's OWN FALLBACK (#1739) ────────────────────────────────────
//
// The bridge above answers "what does this module render as IN ITS LANE". A
// DOCK RAIL occupant is a third surface the rule never covered, and the gap was
// user-visible: `migrated(type)` removes the legacy card from the lane and from
// the dock FULL VIEW (`DockFullView.svelte`, gated on the `migrated` prop), but
// `DockCardHost` resolved `nodeTypes[node.type]` with no `migrated` input at
// all — so the always-on `m` tray kept painting `MixmstrsCard` after mixmstrs
// was promoted. OWNER RULING (#1739): *"the `m` key tray view needs to show the
// new card and not the old one."*
//
// ⚠ `pinned` IS PART OF THE RULE, NOT AN OPTIMISATION. The two rail occupant
// kinds have different amounts of surface:
//   * a PINNED occupant is canvas-hidden (`isCanvasHiddenNode`), so it has NO
//     lane tile, NO EXPAND pill and no route to `DockFullView`. The tray is its
//     ONLY surface, and it is therefore the only place its face can appear.
//   * a USER-DOCKED entry still has both — the lane shows its DockStubCard and
//     the stub's own affordances reach the full view — so its face is already
//     reachable and the rail card is the second surface, not the only one.
// Widening this to every occupant is a separate, deliberate change: it flips
// every user-docked promoted module at once and MOVES `workflow-dock.spec.ts`
// (which docks `mixer` and asserts `.mod-card`) plus the `workflow-dock-
// composite` VRT baseline (which docks `vca`). Both are promoted types.
//
// ⚠ `shellFaces` IS PART OF THE RULE for the same reason it is part of
// `laneRenderKind`: `?shell=legacy` means "verbatim legacy cards inside the
// same shell", and a tray that ignored it would make the escape hatch a lie.
// ⚠ AND IT IS WHY THE THREE SHIPPED DRAWER SPECS CANNOT SEE THIS CHANGE —
// `workflow-dock.spec.ts` and `workflow-mode.spec.ts` both drive
// `/rack?shell=legacy`, so they exercise the `false` arm forever. New coverage
// for the `true` arm must drive the DEFAULT shell; see
// `e2e/tests/workflow-drawer-face.spec.ts`.
//
// ⚠ THE RULE HAS A THIRD CALLER, AND IT HAD TO BE ADDED RATHER THAN FOUND.
// `AudioIoSurface.svelte` — the 🎧 topbar panel — hosts the pinned AUDIO IN and
// AUDIO OUT through this same `DockCardHost`, and it did not call this function
// at all: both mounts passed six props and no `face`, so the host's
// `face = false` default won and it mounted `nodeTypes[type]` unconditionally.
// Those two are canvas-hidden pinned singletons, so by the argument above THAT
// PANEL IS THE ONLY PLACE THEIR FACE CAN APPEAR — promoting either module
// without the prop would have merged green and left the instance every user
// has in every session on the legacy card.
//
// The blind spot repeated too: the panel's own dedicated VRT scene
// (`e2e/vrt/workflow-audio-io-composite.spec.ts`) drives `/rack?shell=legacy`,
// so it is the `false` arm forever exactly like the three drawer specs. The
// prescription above is the fix in both places — the audio-I/O panel's
// default-shell coverage is `e2e/tests/workflow-audio-io-face.spec.ts`.
//
// GENERAL FORM, for whoever adds a FOURTH host: a pure rule with an injected
// input is only as good as its call sites, and nothing here can tell you a
// caller is missing. When you mount `DockCardHost`, decide `face` — the default
// is a decision too, and it is the wrong one for a pinned occupant.

/** Inputs to the pure dock-rail render decision. */
export interface DockRailRenderInput {
  /** Render FACEPLATES at all — false under `?shell=legacy`. */
  shellFaces: boolean;
  /** This occupant is the drawer's PINNED singleton (the M/E trio), i.e. the
   *  tray is its only surface — not a user-docked entry. */
  pinned: boolean;
  /** STRICT_FACES membership for this type — `migrated(type)`, injected by the
   *  caller so this stays pure/registry-free. */
  migrated: boolean;
}

/**
 * Does a DOCK RAIL occupant render the promoted FACEPLATE (`<ModuleShell
 * view='drawer'>`) instead of its verbatim legacy card? PURE.
 *
 * The `'drawer'` view is the dock faceplate PLUS the lane `PatchPanel`: the
 * tray has no `DockFullView` title bar and therefore no flip-to-RearCard
 * affordance, so the shell's own jack rail (and the `.card-back-panel` the
 * canvas-wide rear view reveals) is the ONLY thing keeping the drawer's jacks —
 * which is not hypothetical, since the owner's ES-9 send/return rack patches
 * `masterL` out of and `ch1L` into exactly this surface.
 */
export function dockRailRendersFace(i: DockRailRenderInput): boolean {
  return i.shellFaces && i.pinned && i.migrated;
}
