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
export type MigrationBlockerId = 'needs-note-entry-cell' | 'needs-media-controller';

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
  'needs-note-entry-cell': {
    issue: 1509,
    capability:
      'a note/short-text entry face cell — card-primitive-parity declares NoteEntry `via: none`, ' +
      'and a raw <input type="text"> shares the gap, so a typed pitch field ("c#3"), a MIDI note ' +
      'number or a name field has no face representation at all',
    unblocks:
      'the sequencer-class surfaces (their step rosters are typed, not turned) and every card ' +
      'carrying a short-text field, which today can only hand-roll one',
    probe: {
      evidence:
        'ModuleShell.svelte — the ONE renderer every face cell is painted by — mounts typed ' +
        'entry. There is nowhere else it could land: no ParamCellKind paints text, so the cell ' +
        'cannot exist without the shared shell mounting a <NoteEntry>, a <textarea>, a ' +
        'contenteditable or a typed <input>.',
      shipped: (tree) => tree.faceShellMountsTypedEntry,
      landed: (tree) => ({ ...tree, faceShellMountsTypedEntry: true }),
    },
  },
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
  { type: 'cvBuddy', disposition: 'generic-face', note: 'the PPQN roster + offset are params; SLOTS / LATE / ES-9-present are readouts to register, not knobs' },
  { type: 'cvBuddyMini', disposition: 'generic-face', note: 'renders the same shared CvBuddyBody as cvBuddy — migrate the pair together' },
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
  { type: 'gatemaiden', disposition: 'generic-face' },
  { type: 'grainsOfVision', disposition: 'generic-face' },
  { type: 'graphicEq', disposition: 'generic-face' },
  { type: 'illogic', disposition: 'generic-face' },
  { type: 'inwards', disposition: 'generic-face' },
  { type: 'joystick', disposition: 'generic-face', note: 'its 2-D pad is a HAND-CLONE — migrate onto the shared `xy` cell (#1509 §3), never two knobs' },
  { type: 'karplus', disposition: 'generic-face' },
  { type: 'kickdrum', disposition: 'generic-face' },
  { type: 'lfo', disposition: 'generic-face' },
  { type: 'lines', disposition: 'generic-face' },
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
  { type: 'scope', disposition: 'generic-face', note: 'the dual-trace + Lissajous screen is ONE `scope` glyph binding; if it will not carry two channels the screen becomes a registered panel' },
  { type: 'scoreboard', disposition: 'generic-face' },
  { type: 'shapedramps', disposition: 'generic-face' },
  { type: 'shapegen', disposition: 'generic-face' },
  { type: 'shapes', disposition: 'generic-face' },
  { type: 'shimmershine', disposition: 'generic-face' },
  { type: 'sidecar', disposition: 'generic-face' },
  { type: 'sixstrum', disposition: 'generic-face' },
  { type: 'slewSwitch', disposition: 'generic-face' },
  { type: 'snaredrum', disposition: 'generic-face' },
  { type: 'sourcery', disposition: 'generic-face' },
  { type: 'spectrograph', disposition: 'generic-face', note: 'one gain knob + a B/W toggle; the sonogram waterfall matches no glyph kind, so the screen is a registered panel' },
  { type: 'spirographs', disposition: 'generic-face', note: 'the hue wheel writes a single continuous param — a knob at worst, a colour cell if the range is packed RGB' },
  { type: 'stereovca', disposition: 'generic-face' },
  { type: 'swolevco', disposition: 'generic-face' },
  { type: 'synesthesia', disposition: 'generic-face', note: 'mode/polarity buttons write params; the two band displays are read-only pictures (nearest kind: `meter`)' },
  { type: 'tempest', disposition: 'generic-face' },
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
    disposition: 'bespoke-surface',
    blockers: ['needs-note-entry-cell'],
    why:
      'a VST BRIDGE card (the es9 shape): connection state machine, plugin picker with text ' +
      'filter (the typed entry), mount/unmount/swap gestures, native-editor toggle, and ' +
      'meter/rtt/latency telemetry. Zero params — the surface IS the bridge control plane.',
  },
  {
    type: 'vstFx',
    disposition: 'bespoke-surface',
    blockers: ['needs-note-entry-cell'],
    why:
      'the VST BRIDGE stereo-insert card — the same bridge control plane as vstInstrument ' +
      '(shared VstBridgePanel: picker with its typed filter entry, mount/unmount, editor, ' +
      'meters) with zero params; nothing to rank into a generic face.',
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
  { type: 'wavesculpt', disposition: 'generic-face', note: 'two HAND-CLONED camera pads (#1509 §3) and the largest order after mixmstrs; a face was authored for it once and shipped both pads as knobs — do not repeat that' },
  { type: 'wavetableVco', disposition: 'generic-face' },

  // ── blocked ───────────────────────────────────────────────────────────────
  // Remove the named capability and these are faces — no surface work at all.
  {
    type: 'frametable',
    disposition: 'blocked',
    blockers: ['needs-media-controller'],
    why:
      'knobs plus two hand-cloned 2-D pads (both expressible as `face.xyPads`) over a video ' +
      'source the CARD creates and attaches — it is in DOM_SOURCE_LANE_TYPES, so the shell keeps ' +
      'its card alive off-screen today. Once the source is node-owned this is a face and nothing ' +
      'else.',
  },
  {
    type: 'loopback',
    disposition: 'blocked',
    blockers: ['needs-media-controller'],
    why:
      'a capture LED, a start/stop capture action and one fader — the smallest surface in the ' +
      'media set. Everything about it is expressible today except that the tab-capture stream ' +
      'lives on the card, so the face would render a control over a source that is not there.',
  },
  {
    type: 'videocube',
    disposition: 'blocked',
    blockers: ['needs-media-controller'],
    why:
      'knobs plus three mounts of the SHARED <XyPad> (already a first-class `xy` cell) and a file ' +
      'import (a file cell) — the only thing it cannot express is its card-owned video source, ' +
      'which is exactly what the node-owned media lifecycle lands.',
  },

  // ── bespoke-surface ───────────────────────────────────────────────────────
  // The primary interaction is not param-shaped. Each of these needs a
  // hand-written surface behind the extension seam — which is BUILT and adopted
  // (#1512), so this disposition names WORK, not a wait. What a given module is
  // still waiting on, if anything, is named in its own `blockers`.
  {
    type: 'archivist',
    disposition: 'bespoke-surface',
    blockers: ['needs-media-controller', 'needs-note-entry-cell'],
    why:
      'an archive.org SEARCH BROWSER: a typed query with year bounds, a result list to pick from, ' +
      'and a player. The list is the interaction, the query is typed, and the <video> source is ' +
      'card-owned.',
  },
  {
    type: 'audioIn',
    disposition: 'bespoke-surface',
    blockers: ['needs-media-controller'],
    why:
      'a hardware CAPTURE BINDER: a live enumerateDevices roster (service state, not node state, ' +
      'so no selector cell projects it), a permission/status flow with five failure states, and a ' +
      'getUserMedia stream the card starts and stops with its own lifetime.',
  },
  {
    type: 'audioOut',
    disposition: 'bespoke-surface',
    why:
      'a hardware OUTPUT BINDER around one master fader: a live enumerateDevices roster plus the ' +
      'setSinkId support/error states, which are neither params nor node data and have no cell ' +
      'kind that reads them.',
  },
  {
    type: 'blood',
    disposition: 'bespoke-surface',
    why:
      'a GAME: the card claims the keyboard while focused and its body is the viewport. The knobs ' +
      'are incidental; the interaction is play, which no ranked cell list expresses.',
  },
  {
    type: 'cameraInput',
    disposition: 'bespoke-surface',
    blockers: ['needs-media-controller'],
    why:
      'the capture-source snowflake already carved out of the shell swap: the card owns ' +
      'getUserMedia AND the enumerateDevices picker, and #1511 names its device-selection + ' +
      'permission UI as its own surface concern rather than part of the lifecycle move.',
  },
  {
    type: 'cartesian',
    disposition: 'bespoke-surface',
    blockers: ['needs-note-entry-cell'],
    why:
      'an X/Y PAD SEQUENCER: a grid of cells, each with a typed pitch and a cycling chord button, ' +
      'walked by a cursor. The faders around it are params; the grid is the module.',
  },
  {
    type: 'chromaconsole',
    disposition: 'bespoke-surface',
    why:
      'a MIDI DEVICE BINDER: connect gesture, live output-port roster, channel, and a list of ' +
      'assignment slots that reports stale saved assignments. The roster is WebMIDI service ' +
      'state, and the slot list is the interaction.',
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
    disposition: 'bespoke-surface',
    why:
      'a CODE EDITOR body (CodeMirror) with a clock division and a resize grip — the whole card is ' +
      'the editor, and text editing has no cell kind and no glyph.',
  },
  {
    type: 'controlSurface',
    disposition: 'bespoke-surface',
    blockers: ['needs-note-entry-cell'],
    why:
      'a free-form CONTROL SURFACE: knob boxes dragged into place per source module, renameable in ' +
      'situ. Its content is other modules parameters, so it has no params of its own to rank.',
  },
  {
    type: 'doom',
    disposition: 'bespoke-surface',
    why:
      'a GAME: a WAD-driven viewport with keyboard capture. Its params are CV taps off the running ' +
      'game, not the interaction — the interaction is play.',
  },
  {
    type: 'drumseqz',
    disposition: 'bespoke-surface',
    blockers: ['needs-note-entry-cell'],
    why:
      'a DRUM STEP GRID: per-track lanes of steps with page navigation, quicksave slots and a ' +
      'typed root note per track. The grid is the module and the pitch fields are typed.',
  },
  {
    type: 'electraControl',
    disposition: 'bespoke-surface',
    blockers: ['needs-note-entry-cell'],
    why:
      'the Electra One HARDWARE MAPPER: a fixed row/knob slot matrix that other modules params ' +
      'are dropped into and renamed in place. No params of its own; the matrix is the interaction.',
  },
  {
    type: 'es9',
    disposition: 'bespoke-surface',
    why:
      'the ES-9 BRIDGE: connection state machine, connect/disconnect gestures, device rate and ' +
      'channel-count detail, xrun/rtt telemetry, and sectioned routing across many jacks. The ' +
      'params are routing, the surface is the bridge.',
  },
  {
    type: 'frogger',
    disposition: 'bespoke-surface',
    why: 'a GAME viewport driven by the keyboard — one knob beside it does not make it a face.',
  },
  {
    type: 'gamepad',
    disposition: 'bespoke-surface',
    why:
      'a GAMEPAD MAPPER: a live device roster, a per-button/axis mapping table with importable ' +
      'mapping files, and live input echo. The table is the interaction and none of it is a param.',
  },
  {
    type: 'gibribbon',
    disposition: 'bespoke-surface',
    why:
      'a rhythm GAME: score / health / combo HUD over a viewport, played on the keyboard, with a ' +
      'game-over restart. Its def params are CV taps, not the surface.',
  },
  {
    type: 'kria',
    disposition: 'bespoke-surface',
    why:
      'a monome KRIA step grid: track and page selectors over a per-step cell roster, optionally ' +
      'bound to real grid hardware over WebSerial. The grid is the module.',
  },
  {
    type: 'launchpadControlLeft',
    disposition: 'bespoke-surface',
    why:
      'a Launchpad PAD MAPPER — an 8×8 pad matrix bound to a hardware surface. It has no params; ' +
      'the pad map is the interaction. (Note the type id is launchpadControlLeft, not the ' +
      '`launchpadControl` the older carve-out lists name.)',
  },
  {
    type: 'livecode',
    disposition: 'bespoke-surface',
    why:
      'a LIVE-CODE EDITOR: the card body is the code buffer and its evaluation status. No params, ' +
      'no controls, nothing a ranked cell list can carry.',
  },
  {
    type: 'macseq',
    disposition: 'bespoke-surface',
    blockers: ['needs-note-entry-cell'],
    why:
      'a MACRO-OSCILLATOR STEP SEQUENCER: per-step model + typed pitch rosters with page ' +
      'navigation and quicksave slots. Step rosters are typed and the grid is the interaction.',
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
    disposition: 'bespoke-surface',
    why:
      'a PATCH MATRIX: a scrollable source×destination cross-point grid over the whole rack. It ' +
      'has no params of its own and the grid is the interaction.',
  },
  {
    type: 'midiCvBuddy',
    disposition: 'bespoke-surface',
    why:
      'a MIDI DEVICE BINDER: permission gesture, live input-device roster, channel and mode ' +
      'selection. It declares no params at all — the rosters are WebMIDI service state.',
  },
  {
    type: 'midiLane',
    disposition: 'bespoke-surface',
    blockers: ['needs-note-entry-cell'],
    why:
      'a MIDI DEVICE BINDER with a typed note-number field for the gate tap: permission gesture, ' +
      'live device roster, channel/mode selection. No params, and the one numeric field is typed ' +
      'entry.',
  },
  {
    type: 'midiOutBuddy',
    disposition: 'bespoke-surface',
    why:
      'a MIDI OUTPUT BINDER: permission gesture plus live output-port and channel rosters, with no ' +
      'params of its own to rank.',
  },
  {
    type: 'midiclock',
    disposition: 'bespoke-surface',
    why:
      'a MIDI CLOCK BINDER: permission gesture, live device roster, clock divisor and a running ' +
      'tempo readout. No params — the surface is the binding.',
  },
  {
    type: 'modtris',
    disposition: 'bespoke-surface',
    why: 'a GAME: a falling-block viewport played on the keyboard, with two faders beside it.',
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
    disposition: 'bespoke-surface',
    why:
      'a KEYPAD PERFORMANCE SURFACE: four layers of a key-map roster with its own editing menu, a ' +
      'transport and an octave nudge. The pad map is the interaction, not a ranked control list.',
  },
  {
    type: 'outToLaunch',
    disposition: 'bespoke-surface',
    why:
      'a Launchpad OUTPUT BINDER: device pick, bind/unbind, and a warning that the bound surface ' +
      'can no longer be used for control. The two knobs are incidental to the binding flow.',
  },
  {
    type: 'painter',
    disposition: 'bespoke-surface',
    blockers: ['needs-note-entry-cell'],
    why:
      'a DRAWING SURFACE: freehand strokes on a canvas plus a typed text stamp. Direct pointer ' +
      'painting is the module and it declares no params at all.',
  },
  {
    type: 'peertube',
    disposition: 'bespoke-surface',
    blockers: ['needs-media-controller', 'needs-note-entry-cell'],
    why:
      'a fediverse SEARCH BROWSER: typed query plus an optional instance host, a result list, and ' +
      'a player whose <video> source is card-owned.',
  },
  {
    type: 'picturebox',
    disposition: 'bespoke-surface',
    why:
      'an IMAGE SLOT BANK: per-slot loading, a gate-driven slot select, and a preview of the ' +
      'loaded asset. One file cell covers a single image; the slot roster is the interaction.',
  },
  {
    type: 'polyseqz',
    disposition: 'bespoke-surface',
    blockers: ['needs-note-entry-cell'],
    why:
      'a POLYPHONIC STEP SEQUENCER: a per-step chord/root roster with page navigation and ' +
      'quicksave slots. Steps are typed and the grid is the interaction.',
  },
  {
    type: 'pong',
    disposition: 'bespoke-surface',
    why: 'a GAME: a paddle viewport with CV taps; the faders beside it are not the module.',
  },
  {
    type: 'push2Control',
    disposition: 'bespoke-surface',
    why:
      'the Push 2 SURFACE: a pad grid plus the hardware screen mirror (WebMIDI pads, WebUSB ' +
      'display). It has no params and its whole job is driving a physical control surface.',
  },
  {
    type: 'recorderbox',
    disposition: 'bespoke-surface',
    blockers: ['needs-media-controller', 'needs-note-entry-cell'],
    why:
      'a RECORDER: arm/record/stop transport, quality selection, a typed filename, a take list and ' +
      'a save flow — and the capture canvas plus its per-frame encode loop live on the card, so ' +
      'the recording exists only while it is mounted.',
  },
  {
    type: 'score',
    disposition: 'bespoke-surface',
    why:
      'a NOTATION EDITOR: note / tie / dynamic rosters placed on a staff. Editing a score is not ' +
      'a ranked control list, and the staff is the interaction.',
  },
  {
    type: 'sequencer',
    disposition: 'bespoke-surface',
    blockers: ['needs-note-entry-cell'],
    why:
      'the CV STEP SEQUENCER: pitch / gate / chord rosters per step with page navigation and ' +
      'quicksave slots. Steps are typed and the grid is the interaction.',
  },
  {
    type: 'skifree',
    disposition: 'bespoke-surface',
    why: 'a GAME: a scrolling viewport played on the keyboard, with no params at all.',
  },
  {
    type: 'textmarquee',
    disposition: 'bespoke-surface',
    blockers: ['needs-note-entry-cell'],
    why:
      'a RICH TEXT EDITOR: a contenteditable marquee with per-run colour and formatting. Typing ' +
      'the text IS the module, and it is beyond a short-text field.',
  },
  {
    type: 'toybox',
    disposition: 'bespoke-surface',
    blockers: ['needs-media-controller', 'needs-note-entry-cell'],
    why:
      'a whole SUB-RACK in a card: a node menu, many source pickers and file imports, a named ' +
      'preset store, its own camera capture and an interactive canvas. It declares no params — ' +
      'everything it does is its own surface.',
  },
  {
    type: 'tvLibrarian',
    disposition: 'bespoke-surface',
    blockers: ['needs-media-controller'],
    why:
      'a CHANNEL BROWSER: a station roster with tuning gestures over a player whose <video> source ' +
      'is card-owned. The browse-and-tune flow is the interaction.',
  },
  {
    type: 'twotracks',
    disposition: 'bespoke-surface',
    why:
      'a TAPE DECK: two reels of transport state, and the waveform canvases are INTERACTIVE — ' +
      'scrubbing and setting loop points directly on the picture is a gesture no cell kind has.',
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
    disposition: 'bespoke-surface',
    blockers: ['needs-media-controller'],
    why:
      'a FILE PLAYER: drag-and-drop target, remembered file-handle re-allow prompt, transport and ' +
      'a resizable screen. The <video> is already node-adopted but the card still creates and ' +
      'attaches the source.',
  },
  {
    type: 'videovarispeed',
    disposition: 'bespoke-surface',
    blockers: ['needs-media-controller'],
    why:
      'a multi-SLOT varispeed player: several file slots, a crop overlay dragged over the frame, ' +
      'and scrub/speed transport — over a card-owned video source.',
  },
  {
    type: 'writeseq',
    disposition: 'bespoke-surface',
    blockers: ['needs-note-entry-cell'],
    why:
      'a WRITE-IN SEQUENCER: a typed per-step pitch roster with page navigation and quicksave ' +
      'slots. Steps are typed and the grid is the interaction.',
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
