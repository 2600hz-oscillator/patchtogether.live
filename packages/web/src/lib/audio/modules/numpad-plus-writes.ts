// packages/web/src/lib/audio/modules/numpad-plus-writes.ts
//
// THE ONE WRITE SEAM for NUMPAD+'s `node.data` — the recorded music
// (`data.layers`) and the player's own keyboard layout (`data.keymap`).
//
// `numpad-plus.ts` owns the arithmetic and the engine; this file owns the
// WRITES. Four surfaces call it — the legacy card, the faceplate's step-grid
// panel, its keymap panel, and the FACTORY's live recording path — which is
// what makes "the recorded write and the clicked write take the same path" a
// property of the code rather than a thing to re-verify.
//
// ==========================================================================
// THREE DEFECTS THIS FILE EXISTS TO CLOSE
// ==========================================================================
//
// (1) ⚠ ARM + PLAY ERASED A LAYER AND Cmd-Z COULD NOT BRING IT BACK.
//     `tick()`'s play-from-start branch calls `clearLayer(activeLayerIndex())`
//     — sixteen steps gone — and that helper mutated `live.data` through the
//     bare SyncedStore proxy: no transaction, no origin, therefore no undo
//     entry. Data loss on the module's HEADLINE workflow.
//
// (2) EVERY STEP EDIT AND EVERY REMAP WAS OUTSIDE Cmd-Z, VIA A `transact` WITH
//     NO ORIGIN. `NumpadPlusCard.svelte`'s `setStep` and `writeKeymap` both
//     opened `ydoc.transact(fn)` and both omitted the origin argument.
//     `store.ts` configures the UndoManager with
//     `trackedOrigins: new Set([LOCAL_ORIGIN])`, so an untagged transaction
//     (origin `null`) is silently not captured. Three lines away in the same
//     card, `setNodeParam` was correctly tagged — so the BPM knob was undoable
//     and the sequence was not.
//
//     ⚠ A bare proxy write reads as sloppy; a `ydoc.transact` reads as careful.
//     They are equally un-undoable and only one of them survives a review.
//     No gate could see either: `mutate.guard.test.ts` anchors its regex on the
//     literal token `.params`, and this module's instrument lives in `.data`.
//
//     Everything here routes `mutateNode`, which defaults to `LOCAL_ORIGIN`.
//
// (3) ONE CELL CLICK REWROTE ALL FOUR LAYERS — AND SO DID EVERY RECORDED
//     KEYPRESS. Three sites deep-cloned the whole `4 x 16` structure and
//     reassigned it (`d.layers = cur.map((l) => l.map((s) => ({ ...s })))`).
//     In a multiplayer rack two collaborators recording into DIFFERENT layers
//     of the same node overwrote each other by last-writer-wins, and during
//     OVERDUB the whole-structure rewrite fired at performance rate.
//
// ==========================================================================
// ⚠ WHAT IS AND IS NOT ASSIGNABLE — MEASURED against the real store, not
// inherited from kria's note. THE SHAPES DIFFER AND SO DO THE ANSWERS.
// ==========================================================================
// kria stores PARALLEL SCALAR LANES (`track.trig` is a Y.Array of booleans),
// so its granular write is a per-step `splice`. NUMPAD+ stores an ARRAY OF
// OBJECTS, and a step object is its own Y.Map — which is strictly better:
//
//   `layers[l][s].on = true`     WORKS, and the transaction's `changed` set
//                                has size 1 — ONE Y type per recorded note.
//   `layers[l][s] = {...}`       THROWS "array assignment is not implemented
//                                / supported" — a layer is a live Y.Array.
//   `layers[l].splice(s, 1, v)`  WORKS (the fallback for a corrupt element).
//   `step.midis = [60, 64]`      WORKS, including REASSIGNING an existing one.
//   `delete step.midis`          WORKS — how a poly step becomes mono again.
//   `data.layers = defaultLayers()`  WORKS even over an already-integrated
//                                Y.Array. That is the SEED path and the one
//                                place a whole-structure assignment is right.
//   seeding and reading back INSIDE one transaction WORKS.
//
// So the granular write is a per-key assignment on the step's own Y.Map, and
// no persistence migration is required.

import { mutateNode } from '$lib/graph/mutate';
// `patch` is a LIVE ESM binding that `bindRackspace()` reassigns when the user
// enters a different rackspace, so every read goes through the binding rather
// than a captured copy — the same reason `mutate.ts` imports it that way.
import { patch as livePatch } from '$lib/graph/store';
import { coerceToNoteStep, type NoteStep } from '$lib/audio/note-entry';
import {
  DEFAULT_KEYMAP,
  NUMPAD_OCTAVE_MAX,
  NUMPAD_OCTAVE_MIN,
  NUMPAD_PLUS_LAYERS,
  NUMPAD_PLUS_STEPS,
  defaultLayer,
  defaultLayers,
} from './numpad-plus';

