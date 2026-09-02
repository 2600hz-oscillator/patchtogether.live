// packages/web/src/lib/graph/raw-write-ledger.ts
//
// THE OPT-OUT LEDGER for `mutate.guard.test.ts` — every raw `node.params` write
// in the tree, CLASSIFIED, with a stated reason.
//
// ── Why this file exists (the blind-gate finding, 2026-08-02) ────────────────
// The guard's pattern was `\.params\[[^\]]+\]\s*=` — BRACKET-ONLY. Every raw
// write spelled the ordinary way, `node.params.mode = m`, was invisible to it.
// So was its self-test, which only ever asserted the bracket form. The guard and
// its own negative control were blind in the SAME direction, which is why the
// green run read as "no raw writes exist" rather than "no BRACKETED raw writes
// exist".
//
// Widening the pattern turned up **96 dotted writes the guard had never seen**,
// against **3 bracketed ones** it had. The guard was covering ~3 % of its own
// subject matter.
//
// ── Why a LEDGER and not 96 inline annotations ──────────────────────────────
// The inline `// guard:allow-raw-write` marker is still the idiom for a NEW
// write, and it stays supported. But a 96-line backlog inherited all at once
// needs to be NAMED, and names spread over 40 files cannot be reviewed as one
// thing. The ledger is deny-by-default in both directions:
//
//   * a write that is in NEITHER bucket and carries NO inline marker → RED;
//   * an entry naming a write that no longer exists → RED (a stale exemption is
//     an exemption nobody is watching — the "anchor the metric to the ARTIFACT"
//     rule).
//
// There is NO count. The DEBT total used to be ratcheted from both sides; that
// literal is gone (2026-08-12) and the trace of what it protected sits where it
// stood, below.
//
// Entries name the PARAM KEY, never a line number: a key survives a refactor,
// so an already-listed file that grows a NEW raw write still fails.

/** How a raw write is classified. */
export type RawWriteKind =
  /** Correct as written: it MUST NOT become a tracked (undoable, synced) write. */
  | 'sanctioned'
  /** Wrong as written: it should route through setNodeParam/mutateNode. */
  | 'debt'
  /** Not a graph node at all — the receiver just happens to be named `params`. */
  | 'not-a-node';

export interface RawWriteEntry {
  /** The param keys raw-written in this file. */
  readonly keys: readonly string[];
  readonly kind: RawWriteKind;
  readonly why: string;
}

/**
 * `lib-relative path → entry`. THE COMPLETE inventory of raw `.params` writes
 * outside `graph/mutate.ts`. Adding a file here is a deliberate, reviewed act.
 */
