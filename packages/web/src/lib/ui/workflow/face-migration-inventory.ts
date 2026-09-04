// packages/web/src/lib/ui/workflow/face-migration-inventory.ts
//
// THE TOTAL MIGRATION RECORD (LEG-01) — one DISPOSITION per registered module,
// for the v2 face shell's replacement of the legacy card fleet.
//
// WHY THIS EXISTS. The face shell is the default UI, but every module without a
// promoted `face` renders <ModuleShellPlaceholder> whose expand affordance opens
// the VERBATIM legacy card (DockFullView). The release gate for deleting the
// legacy fleet is "no user-addable module requires a placeholder or a legacy
// card", and until this file landed nothing enumerated how far away that is —
// the cohort issues had to guess at their own scope.
//
// WHAT A DISPOSITION IS. Exactly one per registered def, answering ONE question:
// *what kind of work does this module's v2 surface need?*
//
//   'generic-face'          — author a `face` and rank its controls. Every
//                             interactive control is a param, or a family/static
//                             key one of the shell's existing cell kinds paints
//                             (selector / action / file / toggle / momentary /
//                             segmented / grid / colour / xy), plus a `glyph` or
//                             a registered PANEL for any read-only picture. No
//                             new cell KIND, no new platform seam. The faced
//                             population is a SUBSET of this disposition, which
//                             is what the identity gate asserts.
//   'bespoke-surface'       — the module's PRIMARY INTERACTION is not
//                             param-shaped: a step/clip grid, a code/score/
//                             drawing editor, a game viewport, a routing matrix,
//                             a hardware-device binding flow, a media browser or
//                             transport. A ranked cell list cannot express it;
//                             it needs a hand-written surface behind the
//                             ModuleShell extension seam — which EXISTS
//                             (`shell-extensions.ts`, #1512, two adopters).
//                             The disposition is a statement about the WORK the
//                             module needs, never about a missing platform.
//   'organizational-native' — not a module UI at all. Rack furniture.
//   'blocked'               — would be 'generic-face' TODAY but for a NAMED
//                             missing platform capability, and nothing else.
//
// ⚠ 'blocked' is the NARROW one on purpose. A blocker declared on a
// 'bespoke-surface' entry says "that surface will still need this capability
// from the platform" (the media lifecycle must move whatever UI is built on top
// of it; a sequencer grid still wants ONE shared note-entry primitive rather
// than a ninth hand-clone). A 'blocked' DISPOSITION says something stronger:
// remove the blocker and this module is a face, with no surface work at all.
//
// ⚠ A DISPOSITION IS NOT A BLOCKER (#1799). 'bespoke-surface' used to carry a
// blanket blocker on the ModuleShell extension seam, derived onto all of its
// entries — and it OUTLIVED THE SEAM. #1512 shipped `shell-extensions.ts` with
// the `glyph` and `fullViewBody` slots wired and two modules already plugged
// into it, while a third of the remaining migration went on reading as
// un-startable. Every gate stayed green because all of them checked the blocker
// list against ITSELF (declared ✓, named by something ✓) and none against the
// tree. Blockers now carry a CAPABILITY PROBE (below) and a blocker whose probe
// fires is RED.
//
// ⚠ AND DO NOT RE-ADD IT FOR `editorSurface`. That slot is deliberately UNWIRED:
// shell-extensions.ts specifies that the FIRST ADOPTER wires its render site in
// ModuleShell in the same diff. That is a bespoke surface's OWN work, not a
// platform capability it waits on.
//
// ⚠ WHAT THIS FILE DOES NOT STORE: whether a module is DONE. That is
// `STRICT_FACES` membership, which module-face-lint.test.ts already pins to "the
// defs that declare a `face`", in both directions. Storing it twice is how the
// two would disagree; `migrationDone()` below READS it, and the gate asserts the
// done-set IS `STRICT_FACES`. There is no count in this file, and the per-
// disposition breakdown for the owner is GENERATED
// (docs/design/face-migration.generated.md), never typed.
//
// ⚠ DENY BY DEFAULT: a registered def with no entry here is RED
// (face-migration-inventory.test.ts), so a new module cannot merge without a
// disposition, and an entry naming a def that no longer exists is RED too. That
// pair is what keeps this record TOTAL without anyone maintaining a number.
//
// HOW THE DISPOSITIONS WERE DERIVED (2026-08-13, against `main`): every
// unfaced def was read against its resolved *Card.svelte — which primitives the
// template mounts, whether any canvas is interactive or a read-only picture,
// whether a `<select>` is a param roster or a live device roster, whether a
// pointer surface is a 2-D pad (the `xy` cell) or a resize handle (chrome), and
// who owns the module's media. Two of those judgements are additionally
// MECHANICAL, and the gate re-derives them from the tree rather than trusting
// this list: a card that mounts typed entry cannot be 'generic-face', and a card
// that owns its own engine source (DOM_SOURCE_LANE_TYPES) cannot be either.

/** What kind of work this module's v2 surface needs. See the header. */
export type FaceMigrationDisposition =
  | 'generic-face'
  | 'bespoke-surface'
  | 'organizational-native'
  | 'blocked';

/**
 * A NAMED platform capability a module's v2 surface needs and the platform does
 * NOT HAVE YET — with "yet" measured, not remembered. Each one resolves to an
 * issue below and to a CAPABILITY PROBE that reads the tree: an id with no
 * declaration, a declaration nobody needs, and a declaration whose capability is
 * ALREADY THERE are all RED in the gate.
 */
// ⚠ `'needs-note-entry-cell'` (#1509) WAS HERE AND IS DELETED, NOT RETIRED —
// its capability SHIPPED. `ModuleShell` now mounts a typed-entry cell
// (`ShellEntryCell` -> `TextEntry`), so the blocker's own probe fires and the
// gate below would fail the whole registry while the declaration stood. Twelve
// modules named it; eight named nothing else and now carry no `blockers` key at
// all. Deleting is the correct disposal: a blocker whose capability exists is
// not "done", it is FALSE, and leaving it would pre-approve the next thing to
// take its name.
//
// ⚠ `'needs-media-controller'` (#1511) WAS HERE AND IS DELETED TOO, 2026-09-02,
// FOR THE OTHER OF THE TWO REASONS THE ANCHOR GATE OFFERS — "the modules that
// needed it were reclassified" — and NOT because the capability shipped. It has
// not: `HEADLESS_MOUNT_LANE_TYPES` still holds archivist, cameraInput, loopback
// and six card producers, so the probe below still reads FALSE, and #1511 is
// still a real piece of platform work.
//
// What ended was the WAITING. This blocker was declared by nine modules; eight
// left it during waves 5-7 (videobox and videovarispeed to
// `node-video-source-registry`, peertube and tvLibrarian to
// `node-hls-source-registry`, recorderbox and now toybox because the claim was
// never true of them, archivist by carrying its affordances through a
// status/command registry while the card kept ownership). toybox was the last,
// and with it the record's `blockers` arrays are empty everywhere.
//
// DELETING IS THE DISPOSAL THE GATE ASKS FOR, and it is deliberate rather than
// tidy: "ANCHORED: every declared blocker is named by something" reddens on an
// entry nobody waits on, precisely so this file cannot keep a roadmap item that
// stopped describing any module's migration. The MigrationBlockerId union goes
// empty as a result, which is the honest type — with no blockers declared,
// `blocked` becomes an unconstructable disposition and `blockers?: []` an
// unfillable field. That is the state of the fleet, not a gap.
//
// ⚠ AND THE MACHINERY BELOW STAYS, on this file's own stated design: `staleBlockers`
// takes its record as a PARAMETER "so the gate can drive this same predicate
// over a synthetic record in both directions… That control does not depend on
// which blockers happen to be declared today, so it survives the last one being
// deleted — which is precisely when a self-referential gate goes quiet." This is
// that moment; the synthetic controls are what still exercise the predicate.
export type MigrationBlockerId = never;

/**
 * THE LIVE TREE, reduced to the handful of facts the capability probes read.
 *
 * GATHERED BY THE GATE from the real artifacts and passed in, so this module
 * stays import-free of them — the same discipline `migrationDone` uses for
 * STRICT_FACES, and for the same reason: two derivations of one fact drift.
 * Every field is a MEASUREMENT of something that exists, never a restatement of
 * something declared in this file.
 */
export interface CapabilityEvidence {
  /** Every extension id the `shell-extensions.ts` glob discovered. */
  readonly shellExtensionIds: readonly string[];
  /** The extension slots ModuleShell actually RENDERS (not merely declares). */
  readonly wiredShellExtensionSlots: readonly string[];
  /**
   * Does the ONE shared renderer — ModuleShell.svelte, the only thing that
   * paints a face cell — mount TYPED ENTRY (`<NoteEntry>`, a `<textarea>`, a
   * contenteditable or a typed `<input>`)? Read with the same `mountsTypedEntry`
   * predicate the gate applies to the legacy cards, so the two cannot disagree
   * about what "typed entry" means.
   */
  readonly faceShellMountsTypedEntry: boolean;
  /**
   * Module types whose ENGINE-VISIBLE state exists only while their card is
   * mounted — `HEADLESS_MOUNT_LANE_TYPES`, i.e. a card-owned media element or a
   * card that IS the producer. That set is itself grep-gated against the cards,
   * so it cannot lag the code.
   */
  readonly cardOwnedSourceTypes: readonly string[];
}

/**
 * WHAT MAKES A BLOCKER STILL TRUE — the artifact anchor the blocker legs were
 * missing (#1799).
 *
 * "Declared with an issue" and "named by something" are both INTERNAL
 * referential integrity: a blocker satisfies them just as happily after its
 * capability ships. The probe asks the only question that goes stale — IS THIS
 * SEAM ALREADY IN THE TREE? — and answers it from the tree.
 *
 * ⚠ The probe is REQUIRED BY THE TYPE, not by a test: a blocker declared with no
 * way to observe its own resolution does not compile.
 */
export interface CapabilityProbe {
  /** ONE LINE: what in the TREE exists only once this capability has shipped. */
  readonly evidence: string;
  /** TRUE when that evidence is PRESENT — the capability shipped, so the blocker
   *  is STALE. The gate asserts this is FALSE for every declared blocker. */
  readonly shipped: (tree: CapabilityEvidence) => boolean;
  /** The real tree PATCHED into the world where this capability HAS landed. The
   *  gate asserts `shipped` is TRUE on it, so a probe that can never fire — a
   *  green-because-blind probe, the exact defect this replaces — is refused. */
  readonly landed: (tree: CapabilityEvidence) => CapabilityEvidence;
}

export interface MigrationBlocker {
  /** The GitHub issue that lands this capability. */
  readonly issue: number;
  /** What the capability IS, in one line. */
  readonly capability: string;
  /** What the module fleet gets when it lands. */
  readonly unblocks: string;
  /** How the TREE says whether this is still true. See CapabilityProbe. */
  readonly probe: CapabilityProbe;
}

/**
 * The blocker REGISTRY. Anchored in both directions by the gate: every blocker
 * a module (or a disposition, below) names must be declared here, and every
 * declaration must be named by something — a capability nothing is waiting on is
 * a stale entry, not a roadmap.
 */
// ⚠ EMPTY SINCE 2026-09-02, and empty is a STATEMENT rather than a gap: no
// module's v2 surface is waiting on a platform capability any more. See the note
// on `MigrationBlockerId` above for the disposal of the last entry
// (`needs-media-controller`, #1511) — it was deleted because nothing waits on
// it, NOT because it shipped, and #1511 remains real platform work with
// `HEADLESS_MOUNT_LANE_TYPES` still non-empty.
//
// ⚠ AN EMPTY REGISTRY IS NOT AN INVITATION. A future blocker is added the way
// these two were: with an issue, a `capability`/`unblocks` pair, and a
// `CapabilityProbe` the TYPE requires — a declaration with no way to observe its
// own resolution does not compile. The type-level consequence of empty is the
// honest one and should be left alone: `MigrationBlockerId` is `never`, so
// `blocked` is an unconstructable disposition and `blockers` an unfillable
// field, which is exactly what "nothing is blocked" means.
//
// ⚠ THE TYPE IS `Record<string, …>` WITH A `satisfies` RATHER THAN
// `Record<MigrationBlockerId, …>`, and the difference is not cosmetic. With the
// union empty, `Record<never, MigrationBlocker>` erases to `{}`, so every
// `Object.entries` consumer below (and in the gate, and in the report) would see
// `unknown` values and the probe-shape legs would stop type-checking against the
// thing they check. The `satisfies` keeps the KEY check exactly as strict — a
// key that is not a declared `MigrationBlockerId` is refused right here — while
// leaving the VALUE type readable to the consumers.
export const MIGRATION_BLOCKERS: Readonly<Record<string, MigrationBlocker>> =
  {} satisfies Readonly<Record<MigrationBlockerId, MigrationBlocker>>;

/**
 * Declared blockers whose capability is ALREADY IN THE TREE — the entries that
 * are lying. Empty is the only acceptable answer and the gate asserts exactly
 * that: membership, never a size.
 *
 * `blockers` is a PARAMETER so the gate can drive this same predicate over a
 * synthetic record in both directions. That control does not depend on which
 * blockers happen to be declared today, so it survives the last one being
 * deleted — which is precisely when a self-referential gate goes quiet.
 */
export function staleBlockers(
  tree: CapabilityEvidence,
  blockers: Readonly<Record<string, MigrationBlocker>> = MIGRATION_BLOCKERS,
): string[] {
  return Object.keys(blockers)
    .filter((id) => blockers[id]!.probe.shipped(tree))
    .sort();
}

/**
 * One record per registered module.
 *
 * The `why` is REQUIRED by the TYPE on every disposition except 'generic-face'
 * — i.e. on every entry that says "this one does NOT take the standard path", so
 * an undeclared exception does not compile. 'generic-face' is the default path
 * and needs no defence; its optional `note` carries a warning worth having at
 * migration time (a control the card renders that the def does not declare, a
 * large control count that will need page splitting, a hand-cloned pad to
 * consolidate onto the shared `xy` cell).
 */
export type FaceMigrationEntry =
  | { readonly type: string; readonly disposition: 'generic-face'; readonly note?: string }
  | {
      readonly type: string;
      readonly disposition: 'bespoke-surface';
      readonly why: string;
      readonly blockers?: readonly MigrationBlockerId[];
    }
  | { readonly type: string; readonly disposition: 'organizational-native'; readonly why: string }
  | {
      readonly type: string;
      readonly disposition: 'blocked';
      /** Non-empty by the type: a blocked entry names what blocks it. */
      readonly blockers: readonly [MigrationBlockerId, ...MigrationBlockerId[]];
      readonly why: string;
    };

