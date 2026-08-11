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
// needs to be COUNTED, and a count spread over 40 files cannot be. The ledger
// is deny-by-default in both directions:
//
//   * a write that is in NEITHER bucket and carries NO inline marker → RED;
//   * an entry naming a write that no longer exists → RED (a stale exemption is
//     an exemption nobody is watching — the "anchor the metric to the ARTIFACT"
//     rule); and
//   * the DEBT total is ratcheted with `actual <= CEILING` AND
//     `CEILING - actual === 0`, so a drain that forgets to lower the number is
//     red rather than silent slack absorbing the next regression.
//
// Entries name the PARAM KEY, never a line number: a key survives a refactor,
// so an already-listed file that grows a NEW raw write still fails.

/** How a raw write is classified. */
export type RawWriteKind =
  /** Correct as written: it MUST NOT become a tracked (undoable, synced) write. */
  | 'sanctioned'
  /** Wrong as written: it should route through setNodeParam/mutateNode. Ratcheted. */
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
  'audio/modules/drumseqz.ts': {
    keys: ['isPlaying'],
    kind: 'sanctioned',
    why: 'transport → store reflect; an undoable play/stop tick would storm ydoc + pollute undo',
  },
  'audio/modules/macseq.ts': {
    keys: ['isPlaying'],
    kind: 'sanctioned',
    why: 'transport → store reflect (see drumseqz)',
  },
  'audio/modules/polyseqz.ts': {
    keys: ['isPlaying'],
    kind: 'sanctioned',
    why: 'transport → store reflect (see drumseqz)',
  },
  'audio/modules/score.ts': {
    keys: ['isPlaying'],
    kind: 'sanctioned',
    why: 'transport → store reflect (see drumseqz)',
  },
  'audio/modules/sequencer.ts': {
    keys: ['isPlaying'],
    kind: 'sanctioned',
    why: 'transport → store reflect (see drumseqz)',
  },
  'audio/modules/writeseq.ts': {
    keys: ['isPlaying', 'recArm'],
    kind: 'sanctioned',
    why: 'transport + record-arm → store reflect (see drumseqz)',
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
  'ui/modules/GamepadCard.svelte': {
    keys: ['padIndex'],
    kind: 'debt',
    why: 'pad-slot picker write — user gesture, should be undoable + synced',
  },
  'ui/modules/GatemaidenCard.svelte': {
    keys: ['trigShape'],
    kind: 'debt',
    why: 'card button write — user gesture, should be undoable + synced',
  },
  'ui/modules/JoystickCard.svelte': {
    keys: ['pos_x', 'pos_y'],
    kind: 'debt',
    why: 'joystick drag — per-frame-ish, but it persists; needs the transient-first treatment (midi-cc-write-storm)',
  },
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
  'ui/modules/Moog956Card.svelte': {
    keys: ['pos', 'gate'],
    kind: 'debt',
    why: 'ribbon controller — performance gesture; needs the transient-first treatment, not a bare store write',
  },
  'ui/modules/NibblesCard.svelte': {
    keys: ['auto'],
    kind: 'debt',
    why: 'card button write — user gesture, should be undoable + synced',
  },
  'ui/modules/QuadralogicalCard.svelte': {
    keys: ['pos_x', 'pos_y'],
    kind: 'debt',
    why: 'joystick drag — see JoystickCard',
  },
  'ui/modules/RasterizeCard.svelte': {
    keys: ['wrap'],
    kind: 'debt',
    why: 'card button write — user gesture, should be undoable + synced',
  },
  'ui/modules/SamsloopCard.svelte': {
    keys: ['start', 'end', 'mode'],
    kind: 'debt',
    why: 'start/end are load-derived (sanctionable); `mode` is a card button — triage as one when drained',
  },
  'ui/modules/ScopeCard.svelte': {
    keys: ['mode'],
    kind: 'debt',
    why: 'XY-mode toggle — user gesture, should be undoable + synced',
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
  'ui/modules/SlewSwitchCard.svelte': {
    keys: ['mode', 'length'],
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

/** The DEBT ceiling: the number of `(file, key)` pairs still owed a fix.
 *  ⚠ IT ONLY SHRINKS, and the test asserts BOTH `actual <= CEILING` and
 *  `CEILING - actual === 0` — a drain that forgets to lower this number is red,
 *  not silent slack. Was 53 before `FilterCard`'s `mode` was routed through
 *  `setNodeParam` (the PR that widened the guard; ledger defect #7). */
export const RAW_WRITE_DEBT_CEILING = 52;

/** Every `(file, key)` pair in one bucket. */
export function ledgerPairs(kind: RawWriteKind): string[] {
  const out: string[] = [];
  for (const [file, e] of Object.entries(RAW_WRITE_LEDGER)) {
    if (e.kind !== kind) continue;
    for (const k of e.keys) out.push(`${file}:${k}`);
  }
  return out.sort();
}