export const RAW_WRITE_LEDGER: Readonly<Record<string, RawWriteEntry>> = {
  // ── not-a-node ─────────────────────────────────────────────────────────────
  // FOXY hosts three mini-SWOLEVCO engines (`makeSwole(...)`), each with its own
  // plain `params` bag. `swoleA.params.tune = v` is a write to an AUDIO ENGINE
  // OBJECT inside the factory, not to a ModuleNode — there is no Y.Doc, no undo
  // stack and no origin to tag. The textual guard cannot tell the two receivers
  // apart, so the classification is recorded here rather than guessed.
  'audio/modules/foxy.ts': {
    keys: ['tune', 'fine', 'timbre', 'symmetry', 'fold'],
    kind: 'not-a-node',
    why: 'swoleA/B/C are makeSwole() engine objects with their own params bag — no Y.Doc, no undo stack',
  },

  // ── sanctioned: ENGINE → STORE reflects ────────────────────────────────────
  // A transport advancing its own `isPlaying`/`recArm` mirror is the engine
  // telling the store what it already did. Routing it through the undoable seam
  // would put a playhead tick on the undo stack and storm ydoc.update — the
  // #719 class this guard's opt-out was created for.
  'audio/modules/score.ts': {
    keys: ['isPlaying'],
    kind: 'sanctioned',
    why: 'transport → store reflect; an undoable play/stop tick would storm ydoc + pollute undo',
  },
  'audio/modules/timelorde.ts': {
    keys: ['bpm', 'running', 'wizardOn'],
    kind: 'sanctioned',
    why: 'master-clock state → store reflect; tempo/run state is engine truth, not an edit',
  },
  'audio/modules/numpad-plus.ts': {
    keys: ['octave', 'recArm'],
    kind: 'sanctioned',
    why: 'hardware-surface → store reflect (the numpad drives the value, the store mirrors it)',
  },

  // ── sanctioned: PROGRAMMATIC / BOT / LIVECODE ──────────────────────────────
  'livecode/runtime.ts': {
    keys: ['muteOutputs', 'bpm'],
    kind: 'sanctioned',
    why: 'livecode script writes must NOT enter the user undo stack (the #719 class exactly)',
  },
  'graph/toybox-combine.ts': {
    keys: ['_reset'],
    kind: 'sanctioned',
    why: 'internal reset pulse on a synthesised node, already inside the combine transaction',
  },
  'media/asset-spawn.ts': {
    keys: ['start', 'end'],
    kind: 'sanctioned',
    why: 'sample bounds derived from the decoded buffer at spawn — engine truth, pre-first-render',
  },
  // The SAME shape as asset-spawn, one layer later: `writeSamsloopTake` opens the
  // loop window over the take it is committing in the same statement block that
  // writes `node.data.sample`. Two independent reasons it must stay raw:
  //   * the sample itself is a `node.data` write and is NOT undoable, so routing
  //     only the window through `setNodeParam` would let one Ctrl-Z leave a
  //     window that does not match the sample it describes;
  //   * the commit can fire with NO card mounted and no gesture in flight — the
  //     byte-cap auto-stop while the module is collapsed (#1588) — so it would
  //     push an undo entry for something the user did not just do. That is the
  //     #719 class the sanctioned bucket exists for.
  // (`ui/modules/SamsloopCard.svelte` keeps its own start/end row: the UPLOAD
  // path still writes them there, and that one is a user gesture.)
  'ui/modules/node-samsloop-registry.svelte.ts': {
    keys: ['start', 'end'],
    kind: 'sanctioned',
    why: 'loop window derived from the take being committed; the sample write beside it is not undoable, and a cap-stop commits with no card and no gesture',
  },

  // ⚠ TWO call sites are NOT here because they are already inline-annotated,
  // and the inline marker is consulted BEFORE this ledger:
  //   * `ui/modules/BackdraftCard.svelte` (`tvMode`, `shape`) — per-frame
  //     engine→store reflect. Both lines carry `// guard:allow-raw-write`, and
  //     both are DOTTED: the annotations were written against a guard that
  //     could not see the lines they annotate. Nobody was wrong; the guard was.
  //   * `ui/modules/cloudseed-preset-actions.ts` — an in-place write INSIDE
  //     `mutateNode`'s origin-tagged transact (the sanctioned multi-field seam).

  // ── DEBT: a USER GESTURE that should be undoable and synced ────────────────
  // Every entry below is a card click handler writing straight to the store.
  // The edit is NOT undoable and does NOT ride the LOCAL_ORIGIN tag, so a
  // collaborator can miss it and Ctrl-Z steps over it. Each is a one-line fix
  // (`setNodeParam(id, key, v)`), but each also changes undo/sync SEMANTICS for
  // a shipped control, so they are drained deliberately rather than in bulk
  // under a gate PR. FilterCard was drained in the PR that widened this guard.
  'ui/modules/AcidwarpCard.svelte': {
    keys: ['scene', 'freeze', 'paletteType'],
    kind: 'debt',
    why: 'card button writes — user gesture, should be undoable + synced',
  },
  'ui/modules/ChromaCard.svelte': {
    keys: ['tintR', 'tintG', 'tintB'],
    kind: 'debt',
    why: 'colour-picker write — user gesture, should be undoable + synced',
  },
  'ui/modules/ChromakeyCard.svelte': {
    keys: ['keyR', 'keyG', 'keyB'],
    kind: 'debt',
    why: 'colour-picker write — user gesture, should be undoable + synced',
  },
  'ui/modules/CloudsCard.svelte': {
    keys: ['freeze'],
    kind: 'debt',
    why: 'card button write — user gesture, should be undoable + synced',
  },
  'ui/modules/DoomCard.svelte': {
    keys: ['fillMode', 'audioGain'],
    kind: 'debt',
    why: 'card control writes — user gesture, should be undoable + synced',
  },
  // ⚠ `ui/modules/GamepadCard.svelte` WAS HERE AND IS PAID (2026-08-24, with
  // the gamepad face). Its entry read *"pad-slot picker write — user gesture,
  // should be undoable + synced"*, and the payment is one line: `setPadIndex`
  // now calls `setNodeParam`, so the slot change rides the Y.Doc transaction
  // with `LOCAL_ORIGIN` and reaches the UndoManager. Cmd-Z could not undo a slot
  // change before this.
  //   ⚠ AND IT IS THE GATEMAIDEN LESSON APPLIED RATHER THAN RE-LEARNED. That
  //   entry's note (below) records #2025 arguing a debt was "paid by
  //   construction" because the module got a FACE. It is not: this ledger is
  //   keyed by CARD PATH and anchored to the source, promotion does not delete
  //   the card, and the per-card VRT sweep still renders it under
  //   `?shell=legacy`. So the face PR paid this one EXPLICITLY, by editing the
  //   card — and only then deleted the row. A face does not pay a card's debt.
  // ⚠ `ui/modules/GatemaidenCard.svelte` WAS HERE AND IS PAID (queue Q53,
  // 2026-08-20). Its entry read *"card button write — user gesture, should be
  // undoable + synced"*, and the payment is the plainest form of it: the shape
  // button now calls the tracked `set('trigShape')` seam instead of poking
  // `patch.nodes[id].params` directly, so the gesture is undoable and reaches
  // collaborators. The raw write is gone from the ARTIFACT and this entry had
  // to go with it.
  //   ⚠ WORTH RECORDING BECAUSE THE ISSUE THAT FILED IT GOT THIS WRONG. #2025
  //   argued the debt was "paid by construction" by FACING the module, on the
  //   reasoning that a faceplate routes the param through the normal path.
  //   That is not what this ledger measures. It is keyed by CARD PATH and
  //   anchored to the source, and promotion does not delete the card — the
  //   per-card VRT sweep still renders it under `?shell=legacy`. The raw write
  //   would have survived the promotion untouched and deleting this entry
  //   without touching the card would have gone RED as a stale exemption.
  //   A face does not pay a card's debt; editing the card does.
  // ⚠ `ui/modules/JoystickCard.svelte` WAS HERE AND IS PAID (queue Q43,
  // 2026-08-19). Its entry read *"joystick drag — per-frame-ish, but it
  // persists; needs the transient-first treatment (midi-cc-write-storm)"*, and
  // that treatment is `createDragCommit` — the same rAF-coalescing pump
  // Fader/Knob/XyPad use. The card now writes through the tracked param path,
  // so the raw write is gone from the ARTIFACT and this entry had to go with it
  // (an entry naming a write that no longer exists is RED).
  //
  // ⚠ `ui/modules/QuadralogicalCard.svelte` BELOW IS THE IDENTICAL PATTERN and
  // is DELIBERATELY LEFT ALONE — `quadralogical` is face-queue Q27 and gated,
  // so its card is not being touched in this wave. Its `why` used to point here
  // ("see JoystickCard"); it now carries the mechanism itself, because a
  // cross-reference to a deleted entry is worse than no cross-reference.
  'ui/modules/LumakeyCard.svelte': {
    keys: ['invert'],
    kind: 'debt',
    why: 'card button write — user gesture, should be undoable + synced',
  },
  'ui/modules/MarblesCard.svelte': {
    keys: ['t_model', 'scale'],
    kind: 'debt',
    why: 'card button writes — user gesture, should be undoable + synced',
  },
  'ui/modules/Moog902VcaCard.svelte': {
    keys: ['mode'],
    kind: 'debt',
    why: 'panel switch write — user gesture, should be undoable + synced',
  },
  'ui/modules/Moog904aVcfCard.svelte': {
    keys: ['range'],
    kind: 'debt',
    why: 'panel switch write — user gesture, should be undoable + synced',
  },
  'ui/modules/Moog904bVcfCard.svelte': {
    keys: ['range'],
    kind: 'debt',
    why: 'panel switch write — user gesture, should be undoable + synced',
  },
  'ui/modules/Moog921VcoCard.svelte': {
    keys: ['sync'],
    kind: 'debt',
    why: 'panel switch write — user gesture, should be undoable + synced',
  },
  'ui/modules/Moog921aCard.svelte': {
    keys: ['freqRange'],
    kind: 'debt',
    why: 'panel switch write — user gesture, should be undoable + synced',
  },
  'ui/modules/Moog921bCard.svelte': {
    keys: ['syncMode'],
    kind: 'debt',
    why: 'panel switch write — user gesture, should be undoable + synced',
  },
  // ⚠ `Moog956Card.svelte` PAID AND REMOVED 2026-09-02, in the promotion PR.
  // The entry read: "ribbon controller — performance gesture; needs the
  // transient-first treatment, not a bare store write", keys `pos` + `gate`.
  // Both halves are now discharged rather than re-argued, and each by the
  // treatment its own remedy named:
  //   * `pos` rides a `createDragCommit` pump — tracked, undoable, synced, one
  //     Y.Doc write per frame — through `ui/modules/moog956/ribbon-actions.ts`,
  //     the seam the card, the lane `tileBody` and the dock `fullViewBody` all
  //     call, so the three surfaces cannot drift apart.
  //   * `gate` stopped being a durable value at all: it is `face.momentary`, so
  //     it goes through `setMomentaryParam` (engine only, panic-latched) and a
  //     press can no longer persist a stuck HIGH gate into the rack.
  // This ledger is anchored to the SOURCE in both directions, so removing the
  // entry without removing the writes would have been red.
  // ⚠ `ui/modules/NibblesCard.svelte` LEFT THIS LEDGER with the nibbles face
  // (its `auto` raw write is now `setNodeParam` in `nibbles-game-actions.ts`,
  // shared by the card and the face's toggle cell). Recorded here rather than
  // deleted silently, because the REASON it had to go with that PR is the
  // interesting part: promotion makes a raw write UNREACHABLE without paying
  // it — the face's cell writes through the sanctioned path, so a player can no
  // longer take the raw one, while the code and this entry both stay GREEN
  // FOREVER describing a path nobody can walk. That is the stale-scoping shape
  // this ledger's anchoring exists to catch, and the owner ruling is explicit:
  // never ledger payable debt, fix it in one sweep.
  'ui/modules/QuadralogicalCard.svelte': {
    keys: ['pos_x', 'pos_y'],
    kind: 'debt',
    why: 'XY pad drag — per-frame-ish, but it persists; needs the transient-first treatment (createDragCommit, as JoystickCard now does). Held: quadralogical is face-queue Q27 and gated.',
  },
  'ui/modules/SamsloopCard.svelte': {
    keys: ['start', 'end', 'mode'],
    kind: 'debt',
    why: 'start/end are load-derived (sanctionable); `mode` is a card button — triage as one when drained',
  },
  'ui/modules/ShapegenCard.svelte': {
    keys: ['solids'],
    kind: 'debt',
    why: 'card button write — user gesture, should be undoable + synced',
  },
  'ui/modules/ShapesCard.svelte': {
    keys: ['shape', 'tile'],
    kind: 'debt',
    why: 'card button writes — user gesture, should be undoable + synced',
  },
  'ui/modules/TempestCard.svelte': {
    keys: ['shape'],
    kind: 'debt',
    why: 'card button write — user gesture, should be undoable + synced',
  },
  'ui/modules/WavesculptCard.svelte': {
    keys: ['pos_x', 'pos_y', 'zoom', 'rot'],
    kind: 'debt',
    why: 'viewport/joystick drags — need the transient-first treatment (cv-modulation-live-store-write-storm)',
  },
  'ui/modules/dx7-patch-actions.ts': {
    keys: ['algorithm', 'feedback'],
    kind: 'debt',
    why: 'preset load writes two params outside the seam while the rest of the voice rides node.data — one recall, two persistence laws',
  },
  'ui/modules/dx7/dx7-panel-actions.ts': {
    keys: ['algorithm', 'feedback'],
    kind: 'debt',
    why: 'as dx7-patch-actions — the operator panel repeats the same split',
  },
  'audio/modules/dx7.ts': {
    keys: ['algorithm', 'feedback'],
    kind: 'debt',
    why: 'as dx7-patch-actions — the factory repeats the same split',
  },
};