export const FACE_MIGRATION_INVENTORY: readonly FaceMigrationEntry[] = [
  // ── generic-face ──────────────────────────────────────────────────────────
  // Author a face; rank the controls. The modules already in STRICT_FACES are
  // in here too and are NOT marked — done-ness is read off the def, never typed
  // (see `migrationDone`).
  { type: '4plexvid', disposition: 'generic-face' },
  { type: 'acidwarp', disposition: 'generic-face' },
  { type: 'adsr', disposition: 'generic-face' },
  { type: 'analogLogicMaths', disposition: 'generic-face' },
  { type: 'analogVco', disposition: 'generic-face' },
  { type: 'attenumix', disposition: 'generic-face' },
  { type: 'b3ntb0x', disposition: 'generic-face' },
  { type: 'backdraft', disposition: 'generic-face', note: 'mounts the SHARED <XyPad> twice — those two become `face.xyPads`, not four knobs' },
  { type: 'bentbox', disposition: 'generic-face' },
  { type: 'bluebox', disposition: 'generic-face' },
  { type: 'buggles', disposition: 'generic-face' },
  { type: 'cellshade', disposition: 'generic-face' },
  { type: 'charlottesEchos', disposition: 'generic-face' },
  { type: 'chroma', disposition: 'generic-face' },
  { type: 'chromakey', disposition: 'generic-face' },
  { type: 'clap', disposition: 'generic-face' },
  { type: 'clouds', disposition: 'generic-face' },
  { type: 'cloudseed', disposition: 'generic-face' },
  { type: 'cofefve', disposition: 'generic-face' },
  { type: 'colorizer', disposition: 'generic-face' },
  { type: 'colourofmagic', disposition: 'generic-face', note: 'large control count — the face will need page splitting past the hero slots' },
  { type: 'cube', disposition: 'generic-face' },
  // ⚠ THE ORIGINAL NOTE HERE SAID "SLOTS / LATE / ES-9-present are READOUTS to
  // register, not knobs", and that plan was overturned before it was built:
  // `readouts` and `sidebar` were DELETED by the 2026-08-19 resting-text
  // rulings, so the thing this entry named as the route no longer exists.
  // #2024 re-opened the pair with measurements and the owner ruled "close the
  // gap" — the resolution is `face.rackStatus` (the shell removes a band that
  // belongs to another instance) plus the `StatusLed` primitive on the module's
  // own fullViewBody (a static caption, a lamp, and the measurement in
  // aria-label/title). The slot LABEL paints because it is a NAME.
  //
  // ⚠ KNOWN, DELIBERATE DIVERGENCE FROM THE CARD — recorded here rather than
  // left to be rediscovered as a bug: on a 192px LANE TILE a non-primary
  // instance STILL paints its clock controls. The legacy card hid them at every
  // tier. Suppression requires the status body that explains the absence, and
  // that body is dock-only (`dockFullViewHeadPlan`), so a tile would be left
  // with neither controls nor body — blank, which is worse. This is the same
  // trade MONITOR MODE already makes. If the owner wants tiles suppressed too,
  // that is a rebuild on a ruling, not a defect.
  { type: 'cvBuddy', disposition: 'generic-face', note: 'DONE (#2024): rackStatus + StatusLed; the clock band is primary-only, and a non-primary LANE TILE keeps its clock controls by design — see the note above' },
  { type: 'cvBuddyMini', disposition: 'generic-face', note: 'DONE (#2024): renders the same shared CvBuddyBody as cvBuddy and now shares ONE face object with it, asserted by identity — the pair migrated together' },
  { type: 'delay', disposition: 'generic-face' },
  { type: 'depolarizer', disposition: 'generic-face' },
  { type: 'destroy', disposition: 'generic-face' },
  { type: 'destructor', disposition: 'generic-face' },
  { type: 'dockscope', disposition: 'generic-face', note: 'the trace IS the `scope` glyph (analogVco does exactly this); the CV/AUDIO range button is a param' },
  { type: 'drummergirl', disposition: 'generic-face' },
  { type: 'dx7', disposition: 'generic-face' },
  { type: 'edges', disposition: 'generic-face' },
  { type: 'fader', disposition: 'generic-face' },
  { type: 'featurecv', disposition: 'generic-face' },
  { type: 'feedback', disposition: 'generic-face' },
  { type: 'filter', disposition: 'generic-face' },
  { type: 'flipper', disposition: 'generic-face', note: 'declares no params — its face is a title, a glyph and the rear; nothing to rank' },
  { type: 'fourplexer', disposition: 'generic-face' },
  {
    type: 'foxy',
    disposition: 'generic-face',
    note:
      'DONE (#2007). This entry predicted the blocker correctly — "the raster/XYZ/wavetable ' +
      'previews are read-only pictures" — and, like rasterize, the RESOLUTION half of the ' +
      'prediction ("needing a registered panel, cube is the precedent") was deliberately NOT ' +
      'taken. Two reasons, both structural rather than preference. First the blind-gate one ' +
      'rasterize wrote down: a PF-14 panel REQUIRES an operability probe, and a read-only ' +
      'picture has none of its own, so the probe would watch a DIFFERENT control — an aliveness ' +
      'check that cannot observe the thing it certifies. Second, ARITY: cube is one picture and ' +
      'foxy is five, so panels would have meant five cells consuming five ranks and five probes ' +
      'for pictures that belong together. `fullViewBody` needs no proxy and keeps all five ' +
      'PERSISTENT across the seven tabs, which is the owner backdraft ruling and is what lets a ' +
      'player watch raster B while turning SRC B one tab over. 33 params rank normally around ' +
      'it across seven pages, which reaches DOCK_TAB_MIN_BANDS and engages the tab rail with no ' +
      '`face.tabbed` declaration. The two exported mode-name rosters became `options[]` (#2007), ' +
      'so `sync_mode` stopped rendering as an anonymous three-state rotary.',
  },
  { type: 'freezeframe', disposition: 'generic-face' },
  // ⚠ MOVED HERE FROM `bespoke-surface` (2026-08-26), AND ITS OLD `why` WAS
  // FACTUALLY FALSE — it described a module that does not exist. It read "a
  // GAME viewport driven by the keyboard — one knob beside it does not make it
  // a face." `FroggerCard.svelte` has NO keyboard handler of any kind, and the
  // def never had one: frogger is driven ENTIRELY by gate CV through five
  // rising-edge inputs, which is the whole point of the port and is stated at
  // length in the def's own header AND in the public module manifest ("FULL
  // CV-gate control with NO keyboard exposure on the module"). The `why` was
  // refusing an affordance the module never had, and nothing gated the claim.
  //
  // ⚠ AND THE PREMISE UNDER IT WAS WRONG TOO. "One knob beside it" compares the
  // face against a working card — but frogger is not in NON_SHELL_LANE_TYPES,
  // is not a CARD_PRODUCER and is not in HEADLESS_MOUNT_LANE_TYPES, so the
  // shipping shell already rendered a BLANK PLACEHOLDER for it while the game
  // ran and pulsed gates underneath. The comparison was never face-vs-card; it
  // was face-vs-grey.
  {
    type: 'frogger',
    disposition: 'generic-face',
    note:
      'DONE. One ranked param (TIME) plus the BOARD as a `fullViewBody` extension — the ' +
      '`rasterize` shape, an audio-domain module whose picture the shell has no generic route ' +
      'to (`hasVideoSurface` is `domain === "video"`). The promotion also DISCHARGED THE ' +
      "MODULE'S OWN NAMED RATCHET: its EXEMPT_FROM_VRT entry stated its exit condition " +
      'verbatim ("promote to a real VRT baseline once a deterministic-time test hook is added ' +
      'so the scene can freeze the game at a known tick"), the hook is a boot-time tick pin — ' +
      'cheap here because frogger has NO RNG at all, so the board is already a pure function of ' +
      'tick count — and frogger left EXEMPT_FROM_VRT and ALLOWED_PERMANENT_EXEMPT in the same ' +
      'commit. ⚠ THE LANE TILE STILL HAS NO PICTURE and that is not fixed here: all three ' +
      'outputs are `gate`, so `primaryAudioOutPortId` is null and every glyph but `none` ' +
      'resolves static, while `ShellExtensionGlyphProps` carries no `nodeId` so a glyph ' +
      'component could not reach the game snapshot even if a kind fitted.',
  },
  // ⚠ MOVED HERE FROM `bespoke-surface` (2026-08-24), AND ITS OLD `why` WAS
  // FALSE ON TWO COUNTS — measured against the card and the def rather than
  // re-read. It said "a live device roster", of which there is NONE: the card
  // shows `snapshot.id`, the OS name of the pad in the CURRENTLY SELECTED SLOT
  // ONLY, beside four BLIND buttons labelled `0 1 2 3`. Nothing anywhere
  // enumerates which pads are in which slots — you pick a slot and read the
  // header to find out what you got. And it said "none of it is a param" while
  // `padIndex` is one, and is now this face's only ranked cell. A stale claim in
  // a field agents read as current fact is the `recorderbox` class, so it is
  // rewritten rather than left to be re-discovered. What the entry got RIGHT —
  // the mapping table, the importable mapping files, the live input echo — is
  // exactly the surface that became the `control-grid` fullViewBody.
  {
    type: 'gamepad',
    disposition: 'generic-face',
    note:
      'DONE (2026-08-24). Its "roster" is FOUR NUMBERED SLOTS, not a device list: the Gamepad ' +
      'API caps at four pads and indexes them 0..3, which is a fixed set known when the def was ' +
      'authored — precisely the condition a RUNTIME roster fails — so `padIndex` is an ordinary ' +
      'ParamDef with an `options` roster, renders as a segmented cell, and reaches the lane ' +
      'tile. That is what separates this module from its cohort-mates, whose pickers all need a ' +
      'surface. The mapping board (twelve button LEDs, two trigger rows, two stick pads, both ' +
      'stick calibrations, four inverts, save/load/preset) is a `control-grid` fullViewBody, ' +
      'because every one of those gestures is "move the physical control and watch what lights ' +
      'up" and the live echo cannot fit in 192 px.',
  },
  { type: 'gatemaiden', disposition: 'generic-face' },
  { type: 'grainsOfVision', disposition: 'generic-face' },
  { type: 'graphicEq', disposition: 'generic-face' },
  { type: 'illogic', disposition: 'generic-face' },
  { type: 'inwards', disposition: 'generic-face' },
  {
    type: 'joystick',
    disposition: 'generic-face',
    // ⚠ THE OLD NOTE ("migrate onto the shared `xy` cell, never two knobs")
    // was overturned by the owner, not by drift: an `xyPads` face here
    // resolves to ZERO lane controls (the pad anchor is dock-only and the
    // partner folds at every tier), which module-face-lint denies with this
    // module's old shape as its permanent negative control, and widening that
    // gate to credit a `tileBody` is a gate edit the 2026-08-25 ruling
    // reserves to the owner. The 2026-08-31 decision (owner-decisions item 2)
    // picked the fallback the old note forbade.
    note:
      'SHIPPED as the two-ordinary-cells fallback (owner decision 2026-08-31): `pos_x`/`pos_y` '
      + 'rank as two plain bipolar knob cells — the lane tile paints them, honestly satisfying '
      + 'the #1974 lane clause — and the real pad (jump-to-point, Y flip, tracked commits, '
      + 'double-click re-centre, #1963 no-snap-back) is the `joystick` extension\'s '
      + '`fullViewBody` at the dock. The stated cost is the twotracks redundancy: the dock '
      + 'shows the pad AND both knobs beneath it. The knobs are the parity-credited cells and '
      + 'the per-axis MIDI/Electra anchors; the pad emits no `control-*` anchor and no '
      + '`data-control-params` (joystick-face-model.test.ts pins both directions). The card\'s '
      + 'x/y decimal readout is DELETED on the promoted surfaces, not relocated: values live on '
      + 'the pad\'s aria-label and the knobs\' aria-valuetext.',
  },
  { type: 'karplus', disposition: 'generic-face' },
  { type: 'kickdrum', disposition: 'generic-face' },
  { type: 'lfo', disposition: 'generic-face' },
  { type: 'lines', disposition: 'generic-face' },
  // ⚠ WAS THE INVENTORY'S LAST `blocked` ENTRY, on `needs-media-controller`.
  // The old record read: "a capture LED, a start/stop capture action and one
  // fader — the smallest surface in the media set, and the ONLY genuine case
  // left in it", with the correction that the LIFETIME half had already shipped
  // (#1583) and what remained was "an ACTION cell that can request a stream plus
  // a home for the crop pump".
  //
  // ⚠ THAT SCOPING WAS RIGHT, AND BOTH HALVES ARE NOW BUILT — but neither of
  // them is the blocker's capability, and it is worth being precise about which
  // is which, because "the last blocked module was promoted" is very easy to
  // misread as "#1511 landed":
  //
  //   * ACQUISITION — `$lib/ui/media/loopback-status-registry`. The card keeps
  //     sole ownership of `getDisplayMedia`, the MediaStream and the state
  //     machine; it PUBLISHES its status and REGISTERS acquire/stop commands,
  //     and the faceplate reads and invokes. A remote control, not a second
  //     owner. ⚠ Harder than CAMERA's equivalent: a display capture has no
  //     already-granted state, so this is not a first-visit convenience — it is
  //     the only way a promoted loopback can be started at all.
  //   * THE CROP PUMP — `$lib/ui/media/loopback-crop-pump`, node-keyed and
  //     swept from Canvas. Off the card because a collapse used to freeze the
  //     crop rectangle while the capture kept running (#1531), and because the
  //     card's `document.querySelector('.svelte-flow')` reader was ambiguous
  //     the moment a headless host mounted a second flow — which, measured, was
  //     ALREADY true for an unfaced loopback ('placeholder' hosts too), so that
  //     was a pre-existing defect rather than one the face created.
  //
  // ⚠ AND THE BLOCKER IS UNMOVED. `needs-media-controller`'s capability is
  // "node-owned media lifecycle … instead of a mounted <X>Card.svelte", and its
  // probe is `HEADLESS_MOUNT_LANE_TYPES.length === 0` — still false, and still
  // false BECAUSE OF THIS MODULE among others: loopback's card is exactly what
  // `<HeadlessSourceHost>` keeps alive. What this proves is the narrower thing
  // cameraInput proved first — a card-owned-source module CAN be faced while
  // that blocker is outstanding, by paying the headless-host tax and rebuilding
  // the card-only affordances. It is the SECOND module to pay both halves.
  //
  // ⚠ NO `why` FIELD, AND THAT IS THE TYPE'S DOING RATHER THAN AN OMISSION:
  // `why` exists only on the NON-generic dispositions, because those are the
  // ones that owe an explanation. svelte-check refuses the field outright.
  { type: 'loopback', disposition: 'generic-face' },
  { type: 'luma', disposition: 'generic-face' },
  { type: 'lumakey', disposition: 'generic-face' },
  { type: 'lushgarden', disposition: 'generic-face', note: 'the def declares more params than the card exposes — a face ranks ALL of them, so check each one is real' },
  { type: 'macrooscillator', disposition: 'generic-face' },
  // ⚠ THE PREVIOUS NOTE HERE NAMED THE WRONG GESTURE AND THE WRONG PARAMS, and
  // a face built to it would have wired the wrong pair to its pad. It read:
  // "the orbit drag over the preview is a 2-D camera gesture → the `xy` cell,
  // not two knobs". Checked against `MandelbulbCard.svelte`:
  //
  //   * there IS no orbit drag — the pointer handlers write `slice_y` +
  //     `slice_ry` (`:136-137`), and only fire when SLICE is ON (`:140`);
  //   * `rotate_x`/`rotate_y` are knob-only, so it is not a CAMERA gesture at
  //     all — it is a slice-PLANE selector.
  //
  // Its third clause was RIGHT and is kept: a 2-D pad is the correct shape, and
  // "the `xy` cell" is this file's own shorthand for it (see the header's cell
  // list and the derivation note). The implementation is `face.xyPads`, named
  // here so the next reader does not go looking for an `xy` KIND in
  // `shell-cells.ts`, where there isn't one.
  //
  // A disposition note is a hypothesis like any other — verify it against the
  // code before designing against it.
  { type: 'mandelbulb', disposition: 'generic-face', note: 'the drag over the preview writes slice_y + slice_ry and only when SLICE is on — a slice-plane selector, NOT a camera orbit; rotate_x/rotate_y are knob-only. A 2-D pad is still the right shape: declare it as `face.xyPads` (there is no `xy` KIND in shell-cells.ts). ⚠ glyph MUST be `none`: this is the one video def with an `audio` output, so primaryAudioOutPortId resolves and a live glyph would bind to a tap that cannot see a video-domain node (mandelbulb-glyph-tap.test.ts). The slice WAVEFORM readout canvas is a second bespoke picture: it now lives in the `fullViewBody` extension and is fed by the `read("sliceWave")` seam, NOT re-derived — mbSampleSlice is 16,384 DE calls on the main thread and the card already runs it a second time, so a third derivation would have made a slice move cost 3x. ⚠ `read("slice")` is the TOGGLE STATE, not the wave. ⚠ TWO SCREEN CONTROLS AND THEY ARE NOT DUPLICATES: the `screen_on` PARAM is product behaviour (at 0 the factory skips the raymarch, but only while video_out is unpatched, so it never starves a consumer — the faced `cube` precedent, and NOT the #2015 producer-kill class), while the preview switch is `node.data.previewCollapsed`, pure view layer. One asks "compute a picture at all", the other "do I want to look right now"; separate state, separate meanings, neither can diverge from the other.' },
  { type: 'mandleblot', disposition: 'generic-face' },
  { type: 'mapper', disposition: 'generic-face' },
  { type: 'marbles', disposition: 'generic-face' },
  { type: 'meowbox', disposition: 'generic-face' },
  { type: 'milkdrop', disposition: 'generic-face', note: 'preset roster → selector cell, .milk import → file cell (the dx7 .syx precedent); the visualiser is the video-domain live thumb' },
  { type: 'mirrorpool', disposition: 'generic-face', note: 'two HAND-CLONED camera pads → two `face.xyPads` entries (#1509 §3)' },
  { type: 'mixer', disposition: 'generic-face' },
  { type: 'mixmstrs', disposition: 'generic-face', note: 'every control is a param knob rendered in a strip loop; by far the largest order in the fleet — pages/clusters per channel, and check the strip reads at the dock' },
  { type: 'monoglitch', disposition: 'generic-face' },
  { type: 'moog902', disposition: 'generic-face' },
  { type: 'moog903a', disposition: 'generic-face' },
  { type: 'moog904a', disposition: 'generic-face' },
  { type: 'moog904b', disposition: 'generic-face' },
  { type: 'moog904c', disposition: 'generic-face' },
  { type: 'moog905', disposition: 'generic-face' },
  { type: 'moog907a', disposition: 'generic-face' },
  { type: 'moog911', disposition: 'generic-face' },
  { type: 'moog911a', disposition: 'generic-face' },
  { type: 'moog912', disposition: 'generic-face' },
  { type: 'moog914', disposition: 'generic-face' },
  { type: 'moog921Vco', disposition: 'generic-face' },
  { type: 'moog921a', disposition: 'generic-face' },
  { type: 'moog921b', disposition: 'generic-face' },
  { type: 'moog923', disposition: 'generic-face' },
  { type: 'moog960', disposition: 'generic-face', note: 'the 8-column step grid is knobs binding params — the active-column highlight is a readout, so nothing here is a bespoke gesture' },
  { type: 'moog961', disposition: 'generic-face' },
  { type: 'moog962', disposition: 'generic-face' },
  { type: 'moog984', disposition: 'generic-face', note: 'the cross-point matrix is one param per cell — a grid LAYOUT, not a grid affordance' },
  { type: 'moog992', disposition: 'generic-face' },
  { type: 'moog993', disposition: 'generic-face' },
  { type: 'moog994', disposition: 'generic-face', note: 'declares no params — a passive multiple; face is title + rear' },
  { type: 'moog995', disposition: 'generic-face' },
  { type: 'moogCp3', disposition: 'generic-face' },
  { type: 'ninelives', disposition: 'generic-face' },
  { type: 'noise', disposition: 'generic-face' },
  { type: 'onetonine', disposition: 'generic-face' },
  { type: 'outlines', disposition: 'generic-face' },
  { type: 'peakstate', disposition: 'generic-face' },
  { type: 'pentemelodica', disposition: 'generic-face' },
  { type: 'polarizer', disposition: 'generic-face' },
  { type: 'posterbox', disposition: 'generic-face' },
  // ⚠ MOVED HERE FROM `bespoke-surface` (2026-08-25), AND ITS OLD `why` LED
  // WITH A SURFACE THAT DOES NOT EXIST. It said "a pad grid plus the hardware
  // screen mirror". There is NO PAD GRID: `Push2ControlCard.svelte` renders
  // three buttons, one canvas, a ‹ › flip row, eight lane buttons, four view
  // buttons and a status region — and nothing anywhere in the app has ever
  // painted an 8×8 matrix, because the pads are ON THE HARDWARE. That is the
  // same false claim `launchpadControlLeft`'s entry carried, discovered the
  // same way (by reading the card instead of the field), and it matters here
  // because the imagined pad grid is what made the module look un-faceable: the
  // thing the app actually mirrors is the DISPLAY, byte-for-byte through a
  // shared seam, which is an ordinary `picture` body. The rest of the old
  // sentence was right and is kept.
  {
    type: 'push2Control',
    disposition: 'generic-face',
    note:
      'DONE (2026-08-25). The THIRD meta-domain face. ONE ranked ACTION cell — CONNECT PUSH 2 — ' +
      'because the module is completely inert until Web MIDI is granted and it declares NO PORTS ' +
      'AT ALL, so before promotion its whole surface was dock-only on a module with not even a ' +
      'cable to hint it exists (the midiclock #2187 shape, with a stronger premise). Everything ' +
      'else is a `picture` fullViewBody built around a 960×160 REPLICA of the hardware screen, ' +
      'painted by the SAME `pushDisplayOps()` op list that goes to the panel over WebUSB — so the ' +
      'plate cannot disagree with the device. BIND is a body control because its two presses do ' +
      'OPPOSITE things and `ShellActionCell.label` is a plain string; CONNECT DISPLAY is one ' +
      'because a separate WebUSB permission that is never required cannot be an unconditional ' +
      'cell; and the eight-lane select and four-role view segment are body controls for a reason ' +
      'that reads backwards until checked — a `ShellSelectorCell` could ignore its `node` and ' +
      'read a module-scope rune, but ModuleShell re-projects a cell only on `nodeVersion(id)` and ' +
      'this module writes `node.data` ZERO times, so the cell would never notice the eight ' +
      'buttons ON THE HARDWARE moving it.',
  },
  { type: 'qbrt', disposition: 'generic-face' },
  { type: 'quadralogical', disposition: 'generic-face', note: 'the quad mix pad is a HAND-CLONE → the shared `xy` cell (#1509 §3)' },
  {
    type: 'rasterize',
    disposition: 'generic-face',
    note:
      'DONE (#2001). This entry predicted the blocker correctly — "the scan preview is a read-only ' +
      'picture with no glyph kind, it needs a registered panel or it is a look loss" — and the ' +
      'resolution is the `fullViewBody` extension slot rather than a panel cell. The reason no ' +
      'glyph kind fits is sharper than "none of them match": `hasVideoSurface` is ' +
      '`domain === "video"` and this is an AUDIO def with a mono-video OUT painted in JS by ' +
      'RasterPainter, so the shell has no generic route to the picture at all. Four params rank ' +
      'normally around it; SCAN ranks LAST because it is a change detector rather than a position ' +
      'control (#2000, left open — revisit the rank if that issue is fixed). ' +
      '⚠ THE "registered panel" HALF OF THE PREDICTION WAS DELIBERATELY NOT TAKEN, and the reason ' +
      'is a blind-gate one rather than a preference: a PF-14 panel cell REQUIRES a probe, and the ' +
      'only probe available here reads a DIFFERENT control (the WRAP caption) — a picture whose ' +
      'aliveness check cannot observe the picture. `fullViewBody` needs no such proxy, and ' +
      '`videoOut` is the precedent it matches exactly: a card whose BODY is the live screen.',
  },
  { type: 'reshaper', disposition: 'generic-face' },
  { type: 'resofilter', disposition: 'generic-face' },
  { type: 'reverb', disposition: 'generic-face' },
  { type: 'ringback', disposition: 'generic-face' },
  { type: 'rings', disposition: 'generic-face' },
  { type: 'ruttetra', disposition: 'generic-face' },
  { type: 'sampleHold', disposition: 'generic-face' },
  { type: 'samsloop', disposition: 'generic-face', note: 'file → file cell, trigger → action cell, rec channels/bits/rate → discrete params; the sample waveform is the `waveform` glyph' },
  { type: 'scaler', disposition: 'generic-face' },
  // ⚠ THE ORIGINAL NOTE WAS WRONG AND IS CORRECTED HERE (2026-08-23, with the
  // face). It read: "the dual-trace + Lissajous screen is ONE `scope` glyph
  // binding; if it will not carry two channels the screen becomes a registered
  // panel". Both halves fail. The glyph WOULD resolve — `ch1_out` is a declared
  // audio output, so `glyphBinding` returns `{kind:'live-audio'}` and every
  // gate stays green — but `ch1_out` IS the CH1 input gain with nothing ever
  // written to it, so the trace it paints is invariant to all nine of this
  // module's controls. Live, legal, and a lie. And a `panel` REQUIRES a probe
  // (`shell-cells.ts`), which a read-only picture has none of, so it would have
  // had to watch a DIFFERENT control — an aliveness check that cannot observe
  // the thing it certifies, the refusal `rasterize` and `foxy` both wrote down.
  // The screen is a `fullViewBody`; see `strict-faces.ts` and
  // `scope-face-model.test.ts` for the derivation and the assertion.
  { type: 'scope', disposition: 'generic-face', note: 'FACED 2026-08-23 as `glyph: none` + a `fullViewBody` — the `scope` glyph resolves LIVE here (unlike dockscope) and is still blind, because `ch1_out` is the CH1 input verbatim' },
  { type: 'scoreboard', disposition: 'generic-face' },
  { type: 'shapedramps', disposition: 'generic-face' },
  { type: 'shapegen', disposition: 'generic-face' },
  { type: 'shapes', disposition: 'generic-face' },
  { type: 'shimmershine', disposition: 'generic-face' },
  { type: 'sidecar', disposition: 'generic-face' },
  { type: 'sixstrum', disposition: 'generic-face' },
  {
    type: 'skifree',
    disposition: 'generic-face',
    // ⚠ THE OLD `why` WAS WRONG ON ITS LOAD-BEARING CLAUSE AND RIGHT ON THE
    // OTHER: "a GAME: a scrolling viewport played on the keyboard, with no
    // params at all." There is NO keyboard handler in `SkifreeCard.svelte`, in
    // the vendored `embed.js` or in the upstream `js/` classes — steering is
    // two bipolar CV inputs plus the MOUSE. "No params at all" is true, and it
    // is the only thing that ever made this entry look bespoke.
    //
    // `params: []` is `flipper`'s shape, not `joystick`'s. #1974's zero-lane
    // clause refuses a face that RANKS controls and then drops them at the tier
    // the player is looking at, and it explicitly SKIPS a face that ranks
    // nothing — naming `flipper` and `videoOut` as the honest case. So
    // `order: []` is legal here, and the missing picture is answered by the
    // extension seam rather than by a disposition: `tileBody` for the lane,
    // `fullViewBody` for the dock.
    //
    // ⚠ AND THE STANDING REFUSE-SPEC'S LEAD BLOCKER IS DEAD. `.myrobots/
    // 2026-08-24-bespoke-wave5/skifree/spec.md` refused this face on "promotion
    // DELETES THE GAME — the engine lives on the card", which was TRUE WHEN
    // WRITTEN and was retired by #2192 (868ddb9ee): the bundle load, the
    // controller and its disposal all moved into the FACTORY, on node lifetime.
    // The remaining cost is VRT-only and is discharged as a named
    // `FACES_WITHOUT_SCENES` entry — the game is a committed third-party IIFE
    // running its own rAF and its own RNG, which `simPin` cannot reach.
    note:
      'a GAME with `params: []`, so the face ranks nothing and BOTH extension body slots are '
      + 'load-bearing: `fullViewBody` is the steerable slope (the mouse is the module\'s only '
      + 'direct-manipulation instrument) and `tileBody` is the read-only lane picture, without '
      + 'which the tile would be a title bar and four jacks. The card\'s `{distance}m · lives {n} '
      + '· CV|MOUSE|IDLE · GAME OVER` chrome row is DELETED by the resting-text ruling, not '
      + 'relocated: the numbers survive as the bundle\'s own in-canvas InfoBox and on the '
      + 'picture\'s aria-label, and the control mode as two static-caption StatusLed lamps.',
  },
  { type: 'slewSwitch', disposition: 'generic-face' },
  { type: 'snaredrum', disposition: 'generic-face' },
  { type: 'sourcery', disposition: 'generic-face' },
  { type: 'spectrograph', disposition: 'generic-face', note: 'one gain knob + a B/W toggle; the sonogram waterfall matches no glyph kind, so the screen is a registered panel' },
  { type: 'spirographs', disposition: 'generic-face', note: 'the hue wheel writes a single continuous param — a knob at worst, a colour cell if the range is packed RGB' },
  { type: 'stereovca', disposition: 'generic-face' },
  { type: 'swolevco', disposition: 'generic-face' },
  { type: 'synesthesia', disposition: 'generic-face', note: 'FACED 2026-08-24 as `glyph: none` + a `fullViewBody` VU wall — the mode/polarity buttons became named two-state cells (an `options` roster each), and the read-only band displays moved to the extension because a glyph would resolve LIVE here and paint copy A\'s bass band as though it were the analysis' },
  { type: 'tempest', disposition: 'generic-face' },
  { type: 'tempolock', disposition: 'generic-face', note: 'born faced 2026-08-29 — the beat-tracking clock; one ranked band selector + a status-primitive body (LOCK/BEAT lamps)' },
  { type: 'tidyVco', disposition: 'generic-face' },
  { type: 'tiler', disposition: 'generic-face' },
  { type: 'timelorde', disposition: 'generic-face', note: 'transport + mute write params; TAP TEMPO is an action cell writing the same bpm param' },
  { type: 'tomtom', disposition: 'generic-face' },
  { type: 'treeohvox', disposition: 'generic-face' },
  { type: 'unityscalemathematik', disposition: 'generic-face' },
  { type: 'vca', disposition: 'generic-face' },
  { type: 'vdelay', disposition: 'generic-face' },
  {
    type: 'vstInstrument',
    disposition: 'generic-face',
    note:
      'PROMOTED (with vstFx, one PR). The disposition MOVED from `bespoke-surface` on promotion, ' +
      'like es9 and midiclock before it — the identity gate below requires every def that ' +
      'declares a `face` to be dispositioned generic-face, and the extension seam it uses is ' +
      'the shipped platform rather than the missing one that word was reserved for. ' +
      'The old `why` was the most accurate in this migration ' +
      'and still had two false clauses, recorded because the ten faces before it were wrong in ' +
      'bulk and this one was not. RIGHT: "zero params — the surface IS the bridge control plane" ' +
      'is exact, and it is why this face is TWO cells where es9 (whose identical-sounding `why` ' +
      'named the same "connection state machine") turned out to have twenty-two ParamDefs. ' +
      'WRONG 1: the text filter is NOT "the typed entry" — a ShellEntryCell probe requires a ' +
      'node.data observable and node.data rides the Y.Doc, so persisting a search box would sync ' +
      "one player's keystrokes to every collaborator and dirty the patch per keystroke; it is a " +
      'private view setting and lives beside the picker it narrows. WRONG 2 (on the vstFx entry, ' +
      'which claimed "nothing to rank into a generic face"): CONNECT and DISCONNECT rank as ' +
      'action cells exactly as es9\'s do, which is what puts them on the LANE TILE where the ' +
      'extension body cannot go. The picker itself cannot be a selector cell for a reason that ' +
      'is about the MACHINE, not the read: its roster is the user\'s installed AU library, so it ' +
      "is EMPTY on every runner, and faces-parity's selector branch asserts the roster offers " +
      'more than one option.',
  },
  {
    type: 'vstFx',
    disposition: 'generic-face',
    note:
      'PROMOTED in the SAME PR as vstInstrument, because the two cards are one component: ' +
      'both are a PatchPanel wrapped around the same VstBridgePanel, differing only in their ' +
      'port sets and in which plugin kinds the picker lists. They share one `vstBridge` shell ' +
      'extension for the same reason. See the vstInstrument note for the two clauses this ' +
      "entry's own `why` got wrong.",
  },
  { type: 'vfpgaRunner', disposition: 'generic-face', note: 'preset roster → selector cell, fabric floorplan → a toggled read-only panel; the params are def-declared, so rank those and not the manifest' },
  { type: 'videoMixer', disposition: 'generic-face' },
  { type: 'warrensspectrum', disposition: 'generic-face', note: 'the ws-filterbank family is a bank of param faders — a family cell/panel, the same shape as the faced modules already register' },
  { type: 'warrensvisions', disposition: 'generic-face' },
  {
    type: 'wavecel',
    disposition: 'generic-face',
    note:
      'DONE. This entry mapped it correctly except for ONE word, and that word was the whole ' +
      'build estimate: "viz toggle → toggle" would have made wavecel the FIRST adopter of the ' +
      'data-backed `toggle` shell cell (zero entries, real first-adopter cost). It is not. ' +
      '`WavecelCard.svelte:54` holds the view mode in component `$state`; the def\'s "persists ' +
      'across page reloads + multiplayer" sentence two lines below is about `wavetableSource`, ' +
      'not about the toggle, and both video OUTPUTS render their own view regardless of it. So ' +
      'it is a private view preference over the picture and lives INSIDE the panel — where ' +
      'shell-cells then forced it onto `node.data` anyway, by refusing a probe whose witness ' +
      'was the button\'s own caption ("a control that only relabels itself is indistinguishable ' +
      'from a dead one"). The rosters and the .wav import are `selector` + `file` cells exactly ' +
      'as predicted, and the RECORDED BLOCKER (wavetable selection lives in node.data, which ' +
      '`FaceReadoutValue` cannot see) was stale in both halves: that type is a param reader and ' +
      'is correctly blind to node.data, while shell-cell specs are node-taking closures — dx7 ' +
      'ships both kinds today (#2010 reached this from the docs side the same week). ' +
      'SPREAD ships bit-exactly MONO and five of ten params are inert at spawn (#1999, owner ' +
      'ears, left open); the rank is built around that rather than over it.',
  },
  {
    type: 'frametable',
    disposition: 'generic-face',
    note:
      'knobs plus two hand-cloned 2-D pads (both expressible as `face.xyPads`), a MODE selector ' +
      'that shows/hides each mode\'s extras, and a live video_out preview that EARNS its width. ' +
      'The .frametable.png import (and SAVE) needs an ACTION-shaped cell — a cell kind, not a ' +
      'platform capability. ⚠ It carried `needs-media-controller` until the DOM_SOURCE predicate ' +
      'was corrected: its picture is its `video_in` GRAPH CABLE, and the element the card hands ' +
      'over is a one-shot atlas `detilePendingAtlas()` copies into the ring and drops. No card ' +
      'mount was ever load-bearing, so nothing was blocking it.',
  },
  {
    type: 'videocube',
    disposition: 'generic-face',
    note:
      'knobs plus three mounts of the SHARED <XyPad> (already a first-class `xy` cell), the ' +
      'WRAP/MATERIAL/SCREEN toggles, a global READER row and a live preview. The per-SLOT ' +
      'import is an ACTION-shaped cell, three times over. ⚠ Same corrected premise as ' +
      'frametable: its pictures are the `video_a`/`video_b`/`video_c` GRAPH CABLES, and each ' +
      'slot ingest is a tagged atlas canvas `detilePending(slot)` consumes and nulls (plus a ' +
      '1x1 `videocubeClear` canvas to return a slot to LIVE).',
  },
  {
    type: 'wavesculpt',
    disposition: 'generic-face',
    note: 'PROMOTED 2026-08-24. The old warning here — "a face was authored for it once and '
      + 'shipped both pads as knobs, do not repeat that" — was correct and is now SPENT, so it '
      + 'is replaced by what actually happened rather than left as a caution nobody can act on. '
      + '⚠ THE PADS: `face.xyPads` now exists and `module-face-lint` enforces that both axes are '
      + 'ranked and CONTINUOUS, so shipping a pad as two knobs is refused by a gate rather than '
      + 'by memory. The camera pad survives as a pad, declared `surface: \'body\'` so the module '
      + 'paints it ON its own render. ⚠ THE SECOND PAD DID NOT SURVIVE, DELIBERATELY: zoom/rot '
      + 'became two FADERS on owner instruction, because its axes are not commensurate (zoom log '
      + '0.3..3, rot linear ±1) so equal pixel travel was never equal parameter travel. That is '
      + 'the one case where flattening a pad is the fix rather than the loss. ⚠ IT NEEDED A '
      + 'PRECURSOR PR: the picture was a WebGL2 renderer welded into a 3 644-line card, and no '
      + 'faceplate body can mount that — the renderer was extracted first (behaviour-neutral, '
      + 'VRT-proved) so the card and the face are two mounts of ONE renderer, the cube shape. '
      + '⚠ AND ITS BAND STRUCTURE IS PLATFORM-FORCED: a control-family key is ONE cell for ALL '
      + 'instances, so the twelve wavetable pickers could not sit in the four oscillator bands '
      + 'the spec drew them in and share a WAVETABLES band; four oscillators needed twelve '
      + 'families, videocube-style, not three.',
  },
  { type: 'wavetableVco', disposition: 'generic-face' },

  // ── blocked ───────────────────────────────────────────────────────────────
  //
  // ⚠ THIS BUCKET IS NOW EMPTY, and that is a real state rather than a missing
  // section. `loopback` was its last member and was promoted 2026-08-23; the
  // heading stays because the DISPOSITION still exists in the union and is
  // still the right answer for a future module whose surface genuinely waits on
  // a platform capability. Nothing asserts the bucket is non-empty (the only
  // gate on it refuses a `blocked` entry that names NO blocker), so an empty
  // section is green by construction — but a reader finding no heading at all
  // would reasonably conclude the disposition had been retired, and it has not.
  //
  // ⚠ AND EMPTYING IT DID NOT RETIRE `needs-media-controller`. That blocker's
  // probe is `cardOwnedSourceTypes.length === 0` — i.e. HEADLESS_MOUNT_LANE_TYPES
  // is empty — and it is still false, because loopback's own card is one of the
  // things the headless host keeps alive. Modules in the `bespoke-surface`
  // bucket below still declare the blocker, so the registry entry stays
  // anchored in both directions. "The last blocked module shipped" and "the
  // blocker resolved" are different facts and only the first one happened.
  // ── bespoke-surface ───────────────────────────────────────────────────────
  // The primary interaction is not param-shaped. Each of these needs a
  // hand-written surface behind the extension seam — which is BUILT and adopted
  // (#1512), so this disposition names WORK, not a wait. What a given module is
  // still waiting on, if anything, is named in its own `blockers`.
  // ⚠ WAS `bespoke-surface` WITH A `needs-media-controller` BLOCKER. The old
  // record read: "an archive.org SEARCH BROWSER: a typed query with year
  // bounds, a result list to pick from, and a player. The list is the
  // interaction, the query is typed, and the <video> source is card-owned."
  //
  // ⚠ THE LAST CLAUSE IS STILL TRUE, AND IT IS NOT A BLOCKER. This is the
  // THIRD member of `DOM_SOURCE_LANE_TYPES` to be faced, and unlike the two
  // 2026-09-02 retirements next door it does NOT get there by
  // reclassification: peertube's blocker was a category error (it had already
  // LEFT the set) and recorderbox was never in it, whereas archivist IS in it,
  // its three elements ARE card-attached, and `needsHeadlessSourceMount`
  // genuinely returns true. The blocker is DISCHARGED the way cameraInput's
  // and loopback's were — the card keeps sole ownership of the elements and
  // the fetch/attach chain, and every affordance it draws is carried to the
  // faceplate through a status/command registry. See the `CARD_SOURCE_FACED`
  // entry in face-migration-inventory.test.ts, which is the gate that refuses
  // a DOM-source `generic-face` without one.
  //
  // ⚠ THE SECOND CLAUSE WAS FALSE AS WRITTEN AND IS CORRECTED: "a result list
  // to pick from" describes a surface this module never had. archivist fetches
  // a page of up to 50 docs and picks a RANDOM one; the player's second draw
  // is the ↻ next button, not a row in a roster. There is no list to move to a
  // body, which is why this face needed no `selector`-cell argument at all —
  // the affordances that could not be cells are a free-text TERM, two YEAR
  // bounds, a media-type filter, and four transport ACTIONS.
  //
  // ⚠ AND THE BLOCKER STAYS REGISTERED: `MIGRATION_BLOCKERS` keeps
  // `needs-media-controller` because it is dropped from THIS entry only.
  {
    type: 'archivist',
    disposition: 'generic-face',
    note:
      'an archive.org SEARCH BROWSER, faced 2026-09-02: one ranked param (gain, a fader) over an ' +
      'extension that fills BOTH body slots. ⚠ IT IS IN `DOM_SOURCE_LANE_TYPES`, so promotion ' +
      'parks the REAL card in <HeadlessSourceHost> at left:-9999px with pointer-events:none — ' +
      'MOUNTED, which is what keeps the three node-owned elements attached and a loaded item ' +
      'playing, but UNCLICKABLE. Since this card is all controls, every one of them is carried ' +
      'to the faceplate through $lib/ui/media/archivist-status-registry: the card publishes ' +
      'loading/statusMsg/errorMsg/docCount/positionSec and registers six commands, and the ' +
      'bodies read and invoke. No second owner exists — the bodies fetch nothing, adopt no ' +
      'element and call no engine method. ⚠ THE BODIES ARE LOAD-BEARING IN THE STRONGEST FORM ' +
      'ON THIS ROSTER: a fresh archivist has NO item (node.data.item is null until a search ' +
      'writes one, and the factory searches nothing on its own), so a promotion without them ' +
      'would ship a media source that can never be given any media. ⚠ BOTH SLOTS, because ' +
      'cameraInput shipped fullViewBody-only and lost its only route to a first capture; the ' +
      'lane tile carries a compact copy of the same search and transport and does NO mount-time ' +
      'work (one onMount read, one registry subscribe — no fetch, no probe). ⚠ ONE COMPONENT, ' +
      'THREE MOUNTS (ArchivistBrowseControls.svelte), so the card and both bodies cannot drift — ' +
      'this module has a documented case of exactly that drift in updateDuration\'s comment. ' +
      '⚠ A WRITE-ONLY MIRROR WAS FIXED: the card wrote the four search keys to the Y.Doc and ' +
      'never read them back, so a rack-mate\'s typing left it searching a stale local copy; the ' +
      'query is now read from the GRAPH at the moment a search runs. ⚠ TWO RESTING READOUTS ' +
      'DELETED ON EVERY SURFACE: the `0:04 / 2:00` time line (position lives on the scrubber and ' +
      'its aria-valuetext — videobox and videovarispeed made the same deletion) and the ' +
      '`Internet Archive · {type}` line (the type restated the picker two rows up). Both live on ' +
      'the picture\'s aria-label. The play-only warning is KEPT as a CLEAN OUT StatusLed, since ' +
      'it is the only account a player has of a patched `video` jack delivering the idle pattern.',
  },
  {
    type: 'audioIn',
    // ⚠ WAS `bespoke-surface` WITH A `needs-media-controller` BLOCKER. The old
    // record read: "a hardware CAPTURE BINDER: a live enumerateDevices roster
    // (service state, not node state, so no selector cell projects it), a
    // permission/status flow with five failure states, and a getUserMedia stream
    // the card starts and stops with its own lifetime."
    //
    // ⚠ THE FIRST TWO CLAUSES ARE STILL TRUE and neither is a BLOCKER: the
    // EXTENSION BODY is the rung of the ladder for exactly this, which is the
    // resolution `legacy-fallback.ts` records by name for `cameraInput` ("the
    // one slot that can hold a control no `ParamDef` can express") and which
    // `audioOut` below then applied to the same roster on the other direction of
    // the wire. This module needs TWO slots rather than one — `fullViewBody` for
    // the dock and the 🎧 tray, `tileBody` for the lane — because ENABLE is the
    // only route to a first `getUserMedia` grant and `cameraInput` shipped
    // without a tile and lost it.
    //
    // ⚠ THE THIRD CLAUSE WAS FACTUALLY FALSE, and had been since #1590 — which
    // matters, because it is the clause that made the disposition read as
    // blocked-on-the-platform. `node-audio-input-registry.svelte.ts` states in
    // its own header that "the card ADOPTS and READS; it never CREATES or
    // DESTROYS", teardown is keyed to GRAPH lifetime through
    // `sweep(liveNodeIds)`, and `AudioinCard.svelte` carried the matching "⚠ NO
    // `stopStream()` HERE" banner. The stream had not been the card's for months.
    //
    // ⚠ AND THE PROMOTION WAS NOT A FREE READ-THROUGH, for the same reason
    // `audioOut`'s was not. THREE things did still live in the card's own
    // `onMount` — `nodeAudioInput.adopt` (without which `request()` returns IDLE
    // and the module is silent), the initial `enumerateDevices` + auto-acquire,
    // and the `devicechange` subscription — and this module is in neither
    // `DOM_SOURCE_LANE_TYPES` nor `CARD_PRODUCER_LANE_TYPES`, so no headless host
    // would have kept that card alive. They moved to
    // `$lib/audio/input-device.svelte.ts` (the input-side twin of the seam
    // audioOut's promotion authored) plus `$lib/ui/modules/audioIn/
    // audio-in-actions.ts`, and the legacy card moved onto them too.
    //
    // ⚠ NO `why` FIELD — the type refuses one on `generic-face`, which is the
    // rule enforced by `tsc` rather than by a test.
    disposition: 'generic-face',
  },
  {
    type: 'audioOut',
    // ⚠ WAS `bespoke-surface`. The old record read: "a hardware OUTPUT BINDER
    // around one master fader: a live enumerateDevices roster plus the setSinkId
    // support/error states, which are neither params nor node data and have no
    // cell kind that reads them."
    //
    // ⚠ EVERY FACT IN THAT SENTENCE IS STILL TRUE — the roster is still service
    // state, `setSinkId` support is still not a `ParamDef`, and no cell kind
    // reads either. What changed is that none of it is a BLOCKER, because the
    // EXTENSION BODY is the rung of the ladder for exactly this. `cameraInput`
    // had the identical problem (a `<select>` populated from
    // `enumerateDevices()`, persisted to a `node.data` key) and
    // `legacy-fallback.ts` records the resolution by name — the picker "moved
    // into the faceplate's EXTENSION BODY, which is the one slot that can hold a
    // control no `ParamDef` can express."
    //
    // ⚠ IT WAS NOT A FREE READ-THROUGH, AND THE WORK IS WORTH NAMING because
    // the same shape then repeated on `audioIn` above — which was promoted one
    // wave later and paid exactly this cost, in the same three places (a roster
    // seam, a saved key with an origin, and a card that had to be moved onto
    // both). This sentence used to read "still waits on `audioIn` above"; it
    // does not wait any more. The card was the SOLE
    // caller of `setSinkId` and re-applied the saved device from a retry loop in
    // its own `onMount` — and audioOut is in neither `DOM_SOURCE_LANE_TYPES` nor
    // `CARD_PRODUCER_LANE_TYPES`, so unlike `cameraInput` NO headless host would
    // have kept that card alive. Facing it without moving the apply would have
    // silently stopped the saved output device being restored on load. The apply
    // moved into the audio-out HANDLE, where the engine's own boot is the event
    // the retry loop was polling for; the loop is deleted rather than hosted.
    //
    // ⚠ AND ITS SURFACE PROBLEM WAS NOT ITS OWN. One instance is PINNED into
    // every rackspace and is canvas-hidden, so the 🎧 topbar panel is its only
    // surface — and that panel never called `dockRailRendersFace`. Fixed first,
    // in its own PR, because it moves `audioIn` too.
    //
    // ⚠ NO `why` FIELD — the type refuses one on `generic-face`, which is the
    // rule enforced by `tsc` rather than by a test.
    disposition: 'generic-face',
  },
  // ⚠ MOVED HERE FROM `bespoke-surface` (2026-08-31), AND TWO OF ITS THREE
  // CLAUSES WERE FACTUALLY FALSE. The old `why` read: "a GAME: the card claims
  // the keyboard while focused and its body is the viewport. The knobs are
  // incidental; the interaction is play, which no ranked cell list expresses."
  //
  //   * "the card claims the keyboard while focused" — TRUE, and it is the one
  //     affordance that needed real work to move. It is carried, hand-written,
  //     by the face's `fullViewBody` (no other shipped body in the tree installs
  //     a capture-phase keyboard host).
  //   * "its body is the viewport" — FALSE. `BloodCard.svelte` has NO `<canvas>`
  //     anywhere in its ~380 lines. That sentence describes DoomCard, whose card
  //     really does mount the viewport; blood's picture was only ever visible by
  //     patching `out` into a videoOut. The face ADDS blood's first picture.
  //   * "the knobs" — FALSE as a plural. The card renders exactly ONE knob
  //     (GAIN) and paints NO control for `fillMode` at all, so the face does not
  //     compress this module's controls, it INCREASES them by one.
  //
  // ⚠ WHAT THE ENTRY SHOULD HAVE SAID, AND NOW DOES: the card's real content is
  // the ENGINE BOOT. See the note.
  {
    type: 'blood',
    disposition: 'generic-face',
    note:
      'DONE (2026-08-31). Two ranked params (GAIN, FILL — the second painted by the card NOT AT ' +
      'ALL, so the face adds a control) over a `fullViewBody` carrying everything the card owned. ' +
      '⚠ THE LOAD-BEARING MOVE IS THE ENGINE BOOT, NOT THE KEYBOARD: `BloodCard.svelte` held the ' +
      "TREE'S ONLY `extras.ensureLoaded()` CALL, and blood is in neither half of " +
      'HEADLESS_MOUNT_LANE_TYPES, so promotion with a body that did not boot would have shipped a ' +
      'module dark forever while the def, the registry and every face gate stayed green — the ' +
      'shader compiles and paints its "alive, no signal" field either way. It is extracted to ' +
      '$lib/blood/blood-boot.ts and called by BOTH surfaces, and proved through the face by ' +
      'blood-face-screen.spec.ts plus blood-audio-output.spec.ts, re-pointed off `?shell=legacy` ' +
      'in the same diff. ⚠ ALSO MOVED: the IndexedDB restore, the `multiple + webkitdirectory` ' +
      'folder picker with its resetLoad, the BOOT button, the actionable error prose ' +
      '(BLOOD_REQUIRED_FILES, *.ART/*.DAT, the BLOOD_LINK=1 build command — instructions for a ' +
      'gesture, which a body may carry) and the capture-phase keyboard host on a focusable ' +
      'role="application" frame. ⚠ THE FACE ADDS blood\'s first live picture and its first SCREEN ' +
      'switch. ⚠ ONE RESTING READOUT DELETED: the card\'s "Running — click + use arrows/Ctrl/Space" ' +
      'state line, whose fact moved onto the frame\'s accessible name and a `data-blood-status` ' +
      'attribute. ⚠ WHEN IT BOOTS IS UNCHANGED BY THE PROMOTION — the lane was a placeholder and ' +
      'the card mounted only in the dock, so blood has always started when the dock full view ' +
      'opened, and the body mounts in the same place. ⚠ ZERO ATTEST: `face` and `noUserControl` ' +
      'are both hash-transparent and no `params` field is touched — in particular `fillMode` gets ' +
      'NO `options[]` roster, because two captions on a def inside the WebGL basis would cost a ' +
      'real-GPU re-attest and `discrete 0..1` derives the toggle for free.',
  },
  {
    type: 'cameraInput',
    // ⚠ WAS `bespoke-surface` WITH A `needs-media-controller` BLOCKER. The old
    // record read: "the capture-source snowflake already carved out of the shell
    // swap: the card owns getUserMedia AND the enumerateDevices picker, and
    // #1511 names its device-selection + permission UI as its own surface
    // concern rather than part of the lifecycle move."
    //
    // ⚠ EVERY FACT IN THAT SENTENCE IS STILL TRUE. What changed is that none of
    // them is a BLOCKER, and it is worth being precise about which argument
    // retired which clause, because the same reasoning does NOT transfer to the
    // other members of `DOM_SOURCE_LANE_TYPES`:
    //
    //   * "carved out of the shell swap" — no longer; the carve-out was removed
    //     as part of this promotion (see ./legacy-fallback for the lineage).
    //   * "the card owns getUserMedia" — it still does, and that is the design.
    //     `<HeadlessSourceHost>` keeps the card mounted off-screen, so the
    //     source is never orphaned, and the face never becomes a second owner.
    //   * "the enumerateDevices picker" — rebuilt in the extension body. It can
    //     never be a face cell (a runtime device list is not a `ParamDef` and
    //     not an `options` roster), and the extension slot is exactly the rung
    //     of the ladder for a control the generic cells cannot express.
    //   * "its device-selection + permission UI as its own surface concern" —
    //     the sharpest clause, and the one that took real work rather than a
    //     re-reading. An off-screen host is `pointer-events: none`, so the
    //     card's acquire gesture and recovery text ARE unreachable under the
    //     shell. `$lib/ui/media/camera-status-registry` carries both to the
    //     faceplate without moving ownership of the stream.
    //
    // ⚠ THIS IS NOT #1511 LANDING. The blocker's capability is "node-owned media
    // lifecycle … instead of a mounted <X>Card.svelte", and its probe is
    // `HEADLESS_MOUNT_LANE_TYPES.length === 0` — which is still false, and stays
    // false, because this module's card is exactly what the host keeps alive.
    // What this proves instead is narrower and worth having: a card-owned-source
    // module CAN be faced while that blocker is outstanding, by paying the
    // headless-host tax and rebuilding the card-only affordances. The other
    // eleven waiting on #1511 have not paid either half.
    //
    // ⚠ NO `why` FIELD, AND THAT IS THE TYPE'S DOING RATHER THAN AN OMISSION:
    // `why` exists only on the NON-generic dispositions, because those are the
    // ones that owe an explanation. svelte-check refuses the field outright,
    // which is the rule enforced by `tsc` rather than by a test.
    disposition: 'generic-face',
  },
  {
    type: 'cartesian',
    disposition: 'generic-face',
    // ⚠ THE OLD `why` WAS RIGHT AND IS WORTH QUOTING RATHER THAN JUST DELETING:
    // *"the grid is the module."* This entry read `bespoke-surface` on that
    // basis, and the first attempt at the face tried to overturn it by ranking
    // sixteen pads as forty-eight generic band cells. That is not expressible
    // (see CartesianPadGrid.svelte), so the grid became a PF-14 panel — one
    // picture-you-edit inside the generic face, kria's shape — which is a
    // GENERIC face carrying a bespoke cell, not a bespoke surface. The sentence
    // was correct about the module and wrong only about which rung of the
    // ladder that implies.
    note:
      'the 4×4 pad grid is a PF-14 PANEL (`cart-pitch-{n}` -> CartesianPadGrid), promoted to ' +
      'face.hero.cell so PF-22 keeps it off the lane roster; the five faders are ordinary param ' +
      'cells. First adopter of the #1509 TextEntry primitive.',
  },
  // ⚠ THE OLD `why` WAS TRUE IN ONE CLAUSE OF FOUR, and naming which is the
  // point — the entry was cited as a PRECEDENT by two other modules while three
  // of its four clauses were dead:
  //
  //   TRUE and still true: the live output-port ROSTER is WebMIDI service state
  //   rather than a param, so it is a `fullViewBody` and not a cell (a
  //   `ShellSelectorCell.options` is a pure function of the node).
  //
  //   FALSE (1) "connect gesture" — a shipped `action` cell on five siblings
  //   (midiclock, midiCvBuddy, midiOutBuddy, ptzcam, es9) at the time this was
  //   written, and now on this module too, where it ranks FIRST.
  //   FALSE (2) "channel" — a FIXED 16-entry roster. It is in the body for a
  //   DIFFERENT reason the entry never gave: the channel lives on the device
  //   HANDLE, not the graph, so a cell's node-pure `value` would be stale.
  //   FALSE (3) "the slot list is the interaction" — the 29-entry assignment
  //   roster is STATIC descriptor data, not service state, and the eight slots
  //   ARE real params with real cells.
  //
  // The real constraint was never named: `deviceSlotParams` mints eight
  // identical `0..127 linear` params labelled "slot 1".."slot 8", and what each
  // one DRIVES is per-NODE `node.data.assign` — which a cell caption
  // (`ParamDef.label`, no node input anywhere in the shell) cannot say.
  {
    type: 'chromaconsole',
    disposition: 'generic-face',
    note:
      'face + `fullViewBody`, the midiclock/ptzcam shape with one addition. TWO ranked `action` ' +
      'cells — CONNECT (rank 1: Web MIDI publishes no port until the browser consents, so a ' +
      'fresh spawn is eight knobs that send nothing) and PUSH ALL (rank 2: the pedal is ' +
      '`readBack: none`, so re-sending every slot is the ONLY reconciliation that exists in ' +
      'either direction, and neither gesture has a second surface while the eight slot VALUES ' +
      'have four) — over the eight slot params as ordinary knob cells. The body carries what ' +
      'cannot be a cell: the live output roster (WebMIDI service state), the channel (which ' +
      'lives on the device HANDLE, so a node-pure `ShellSelectorCell.value` would paint a stale ' +
      'number), and the slot BOARD — the eight assignment selects over the 29-entry grouped ' +
      'roster, the NAMES those assignments give eight otherwise-identical params, and the real ' +
      '`Segmented` for a slot assigned to one of the pedal\'s named-range selectors. Two ' +
      'surfaces per slot is the owner-approved shape (owner decisions 2026-08-31 item 7); ' +
      'per-node cell derivation is the alternative that ruling declines as platform work.',
  },
  // ⚠ THE OLD `why` WAS TRUE IN ITS FACTS AND WRONG IN BOTH OF ITS
  // CONCLUSIONS, and it is worth naming which was which.
  //
  // TRUE and still true: the connect gesture and the live bound / no-port /
  // no-reply / camera-absent state ARE WebMIDI service state rather than params.
  // That is exactly why the module gets a `controlFamily` + an extension body
  // instead of five param cells.
  //
  // FALSE (1) — the PRECEDENT. It reasoned "like chromaconsole", pointing at the
  // one binder that was then still unfaced, while every other device binder had
  // already shipped this shape: midiclock, midiCvBuddy, midiLane, midiOutBuddy,
  // launchpadControlLeft, outToLaunch, push2Control, es9, cameraInput and
  // electraControl are all in STRICT_FACES. ptzcam did not inherit
  // chromaconsole's blocker either: chromaconsole's real constraint is that
  // `deviceSlotParams` mints eight identical `slot 1`..`slot 8` params whose
  // meaning is per-NODE `node.data.assign`, and ptzcam has nothing of the kind —
  // its four knobs are ordinary named params. ⚠ AND THE CITATION IS NOW STALE IN
  // THE OTHER DIRECTION TOO: chromaconsole itself is faced (its entry above),
  // with the per-node names on its extension body under the owner's
  // two-surfaces-per-slot ruling, so "the binder that cannot be faced" names no
  // module in this tree.
  //
  // FALSE (2) — "the four trim knobs are the only generic-face material". The
  // CONNECT gesture is a fifth ranked control through the family key-space, and
  // its `testidPrefix` already existed on the legacy card, so no card edit was
  // needed to satisfy module-docs-lint. It ranks FIRST, not fifth.
  // ── TRAILS — SHIPPED 2026-09-02, and the disposition MOVED with it ─────────
  //
  // ⚠ THE ENTRY IS `generic-face` NOW, AND THAT IS A MECHANICAL REQUIREMENT
  // RATHER THAN A RECLASSIFICATION OF THE SURFACE. `migrationDone` is
  // `disposition === 'generic-face' && isFaced`, and the identity leg above
  // asserts the done-set IS `STRICT_FACES` — plus an independent leg reading the
  // DEF ("a module cannot be 'needs a bespoke surface' and ship a curated face
  // at the same time"). So a bespoke surface that SHIPS flips its disposition;
  // leaving it on `bespoke-surface` fails three clauses at once. The build spec
  // for this module predicted the opposite ("the disposition stays
  // `bespoke-surface`; its state flips to done automatically"), which is the
  // face-inventory prose failure mode in its own file: TRUE of an earlier tree,
  // never re-checked. The `note` below is where the bespoke half is recorded.
  {
    type: 'trails',
    disposition: 'generic-face',
    note:
      'a MIDI DEVICE BINDER whose second surface is a PICTURE. Two of the three things this '
      + 'module offers are outside the generic-face vocabulary: the CONNECT gesture and the '
      + 'bound / no-port / denied / prompt-suppressed status are WebMIDI service state rather '
      + 'than params (the chromaconsole + ptzcam argument), and the pad mirror is a READ-ONLY '
      + 'view of the physical panel — the 85x85mm pad as four coloured dots with fading trails, '
      + 'plus the 10x85mm touch bar drawn inert because the device transmits no value for it, '
      + 'all painted from transient decode state. It is deliberately NOT an `xyPads` cell: a '
      + 'declared pad names the two params its axes DRIVE, and these axes drive nothing, they '
      + 'report. A third non-param surface has since joined them: MON, a live readout of the raw '
      + 'MIDI the device is sending INCLUDING the messages this module does not recognise, which '
      + 'is the only affordance that can correct the wire constants against real hardware. '
      // ⚠ THE CLAUSE THAT STOPPED BEING TRUE, corrected rather than left standing.
      // It read: "Three knobs are the only generic-face material, and a face that
      // ranked those would move the knobs to the lane and leave behind every one
      // of the things that make the module usable." Both halves were accurate
      // about a face with THREE ranked keys and no bodies; neither survives the
      // shipped surface, and this entry is one of the seven the face-inventory
      // prose audit found had been TRUE-when-written and never re-checked.
      + 'SHIPPED 2026-09-02 as `face` + BOTH body slots. The three knobs are NOT the only '
      + 'ranked material: CONNECT reaches face.order through the family key-space and ranks '
      + 'FIRST, so on a glyph-less compact tile (cap 3) the lane paints CONNECT, RANGE and '
      + 'SMOOTH, and the grant no longer requires finding the dock. Nothing is left behind '
      + 'either — the pad mirror is ONE component mounted by the `fullViewBody` at the card\'s '
      + 'own 140px and by the `tileBody` at 40px, so the picture is on the lane tile too; the '
      + 'bound sentence moved onto StatusLed.detail (aria-label + title) while the four fault '
      + 'sentences survive as painted role="alert" text; and MON, its reset, the counters ratio '
      + 'and the selectable `<pre>` summary are dock-only by MEASUREMENT — the lane body budget '
      + 'is LANE_BODY_H(112) − LANE_KNOB_READOUT_H(57) − 4 ≈ 51px (both range and divisor '
      + 'declare `options`, so the compact row earns a readout) and the panel alone is taller '
      + 'than that. The parity leftover set is EMPTY: all ten card testids and every non-testid '
      + 'affordance have a home, the module still makes NO node.data writes, and `?shell=legacy` '
      + 'still renders the verbatim card, so the three DOM-asserting legs in trails.spec.ts are '
      + 'unchanged rather than re-pointed.',
  },
  {
    type: 'ptzcam',
    disposition: 'generic-face',
    note:
      'face + `fullViewBody`, the midiclock shape. CONNECT is a ranked `action` cell (an action ' +
      'cell is not dock-restricted, so it reaches the lane tile inside the glyph-less compact cap ' +
      'of 3) and ranks FIRST, because the module is inert twice over before it — Web MIDI ' +
      'publishes no port until the browser consents, and the native PT-PTZ helper is what ' +
      'publishes the virtual camera pair at all. The body carries the three things that cannot be ' +
      'cells: the live `PT-PTZ-*` roster (read off the app\'s sysex MIDI access, so a ' +
      '`ShellSelectorCell.options` — a pure fn of the node — would be stale across the async ' +
      'grant), the nine-kind LINK state, and the per-axis abs/velocity mode the CAMERA reports in ' +
      'the caps handshake. The mode line is the one deleted readout: three lamps lit on VELOCITY, ' +
      'rendered only inside `{#if caps}` so pre-handshake "unknown" is the indicator\'s ABSENCE ' +
      'rather than three dark lamps identical to a bound all-absolute camera. `glyph: \'none\'` is ' +
      'forced (`outputs: []`). The send loop is in the factory on the scheduler tick and has ' +
      'always run with no surface mounted, so promotion moves no producer.',
  },
  {
    // ⚠ THE OLD `why` WAS TRUE AS DESCRIPTION AND CIRCULAR AS AN ARGUMENT — the
    // eleventh consecutive face where that has been the case. It read: "the
    // CLIP LAUNCHER: a scene/track grid of pads with per-cell arm, capture,
    // quantised launch and automation state. It is already carved out of the
    // shell swap (NON_SHELL_LANE_TYPES) and is the canonical bespoke surface
    // the extension seam was built for (#1512, now shipped)." The first
    // sentence is an accurate inventory of what the card does. The second is
    // the module citing its own carve-out as the reason for its carve-out, and
    // it was written when the extension seam had one slot; `tileBody` (#2242)
    // and PF-22's hero-rank fix both landed afterwards and are what made the
    // faceplate reachable.
    type: 'clipplayer',
    disposition: 'generic-face',
    note:
      'PROMOTED — the LAST module card to leave NON_SHELL_LANE_TYPES, which now holds only ' +
      'organizational chrome and a roaming sprite. SIX PF-14 PANEL CELLS carry the instrument: ' +
      'the 8x8 LAUNCH GRID, the PIANO ROLL, and four EIGHT-WIDE rows (mono/poly, clock rate, ' +
      'automation arm, scene repeats) that paint all eight lanes at once because comparing the ' +
      'eight lanes is what a launcher is looked at for. ⚠ IT IS A TAB-RAILED FACE WITH NO ' +
      '`face.hero`, on the owner\'s 2026-09-04 P0. This note used to say the grid ranked first ' +
      '"through `face.hero.cell`, the kria route"; that shipped and was rejected — "we do NOT ' +
      'want the clip viewer always visible. we want to see it when we double click on a grid ' +
      'cell, at which point, we do not see the grid. this needs to work exactly the way the ' +
      'legacy card did". The launcher and the piano roll are the card\'s two mutually exclusive ' +
      '`cardView` branches; band hiding (`face.tabbed`) is the only mechanism that reproduces ' +
      'them, and a hero is painted ABOVE every tab panel and therefore cannot be hidden. So the ' +
      'grid is an ordinary panel ranked EIGHTH — past the six-cell plate, which is what a panel ' +
      'needs once no hero promotion excuses it — on the `session` page, and `session` is ' +
      '`pages[0]` and therefore the default view. Double-clicking a pad selects the clip AND ' +
      'opens the editor page, through the node-keyed `face-tab-request` seam. The transport, ' +
      'both recorders, the ' +
      'clip-undo stack, the per-lane mute/stop deck, the monome bind, the arranger pop-out and ' +
      'the automation lamps are a `control-grid` fullViewBody; a `tileBody` gives the 192px lane ' +
      'tile a strip of the eight lanes\' live state plus a panic STOP, which is the per-node ' +
      'glance a shell glyph structurally cannot give (ShellExtensionGlyphProps carries no ' +
      'nodeId). Lane-tier change per owner ruling 2026-08-31, owner-decisions item 10, alongside ' +
      'controlSurface; the owner previews the COMPACT tier before merge. FOUR CONTROL FAMILIES ' +
      'ARE DELETED (a contract change): auto-assigned, auto-cap and auto-override are pure or ' +
      'conditional READOUTS with no gesture a faces-parity probe could drive on a fresh node, and ' +
      'clear-auto renders only inside the editor on a clip that carries automation — all four ' +
      'still paint, three as StatusLed lamps in the body and CLR AUTO as a button in the note ' +
      'panel, but none is a CELL, because a family no probe can reach is a cell nothing can ' +
      'prove is alive. `clipplayer-scene-repeat` survived that cut only because its doc prose was ' +
      're-read against the card: it still described a "read-only" flair set on a Launchpad, and ' +
      'the card has carried a click-to-cycle gesture long enough to say so in its own comment. ' +
      'The right-click clip menu is EXTRACTED to one shared component all three surfaces render ' +
      '— the card\'s own comment records that two copies of it is how a restructure once landed ' +
      'on one surface with every test green. The ONE ongoing behaviour the card owned needed no ' +
      'move: `pruneAllAutoAssignDangling` already sweeps every clip player from the Canvas ' +
      'graph-change seam, expressly so an assignment is dropped with no card mounted.',
  },
  {
    type: 'clockedRunner',
    disposition: 'generic-face',
    note:
      'PROMOTED, with LIVECODE, as the CODE-BUFFER pair. Every clause of the `why` was TRUE and ' +
      'the conclusion drawn from them was wrong — the tenth consecutive face where that has been ' +
      'the case. "Text editing has no cell kind" is exactly right: `resolveFaceControl` resolves ' +
      'a key to a param, a `<id>-{n}` family or a legend static, and a document is none of the ' +
      'three. That is what a `fullViewBody` is FOR, which electraControl established one wave ' +
      'earlier by putting thirty-six unaddressable rename fields there. "No glyph" is right too, ' +
      'and it is a DECLARATION rather than a gap: `outputs` is empty, so every live-audio binding ' +
      "short-circuits and `glyph: 'none'` is the only literal that is not a dead static. What the " +
      '`why` did not mention is the one affordance that IS cell-shaped — the DIVISION, a nine-entry ' +
      '`node.data` roster the card already renders as a `<select>`, now a ranked `selector` cell ' +
      'that reaches the lane tile. The RESIZE GRIP is deliberately not carried over: it writes ' +
      'node.data.width/height, which size the CARD, and a dock plate is sized by its pane (the ' +
      'videoOut ruling). The card keeps it under `?shell=legacy`, and the width is still READ by ' +
      "LIVECODE's spawn geometry. ⚠ AND THIS MODULE IS THE PAIR'S CONTROL CASE for the ES-9 " +
      'card-only-side-effect question: its tick loop is `clock.subscribe(tick)` inside the ' +
      'FACTORY, so it evaluates with no card, no faceplate and no lane tile mounted anywhere. Its ' +
      'card only ever POLLED it. Its parent answers the same question oppositely.',
  },
  {
    type: 'controlSurface',
    disposition: 'generic-face',
    // ⚠ WAS `bespoke-surface`. The old `why` read: "a free-form CONTROL
    // SURFACE: knob boxes dragged into place per source module, renameable in
    // situ. Its content is other modules parameters, so it has no params of its
    // own to rank." The first sentence is true and is what the fullViewBody
    // carries. The second sentence's CONCLUSION was false: the LOCK toggle
    // (`node.data.locked`) is one node-data-backed control of the module's OWN,
    // and matrixMix/electraControl had already refuted the zero-rankable
    // framing — a `controlFamilies` entry over node.data ranks fine.
    note:
      'PROMOTED — the FIFTH meta-domain face, and the second-to-last module to leave ' +
      'NON_SHELL_LANE_TYPES (clipplayer, the last one, followed with its own face). ONE ranked ' +
      'TOGGLE ' +
      'cell — LOCK, over ' +
      'node.data.locked through the same setSurfaceLocked mutator the card calls — because every ' +
      'other affordance proxies a param on a DIFFERENT node, which no face key can address at any ' +
      'rank (the electraControl addressability argument). The board — group boxes, proxied knobs, ' +
      'passthrough colour stripes, per-knob rename, drag layout, empty-state prompt — is a ' +
      '`control-grid` fullViewBody; a `tileBody` adds the lane strip of live bound-source colours ' +
      'AND carries the AUTO-PRUNE effect, whose only production caller was the card\'s $effect ' +
      '(controlSurface is in neither half of HEADLESS_MOUNT_LANE_TYPES, so a body-only promotion ' +
      'would have stopped it silently — the ES-9 card-only-side-effect shape). ' +
      '⚠ THIS IS A LANE-TIER CHANGE, OWNER-APPROVED 2026-08-31 (owner-decisions item 10): the ' +
      'free-growing 360–760 px inline panel becomes a 192×180 tile plus one Expand click, on the ' +
      'electraControl / semantic-zoom precedent — the refusal this entry used to justify was ' +
      'measured BEFORE `tileBody` existed (#2242). A USER-DOCKED node\'s rail occupant still ' +
      'mounts the verbatim card (dockRailRendersFace requires `pinned`), where it stays ' +
      'DYNAMIC_SIZED. ⚠ EVERY PROXIED KNOB IN THE BODY PASSES AN EXPLICIT testid — Knob.svelte ' +
      'emits control-<paramId> whenever the MIDI-learn key is passed, and faces-parity asserts ' +
      'exact multiset equality against params: [] — and for the same reason the body does NOT ' +
      'reuse the card\'s control-surface-* testid vocabulary (every one of those matches the ' +
      'sweep\'s ^control- scan); its namespace is cs-board-*. ⚠ ZERO RESTING READOUTS DELETED: ' +
      'the card painted no derived value outside a control (the lock caption is a control\'s own ' +
      'label), so the promotion deletes none.',
  },
  {
    type: 'doom',
    disposition: 'generic-face',
    note:
      'PROMOTED 2026-09-02 under a SPECIFIC owner authorisation; the standing "never touch DOOM ' +
      'without approval" ruling is SATISFIED for this change, not overturned. The old `why` read: ' +
      '"a GAME: a WAD-driven viewport with keyboard capture. Its params are CV taps off the ' +
      'running game, not the interaction — the interaction is play." ' +
      '⚠ THE FIRST HALF WAS EXACTLY RIGHT, and it is why the promotion is shaped the way it is: ' +
      'the interaction IS play, so the play surface moved WHOLE into ' +
      '$lib/ui/modules/doom/DoomSurface.svelte, which the legacy card and the faceplate body BOTH ' +
      'mount — one screen, one keyboard map, one node-owned session adoption, no second ' +
      'implementation to drift. ' +
      '⚠ THE SECOND HALF IS WHAT MADE THIS READ AS UN-FACEABLE, AND IT MEASURED THE WRONG THING. ' +
      'The 38 `cv_*` params are not controls that resist ranking; they are targets written by ' +
      'their own jacks, and `noUserControl` is the field that says so (each is anchored to the ' +
      'port whose `paramTarget` names it, so the claim is checked rather than asserted). With ' +
      'those declared the plate ranks exactly TWO controls — `audioGain` and `fillMode`, the same ' +
      'two the card drew as its Volume knob and OUTPUT FIT toggle — which is a small face, not an ' +
      'impossible one. ' +
      '⚠ THE LOAD-BEARING FACT, recorded because it is what a reviewer must check rather than ' +
      'infer: promotion stops the default shell rendering DoomCard.svelte, and this card was the ' +
      "module's RUNTIME OWNER — `nodeDoomSession.adopt` (the pump that feeds the lockstep " +
      'barrier), the awareness/nodes/edges observers, the capture-phase keyboard listeners, the ' +
      'framebuffer blit and the `__doomCards` hook every DOOM spec reads. A face that carried only ' +
      'CONTROLS would have shipped a promoted DOOM that is a black tile with no game and no ' +
      'netgame, while this inventory, faces-parity and every def-reading gate stayed green. ' +
      '⚠ ONE RESTING READOUT DELETED, DELIBERATELY: the card paints a derived identity sentence ' +
      '("Player 2 — alice (you)") and a session footer ("2 rack-mates · host: remote · player 2") ' +
      'beside the screen. The face keeps the short BADGE and moves both sentences to the ' +
      "surface's accessible name (the GAMES.md §1.1 remedy), so no assertion was weakened and no " +
      'affordance was lost. The legacy card still paints both. ' +
      '⚠ NO VRT SCENES: `runtime.runTic()` runs inside `surface.draw`, so DOOM\'s game clock IS ' +
      'its frame clock. It holds a named FACES_WITHOUT_SCENES exemption whose argument is ' +
      "RE-DERIVED at the source for the face scenes rather than inherited from the card's " +
      'EXEMPT_FROM_VRT entry, which stays standing because the promotion changed nothing about ' +
      'the engine.',
  },
  {
    type: 'electraControl',
    disposition: 'generic-face',
    note:
      'PROMOTED — the FOURTH meta-domain face, and the LAST module to leave NON_SHELL_LANE_TYPES. ' +
      '⚠ TWO CLAUSES OF THE OLD `why` WERE FALSE, and they are retired here BY CONSTRUCTION since ' +
      'a promoted module carries a `note` rather than a `why`. It said slots are what other ' +
      'modules params "are dropped into": there is NO drag-and-drop anywhere near this module and ' +
      'NO affordance on the board at all — assignment is a three-level cascade on the SOURCE ' +
      'control\'s context menu, and an empty cell cannot solicit one, which is a real UX gap the ' +
      'promotion does not close. And it said "the matrix is the interaction": the matrix is the ' +
      'LAYOUT, and the interaction that makes the module DO anything is SEND TO ELECTRA, which is ' +
      'the only gesture here that leaves the browser. Same stale-`why` class as recorderbox, ' +
      'launchpadControlLeft, gamepad and push2Control. What was right and is kept: a fixed 6×6 ' +
      'row/knob matrix, renameable in place, with no params of its own. ' +
      'ONE ranked ACTION cell — SEND TO ELECTRA — and it is the one ranked cell because it is the ' +
      'only ADDRESSABLE one, not because the others lost a ranking argument: every other control ' +
      'proxies a param on a DIFFERENT node, and a face key resolves only to a param on THIS def, ' +
      'a `<familyId>-{n}` template (ONE cell, no per-member index), or a legend static — so ' +
      'thirty-six proxies and thirty-six rename fields are unaddressable at any rank. They are a ' +
      '`control-grid` fullViewBody, which reaches the workflow DRAWER because ' +
      'dockFullViewHeadPlan gates it on isFaceplateView(view) = view !== \'lane\'. ' +
      '⚠ THE STOP-1 ANSWER IS UNLIKE ITS SIBLINGS\': gamepad, push2Control and ' +
      'launchpadControlLeft each rendered `placeholder` already and argued "no tier to lose". ' +
      'This one rendered `legacy`, so it HAD a tier. It is still a gain, because the module\'s ' +
      'design home is not a lane tile: it is the `E` of the M/E/C pin trio with surface `drawer`, ' +
      'canvas-hidden, so its always-on instance has no lane tile and its drawer gains the face. ' +
      'The residual is a second, user-spawned canvas instance whose board moves one click into ' +
      'the dock full view — the ordinary semantic-zoom contract, with no affordance lost.',
  },
  {
    type: 'es9',
    disposition: 'generic-face',
    note:
      'PROMOTED, and the `why` was wrong in FOUR of its five clauses — each in the same way, and ' +
      'the way is instructive: it named READOUTS as if they were surface. It read "the ES-9 ' +
      'BRIDGE: connection state machine, connect/disconnect gestures, device rate and ' +
      'channel-count detail, xrun/rtt telemetry, and sectioned routing across many jacks. The ' +
      'params are routing, the surface is the bridge." Measured against the card: the ' +
      '"connection state machine" is `stateLabel`, a seven-way string switch painted as one ' +
      '<span> — a STATE WORD outside every control, which is the shape the resting-text ruling ' +
      'deletes; "device rate and channel-count detail" is three derived numbers; "xrun/rtt ' +
      'telemetry" is a count and a measurement with a decimal. All three are `StatusLed` lamps ' +
      'now, with their sentences on `aria-label`. "Sectioned routing across many jacks" is ' +
      'twenty-two ordinary `ParamDef`s already in contract-lock plus a PatchPanel, which on a ' +
      'face is the REAR CARD rather than the plate. Only "connect/disconnect gestures" survived ' +
      'contact, and two gestures are two `action` cells — the midiclock precedent, with the ' +
      'difference that this module waits on a PROCESS (the es9-bridge companion app) rather ' +
      'than on a browser permission, so there is no prompt and no device roster: `maxInstances` ' +
      'is 1 and the app accepts one client. What is left that a generic face cannot do is ' +
      'exactly the lamps, since `StatusLed` renders only from a module-owned `fullViewBody` — a ' +
      'shipped `status-primitive` body of the same shape midiclock and cvBuddy already carry. ' +
      'So this needed strictly LESS bespoke machinery than `kria`, which was re-dispositioned ' +
      'while still needing a real PF-14 panel component.',
  },
  {
    type: 'gibribbon',
    disposition: 'generic-face',
    note:
      'PROMOTED AS PART OF THE OWNER-RULED FULL REWRITE (face-specs/gibribbon.html rev 3): the ' +
      'module never really worked — its playability was an analog calibration smeared across ' +
      "synesthesia's DSP (#624/#698/#701), its only shipped play experience was deleted (#1421/" +
      '#2183), and its autoplay fallback played itself (#626). The rewrite makes the course a ' +
      'DERIVED, ADAPTIVE function of the incoming signal (relative-prominence extraction, rank ' +
      'competition), runs on ONE scheduler-tick clock (the #635 class unrepresentable), and ' +
      'replaces autoplay with an honestly-labelled in-canvas ATTRACT mode. The old `why` said ' +
      '"score / health / combo HUD over a viewport" — that DOM HUD was the GAMES.md ' +
      'forbidden-chrome shape and is deleted: the HUD is painted INTO the frame by the ' +
      "module's own rasteriser, the speakable copy rides aria-label on the playfield, and the " +
      'face is three ranked controls (difficulty / tempo / attract) + a fullViewBody game ' +
      'screen. The lane tile takes the free video-domain VideoTileThumb — the LIVE GAME — ' +
      'where the un-migrated module showed a bare placeholder. ⚠ AUDIO REDIRECT 2026-08-29 ' +
      '(owner, on playing the build): the CV-era event inputs were replaced with ONE ' +
      'audio_in — the module analyses the signal itself (own AnalyserNode, musical band ' +
      'fold, spectral-flux onsets) and the extractor consumes bands, which is what the ' +
      'original game actually does ("generates obstacles based on interesting frequency ' +
      'changes"). The id surgery was clean (unmerged PR, never-worked module): cv1..cv4 / ' +
      'clock / gate are gone, 7 noUserControl CV targets remain (aim, buttons, restart).',
  },
  {
    type: 'kria',
    disposition: 'generic-face',
    note:
      'PROMOTED. The step grid IS the module, and it was the reason this entry read ' +
      "'bespoke-surface' — but it fits a PF-14 PANEL (one picture-you-edit) rather than needing a " +
      'shell extension, and PF-22 lets that panel rank FIRST as the dock hero instead of being ' +
      'pushed to a rank this module has too few keys to reach. Everything else — loop, time, ' +
      'direction, mute, scale, root — is a generic selector or toggle over a roster the def ' +
      'already declared. Nothing here is bespoke except the grid picture itself.',
  },
  {
    type: 'launchpadControlLeft',
    disposition: 'generic-face',
    note:
      'PROMOTED, and it is the SECOND META-DOMAIN FACE. ⚠ THIS ENTRY USED TO SAY "an 8×8 pad ' +
      'matrix bound to a hardware surface … the pad map is the interaction", AND THERE IS NO 8×8 ' +
      'GRID ANYWHERE IN THE APP. The matrix is on the HARDWARE. Since the LEFT + RIGHT cards were ' +
      'consolidated into one, LaunchpadControlCard.svelte renders a title, four buttons, a status ' +
      'line and a docs hint — no canvas, no pad matrix, and not even the colour legend a sibling ' +
      'artifact credited it with (that moved to LaunchpadDocs.svelte). Three shipped artifacts ' +
      'described that surface and all three predated the consolidation; this is the recorderbox ' +
      'stale-`why` class arriving from the other direction, and it is retired here BY ' +
      'CONSTRUCTION, since a promoted module must carry a `note` rather than a `why`. What the ' +
      'module actually is: a DEVICE BINDER with four gestures and zero params. Two of them — ' +
      'SINGLE and PAIR — are ranked action cells that reach the lane tile; BIND and the ' +
      'four-role view segment are in a `fullViewBody` extension, because ShellActionCell.label is ' +
      'a plain string (so a cell cannot flip between Bind and Unbind) and a selector whose roster ' +
      'is empty in pair mode is the same defect one kind over. ⚠ AND THE PROMOTION IS A ' +
      'DELETION: this was the only queued module carved out of NON_SHELL_LANE_TYPES, which ' +
      'short-circuits laneRenderKind BEFORE `migrated` is read, so the carve-out entry had to go ' +
      'in the same commit or the face would have been unreachable in the lane.',
  },
  {
    type: 'livecode',
    disposition: 'generic-face',
    note:
      'PROMOTED, with the CLOCKED RUNNER it spawns, as the CODE-BUFFER pair. "The card body is ' +
      'the code buffer" is TRUE and is why this needs a `fullViewBody` rather than a ranking. ' +
      '"Nothing a ranked cell list can carry" was simply FALSE: RUN is an ordinary `action` cell ' +
      'over a gesture the card already had at `data-testid="livecode-run"`, and an action cell is ' +
      'not dock-restricted, so it now reaches the LANE TILE — one click from the rack, where ' +
      'before promotion running a script meant first discovering the dock full view. "Its ' +
      'evaluation status" is the half the rulings deleted: a resting instruction, a mutation ' +
      'COUNT and an error sentence, all painted outside any control, now a StatusLed whose ' +
      'sentence reaches aria-label and title only. ⚠ THE FINDING THIS PROMOTION TURNED UP is not ' +
      'in the `why` at all, and it is the one worth carrying forward: `livecodeDef.factory` ' +
      'returns a NO-OP handle, so `runScript()` on the card was LITERALLY everything the module ' +
      'did — and `migrated(type)` stops both surfaces rendering a promoted module\'s card. ' +
      'Promoting without moving the evaluation would have shipped a module that cannot do ' +
      'anything, with every def-reading gate green because the def has nothing to read. It now ' +
      'lives in `$lib/ui/modules/livecode-cell-actions.ts`, called by the ranked cell, the ' +
      'faceplate body and the legacy card. The run OUTCOME moved from component `$state` onto ' +
      '`node.data.lastRun` in the same change, which fixes a live #1531-class loss: collapsing ' +
      'the pane used to discard the log and the error you were reading.',
  },
  {
    type: 'mappy',
    disposition: 'generic-face',
    note:
      'PROMOTED. The old entry read "quad corners dragged on a canvas, with mapping ' +
      'import/export — direct geometry manipulation is the entire module". The first half is ' +
      'TRUE and is precisely what a `fullViewBody` is for; the CONCLUSION is false, and it had ' +
      'already propagated into a gate — `dock-tray-shrink-to-content.spec.ts` quoted this entry ' +
      'to pin mappy\'s un-migrated status as a DURABLE PROPERTY rather than a queue position ' +
      '(that spec now asks for the un-migrated RENDER PATH through the #2299 forced-placeholder ' +
      'seam, so it depends on no module\'s disposition at all). mappy declares TWO real params ' +
      'the card paints as controls: a GRID override button and a +/- surface counter. They rank ' +
      'as a Toggle and a six-state roster, with the venue MAP\'s import/export as two ranked ' +
      'control families beside them. ' +
      'The body carries what is genuinely gesture-shaped: the composite preview with its ' +
      'corner-pin overlay, the whole-surface move drag, surface focus, the six INDEPENDENT ' +
      'per-surface FIT/CROP and RESET pairs (a controlFamilies template is ONE cell with no ' +
      'per-member index, so they cannot be cells), the MAP button that opens the full-window ' +
      'editor, the export outcome\'s status line (the shell paints one for a FILE cell and not ' +
      'for an ACTION cell), the empty-state hint, and the module\'s first SCREEN switch. ' +
      '⚠ It also hand-carries the card\'s `ydoc.getMap("edges").observeDeep` bridge, which lives ' +
      'in none of the three shared mappy seams: without it `live[]`, the hit-test roster and the ' +
      'editor\'s `connected` prop never see a cable patched while the pane is open. ' +
      '⚠ THE PROMOTION\'S REAL COST WAS AN INERT-CONTROL TRAP: the factory PREFERRED a ' +
      '`node.data` mirror over the param for both controls while every shell cell writes the ' +
      'param alone, so on any node a card or a `?shell=legacy` collaborator had touched the ' +
      'faceplate would have been dead with every def-reading gate green. The mirror is gone in ' +
      'both directions. And both params moved `curve: linear` -> `discrete` (a FUNCTIONAL fix, ' +
      'the frametable precedent: a two-state override was going to paint a 200 px continuous ' +
      'drag), which is a contract re-pin and the program\'s one real-GPU re-attest.',
  },
  {
    type: 'matrixMix',
    disposition: 'generic-face',
    note:
      'PROMOTED, and it is the FIRST META-DOMAIN FACE. This entry read bespoke-surface on two ' +
      'grounds, and only one of them survived. "The grid is the interaction" is TRUE and is why ' +
      'the cross-point field is a `fullViewBody` shell extension rather than a PF-14 panel (a ' +
      "panel's minWidth is a required number, and this grid is 4 columns or 40 depending on two " +
      'OTHER modules — any number there would be a fiction in a required field). "It has no ' +
      'params of its own" is TRUE and turned out not to imply anything: the two AXIS PICKERS are ' +
      'real ranked cells, because a ShellSelectorCell roster is a FUNCTION over the live graph, ' +
      'not a fixed list. That is what a zero-param face looks like — order: [] would have been ' +
      'legal and would have painted a blank tile, which is worse than the placeholder it ' +
      'replaces. The real blocker was neither: MetaModuleDef had no `face` field and no ' +
      '`controlFamilies` field, so no meta module could rank any control at all.',
  },
  {
    type: 'midiCvBuddy',
    disposition: 'generic-face',
    note:
      'PROMOTED. The `why` was right about the SHAPE, wrong about the CONCLUSION, and wrong ' +
      'about the CONTROLS — it read: "a MIDI DEVICE BINDER: permission gesture, live ' +
      'input-device roster, channel and mode selection. It declares no params at all — the ' +
      'rosters are WebMIDI service state." ⚠ THERE IS NO MODE ON THIS MODULE. `mode` is ' +
      'midiLane\'s MONO/POLY switch; this one is monophonic by construction and has no such ' +
      'setting. The two controls the `why` omitted entirely are VOICE PRIORITY and RETRIGGER, ' +
      'which are half of everything the card offers. "No params" turned out to imply nothing: a ' +
      '`ShellSelectorCell` reads and writes `node.data` through closures, so four controls rank ' +
      'without the module declaring a single ParamDef. "Permission gesture" is a ranked `action` ' +
      'cell, the midiclock precedent. Only the LIVE DEVICE ROSTER genuinely cannot be a cell — a ' +
      'roster is a fixed set known when the def is authored and this one lives behind ' +
      '`requestMIDIAccess()` — so it is a `fullViewBody` extension, exactly as on midiclock and ' +
      'midiLane. ⚠ AND THE PROMOTION FOUND A LIVE DEFECT THE `why` COULD NOT HAVE: the card ' +
      'wrote its MIDI channel filter into `node.data.channel`, which `channel-columns.ts` ' +
      'declares to be workflow COLUMN MEMBERSHIP TRUTH, so picking a channel ejected the module ' +
      'from its lane or teleported it into another\'s — and the factory read the same key back, ' +
      'so dropping a fresh module into channel column 5 made it listen to MIDI channel 6 only, ' +
      'with no user action at all. That is #1168, fixed on the OUTPUT sibling in 2026-08 and ' +
      'never checked here. The filter is now `midiInChannel`.',
  },
  {
    type: 'midiLane',
    disposition: 'generic-face',
    note:
      'PROMOTED. The `why` was accurate about the SHAPE and wrong about the CONCLUSION, and the ' +
      'part that turned is the typed field. "The one numeric field is typed entry" was the reason ' +
      'this sat in bespoke-surface, and #1509 shipped `ShellEntryCell` — so the field is now a ' +
      'ranked `entry` cell and midiLane is that cell type\'s FIRST adopter (it had a render ' +
      'branch, a primitive, a probe contract and no registered instance). "Permission gesture" is ' +
      'a ranked `action` cell, the midiclock precedent. "Channel/mode selection" is two ' +
      '`ShellSelectorCell`s, and "no params" turned out to imply nothing: a selector cell reads ' +
      'and writes `node.data` through closures, so ten controls rank without the module ' +
      'declaring a single ParamDef. Only the LIVE DEVICE ROSTER genuinely cannot be a cell — a ' +
      'roster is a fixed set known when the def is authored and this one lives behind ' +
      '`requestMIDIAccess()` — so it is a `fullViewBody` extension, exactly as on midiclock.',
  },
  {
    type: 'midiOutBuddy',
    disposition: 'generic-face',
    note:
      'PROMOTED. The `why` read: "a MIDI OUTPUT BINDER: permission gesture plus live output-port ' +
      'and channel rosters, with no params of its own to rank." Every clause is accurate and the ' +
      'conclusion drawn from them was still wrong, in the way this file keeps recording: ' +
      '"permission gesture" is a ranked `action` cell (the midiclock precedent), "channel roster" ' +
      'is a FIXED sixteen-entry list known when the def is authored and therefore an ordinary ' +
      '`ShellSelectorCell`, and "no params to rank" implies nothing because a selector cell reads ' +
      'and writes `node.data` through closures. ⚠ ONLY THE OUTPUT-PORT ROSTER IS ACTUALLY ' +
      'SERVICE STATE — the `why` bracketed it with the channel roster as if the two were the ' +
      'same kind of thing, and they are not: one lives behind `requestMIDIAccess()` and differs ' +
      'per machine, the other is the MIDI specification. That single genuine blocker is a ' +
      '`fullViewBody` extension. ⚠ AND THE `why` OMITTED THE AFFORDANCE THAT ACTUALLY NEEDED ' +
      'THOUGHT: the CH-vs-LANE divergence warning, which the card carried as a violet outline ' +
      'plus a badge and which is derived state a faceplate may not paint in either form. It is ' +
      'the LANE lamp, `tone="warn"`, with the badge\'s own sentence as its detail.',
  },
  {
    type: 'midiclock',
    disposition: 'generic-face',
    note:
      'DONE: two ranked cells (the clock DIVISION as a segmented param, CONNECT MIDI as an action ' +
      'cell that reaches the lane) plus a `fullViewBody` carrying the one thing that cannot be a ' +
      'cell — the runtime MIDI input roster, which lives on the engine handle behind ' +
      '`requestMIDIAccess()` and differs per machine. ⚠ THIS ENTRY USED TO SAY "clock divisor and ' +
      'a running TEMPO READOUT. No params", and BOTH halves were wrong. No tempo is computed ' +
      'anywhere in the module — nothing derives BPM from the tick stream, and the card showed ' +
      'STATE and TICKS, never a tempo. And the divisor was never un-rankable: its roster ' +
      '(`CLOCK_DIVISORS`), its labels and its validator were all exported from the def already; ' +
      'it simply had not been DECLARED as a param, on the def\'s stated reasoning that a discrete ' +
      'choice is not a continuous AudioParam — true of an AudioParam, and not of a `ParamDef`.',
  },
  // ⚠ MOVED HERE FROM `bespoke-surface` (2026-08-31), AND ITS OLD `why` WAS
  // FALSE ON BOTH CLAUSES — measured against the card rather than re-read. It
  // read "a GAME: a falling-block viewport played on the keyboard, with two
  // faders beside it."
  //
  //   "played on the keyboard" — `ModtrisCard.svelte` registers NO key handler
  //   of any kind, and the def never had one. modtris is driven entirely by five
  //   rising-edge GATE inputs, which is the whole point of the port and is
  //   stated at length in the def's own header. The same sentence was wrong on
  //   `frogger` and on `skifree`; it is a family-resemblance error, not a
  //   measurement.
  //
  //   "with two faders beside it" — the comparison was never face-vs-card.
  //   modtris is not in NON_SHELL_LANE_TYPES, is not a CARD_PRODUCER and is not
  //   in HEADLESS_MOUNT_LANE_TYPES, so the shipping shell already rendered a
  //   BLANK PLACEHOLDER for it while the game ran and pulsed gates underneath.
  //   It was face-vs-grey.
  {
    type: 'modtris',
    disposition: 'generic-face',
    note:
      'DONE. Two ranked params (DROP, LVL) as declared `fader` cells plus the WELL as a ' +
      '`fullViewBody` extension — the `rasterize` / `frogger` shape, an audio-domain module ' +
      'whose picture the shell has no generic route to (`hasVideoSurface` is ' +
      '`domain === "video"`). ⚠ THE PROMOTION ALSO WIRED A DEAD CONTROL: `levelStep` was read ' +
      'by NOTHING — the stepper\'s own type comment said "unused in v1 stepper", and ' +
      '`ModtrisState` carried no `level` field at all — while the docs promised "gravity speeds ' +
      'up each level". A face cannot rank a control it knows is inert, so the ramp ships in the ' +
      'same diff (`level = floor(lines / levelStep)`, seconds-per-drop x 0.85 per level, floored ' +
      'at 50 ms). ⚠ AND IT DISCHARGED THE MODULE\'S VRT EXEMPTION BY JUDGEMENT RATHER THAN BY ' +
      'ITS OWN TERMS: unlike frogger\'s, modtris\' EXEMPT_FROM_VRT entry stated no exit ' +
      'condition, and the seam is strictly harder — frogger has no RNG, so a tick count alone ' +
      'pinned its board, while modtris\' 7-bag Fisher-Yates shuffle needs a SEED ' +
      '(`__modtrisVrtSeed`) as well as a tick budget (`__modtrisVrtTicks`). It left ' +
      'EXEMPT_FROM_VRT and ALLOWED_PERMANENT_EXEMPT in the same commit. ⚠ THE LANE TILE STILL ' +
      'HAS NO WELL and that is not fixed here: both outputs are `gate`, so ' +
      '`primaryAudioOutPortId` is null and every glyph but `none` resolves static, while ' +
      '`ShellExtensionGlyphProps` carries no `nodeId` so a glyph component could not reach the ' +
      'game snapshot even if a kind fitted. ⚠ AND `vizPassthrough: true` REMAINS A LICENCE ' +
      'RATHER THAN A PATH — `GROUP_VIZ_HOST_TYPES` is `new Set(["scope"])` and ' +
      '`group-viz-hosts.test.ts` measures `canvasInSlot 0` for modtris (#1755) — so the ' +
      'user-facing prose promising a GROUP-card portal was deleted from `docs.explanation` ' +
      'instead of being left to describe something the product does not do.',
  },
  {
    type: 'moog956',
    disposition: 'generic-face',
    note:
      'PROMOTED (2026-09-02). ⚠ THE `why` WAS TRUE IN ITS PARTS AND WRONG IN ITS CONCLUSION, ' +
      'the same difference as the eleven promotions before it. "A 1-D touch surface is not a ' +
      'knob" is right; what it could not express is not the POSITION (a 0..1 throw is a FADER, ' +
      'exactly, and `pos` ranks as one) but the ONE-POINTER GESTURE — one stroke writing `pos` ' +
      'AND raising `gate`, sliding with the gate standing, dropping the gate on release while ' +
      'LEAVING the pitch. Two cells reach every value that gesture reaches; what they cannot do ' +
      'is reach them TOGETHER, which is the arity `ModuleFace.xyPads` records one dimension up ' +
      'and which the wired extension seam exists for. So the strip is the module\'s own surface ' +
      'and all four params still rank as ordinary cells beneath it — the joystick shape (owner ' +
      'decision 2026-08-31 item 2) at 1-D. "Scale and offset are params around it" was simply ' +
      'true and is kept. ' +
      '⚠ TWO BODIES, AND THE SECOND ONE IS A PARITY HOLE RATHER THAN A PICTURE: ' +
      '`faceTierCap(\'compact\', \'none\')` is 3, so the compact lane tile paints ' +
      '`pos`/`scale`/`offset` and `gate` — one of the module\'s two OUTPUTS — falls off. The ' +
      '`tileBody` strip restores the whole gesture where the module is normally met (the ' +
      'skifree/audioIn finding); the `fullViewBody` is the same strip at plate width, where the ' +
      'ribbon\'s precision actually exists. ' +
      '⚠ THE CONTRACT MOVED and the move corrects a lie: `gate` was declared `curve: \'linear\'` ' +
      'while the factory has thresholded it at `> 0.5` since the module shipped, which made it ' +
      'invisible to the switch-classification ratchet AND made `face.momentary` refuse it. ' +
      'Neutral by construction, re-pinned through `docs:accept`. The same edit ends a ' +
      'data-integrity bug: a press whose release never arrived used to persist a HIGH gate into ' +
      'the rack and sync it to every peer. ' +
      '⚠ THE DELETED READOUT is the card\'s `{n} st` pitch line (owner-decisions item 11) — the ' +
      'value is the strip\'s `aria-valuetext`, which `role="slider"` genuinely has. The gate LED ' +
      'survives as a colour mark on the wiper. ' +
      '⚠ THE STATED REDUNDANCY (twotracks/joystick): the dock paints the strip AND the four ' +
      'cells over the same params; the cells are the parity-credited controls and the MIDI-learn ' +
      'anchors the hand-rolled card never had, and the strip carries no `control-*` anchor.',
  },
  {
    type: 'nibbles',
    disposition: 'generic-face',
    // ⚠ THE OLD `why` WAS FACTUALLY CORRECT AND STILL DREW THE WRONG
    // CONCLUSION — "a GAME: a snake viewport played on the keyboard; its
    // outputs are taps off the running game." Every clause of that is true; it
    // was the ONE entry in this game group whose `why` was true when written.
    // What it missed is that nibbles declares TWO real params the card paints
    // as a knob and a button, plus one gesture, so a ranked cell list is
    // exactly what its control surface IS — and the viewport and the arrow keys
    // are the `fullViewBody` extension's job, which is the call frogger,
    // modtris and skifree all reached one wave earlier.
    note:
      'DONE. Two ranked params (TICK, AUTO) in ONE band, with the 320x200 game screen, its '
      + 'SCREEN, SCALE and RESET controls and the ARROW KEYS as a `fullViewBody` extension. '
      + '⚠ RESET IS A BODY BUTTON RATHER THAN A RANKED ACTION CELL, on a measurement that '
      + 'overruled the build spec: an action cell needs an AUDITION probe here (reset writes no '
      + 'param and no node.data), and faces-parity spawns every module with NO `domain`, which '
      + '`_helpers.ts` defaults to `audio` — so a VIDEO module\'s factory is never constructed in '
      + 'that sweep and `read(node, "extras")` is undefined. Measured both ways on the default '
      + 'shell: `domain: video` delivers, the sweep\'s spawn does not. The probe moved into '
      + '`face-nibbles.spec.ts`, which presses it on a real constructed module. ⚠ IT IS THE ONLY VIDEO-DOMAIN MODULE IN ITS GAME GROUP, '
      + 'and that is what makes this promotion cheaper than its three siblings\': `laneGlyphFor` '
      + 'returns \'picture\' for `domain === "video"` BEFORE it reads `face.glyph`, so the lane '
      + 'tile gets a LIVE PER-NODE VideoTileThumb for free where the shipping shell painted a '
      + 'blank placeholder — skifree had to author a whole second `tileBody` for the same thing. '
      + '`face.glyph: \'none\'` is therefore MANDATORY rather than a lazy default, and since '
      + '"none + blank tile" and "none + live thumb" are indistinguishable from the declaration, '
      + 'the face-model test asserts `hasVideoSurface` DIRECTLY. ⚠ THE ARROW KEYS ARE THE '
      + 'INSTRUMENT, NOT KEYBOARD-A11Y: `pushDirection` is the module\'s only manual steering, so '
      + 'the body is focusable and takes keydown — but at `tabindex="-1"`, not the card\'s "0", so '
      + 'it is reachable by CLICK and absent from the tab order, and Tab stays the faceplate FLIP '
      + 'gesture. ⚠ THE CARD\'S `LEN {n}` ROW IS DELETED, NOT RELOCATED, and this is the group\'s '
      + 'expensive case: `paintFrame` contains no `fillText`, no glyph table and no font, so '
      + 'unlike frogger and modtris there is no in-canvas HUD to fall back on. The value lives on '
      + 'the screen\'s aria-label; `nibbles.spec.ts` already read it through `eng.read(node, '
      + '"score")` rather than off the DOM, so no assertion was weakened. Restoring a PAINTED '
      + 'score would be a `paintFrame` edit on a file in the WebGL attest basis and is left as a '
      + 'separate priced change. ⚠ ZERO ATTEST, MEASURED BOTH WAYS: all three nibbles sources are '
      + 'in the basis, this PR adds only `face` and edits `docs` (both hash-transparent; the '
      + 'CONTRACT is untouched — no param, no port and no `controlFamilies`) and the hash is '
      + 'byte-identical to main\'s, while a control edit to '
      + 'NIBBLES_MAX_LENGTH moves it. ⚠ AND IT REPAIRS TWO LIVE DEFECTS ON THE CARD TOO, because '
      + 'both surfaces now call ONE gesture seam: the 1x-4x zoom was component `$state` (a dock '
      + 'collapse or an LRU eviction reset it — #1531/#1574/#1583) and AUTO was a ledgered raw '
      + '`params` write that promotion would have made unreachable-without-paying rather than '
      + 'paid; the raw-write-ledger entry is deleted in the same commit.',
  },
  {
    type: 'numpadPlus',
    disposition: 'generic-face',
    note:
      'PROMOTED (2026-08-26). ⚠ THIS ENTRY\'S OWN `why` WAS TRUE IN ITS PARTS AND DREW THE WRONG ' +
      'CONCLUSION, which is now the eleventh consecutive face where that was the difference. ' +
      '"The pad map is the interaction" is exactly right — and so is the step grid, and BOTH fit ' +
      'a PF-14 PANEL (one picture-you-edit) rather than needing a shell extension, which is the ' +
      'call kria made one wave earlier for the identical cohort. "Not a ranked control list" was ' +
      'read as "cannot be faced"; what it actually meant is that the two things a player MAKES ' +
      'live in `node.data` and have no ParamDef, which is the gap the shell-cell registry exists ' +
      'to close. And "an octave nudge" undersold the defect: the card painted the octave as a ' +
      'bare NUMBER between two arrows, so the resting-text ruling deletes it and the states ' +
      'needed NAMES — `c0..c8`, derived from `midiForKey`\'s own arithmetic, which is what makes ' +
      'the octave selectable rather than an anonymous nine-position dial. ' +
      'Nine ranked keys over four bands: the sixteen steps as `face.hero.cell`, the fourteen key ' +
      'caps ranked last (dock-only by arithmetic, not by a rule), and all seven params as ' +
      'ordinary cells. No `face.extension`, no lazy chunk, no platform seam, zero attest. ' +
      '⚠ THE OBVIOUS WORRY WAS FREE AND THE REAL WORK WAS UNDERNEATH. Promotion does not unplug ' +
      'the keypad — the capture listener is in the FACTORY, not on the card, so numpadPlus is in ' +
      'none of the headless-mount sets. What it DID need was a write seam: arming REC and ' +
      'pressing PLAY erased sixteen steps through a bare SyncedStore proxy write that Cmd-Z could ' +
      'not reach, every step edit and remap went through a `ydoc.transact` with NO origin, and ' +
      'one cell click rewrote all four layers. All three are fixed in the promotion PR.',
  },
  {
    type: 'outToLaunch',
    disposition: 'generic-face',
    note:
      'DONE (2026-08-25). The fourth device BINDER faced and the first that is also a VIDEO ' +
      'module. THREE ranked cells — CONNECT LAUNCHPAD, BRIGHT, GAMMA — over a `picture` ' +
      'fullViewBody carrying the live 9x9 monitor, its SCREEN switch, the per-machine port ' +
      'picker, UNBIND and the MONITOR lamp. ' +
      '⚠ THIS ENTRY\'S OWN `why` WAS WRONG IN TWO WAYS AND IS KEPT HERE AS THE CORRECTION. It ' +
      'read: "a Launchpad OUTPUT BINDER: device pick, bind/unbind, and a warning that the bound ' +
      'surface can no longer be used for control. The two knobs are incidental to the binding ' +
      'flow." The binder half was accurate. But (1) "the two knobs are incidental" is a claim ' +
      'about ONE FLOW read as a claim about the module: `bright` and `gamma` are real ParamDefs ' +
      'that the LED pump reads off the live engine handle every frame, so they shape EVERY frame ' +
      'that reaches the hardware, and `gamma`\'s 2.2 default is the picture actually shipping; ' +
      'and (2) it never mentioned the 9x9 PREVIEW at all — the def\'s own docs call it the thing ' +
      'that lets you "dial it in without hardware", and it is the module\'s ONLY surface on a ' +
      'machine with no Launchpad attached. An inventory that leads with "the knobs are ' +
      'incidental" and omits the picture is what made this look like a pure binder. Found by ' +
      'reading the CARD instead of the field, which is now the eighth consecutive face where ' +
      'that was the difference. ' +
      'The picker and UNBIND are body controls for the reasons their siblings record — a roster ' +
      'enumerated from the MACHINE is not a ParamDef\'s `options` and cannot be a ' +
      'ShellSelectorCell either, because ModuleShell re-projects a cell only on `nodeVersion(id)` ' +
      'and `bindMonitor` writes `node.data` ZERO times by design; and UNBIND\'s two presses do ' +
      'OPPOSITE things to CONNECT\'s while `ShellActionCell.label` is a plain string. The ' +
      'WARNING survives as the MONITOR lamp\'s accessible name, which is where the resting-text ' +
      'ruling puts a derived sentence. ' +
      '⚠ AND PROMOTION SURFACED A LIVE DEFECT: this is the one video def with a null surface ' +
      'texture, and `VideoTileThumb` snapshots the engine\'s SHARED drawing buffer after a blit ' +
      'that does nothing on such a node — so its lane tile painted whichever node blitted last ' +
      '(measured byte-identical to a `videoOut` tile with nothing patched in). Fixed in the ' +
      'thumbnail rather than masked in the baseline.',
  },
  {
    type: 'painter',
    disposition: 'generic-face',
    note:
      'PROMOTED (2026-09-02). ⚠ THE OLD `why` WAS FACTUALLY TRUE AND ITS CONCLUSION WAS THE ' +
      'TEXTMARQUEE ONE. It read: "a DRAWING SURFACE: freehand strokes on a canvas plus a typed ' +
      'text stamp. Direct pointer painting is the module and it declares no params at all." Both ' +
      'clauses are exactly right and neither disqualifies anything — what changed is the LADDER. ' +
      'A `fullViewBody` is a SLOT, not a CELL, so "not cell-shaped" stopped being a refusal; ' +
      'videoOut is the shipped zero-param precedent and flipper the shipped ranks-nothing one, ' +
      'and painter is both at once. `face.order` is EMPTY: every affordance is either ' +
      'per-collaborator LOCAL tool state (a cell would paint another peer\'s active tool out from ' +
      'under them mid-stroke) or an op-log ACTION. ⚠ THE BODY IS THE WHOLE MODULE rather than a ' +
      'preview beside a plate — nine tools, the 28-colour Win95 palette, SIZE, FILL, the text ' +
      'stamp, UNDO/CLEAR and the drawing canvas whose pixels ARE the video output — and painter ' +
      'is in none of DOM_SOURCE_LANE_TYPES / CARD_PRODUCER_LANE_TYPES / HEADLESS_MOUNT_LANE_TYPES, ' +
      'so after promotion no card mounts anywhere. ⚠ THE PICTURE ALREADY SURVIVED WITH NO SURFACE ' +
      'MOUNTED BEFORE THIS PR: #1720 moved the op-log replay onto NODE lifetime in ' +
      'extras-producers.ts (measured then: meanRGB 255,255,255 with no card vs the drawing\'s ' +
      '255,0,0), so what promotion adds is the EDITOR plus the lease handshake that lets the ' +
      'mounted surface push its own live canvas — an in-progress stroke reaches OUT before the op ' +
      'commits — and hand the binding straight back on unmount. ⚠ ONE SEAM, TWO MOUNTS: the ' +
      'pointer -> PaintOp arithmetic is $lib/ui/modules/painter/paint-surface.ts, imported by the ' +
      'body AND by the still-live legacy card, because the op log is VALID either way and a ' +
      'divergence would sync two different pictures to two peers with every gate green. ⚠ THE ' +
      'TYPED-ENTRY LEG IS CARRIED, NOT DODGED: the card mounts <input type="text"> for the TEXT ' +
      "tool's stamp string, and the body renders the same field in its OWN file (the leg reads " +
      'the directly-named fullViewBody source, so an input inside an imported child would read as ' +
      '"the face carries none"). ⚠ SCREEN OFF puts the whole paint set away rather than collapsing ' +
      'a preview well — here the picture IS the instrument — and the output is untouched: the ' +
      'release re-pushes the node-lifetime producer and the body goes on renewing the watch mark. ' +
      'ZERO attest, contract unchanged.',
  },
  {
    type: 'peertube',
    disposition: 'generic-face',
    note:
      'PROMOTED (2026-09-01, wave 4). ⚠ THIS ENTRY DISPROVED ITS OWN BLOCKER IN ITS OWN PROSE ' +
      'AND KEPT IT ANYWAY, which is the correction worth recording. It read: "a fediverse SEARCH ' +
      'BROWSER: typed query plus an optional instance host, a result list, and a player. ⚠ ITS ' +
      'SOURCE IS NO LONGER CARD-OWNED (LEG-02 P3, #1511) — the element, the hls.js demuxer, the ' +
      'attach, the audio wire, the catalogue and both triggers moved to ' +
      '$lib/ui/media/node-hls-source-registry on graph lifetime. The blocker stays because it is ' +
      'ALL-OR-NOTHING: its probe is HEADLESS_MOUNT_LANE_TYPES being EMPTY, and archivist, ' +
      'cameraInput and loopback are still in it." The LEG-02 sentence is exactly right and is ' +
      'why the promotion is cheap. The retention argument is a CATEGORY ERROR: a registry-wide ' +
      'probe is not a fact about this module, and cameraInput and loopback are both ' +
      'generic-face TODAY with that same blocker outstanding. peertube does not even pay the ' +
      'headless-host tax it was being charged for — it left DOM_SOURCE_LANE_TYPES in the same ' +
      'phase, so under the shell NO card is mounted anywhere, which makes the fullViewBody ' +
      'load-bearing rather than a nicety: without it a promoted peertube would be a search ' +
      'browser with no search box. The blocker is dropped from THIS entry only; the ' +
      'registration stays and other entries still name it. ' +
      '⚠ "AN OPTIONAL INSTANCE HOST" WAS A DEAD CONTROL, not a migration obstacle: the input ' +
      'wrote node.data.instanceHost and NOTHING read it (buildSearchUrl takes no host; ' +
      'fetchCatalogue ignores data). The control and its write are deleted, and the def docs + ' +
      'module-manifest prose that claimed it scoped the search are corrected. The ' +
      'PeerTubeData.instanceHost TYPE is deliberately KEPT: peertube-query.ts is in the WebGL ' +
      'attest basis and type declarations are not hash-transparent there, so deleting it would ' +
      'buy a real-GPU re-attest window for a dead field that still sits in saved racks. ' +
      '⚠ SHAPE: one ranked param (gain, a fader), glyph none (a real choice — two audio outputs ' +
      'mean any other literal binds LIVE and the dead-glyph clause stays silent), two ' +
      'noUserControl bridge caches, and PeerTubePicker.svelte shared by the card and the body so ' +
      'the pair cannot drift — this module already has a documented case of correctness ' +
      'travelling by hand-copy and arriving late (the muted = false audio trap). ' +
      '⚠ ONE DERIVED READOUT DELETED ON BOTH SURFACES: peertube-now-playing, the selected ' +
      "video's name painted outside every control. It lives on the picture's aria-label, sourced " +
      'from the controller\'s selectionLabel rather than from a highlighted roster row — ' +
      'autoLoadCatalogue is FALSE here, so a reloaded rack restores a selection with an EMPTY ' +
      'catalogue and tvLibrarian\'s highlighted-row answer would not transfer. The attribution ' +
      'ANCHOR to https://<host>/w/<uuid> is KEPT as a navigational control (and is now the only ' +
      'place the instance host is named), as is the PeerTube / Sepia Search legal disclaimer.',
  },
  // ⚠ RECLASSIFIED 2026-08-24, bespoke-surface -> generic-face, and — like pong's
  // reclassification below — THE OLD WHY WAS RIGHT ABOUT THE MODULE AND WRONG ABOUT
  // THE LADDER. It read: "an IMAGE SLOT BANK: per-slot loading, a gate-driven slot
  // select, and a preview of the loaded asset. One file cell covers a single image;
  // the slot roster is the interaction." Every clause of that is still true. What
  // stopped being true is the implied conclusion that a slot roster cannot live on
  // a generic face: the `fullViewBody` extension slot carries exactly this kind of
  // surface, and the module needs no bespoke DISPOSITION, only a bespoke BODY.
  //
  // ⚠ The reclassification is REQUIRED rather than cosmetic — two gates couple to it
  // in both directions (every def declaring a `face` must be dispositioned
  // generic-face, and the done-set must BE STRICT_FACES), so promoting without it is
  // red. That is how pong's was caught and how this one was.
  {
    type: 'picturebox',
    disposition: 'generic-face',
    note: 'ONE ranked control (GAIN) over a module that is otherwise a PICTURE and a BANK. '
      + 'The picture is free and per-node: `laneGlyphFor` returns \'picture\' for any '
      + 'video-domain def, so the lane tile is a live VideoTileThumb of this node\'s own '
      + 'output — which is why this face accepts a lane picture where the glyph-seam '
      + 'modules cannot (a glyph is a pure function of one param value, so every instance '
      + 'would draw the same thing). The bank and all eight file pickers live in the '
      + 'fullViewBody, because no ParamCellKind mounts an <input type="file"> and without '
      + 'them a promoted picturebox could never be given a picture. ⚠ The promotion also '
      + 'FIXES a live defect: on the card, slots 2-7 sit behind an oncontextmenu toggle '
      + 'nothing advertises, and the body puts all seven on screen permanently.',
  },
  // ⚠ RECLASSIFIED 2026-08-23, bespoke-surface -> generic-face, AND THE OLD WHY WAS
  // RIGHT ABOUT THE MODULE AND WRONG ABOUT THE LADDER. It read: "a GAME: a paddle
  // viewport with CV taps; the faders beside it are not the module." The first half
  // still holds — the court IS the module and three faders are not. What changed is
  // that "the viewport cannot be a generic face" stopped being true: the
  // fullViewBody extension slot carries exactly that kind of surface, and backdraft,
  // spirographs and videoOut all reach it from a generic-face disposition. So pong
  // needs no bespoke DISPOSITION, only a bespoke BODY.
  //
  // ⚠ And the reclassification is REQUIRED rather than cosmetic: two gates couple to
  // it in both directions — every def declaring a face must be dispositioned
  // generic-face, and the done-set must BE STRICT_FACES. Promoting without this is
  // red, which is how this was caught.
  {
    type: 'pong',
    disposition: 'generic-face',
    note: 'the COURT is the module and the three faders are not, so its picture lives in a '
      + 'fullViewBody extension rather than a glyph. ⚠ The lane tile still gets NO picture: '
      + 'pong is domain audio so hasVideoSurface is false, and both outputs are gate so every '
      + 'glyph literal except none reddens the dead-glyph clause. That is a PLATFORM gap '
      + 'shared with timelorde, scope, rasterize and wavesculpt, not a property of this '
      + 'module. ⚠ AND ITS SHAPE CHANGED WITH #2160, which is why this no longer says '
      + '"the five-module platform gap": the widening added `algorithm` + `layoutSource`, '
      + 'so a glyph literal now RESOLVES for that cohort — the gap closed MECHANICALLY. It '
      + 'remains open SUBSTANTIVELY, and that is the half that matters: `ModuleShell` '
      + 'hardcodes topologyValue to 0 when paramId is null and ShellExtensionGlyphProps '
      + 'carries no nodeId, so what resolves is a CONSTANT picture, identical on every node '
      + 'and over time. The old sentence now over-claims in one direction (a kind does fit) '
      + 'and under-claims in the other (fitting buys nothing). rasterize is where this is '
      + 'easiest to check, being the only cohort member already faced.',
  },
  {
    type: 'recorderbox',
    disposition: 'generic-face',
    note:
      'PROMOTED (wave 5). ⚠ EVERY CLAUSE OF THE OLD `why` AFTER THE DASH WAS FALSE, AND #1574/#1584 ' +
      '(bdef392f6) IS WHAT MADE IT FALSE — the entry described a card that had already been ' +
      'rewritten, and nothing re-read it. It said "the capture canvas plus its per-frame encode ' +
      'loop live on the card, so the recording exists only while it is mounted": the capture ' +
      'canvas is created by `node-recorder-registry`, NEVER enters the document and is pumped by ' +
      'the registry under its own `acquireRenderLease`, the card\'s line 257 says "CAPTURE IS NOT ' +
      'HERE" in capitals, and the recording surviving card unmount is the registry\'s entire ' +
      'purpose — it exposes no teardown precisely so a future card cannot undo it. "A take list" ' +
      'was wrong too: that block is a crash-RECOVERY list read from OPFS manifests, empty after a ' +
      'clean boot. This is the entry the tree\'s own stale-`why` class is NAMED after (see the ' +
      'note at the top of this file), and it is rewritten here rather than deleted. ' +
      '⚠ `needs-media-controller` NEVER APPLIED EITHER: recorderbox is a SINK — it consumes the ' +
      'engine\'s FBO via `blitOutputForPreview` and owns no <video>, no MediaStream source and no ' +
      'element to adopt — so it is in neither half of HEADLESS_MOUNT_LANE_TYPES, and in neither ' +
      'DOM_SOURCE_LANE_TYPES nor CARD_PRODUCER_LANE_TYPES. The blocker described a module this ' +
      'never was, and it is dropped from this entry WITHOUT being deleted from MIGRATION_BLOCKERS ' +
      '(other entries still cite it). ' +
      '⚠ WHAT WAS ACTUALLY LOAD-BEARING is what no def-reading gate could see: because ' +
      'recorderbox is in none of those sets, promotion stops RecorderboxCard being mounted ' +
      'ANYWHERE, and SIX things lived only in it — the `probeEncoders` support probe and the ' +
      '`listRecoverable` crash scan (each the tree\'s ONLY caller), the ~120-line start ' +
      'orchestration, the folder re-pick, the <a download> fallback, and the $effect reacting to ' +
      'the Y.Doc-synced `node.data.recording`. All six moved to ' +
      '$lib/ui/modules/recorderbox-transport.ts, which the legacy card and both faceplate bodies ' +
      'call. The surface is face + `fullViewBody` + `tileBody`: `params: []` means `order: []` ' +
      '(the videoOut shape), and the tile body is not optional because Canvas auto-spawns a ' +
      'recorderbox into every fresh workflow rack.',
  },
  {
    type: 'score',
    disposition: 'generic-face',
    note:
      'PROMOTED. ⚠ THE OLD `why` — "editing a score is not a ranked control list, and the staff ' +
      'IS the interaction" — was true and was not disqualifying, which is the same mistake kria\'s ' +
      'entry made. A staff is ONE PICTURE-YOU-EDIT, which is a PF-14 panel\'s own description, and ' +
      'PF-22 lets that panel rank first as the dock hero instead of being pushed past a lane cap ' +
      'this module could never clear. Everything the staff is NOT — note value, accidental, key ' +
      'signature, dynamic, tie, stop bar, loop, page count — is a generic selector or toggle over a ' +
      'roster the module already had. What made it look bespoke was that the CARD expressed all of ' +
      'them as fifteen MODAL toolbar buttons; the face expresses them as cells acting on a ' +
      'SELECTED note — or, with nothing selected, arming what you write next — which is what ' +
      'makes them cell-shaped at all. Quicksave is a second panel, ' +
      'and it had to be: four declared CV inputs (queue1..4) bottom out in `data.slots`, which ' +
      'until this PR only the legacy card could write.',
  },
  // ⚠ MOVED HERE FROM `bespoke-surface` ON PROMOTION, and the move is MECHANICAL
  // rather than a change of mind: `migrationDone` is
  // `disposition === 'generic-face' && isFaced`, and the gate asserts the
  // done-set IS STRICT_FACES in BOTH directions — so a faced module left on
  // `bespoke-surface` reddens it. `skifree` and `modtris`, the two nearest
  // siblings, were moved for exactly this reason.
  //
  // ⚠ AND UNUSUALLY, EVERY FACT IN THE OLD `why` WAS TRUE — verified line by
  // line against `SeqtrisCard.svelte` before this edit, which is worth stating
  // because the standing program finding is that inventory prose is
  // systematically false (7/7 prior promotions found theirs wrong). Only the
  // CONCLUSION was stale, and the extension seam is what retires it: the well,
  // the hardware column and CONNECT go into `fullViewBody` + `tileBody`, so the
  // two knobs can be ranked WITHOUT leaving the board and the controller
  // behind. The old text, preserved because it is still the argument:
  //
  //   "a GAME plus a HARDWARE BINDER, and neither half is generic-face
  //    material. The well is an 8×8 picture of live gameplay — sixty-four
  //    coloured cells painted from transient engine state — and the eight
  //    controls beside it are not params: they are the LAUNCHPAD'S OWN SCENE
  //    COLUMN, laid out in hardware order (including the two dead buttons)
  //    precisely so the mapping is learnable from the screen. Ranking them as
  //    cells would reorder them, which is the one thing they must not do. The
  //    CONNECT gesture and the bound / no-device / claimed status are WebMIDI
  //    service state rather than params — the outToLaunch + chromaconsole +
  //    ptzcam argument. Two knobs (grav, quant) are the only generic material,
  //    and a face that ranked those would move them to the lane and leave the
  //    board and the controller behind."
  {
    type: 'seqtris',
    disposition: 'generic-face',
    note:
      'DONE. Two ranked params (GRAV, QUANT) as DERIVED cells — no `paramCells`, because a knob ' +
      'is what `paramCellKind` already resolves for both and there is no `knob` literal to ' +
      'declare — plus BOTH extension body slots. `fullViewBody` carries the well, the eight-row ' +
      'hardware scene column INCLUDING the two dead buttons, CONNECT / Unbind, the index-keyed ' +
      'port picker and the bind LAMP that carries the six status strings on its `detail`; ' +
      '`tileBody` carries the same well read-only plus that lamp, so the lane answers "is it ' +
      'playing, and is my Launchpad on it" without expanding. ' +
      '⚠ THE WELL STAYS DOM — a CSS grid of 64 spans, not a canvas: the modtris/skifree DPR ' +
      'lessons are canvas-BLIT hazards that a 1fr grid with a 1/1 aspect-ratio cannot have, and ' +
      'converting it would delete 64 testids plus the `data-piece` attribute (the only ' +
      'machine-readable read of the board that is not a page.evaluate into engine internals). ' +
      '⚠ AND THE BODIES SUBSCRIBE RATHER THAN rAF, the sharpest divergence from both siblings: ' +
      'this factory PUSHES on every state change, so a poll would make an idle, unclocked ' +
      'seqtris do work forever. ⚠ THE CARD\'S `revision` SEAM IS CARRIED OVER AND MADE SHARED — ' +
      '`launchpadStatus()` reads a per-binding closure that nothing invalidates, so omitting the ' +
      'tick freezes the lamp, its status detail and the CONNECT/Unbind swap silently, and a lane ' +
      'tile mounted beside an open dock pane would otherwise disagree with it about one ' +
      'hardware claim. ⚠ NO simPin AND NO VRT EXEMPTION TO DISCHARGE: unlike modtris, pong, ' +
      'frogger and skifree, seqtris was NEVER in EXEMPT_FROM_VRT — the bag is seeded from a ' +
      'fixed constant and `tick()` returns early on `edges <= 0`, so with nothing patched into ' +
      'CLOCK the board is time-invariant at rest BY CONSTRUCTION. ⚠ NO NEXT-PIECE PREVIEW was ' +
      'added: `SeqtrisSnapshot` exposes no `next` field and the card never had one, so inventing ' +
      'one would be a snapshot-shape change and a redesign rather than the 1:1 parity asked for. ' +
      'CONTRACT, ART AND ATTEST ALL NIL.',
  },
  // ⚠ MOVED HERE FROM `bespoke-surface` (2026-08-31). Unusually, EVERY FACT IN
  // THE OLD `why` WAS TRUE and only the conclusion was stale. It read: "a RICH
  // TEXT EDITOR: a contenteditable marquee with per-run colour and formatting.
  // Typing the text IS the module, and it is beyond a short-text field."
  //
  //   * "a contenteditable marquee with per-run colour and formatting" — TRUE.
  //   * "typing the text IS the module" — TRUE, and stronger than it sounds:
  //     all four params only MOVE the ribbon.
  //   * "beyond a short-text field" — TRUE, and still true. `ShellEntryCell`
  //     (#1509) shipped, but it parses ONE SCALAR per cell; a styled
  //     multi-paragraph document is not that, and this promotion does not
  //     pretend otherwise.
  //
  // What changed is the LADDER, not the module: a `fullViewBody` is a SLOT, not
  // a cell, so "not cell-shaped" stopped being disqualifying — the
  // picturebox / painter / score shape.
  {
    type: 'textmarquee',
    disposition: 'generic-face',
    note:
      'DONE (2026-08-31). Four ranked knob cells (PosX, PosY, ScrlX, ScrlY — position first, ' +
      'because ScrlX/ScrlY default to 0.5 and `scrollOffset` special-cases that to a velocity of ' +
      'exactly zero, so out of the box the two SCRL knobs do nothing) over a `fullViewBody` ' +
      'carrying the whole editor. ⚠ THE LOAD-BEARING MOVE IS THE MODEL WRITER: THIRTEEN of the ' +
      "card's fifteen data-testids are it — align L/C/R, B/I/U, the per-selection TEXT colour, " +
      'the 12-entry FONT select, the SIZE range, the layer BG swatch and the contenteditable ' +
      'itself — and ZERO are expressible as a face cell (they act on a live DOM Selection, or are ' +
      'colour inputs, or are the document). All thirteen move to the body, with the same testids. ' +
      '⚠ AND RE-HOSTING THEM IS A SEMANTIC CHANGE UNLESS IT IS STOPPED: `serializeEditor` reads ' +
      "`getComputedStyle`, so the editor's CASCADE is part of the persisted document. The card's " +
      '`.editor` rule set color:#ffffff and white-space:pre-wrap; `.dock-ext-body` sets neither ' +
      'and inherits the faceplate var(--text,#eef1f5), so a copy-pasted body would have written ' +
      '#eef1f5 into every untouched run of every rack anyone opened the dock on, Y.Doc-persisted ' +
      'and read back by the still-live legacy card. The serializer is extracted to ' +
      '$lib/graph/textmarquee-editor (outside lib/video/**, so it costs no attest) and both ' +
      'surfaces stamp EDITOR_BASE_STYLE on the element rather than inheriting it. ⚠ NOT A ' +
      'PRODUCER: the rasterize-and-push half moved to $lib/ui/media/extras-producers on NODE ' +
      'lifetime in #1720, so the node shows your text with no UI mounted and textmarquee stays ' +
      'correctly out of CARD_PRODUCER_LANE_TYPES. ⚠ THE FACE ADDS textmarquee\'s first LANE ' +
      'picture (the generic VideoTileThumb — the card only ever painted its preview inside ' +
      'itself) and its first SCREEN switch. ⚠ ZERO RESTING READOUTS WERE DELETED, because the ' +
      'card painted none: no value, no measurement, not even a number beside the SIZE slider. ' +
      'The only non-control text carried across is the empty-state TYPE TEXT… badge. ⚠ ZERO ' +
      'ATTEST AND ZERO CONTRACT MOVEMENT, measured: webgl-attest-hash.sh returns the same hash ' +
      'with this diff as without it, and no `params` field is touched.',
  },
  {
    type: 'toybox',
    disposition: 'generic-face',
    note:
      'DONE (2026-09-02). The old `why` — "a whole SUB-RACK in a card: a node menu, many source ' +
      'pickers and file imports, a named preset store, its own camera capture and an interactive ' +
      'canvas. It declares no params — everything it does is its own surface." — was ACCURATE, ' +
      'and it described a BODY rather than a blocker. `params: []` means `order: []` (the ' +
      'videoOut shape) and the whole sub-rack mounts in one `fullViewBody`. ' +
      '⚠ `needs-media-controller` WAS FALSE FOR THIS MODULE and is dropped — on RECORDERBOX\'s ' +
      'argument, not archivist\'s, which is the distinction worth keeping because all three ' +
      'promotions landed in one week. archivist genuinely IS in DOM_SOURCE_LANE_TYPES and needed ' +
      'a status/command registry so its parked card could stay the sole owner; toybox is in ' +
      'NEITHER half of HEADLESS_MOUNT_LANE_TYPES. It never calls attachExternalSource — its ' +
      'per-layer <video> elements reach the engine through the module\'s OWN handle extras ' +
      '(attachLayerVideo) — and it is not a card producer: the factory renders all four layers ' +
      'from node.data with no UI mounted. ' +
      '⚠ AND THE TAX THE BLOCKER NAMED WAS ALREADY PAID, in the module\'s own history rather ' +
      'than in the face PR: #1589 moved every per-layer element, object-URL and camera ' +
      'MediaStream into $lib/ui/media/node-media-registry on GRAPH lifetime (card-media-lifetime' +
      '.test.ts fails the build if a revoke/stop/detach returns to an unmount path), and the ' +
      'IMAGE half is a node-lifetime extras-producers entry, so an image layer is reconstructed ' +
      'from node.data with no surface at all. The blocker outlived its subject by a fortnight. ' +
      '⚠ WHAT WAS ACTUALLY LOAD-BEARING is the consequence of that same membership, in the ' +
      'opposite direction: with toybox in none of those sets there is NO <HeadlessSourceHost>, ' +
      'so promotion stops ToyboxCard.svelte mounting anywhere — and that card was the module\'s ' +
      'only surface. Everything MOVED rather than being duplicated: ' +
      '$lib/ui/modules/toybox/ToyboxConsole.svelte is ONE component with a `layout` prop that ' +
      'the legacy card and the faceplate body both mount, every zone a snippet, pinned in both ' +
      'directions by toybox-face-model.test.ts. The face arrangement is owner-specified ' +
      '(2026-08-28): screen with an on/off switch, a persistent layer band, then three tabs — ' +
      'cv-mod, combine graph, presets.',
  },
  {
    type: 'tvLibrarian',
    disposition: 'generic-face',
    note:
      'DONE (2026-08-26). The refusal above named the interaction correctly and drew the wrong ' +
      'conclusion from it. "The browse-and-tune flow is the interaction" is true, and it is a ' +
      'BODY, not a blocker: `face.extension` mounts the module\'s own browse surface in the dock ' +
      'full view while the one control that IS param-shaped (`gain`) stays an ordinary ranked ' +
      'cell reachable from the lane. ⚠ AND THE `needs-media-controller` BLOCKER WAS ALREADY ' +
      'DISCHARGED when this entry still carried it — LEG-02 P3 (#2209) moved the stream to ' +
      '`node-hls-source-registry`, which is what the note beneath it says. The consequence the ' +
      'note did not draw: leaving `DOM_SOURCE_LANE_TYPES` also means there is no ' +
      '`<HeadlessSourceHost>`, so under the shell NO card is mounted anywhere and the body is ' +
      'the ONLY surface a station can be picked from. That is what makes it load-bearing rather ' +
      'than a second copy of the card. ⚠ The real precursor was never the media controller: it ' +
      'was `gain`, declared and read by nothing, which a face MUST rank. #2189 wired the uGain ' +
      'uniform for four modules in one attest window, so the ranked cell is honest and this ' +
      'promotion moves no attest hash.',
  },
  {
    type: 'twotracks',
    disposition: 'generic-face',
    note:
      'DONE (2026-08-24). The refusal above was half right and the half that was wrong is the ' +
      'interesting part. "Transport state on two reels" was never the obstacle — REC/PLAY/STOP and ' +
      'SAVE TAPE are ordinary `action` cells over control families, exactly as samsloop\'s are. The ' +
      'real claim was that the INTERACTIVE canvas is "a gesture no cell kind has", and that is still ' +
      'true: no cell kind scrubs a playhead. It stopped being a BLOCKER because the gesture does not ' +
      'need a cell — `fullViewBody` mounts the module\'s own picture, pointer handlers and all, while ' +
      'the params it writes (start/end per reel) keep ordinary param cells in the TAPE bands. So the ' +
      'picture is an ADDITIONAL way to operate controls the faceplate already reaches, rather than the ' +
      'only way, which is what a body can honestly be and a panel could not (a panel would have to ' +
      'claim those cells do not exist). ' +
      '⚠ Promotion also required a CONTRACT CHANGE first: `playhead_a`/`playhead_b` were declared ' +
      'params nothing wrote and nothing read, invisible while the card mounted no control for them ' +
      'and unavoidable the moment a face had to rank every param. They were deleted, not hidden.',
  },
  {
    type: 'videoOut',
    disposition: 'generic-face',
    note:
      'DONE (#1821). The OUTPUT MONITOR was the archetypal bespoke surface — its card BODY is the ' +
      'live screen at the end of every video chain — and it is a GENERIC face now for one reason: ' +
      'the `fullViewBody` extension slot (#1732) gives the shell a place to mount that screen, so ' +
      'the surface is a declaration rather than a carve-out. It ranks NOTHING (`params: []`); the ' +
      'picture plus full frame / full screen / DETACH / present are the whole faceplate.',
  },
  {
    type: 'videobox',
    disposition: 'generic-face',
    note:
      'PROMOTED (2026-09-01, wave 3). ⚠ THIS ENTRY\'S OWN `why` WAS FALSE IN THE CLAUSE THAT ' +
      'DECIDED IT, kept here as the correction. It read: "a FILE PLAYER: drag-and-drop target, ' +
      'remembered file-handle re-allow prompt, transport and a resizable screen. The <video> is ' +
      'already node-adopted but the card still creates and attaches the source." The player half ' +
      'is accurate — and every one of those affordances now lives on the `fullViewBody`. But ' +
      '"the card still creates and attaches the source" had been false since LEG-02 P1 (#1511): ' +
      '`attachExternalSource` does not appear in VideoboxCard.svelte, and the attach, audio ' +
      'wire, saved-handle restore, drift loop, gate loop and sync application are all ' +
      '`node-video-source-registry`\'s, on NODE lifetime — which is exactly what the ' +
      '`needs-media-controller` blocker asked for, so the blocker was already discharged. The ' +
      'second stale fact decided the old disposition: `gain` used to be a declared param ' +
      'nothing wrote and nothing read; #2189 wired `uGain`, so videobox has exactly one honest ' +
      'control to rank. ONE ranked cell (`gain`, fader) + `glyph: \'none\'` (a real choice — ' +
      'two audio outputs would bind a LIVE soundtrack VU over the module\'s own picture) + one ' +
      '`noUserControl` bridge cache (`cv_play_trigger`) over a `picture` body carrying the ' +
      'file/drop/re-allow/re-link gestures, the transport, the seek thumb, fullscreen, Full ' +
      'Frame on the same `node.data.fullFrame` key, the SCREEN switch and the corner resize ' +
      'over the card\'s own `width`/`height` keys.',
  },
  {
    type: 'videovarispeed',
    disposition: 'generic-face',
    note:
      'PROMOTED (2026-09-01, wave 4). ⚠ THIS ENTRY\'S OWN `why` WAS HALF FALSE AND HALF TRUE, ' +
      'and the halves point opposite ways — which is why this promotion is bigger than ' +
      'videobox\'s and why the correction is worth the space. It read: "a multi-SLOT varispeed ' +
      'player: several file slots, a crop overlay dragged over the frame, and scrub/speed ' +
      'transport — over a card-owned video source." The player half is accurate, and every one ' +
      'of those affordances now lives on the `fullViewBody`. "Over a card-owned video source" ' +
      'had been FALSE since LEG-02 P2 (#1511): the seven elements, the engine attach, the audio ' +
      'wire, the transport loop, the 33 ms CV poll, the gate-driven slot switch, the seven ' +
      'virtual playheads and the crop push are all `node-varispeed-registry`\'s, on GRAPH ' +
      'lifetime. But the `needs-media-controller` blocker was NOT fully discharged, and the ' +
      'residue is what the recon would have missed: that registry imported neither ' +
      '`video-file-store` nor `video-export-registry` and could not load bytes at all, so the ' +
      'per-slot LOADER, both saved-handle RESTORES, the multi-slot EXPORT resolver and the crop ' +
      'ASPECT RE-FIT were still card `$effect`s. This PR moves those four, which is what ' +
      'discharges the blocker rather than declaring it discharged. ⚠ AND THE MOVE IS A REPAIR: ' +
      'videovarispeed is in neither `DOM_SOURCE_LANE_TYPES` nor `CARD_PRODUCER_LANE_TYPES`, so ' +
      'it gets no headless host and the default shell mounts no card anywhere — yet the card\'s ' +
      '`fileMeta.handleId` effect is the documented delivery mechanism for the Loaded-Assets ' +
      'picker spawn, `runAssetRebindSweep` and the perf-zip restore. All three were already ' +
      'dock-gated on main. THREE ranked cells (`speed` as the card\'s rotary — its law is an ' +
      'asymmetric clock face a linear throw cannot read — plus `start`/`end` as `fader`s, the ' +
      'primitive the card already drew) + `glyph: \'none\'` (a real choice: two audio outputs ' +
      'would bind a LIVE soundtrack VU over the module\'s own picture) + NINE `noUserControl` ' +
      'bridge caches, over a `picture` body carrying the drop target, the verbatim ' +
      'showOpenFilePicker handle acquisition, the re-allow and re-link overlays, the transport, ' +
      'the seek thumb, the SPEED multiplier, the START-past-END warning, the crop editor, the ' +
      '7-slot asset bank and the module\'s first SCREEN switch. No pages: three cells is not ' +
      'control-heavy, and the wave plan\'s proposed transport/window split would have padded ' +
      'pages to manufacture a tab rail.',
  },

  // ── organizational-native ─────────────────────────────────────────────────
  // Rack furniture. Not a migration at all — nothing to face, nothing to delete.
  {
    type: 'cadillac',
    disposition: 'organizational-native',
    why:
      'the roaming sprite — drawn as a full-canvas overlay, never as a flow node. It has no card ' +
      'at all, so there is no legacy card to replace.',
  },
  {
    type: 'group',
    disposition: 'organizational-native',
    why:
      'a rack GROUP frame: a labelled boundary around other nodes. It has no ports, no params and ' +
      'no engine binding — the frame is the whole object.',
  },
  {
    type: 'sticky',
    disposition: 'organizational-native',
    why:
      'a paper STICKY NOTE: a resizable text area pinned to the rack. It binds to no engine and ' +
      'its text is the object, not a control over one.',
  },
];

