// packages/web/src/lib/ui/modules/midi-lane-cell-actions.ts
//
// The MIDI LANE faceplate's cell seams — the module-owned end of every ranked
// cell, kept out of `shell-cells.ts` so the shared registry imports one file
// per module rather than the module's whole world.
//
// ── WHY EVERY WRITE IS A PAIR ───────────────────────────────────────────────
//
// This module declares `params: []`. Every setting it has lives in TWO places
// at once and both have to move together:
//
//   * the ENGINE's closure state, which is what the live MIDI handler actually
//     reads (`channelSet`, `mode`, `priority`, `retrig`, `noteGateNote`), and
//   * `node.data`, which is what survives a reload and syncs to collaborators.
//
// Writing only the first is a setting that works until you refresh; writing
// only the second is a setting that does nothing until you refresh. The card
// has always done both (`getApi()?.setChannels(next)` beside `writeData(…)`)
// and so does every helper here.
//
// ⚠ THE PERSISTENCE HALF GOES THROUGH `mutateNode`, NOT A BARE PROXY WRITE, and
// that is a fix rather than a transcription. `MidiLaneCard.svelte`'s `writeData`
// assigns straight onto the SyncedStore proxy — no `transact`, no
// `LOCAL_ORIGIN` — so every one of this module's settings syncs to
// collaborators and is INVISIBLE TO Cmd-Z, because `mutate.guard`'s patterns
// anchor on `.params` and these touch `.data`. midiclock found the identical
// defect on promotion (#2187 D1). The faceplate's writes are undoable from the
// day it ships; the card keeps its own path until someone is in that file for
// another reason.
//
// ⚠ THE ACTIONS TAKE A `nodeId` AND RESOLVE THE ENGINE THEMSELVES, and this is
// the shipped idiom rather than a workaround. `ShellCellEnv.engine` is typed
// structurally as `{ write(...) }` — there is NO `read` on it — and every seam
// here needs a read (`read(node, 'card-api')`). `getActiveEngine()` is the
// general route and `shell-cells.ts` names it twice as the reason an action
// needs no `env` at all.

import { getActiveEngine } from '$lib/audio/engine-ref';
import { patch } from '$lib/graph/store';
import { mutateNode } from '$lib/graph/mutate';
import { recordAudition } from '$lib/ui/modules/audition-ledger';
import type { ModuleNode } from '$lib/graph/types';
import type { VoicePriority } from '$lib/audio/modules/midi-cv-buddy';
import {
  channelsForChoice,
  choiceForChannels,
  noteGateNoteText,
  type LaneMode,
  type MidiLaneApi,
  type MidiLaneData,
} from '$lib/audio/modules/midi-lane';

/** The live card-api handle for a midiLane node, or null when the engine is not
 *  up / the node is gone / the handle does not answer the read key. */
export function midiLaneApi(nodeId: string): MidiLaneApi | null {
  const engine = getActiveEngine();
  if (!engine) return null;
  const node = patch.nodes[nodeId] as ModuleNode | undefined;
  if (!node) return null;
  return (engine.read(node, 'card-api') as MidiLaneApi | undefined) ?? null;
}

/** The saved settings on a node, with nothing assumed about their presence. */
function savedData(node: ModuleNode | undefined): Partial<MidiLaneData> {
  return (node?.data ?? {}) as Partial<MidiLaneData>;
}

/** Persist one or more settings, through the undo-aware seam. */
function writeData(nodeId: string, values: Partial<MidiLaneData>): void {
  mutateNode(nodeId, (live) => {
    if (!live.data) live.data = {};
    for (const [k, v] of Object.entries(values)) {
      (live.data as Record<string, unknown>)[k] = v as unknown;
    }
  });
}

// ── CHANNEL ────────────────────────────────────────────────────────────────

export function midiLaneChannelValue(node: ModuleNode | undefined): string {
  return choiceForChannels(savedData(node).channels ?? null);
}

export function midiLaneSetChannel(nodeId: string, choice: string): void {
  const channels = channelsForChoice(choice);
  midiLaneApi(nodeId)?.setChannels(channels);
  writeData(nodeId, { channels });
}

// ── MODE ───────────────────────────────────────────────────────────────────

export function midiLaneModeValue(node: ModuleNode | undefined): string {
  return savedData(node).mode ?? 'mono';
}

export function midiLaneSetMode(nodeId: string, value: string): void {
  const mode = (value === 'poly' ? 'poly' : 'mono') satisfies LaneMode as LaneMode;
  midiLaneApi(nodeId)?.setMode(mode);
  writeData(nodeId, { mode });
}

// ── VOICE PRIORITY ─────────────────────────────────────────────────────────

/** The three priorities the engine's `pickWinner` implements. Named here
 *  because `VoicePriority` is a TYPE — there is no runtime array to import —
 *  and the roster must agree with it or a picked value reaches `pickWinner`
 *  as something it has no branch for. `tsc` checks that agreement: the array is
 *  typed `VoicePriority[]`, so adding a name the union does not have is a
 *  compile error rather than a runtime shrug. */
const LANE_PRIORITIES: ReadonlyArray<{ value: VoicePriority; label: string }> = [
  { value: 'last', label: 'LAST' },
  { value: 'low', label: 'LOW' },
  { value: 'high', label: 'HIGH' },
];