/* ⚠ `RAW_WRITE_DEBT_CEILING` (51) IS GONE — 2026-08-12, the no-ratchets sweep,
 *  paying the boy-scout debt the rings-face PR flagged and did not pay.
 *
 *  WHAT IT PROTECTED, traced before deleting rather than assumed: the `<=` half
 *  made a NEW `kind: 'debt'` entry loud. The two unconditional checks either
 *  side of it genuinely do not catch that — `tree ⊆ ledger` only asks that a
 *  write be explained SOMEHOW, and `ledger ⊆ tree` only asks that an
 *  explanation still have a write. Neither reads `kind`.
 *
 *  WHY DELETING IT IS THE RIGHT TRADE ANYWAY: growing the debt bucket already
 *  costs an entry naming the exact `(file, key)`, a `kind: 'debt'` literal and
 *  a `why` string — three reviewable tokens in the diff. The number added a
 *  fourth place to notice the same act, in a file that three concurrent face
 *  branches edit, and it is the construct that auto-merges cleanly and wrongly:
 *  two branches each draining one entry both write 50, and the merged truth is
 *  49 with a slot of slack for the next regression to hide in. No successor
 *  counter is written. Named as dropped protection in the sweep PR's body.
 */

// ── WHOLE-BAG REPLACEMENT (`x.params = …`) ──────────────────────────────────
// A form `RAW_PARAM_WRITE` is structurally unable to see: it matches an
// assignment INTO a bag (`.params[k] =` / `.params.k =`), never a replacement
// OF one. The three shapes below are not one thing, so they are declared one
// by one instead of counted.
//
// This list replaces `WHOLE_BAG_CEILING = 16` (deleted 2026-08-12). The ceiling
// made a 17th site loud; so does this, and it also says WHICH site and WHY,
// while a name that no longer resolves goes RED where a number silently kept
// its slack. `why` is REQUIRED BY THE TYPE, so `tsc` refuses an undeclared
// entry before a test runs.

