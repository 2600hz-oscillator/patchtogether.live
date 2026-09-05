// packages/web/src/lib/meta/modules/push2-control.ts
//
// PUSH 2 CONTROL — a CONTROL SURFACE node that binds an Ableton Push 2 to a
// focused `clipplayer` (Phase 1). The Push drives the FULL Launchpad clip-launch
// / note-editor / arm / scene / KEYS parity surface by injecting itself as the
// control surface of the shipped launchpad-control singleton (no forked parity
// logic — see $lib/control/push2/push2-control.svelte.ts and the plan
//, decision A).
//
// ON TOP of parity, the additive Push-only features are built around the PUSH
// CARD — the view every module shows on the 960×160 screen (up to 8 controls,
// each a name + bar graph + readout, one per display encoder):
//   · the 8 buttons above the display select LANE 1-8 and switch the screen to
//     that lane's push card;
//   · the #2-from-the-left encoder flips through the cards of the modules in
//     that lane, one at a time;
//   · the 8 display encoders turn the card's 8 controls (SHIFT = fine);
//   · the master encoder drives MixMasters master volume;
//   · the D-Pad scrolls the CLIP-view window (SHIFT = ×8).
// START/STOP moves to the Push Play button. Which 8 controls a module shows is
// an owner-editable text schema: $lib/control/push2/push-card-config.ts.
//
// LEGEND MODE — hold the LEGEND button (`PUSH_CC_LEGEND`) and the screen becomes
// 2 rows × 8 slices naming what the surrounding buttons do IN THE CURRENT VIEW:
// the BOTTOM row sits directly above the 8 function buttons under the display,
// the TOP row documents the 8 scene buttons beside the grid (left→right =
// top→bottom). SHIFT swaps every cell to its shift layer without releasing.
// MOMENTARY and DISPLAY-ONLY — no button changes what it does, and release
// restores the previous screen. The text is not a written list: it lives ON the
// routing table rows themselves ($lib/control/launchpad/launchpad-map.ts) or is
// computed from the router's own classifiers, and a unit gate
// (push-legend-model.test.ts) fails in BOTH directions if a binding loses its
// legend or a legend loses its binding.
//
// The 960×160 display runs over WebUSB and degrades to nothing if it is
// unavailable or declined — pads and encoders keep working over Web MIDI, and
// the card renders the same push card in the browser. Modeled on
// ElectraControl / LaunchpadControl — a meta-domain control-surface node with no
// audio cable I/O; all hardware state is per-machine local, LED and display
// frames never touch the Y.Doc.
//
// Inputs: none. Outputs: none. Params: none — so the face ranks a declared
// control FAMILY rather than a param, and the rest of the surface rides the
// extension's `fullViewBody`. See the `face` block at the bottom of this file.

import type { MetaModuleDef } from '$lib/meta/module-registry';

export const PUSH2_CONTROL_TYPE = 'push2Control';

/**
 * The four Launchpad-parity single-mode views, as the device names them.
 *
 * Exported so the faceplate body and the legacy card read ONE roster instead of
 * each typing its own array — the same one-place rule the range and options
 * sections of `module-faceplates.md` state, and for the same reason: no runtime
 * gate reads a literal inside a `.svelte` file.
 *
 * ⚠ NOT a `ParamDef` `options` roster, and it must not become one. It is
 * `launchpadActiveView()`, module-scope state on the shared launchpad singleton
 * — not a param, not on `node.data`, and per-machine by design. Converting it
 * into a param purely to gain the `options` vocabulary would move a
 * per-machine hardware role into the shared document.
 */
export const PUSH2_VIEWS = [
  { id: 'grid', label: 'GRID' },
  { id: 'clip', label: 'CLIP' },
  { id: 'arranger', label: 'ARR' },
  { id: 'control', label: 'CTRL' },
] as const;

