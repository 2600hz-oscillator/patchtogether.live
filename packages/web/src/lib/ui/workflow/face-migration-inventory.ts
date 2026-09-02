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
export type MigrationBlockerId = 'needs-media-controller';

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
export const MIGRATION_BLOCKERS: Readonly<Record<MigrationBlockerId, MigrationBlocker>> = {
  'needs-media-controller': {
    issue: 1511,
    capability:
      'node-owned media lifecycle — creation, device selection, stream acquisition, object-URL ' +
      'lifetime, engine attachment and teardown owned by a node-scoped controller instead of by ' +
      'a mounted <X>Card.svelte',
    unblocks:
      'every module whose source exists only because a card is mounted; until it lands their ' +
      'cards are kept alive off-screen by HeadlessSourceHost, which is a tax on every rack',
    probe: {
      evidence:
        'NO module type is left whose engine-visible state depends on its card being mounted ' +
        '(HEADLESS_MOUNT_LANE_TYPES is empty) — which is #1511 stated as a property of the tree: ' +
        '"no source may exist because a card is mounted". The set is grep-gated against the ' +
        'cards that call attachExternalSource, so it cannot lag the code it describes.',
      shipped: (tree) => tree.cardOwnedSourceTypes.length === 0,
      landed: (tree) => ({ ...tree, cardOwnedSourceTypes: [] }),
    },
  },
};

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
  {
    type: 'archivist',
    disposition: 'bespoke-surface',
    blockers: ['needs-media-controller'],
    why:
      'an archive.org SEARCH BROWSER: a typed query with year bounds, a result list to pick from, ' +
      'and a player. The list is the interaction, the query is typed, and the <video> source is ' +
      'card-owned.',
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
  {
    type: 'chromaconsole',
    disposition: 'bespoke-surface',
    why:
      'a MIDI DEVICE BINDER: connect gesture, live output-port roster, channel, and a list of ' +
      'assignment slots that reports stale saved assignments. The roster is WebMIDI service ' +
      'state, and the slot list is the interaction.',
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
  // one binder in the tree that is still unfaced, while every other device
  // binder had already shipped this shape: midiclock, midiCvBuddy, midiLane,
  // midiOutBuddy, launchpadControlLeft, outToLaunch, push2Control, es9,
  // cameraInput and electraControl are all in STRICT_FACES. ptzcam does not
  // inherit chromaconsole's blocker either: chromaconsole's real constraint is
  // that `deviceSlotParams` mints eight identical `slot 1`..`slot 8` params
  // whose meaning is per-NODE `node.data.assign`, and ptzcam has nothing of the
  // kind — its four knobs are ordinary named params.
  //
  // FALSE (2) — "the four trim knobs are the only generic-face material". The
  // CONNECT gesture is a fifth ranked control through the family key-space, and
  // its `testidPrefix` already existed on the legacy card, so no card edit was
  // needed to satisfy module-docs-lint. It ranks FIRST, not fifth.
  {
    type: 'trails',
    disposition: 'bespoke-surface',
    why:
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
      + 'is the only affordance that can correct the wire constants against real hardware. Three '
      + 'knobs (range, smooth, clock div) are the only generic-face material, and a face that '
      + 'ranked those would move the knobs to the lane and leave behind every one of the things '
      + 'that make the module usable.',
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
    type: 'clipplayer',
    disposition: 'bespoke-surface',
    why:
      'the CLIP LAUNCHER: a scene/track grid of pads with per-cell arm, capture, quantised launch ' +
      'and automation state. It is already carved out of the shell swap (NON_SHELL_LANE_TYPES) ' +
      'and is the canonical bespoke surface the extension seam was built for (#1512, now shipped).',
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
      'NON_SHELL_LANE_TYPES (clipplayer remains). ONE ranked TOGGLE cell — LOCK, over ' +
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
    disposition: 'bespoke-surface',
    why:
      'a GAME: a WAD-driven viewport with keyboard capture. Its params are CV taps off the running ' +
      'game, not the interaction — the interaction is play.',
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
    disposition: 'bespoke-surface',
    why:
      'a PROJECTION MAPPER: quad corners dragged on a canvas, with mapping import/export. Direct ' +
      'geometry manipulation is the entire module.',
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
    disposition: 'bespoke-surface',
    why:
      'a RIBBON CONTROLLER: the playable strip — press position and gate — IS the module, and a ' +
      '1-D touch surface is not a knob. Scale and offset are params around it.',
  },
  {
    type: 'nibbles',
    disposition: 'bespoke-surface',
    why: 'a GAME: a snake viewport played on the keyboard; its outputs are taps off the running game.',
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
    disposition: 'bespoke-surface',
    why:
      'a DRAWING SURFACE: freehand strokes on a canvas plus a typed text stamp. Direct pointer ' +
      'painting is the module and it declares no params at all.',
  },
  {
    type: 'peertube',
    disposition: 'bespoke-surface',
    blockers: ['needs-media-controller'],
    why:
      'a fediverse SEARCH BROWSER: typed query plus an optional instance host, a result list, and ' +
      'a player. ⚠ ITS SOURCE IS NO LONGER CARD-OWNED (LEG-02 P3, #1511) — the element, the ' +
      'hls.js demuxer, the attach, the audio wire, the catalogue and both triggers moved to ' +
      '$lib/ui/media/node-hls-source-registry on graph lifetime. The blocker stays because it is ' +
      'ALL-OR-NOTHING: its probe is HEADLESS_MOUNT_LANE_TYPES being EMPTY, and archivist, ' +
      'cameraInput and loopback are still in it.',
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
    disposition: 'bespoke-surface',
    blockers: ['needs-media-controller'],
    why:
      'a RECORDER: arm/record/stop transport, quality selection, a typed filename, a take list and ' +
      'a save flow — and the capture canvas plus its per-frame encode loop live on the card, so ' +
      'the recording exists only while it is mounted.',
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
  {
    type: 'seqtris',
    disposition: 'bespoke-surface',
    why:
      'a GAME plus a HARDWARE BINDER, and neither half is generic-face material. The well is an ' +
      '8×8 picture of live gameplay — sixty-four coloured cells painted from transient engine ' +
      'state — and the eight controls beside it are not params: they are the LAUNCHPAD\'S OWN ' +
      'SCENE COLUMN, laid out in hardware order (including the two dead buttons) precisely so the ' +
      'mapping is learnable from the screen. Ranking them as cells would reorder them, which is ' +
      'the one thing they must not do. The CONNECT gesture and the bound / no-device / claimed ' +
      'status are WebMIDI service state rather than params — the outToLaunch + chromaconsole + ' +
      'ptzcam argument. Two knobs (grav, quant) are the only generic material, and a face that ' +
      'ranked those would move them to the lane and leave the board and the controller behind.',
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
    disposition: 'bespoke-surface',
    blockers: ['needs-media-controller'],
    why:
      'a whole SUB-RACK in a card: a node menu, many source pickers and file imports, a named ' +
      'preset store, its own camera capture and an interactive canvas. It declares no params — ' +
      'everything it does is its own surface.',
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
    disposition: 'bespoke-surface',
    blockers: ['needs-media-controller'],
    why:
      'a multi-SLOT varispeed player: several file slots, a crop overlay dragged over the frame, ' +
      'and scrub/speed transport — over a card-owned video source.',
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