/** How a whole-bag replacement is classified. */
export type WholeBagKind =
  /** `if (!n.params) n.params = {}` — bag INITIALISATION, not a value edit. */
  | 'init'
  /** A reconciler/proxy SNAPSHOT of a bag, held for later comparison. */
  | 'snapshot'
  /** Not a graph node — the receiver just happens to have a `params` field. */
  | 'not-a-node';

export interface WholeBagEntry {
  /** lib-relative source file. */
  readonly file: string;
  /** The source line VERBATIM (trimmed) — the artifact anchor. Edit the code
   *  and this must move with it, which is the point: it cannot go stale
   *  quietly. */
  readonly code: string;
  readonly kind: WholeBagKind;
  readonly why: string;
}

/**
 * THE COMPLETE inventory of whole-bag `x.params = …` replacements outside
 * `graph/mutate.ts`. Deny-by-default: an undeclared `(file, code)` pair is RED,
 * and an entry matching nothing in the tree is RED.
 *
 * ⚠ STATED SCOPE — what this CANNOT see: a SECOND site in an already-listed
 * file whose source line is character-identical to a listed one (the six
 * `if (!n.params) n.params = {};` initialisers are already such duplicates).
 * That is deliberate — those are the same, already-classified act — but it is
 * the "already-listed file" blindness in miniature, so it is written down
 * rather than left as an assumed property.
 */