export function midiLanePriorityOptions(): Array<{ value: string; label: string }> {
  return LANE_PRIORITIES.map((p) => ({ value: p.value, label: p.label }));
}

export function midiLanePriorityValue(node: ModuleNode | undefined): string {
  return savedData(node).priority ?? 'last';
}

export function midiLaneSetPriority(nodeId: string, value: string): void {
  const priority = (LANE_PRIORITIES.find((p) => p.value === value)?.value ?? 'last');
  midiLaneApi(nodeId)?.setPriority(priority);
  writeData(nodeId, { priority });
}

// ── RETRIGGER ──────────────────────────────────────────────────────────────

export function midiLaneRetrigValue(node: ModuleNode | undefined): boolean {
  return savedData(node).retrig ?? true;
}

export function midiLaneSetRetrig(nodeId: string, on: boolean): void {
  midiLaneApi(nodeId)?.setRetrig(on);
  writeData(nodeId, { retrig: on });
}

// ── THE BY-NOTE GATE'S NOTE ────────────────────────────────────────────────

/** The text the typed field shows at rest — the user's own stored note, round-
 *  tripped by the module's own speller. Never a formatter over a derived
 *  quantity: this IS the stored value, which is what makes the field's resting
 *  string an `authored-entry` rather than a readout. */
export function midiLaneNoteText(node: ModuleNode | undefined): string {
  return noteGateNoteText(savedData(node).noteGateNote ?? 36);
}

/** Called ONLY with a value `parseNoteGateNote` already accepted — the shell
 *  never hands a module raw text, so there is no clamp to express here. */
export function midiLaneSetNote(nodeId: string, note: number): void {
  midiLaneApi(nodeId)?.setNoteGateNote(note);
  writeData(nodeId, { noteGateNote: note });
}

// ── THE PERMISSION GESTURE ─────────────────────────────────────────────────

/**
 * Ask the browser for Web MIDI on this node's behalf.
 *
 * ⚠ RETURNS WHETHER THE SEAM WAS REACHED, and records it. An ACTION cell writes
 * nothing to the graph, so `readParam`/`readData` are structurally blind to it
 * and a click on a dead button is indistinguishable from a click on a live one.
 * `delivered: false` is recorded, never dropped.
 *
 * ⚠ THE LEDGER RECORD IS WRITTEN SYNCHRONOUSLY, BEFORE THE `void`. `connect()`
 * returns a promise that can sit for a long time when the browser quietly
 * suppresses its own permission prompt. `delivered` is not about that OUTCOME,
 * it is about whether the press reached a callable at all, which is knowable
 * the instant the handle answers the read key. A probe that waited for the
 * grant would be asserting "this CI runner has MIDI hardware", which no runner
 * does.
 */
export function midiLaneConnect(nodeId: string): boolean {
  const api = midiLaneApi(nodeId);
  if (!api) {
    recordAudition({ nodeId, seam: 'engine-message', delivered: false });
    return false;
  }
  recordAudition({ nodeId, seam: 'engine-message', delivered: true });
  // Fire-and-forget: `connect()` owns its own outcome reporting through the
  // subscriber, and MUST be called synchronously from the user gesture — an
  // `await` above `requestMIDIAccess` spends the user activation and Chromium
  // then refuses to prompt at all.
  void api.connect();
  return true;
}

// ── THE CC TAPS ────────────────────────────────────────────────────────────
//
// ⚠ LEARN IS AN AUDITION AND CLEAR IS **ALSO** AN AUDITION, and the second one
// is worth stating because it looks like it could be a `data` probe. Clearing
// tap A does write `node.data.ccA = null` — but the write is a MIRROR of the
// engine's assignment, not the assignment itself: the authority is the engine
// closure's `ccA`, and `setCcA(null)` is what actually stops the tap following
// a controller. A `data` probe would pass on a build where the persistence
// write survived and the engine call did not, which is the exact caller→seam
// gap the ledger exists to close. Both halves still run; only the OBSERVABLE is
// the audition.

export function midiLaneLearnCcA(nodeId: string): boolean {
  const api = midiLaneApi(nodeId);
  if (!api) {
    recordAudition({ nodeId, seam: 'engine-message', delivered: false });
    return false;
  }
  recordAudition({ nodeId, seam: 'engine-message', delivered: true });
  api.learnCcA();
  return true;
}

export function midiLaneLearnCcB(nodeId: string): boolean {
  const api = midiLaneApi(nodeId);
  if (!api) {
    recordAudition({ nodeId, seam: 'engine-message', delivered: false });
    return false;
  }
  recordAudition({ nodeId, seam: 'engine-message', delivered: true });
  api.learnCcB();
  return true;
}

export function midiLaneClearCcA(nodeId: string): boolean {
  const api = midiLaneApi(nodeId);
  writeData(nodeId, { ccA: null });
  if (!api) {
    recordAudition({ nodeId, seam: 'engine-message', delivered: false });
    return false;
  }
  recordAudition({ nodeId, seam: 'engine-message', delivered: true });
  api.setCcA(null);
  return true;
}

export function midiLaneClearCcB(nodeId: string): boolean {
  const api = midiLaneApi(nodeId);
  writeData(nodeId, { ccB: null });
  if (!api) {
    recordAudition({ nodeId, seam: 'engine-message', delivered: false });
    return false;
  }
  recordAudition({ nodeId, seam: 'engine-message', delivered: true });
  api.setCcB(null);
  return true;
}