/** Index by module type. */
const BY_TYPE: ReadonlyMap<string, FaceMigrationEntry> = new Map(
  FACE_MIGRATION_INVENTORY.map((e) => [e.type, e]),
);

/** The disposition record for a module type, or undefined if it has none (which
 *  the gate makes impossible for a REGISTERED def — see the header). */
export function inventoryEntry(type: string): FaceMigrationEntry | undefined {
  return BY_TYPE.get(type);
}

/**
 * Every blocker that stands between this module and its v2 surface: the ones the
 * entry names. Sorted + de-duplicated so callers can compare sets.
 *
 * ⚠ THERE IS NO DISPOSITION-DERIVED BLOCKER ANY MORE (#1799). One used to hang
 * `needs-extension-registry` on every 'bespoke-surface' entry from a single
 * declaration; when the seam shipped, that one line kept a third of the
 * migration marked un-startable and no gate could see it. A blocker is a fact
 * about a MODULE, so it is typed on the module. If a capability is ever again
 * genuinely missing for a whole disposition, the derivation comes back WITH a
 * capability probe — the thing that makes such a claim falsifiable.
 */
export function migrationBlockers(entry: FaceMigrationEntry): readonly MigrationBlockerId[] {
  const declared = 'blockers' in entry && entry.blockers ? entry.blockers : [];
  return [...new Set<MigrationBlockerId>(declared)].sort();
}

/**
 * Is this module's migration DONE?
 *
 * ⚠ READ, never stored. A module is migrated exactly when it is in
 * `STRICT_FACES`, which module-face-lint.test.ts asserts IS the set of defs
 * declaring a `face`. The caller passes that membership in so this module stays
 * import-free of the face set and the two can never drift apart — and the gate
 * asserts the done-set IS `STRICT_FACES`, in both directions.
 */
export function migrationDone(entry: FaceMigrationEntry, isFaced: boolean): boolean {
  return entry.disposition === 'generic-face' && isFaced;
}

/**
 * The per-disposition roster, for the GENERATED progress artifact. Returns
 * membership — the names — and never a size: the counts a reader wants are read
 * off the generated markdown, which is a pure function of this record plus the
 * live registry.
 */
export function dispositionRoster(
  types: readonly string[],
): ReadonlyMap<FaceMigrationDisposition, readonly string[]> {
  const out = new Map<FaceMigrationDisposition, string[]>();
  for (const type of [...types].sort((a, b) => a.localeCompare(b))) {
    const entry = BY_TYPE.get(type);
    if (!entry) continue;
    const bucket = out.get(entry.disposition) ?? [];
    bucket.push(type);
    out.set(entry.disposition, bucket);
  }
  return out;
}