// ⚠ THE LANE ROSTER IS NOT DECLARED HERE. It is `PUSH2_LANE_INDICES` in
// `$lib/control/push2/push2-control.svelte`, DERIVED from `MIXMSTRS_CHANNELS` —
// beside `selectChannel`, which is the function that clamps against the same
// authority. Writing `[0,1,2,3,4,5,6,7]` on this def would be a second source of
// truth for a population, and it would fail silently in the worst direction: a
// ninth mixer channel would leave the faceplate painting eight buttons while
// the setter accepted the ninth from the hardware.

export const push2ControlDef: MetaModuleDef = {
  type: PUSH2_CONTROL_TYPE,
  palette: { top: 'Hybrid', sub: 'Hybrid' }, // sits beside the other control surfaces
  domain: 'meta',
  label: 'push 2 control',
  category: 'tools',
  // 2u: the card now carries a 960×160 PUSH-CARD PREVIEW (CSS-scaled to the card
  // width) plus the card-flip row above the lane buttons, which takes its natural
  // height past the 180 px a 1u allows. `card-control-overflow` measured 201 px
  // of content in a 180 px card — the def is the ONE place that height is
  // declared, so it moves here rather than the preview being shrunk to fit.
  size: '2u',
  hp: 2,
  inputs: [],
  outputs: [],
  params: [],
  // One expensive device per rack (like ElectraControl / ES-9). Deletable → the
  // deterministic post-merge singleton cleanup covers it.
  maxInstances: 1,

  // ── THE CONNECT GESTURE, DECLARED AS A ONE-MEMBER FAMILY ──────────────────
  //
  // launchpadControl's route, and for a meta def it is the ONLY route: `params`
  // is empty by construction (no engine, no ports), so every key `face.order`
  // can ever hold is a NON-param key, and module-face-lint legitimizes one
  // exactly two ways — a `<familyId>-{n}` template whose prefix is a family
  // DECLARED here, or an entry in a committed `<type>.legend.json`, of which
  // three exist in the whole repo and none is this module's. Without this the
  // face could rank NOTHING and `face` alone would be a promotion route to a
  // blank tile.
  //
  // ⚠ EXACTLY ONE FAMILY IS DECLARED, and the ceiling is a GATE rather than a
  // preference: module-face-lint requires every declared family to appear in
  // `face.order` AND the dock plan to render it exactly once. A family is
  // therefore a promise to RANK, not a vocabulary list — declaring the lane
  // select, the card flip or the view segment here would force them into cells
  // they cannot be, for the mechanical reasons the face comment below gives.
  //
  // ⚠ THE `testidPrefix` IS NOT EMITTED AS A LITERAL BY ANY SURFACE —
  // MEASURED. The shell stamps this family generically from the declaration, so
  // module-docs-lint holds it through the CELL arm (`push2-control-connect-{n}`
  // ranked on the face plan and resolving to a live shell cell), never a source
  // grep.
  controlFamilies: [
    {
      id: 'push2-control-connect',
      label: 'Connect',
      kind: 'other',
      testidPrefix: 'push2-control-connect',
    },
  ],

  // ── THE FACE ──────────────────────────────────────────────────────────────
  //
  // WHAT IT IS FOR: this is the only thing that puts an Ableton Push 2 in
  // charge of a rack — the clip grid, the note editor, and the eight display
  // encoders that turn whichever module's PUSH CARD the selected lane is
  // showing. The verb a player performs on it is CONNECT THE DEVICE, and
  // everything else on the plate exists to steer what the 960×160 screen shows
  // once that has happened. One band, no tab rail; `DOCK_TAB_MIN_BANDS` is 7
  // and nothing here is padded toward it.
  //
  // THE LADDER, read back as a sentence: at every tier you get the gesture the
  // module is completely inert without; at the dock you additionally get a
  // pixel-exact replica of the hardware screen, the lane and card selection
  // that steers it, the four-role view segment, the clip-player binding, the
  // separate WebUSB display permission, and three lamps.
  //
  // ⚠ WHY CONNECT IS THE ONE RANKED CELL — the other four gestures are each
  // refused by a MECHANISM, not by a ranking judgement:
  //
  //   * CONNECT PUSH 2 → RANKED. `midiclock`'s argument (#2187) transfers with
  //     a stronger premise: only the `panel` kind is dock-restricted, so an
  //     `action` cell reaches the lane tile, and on a module that does NOTHING
  //     until it is granted Web MIDI this is the single biggest thing promotion
  //     changes for a player. Here it is the ONLY thing, because this def has
  //     no jacks at all — there is not even a cable to hint the module exists.
  //   * BIND / UNBIND → BODY. One control with two OPPOSITE actions, and
  //     `ShellActionCell.label` is a plain `string`, so a cell cannot say which
  //     it is about to do. It is also a no-op until a clip-player exists —
  //     the state every fresh rack is in — and an action cell has no
  //     `disabled`. `connect()` auto-binds already, so the common path never
  //     presses it.
  //   * CONNECT DISPLAY → BODY. Conditional on WebUSB being present and the
  //     screen not already open, and NEVER REQUIRED by design (see the header:
  //     the display "degrades to nothing"). An unconditional cell that is inert
  //     on every browser without WebUSB is a control that looks alive and is
  //     not.
  //   * THE LANE SELECT, THE CARD FLIP AND THE VIEW SEGMENT → BODY, and the
  //     reason is REACTIVITY rather than the shape of the control. ModuleShell
  //     re-projects a cell's `value(node)` from `liveCell`, which is keyed on
  //     `nodeVersion(id)` — the node's Y.Doc revision. This module writes to
  //     `node.data` ZERO times (`mutateNode` and `setNodeParam` both appear 0×
  //     in `push2-control.svelte.ts` and in the card); the selected lane is
  //     `localStorage`, and the binding, focus and active view are module-level
  //     runes on the control singleton. A selector cell would therefore paint
  //     the position it had at mount and never move again — not when the body
  //     changes it, not when the eight buttons ON THE HARDWARE change it, not
  //     when a reload restores it. A body is an ordinary component and can
  //     subscribe to `statusRune()`, which is what the card already does.
  //     ⚠ AND THE PLACEMENT OF THAT STATE IS CORRECT, not a convenience to be
  //     fixed later: two collaborators on one rack each have their own Push on
  //     their own lane, so syncing `selectedChannel` would make one player's
  //     lane button move the other player's hardware screen.
  //
  // ⚠ `glyph: 'none'` IS THE ONLY LITERAL THAT COMPILES INTO A GREEN RUN, and
  // here the premise is true by inspection rather than by luck: `outputs` is
  // EMPTY, so `primaryAudioOutPortId` (`outputs.find(o => o.type === 'audio')`)
  // resolves null and every live-audio binding short-circuits; 'envelope' needs
  // a/d/s/r params and there are none. Each falls to `{kind:'static'}`, which
  // module-face-lint reddens by name (#1692) with no exemption list. 'algorithm'
  // would resolve — it accepts a `face.extension` — but `ShellExtensionGlyphProps`
  // carries `num`/`numbers`/`testid` and NO nodeId, so every instance would draw
  // the same picture while the only useful glance here ("is a Push attached, and
  // to what") is per-node binding state. That is the sixth module to reach this
  // conclusion and no new glyph kind is invented for it.
  //
  // ⚠ NO `pages`. One ranked cell is one band, and a section header reading
  // "surface" over a single cell captioned "Connect Push 2" is a header that
  // adds a ~81 px band to say nothing the cell has not said. `face.pages` is
  // for a face with more than one IDEA in it.
  //
  // ⚠ NO `rear` GROUPS: `inputs` and `outputs` are both empty, so there is no
  // jack for a group to name and module-face-lint refuses a group that resolves
  // to no port at all.
  //
  // The replica screen, the eight lane buttons, the card ‹ › flip, the four-role
  // view segment, BIND, CONNECT DISPLAY and the three lamps are the extension's
  // `fullViewBody` — see $lib/ui/modules/push2Control/shell-extension.ts.
  face: {
    glyph: 'none',
    order: ['push2-control-connect-{n}'],
    extension: 'push2Control',
  },
};