export const WHOLE_BAG_WRITES: readonly WholeBagEntry[] = [
  {
    file: 'audio/reconciler.ts',
    code: 'prev.params = { ...node.params };',
    kind: 'snapshot',
    why: 'the reconciler stores last-seen params to diff the NEXT tick against — a read, copied',
  },
  {
    file: 'control/launchpad/launchpad-control.svelte.ts',
    code: 'if (!n.params) n.params = {};',
    kind: 'init',
    why: 'bag initialisation before a tracked write; the write itself goes through the seam',
  },
  {
    file: 'control/monome/monome-control.svelte.ts',
    code: 'if (!n.params) n.params = {};',
    kind: 'init',
    why: 'as launchpad-control — bag initialisation before a tracked write',
  },
  {
    file: 'docs/module-manifest.ts',
    code: 'out.params = synth.params;',
    kind: 'not-a-node',
    why: '`out` is a DOC MANIFEST record being assembled, not a ModuleNode — no Y.Doc, no undo stack',
  },
  {
    file: 'graph/cv-buddy-es9-reconcile.ts',
    code: 'if (!live.params) live.params = {};',
    kind: 'init',
    why: 'bag initialisation on the live node before the ES-9 slot reconcile writes into it',
  },
  {
    file: 'graph/persistence.ts',
    code: 'node.params = {};',
    kind: 'init',
    why: 'load path — a node deserialised without a params bag gets an empty one before hydration',
  },
  {
    file: 'graph/toybox-combine.ts',
    code: 'if (!n.params) n.params = {};',
    kind: 'init',
    why: 'as launchpad-control — bag initialisation before a tracked write',
  },
  {
    file: 'graph/toybox-layers.ts',
    code: 'if (!layer.params) layer.params = {};',
    kind: 'init',
    why: 'as launchpad-control — bag initialisation before a tracked write',
  },
  {
    file: 'graph/toybox-layers.ts',
    code: 'layer.params = { ...params };',
    kind: 'not-a-node',
    why: 'a TOYBOX LAYER is a plain record inside the toybox node’s own data, not a ModuleNode',
  },
  {
    file: 'video/modules/outlines-sim.ts',
    code: 'this.params = p;',
    kind: 'not-a-node',
    why: 'an engine class whose own field happens to be called `params` — no graph node involved',
  },
  {
    file: 'video/toybox-control-params.ts',
    code: 'if (!layer.params) layer.params = {};',
    kind: 'init',
    why: 'as toybox-layers — layer bag initialisation',
  },
  {
    file: 'video/toybox-control-params.ts',
    code: 'if (!n.params) n.params = {};',
    kind: 'init',
    why: 'as launchpad-control — bag initialisation before a tracked write',
  },
  {
    file: 'video/worker/worker-proxy-handle.ts',
    code: 'this.params = { ...opts.node.params };',
    kind: 'snapshot',
    why: 'the worker proxy copies the bag across the postMessage boundary — a read, copied',
  },
];

/** Every `(file, key)` pair in one bucket. */
export function ledgerPairs(kind: RawWriteKind): string[] {
  const out: string[] = [];
  for (const [file, e] of Object.entries(RAW_WRITE_LEDGER)) {
    if (e.kind !== kind) continue;
    for (const k of e.keys) out.push(`${file}:${k}`);
  }
  return out.sort();
}