/**
 * The origin for the FACTORY's LIVE RECORDING write — a deliberately
 * NON-TRACKED origin, so a recorded keypress does not land on Cmd-Z.
 *
 * ⚠ THE DISTINCTION IS THE POINT, and it is the axis `mutate.ts` exposes
 * rather than a boolean. A key held down during OVERDUB writes a step on every
 * press, several times a second, with no gesture on the graph at all — pushing
 * an undo entry per note is the #719 storm class the ledger's `sanctioned`
 * bucket exists for. What a player means by "undo" here is the EDIT they made
 * with a pointer, and that is what stays on the stack.
 *
 * ⚠ `clearNumpadLayer` is NOT this. It is one destructive act from one user
 * gesture (pressing PLAY with ARM lit erases sixteen steps), so it takes the
 * DEFAULT origin and IS undoable — which is defect (1) above.
 */
export const NUMPAD_RECORD_ORIGIN = Symbol('numpad-plus-record');

/** Clamp a layer index into range. Pure. */
export function numpadLayerIndex(n: unknown): number {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(NUMPAD_PLUS_LAYERS - 1, v));
}

/** Clamp a step index into range. Pure. */
export function numpadStepIndex(n: unknown): number {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(NUMPAD_PLUS_STEPS - 1, v));
}

type Bag = Record<string, unknown>;

/**
 * Ensure `data.layers` exists and is the right SHAPE, and return the LIVE
 * outer array (a Y.Array proxy) to mutate in place.
 *
 * Seeding assigns a whole plain structure, which is the one place a
 * whole-object write is correct: there is nothing there to merge with.
 */
function liveLayers(d: Bag): unknown[] | null {
  const cur = d.layers;
  const wellFormed =
    Array.isArray(cur)
    && cur.length === NUMPAD_PLUS_LAYERS
    && cur.every((l) => Array.isArray(l) && l.length === NUMPAD_PLUS_STEPS);
  if (!wellFormed) d.layers = defaultLayers();
  const live = d.layers;
  return Array.isArray(live) ? (live as unknown[]) : null;
}

/** Write one step's fields onto its LIVE Y.Map, touching only what differs. */
function writeStepDiff(live: Bag, next: NoteStep): void {
  if (live.on !== next.on) live.on = next.on;
  if (live.midi !== next.midi) live.midi = next.midi;
  const want = next.midis;
  const have = live.midis;
  if (!want || want.length === 0) {
    if (have !== undefined) delete live.midis;
    return;
  }
  const same =
    Array.isArray(have)
    && have.length === want.length
    && want.every((m, i) => (have as unknown[])[i] === m);
  if (!same) live.midis = [...want];
}

/**
 * Set one step of one layer.
 *
 * The write is GRANULAR — it reaches the step's own Y.Map and assigns only the
 * keys that changed — so peer A recording into layer 3 no longer transmits
 * (and therefore no longer overwrites) peer B's layer-1 edit.
 *
 * @param origin transaction origin. Omitted = `LOCAL_ORIGIN` (undoable), which
 *   is what every POINTER edit passes. The factory's live recording passes
 *   `NUMPAD_RECORD_ORIGIN`.
 */
export function setNumpadStep(
  nodeId: string,
  layerIdx: number,
  stepIdx: number,
  next: NoteStep,
  options: { origin?: unknown } = {},
): void {
  const l = numpadLayerIndex(layerIdx);
  const s = numpadStepIndex(stepIdx);
  mutateNode(
    nodeId,
    (node) => {
      if (!node.data) node.data = {};
      const layers = liveLayers(node.data as Bag);
      const layer = layers?.[l];
      if (!Array.isArray(layer)) return;
      const step = (layer as unknown[])[s];
      if (!step || typeof step !== 'object' || Array.isArray(step)) {
        // Corrupt element on an older save — a layer is a live Y.Array, so an
        // index ASSIGNMENT throws; splice is the replacement that works.
        (layer as unknown[]).splice(s, 1, { ...next });
        return;
      }
      writeStepDiff(step as Bag, next);
    },
    options,
  );
}

/**
 * Toggle one step of one layer on/off, keeping (or seeding) its note.
 *
 * The seeded note is the octave's C — the same arithmetic the legacy card's
 * `toggleStep` used, kept in ONE place so the card and the panel cannot
 * disagree about what a freshly lit step plays.
 */
export function toggleNumpadStep(
  nodeId: string,
  layerIdx: number,
  stepIdx: number,
  octave: number,
): void {
  const l = numpadLayerIndex(layerIdx);
  const s = numpadStepIndex(stepIdx);
  const cur = readNumpadStep(nodeId, l, s);
  setNumpadStep(nodeId, l, s, {
    ...cur,
    on: !cur.on,
    midi: cur.midi ?? numpadDefaultMidi(octave),
  });
}

/** The MIDI note a freshly lit step takes: C of the module's current octave. */
export function numpadDefaultMidi(octave: number): number {
  const o = Math.max(NUMPAD_OCTAVE_MIN, Math.min(NUMPAD_OCTAVE_MAX, Math.round(Number(octave) || 0)));
  return (o + 1) * 12;
}

/** Nudge one step's note by `semitones`, clamped to the storable note range.
 *  A step that is OFF is turned ON by the drag, which is what makes the grid a
 *  picture-you-EDIT rather than a picture-you-toggle. */
export function nudgeNumpadStepNote(
  nodeId: string,
  layerIdx: number,
  stepIdx: number,
  semitones: number,
  octave: number,
): void {
  const l = numpadLayerIndex(layerIdx);
  const s = numpadStepIndex(stepIdx);
  const cur = readNumpadStep(nodeId, l, s);
  const base = cur.midi ?? numpadDefaultMidi(octave);
  const midi = clampStorableMidi(base + Math.round(semitones));
  if (cur.on && cur.midi === midi) return;
  // A dragged note is MONO by definition — it replaces whatever chord was
  // recorded, so the poly voices go with it rather than being left stale.
  setNumpadStep(nodeId, l, s, { on: true, midi });
}

/** The MIDI range a `NoteStep` can actually STORE (`coerceToNoteStep` nulls
 *  anything outside it), so a hand-edited note never lands out of range. */
const STORABLE_MIN = 12;
const STORABLE_MAX = 108;
function clampStorableMidi(m: number): number {
  return Math.max(STORABLE_MIN, Math.min(STORABLE_MAX, Math.round(m)));
}

/** Read one canonical step off the live node (never null). */
export function readNumpadStep(nodeId: string, layerIdx: number, stepIdx: number): NoteStep {
  return coerceToNoteStep(rawStep(nodeId, numpadLayerIndex(layerIdx), numpadStepIndex(stepIdx)));
}

function rawStep(nodeId: string, l: number, s: number): unknown {
  // Imported lazily through the same live binding `mutateNode` uses, so a
  // rackspace swap cannot leave this reading a dead doc.
  const nodes = (livePatchNodes() ?? {}) as Record<string, { data?: unknown } | undefined>;
  const layers = (nodes[nodeId]?.data as Bag | undefined)?.layers;
  if (!Array.isArray(layers)) return undefined;
  const layer = (layers as unknown[])[l];
  return Array.isArray(layer) ? (layer as unknown[])[s] : undefined;
}

/**
 * CLEAR one layer — the destructive half of REC ARM.
 *
 * ⚠ UNDOABLE, deliberately, and that is defect (1). Arming REC and pressing
 * PLAY erases sixteen steps in one act, and until this seam existed Cmd-Z could
 * not bring them back.
 *
 * Written IN PLACE, step by step, rather than by splicing the layer out of the
 * outer array: an in-place reset never deletes a live Y type, and it keeps the
 * blast radius to the sixteen step maps of ONE layer, so a collaborator
 * recording into a different layer is untouched. Steps already at rest are
 * skipped, so clearing an EMPTY layer writes nothing at all and opens no undo
 * entry for a gesture that changed nothing.
 */
export function clearNumpadLayer(nodeId: string, layerIdx: number): void {
  const l = numpadLayerIndex(layerIdx);
  const rest = defaultLayer()[0]!;
  mutateNode(nodeId, (node) => {
    if (!node.data) node.data = {};
    const layers = liveLayers(node.data as Bag);
    const layer = layers?.[l];
    if (!Array.isArray(layer)) return;
    for (let s = 0; s < NUMPAD_PLUS_STEPS; s++) {
      const step = (layer as unknown[])[s];
      if (!step || typeof step !== 'object' || Array.isArray(step)) {
        (layer as unknown[]).splice(s, 1, { ...rest });
        continue;
      }
      writeStepDiff(step as Bag, rest);
    }
  });
}

// ── THE KEYMAP ──────────────────────────────────────────────────────────────

/**
 * Replace the keymap with `next`, writing only the bindings that differ.
 *
 * `remapKeymap` returns a whole new map because it has to keep the bijection
 * (freeing the note's old key AND the key's old note), but the WRITE does not
 * have to be whole: a remap moves two or three entries and this transmits two
 * or three keys.
 */
export function setNumpadKeymap(nodeId: string, next: Readonly<Record<string, number>>): void {
  mutateNode(nodeId, (node) => {
    if (!node.data) node.data = {};
    const d = node.data as Bag;
    const cur = d.keymap;
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) {
      d.keymap = { ...next };
      return;
    }
    const live = cur as Record<string, number>;
    for (const code of Object.keys(live)) {
      if (!(code in next)) delete live[code];
    }
    for (const [code, st] of Object.entries(next)) {
      if (live[code] !== st) live[code] = st;
    }
  });
}

/** The live keymap for a node, falling back to the default layout. */
export function readNumpadKeymap(nodeId: string): Readonly<Record<string, number>> {
  const nodes = (livePatchNodes() ?? {}) as Record<string, { data?: unknown } | undefined>;
  const raw = (nodes[nodeId]?.data as { keymap?: unknown } | undefined)?.keymap;
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, number>)
    : DEFAULT_KEYMAP;
}

function livePatchNodes(): unknown {
  return livePatch?.nodes;
}
