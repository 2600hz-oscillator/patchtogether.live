// packages/web/src/lib/ui/modules/midi-cv-buddy-cell-actions.ts
//
// The MIDI-CV-BUDDY faceplate's cell seams — the module-owned end of every
// ranked cell, kept out of `shell-cells.ts` so the shared registry imports one
// file per module rather than the module's whole world.
//
// ── WHY EVERY WRITE IS A PAIR ───────────────────────────────────────────────
//
// This module declares `params: []`. Every setting it has lives in TWO places
// at once and both have to move together:
//
//   * the ENGINE's closure state, which is what the live MIDI handler actually
//     reads (`channel`, `priority`, `retrig`), and
//   * `node.data`, which is what survives a reload and syncs to collaborators.
//
// Writing only the first is a setting that works until you refresh; writing
// only the second is a setting that does nothing until you refresh. The card
// has always done both (`getApi()?.setChannel(ch)` beside `writeData(…)`) and
// so does every helper here.
//
// ⚠ THE PERSISTENCE HALF GOES THROUGH `mutateNode`, NOT A BARE PROXY WRITE, and
// that is a fix rather than a transcription. `MidiCvBuddyCard.svelte`'s
// `writeData` assigns straight onto the SyncedStore proxy — no `transact`, no
// `LOCAL_ORIGIN` — so every one of this module's settings syncs to
// collaborators and is INVISIBLE TO Cmd-Z, because `mutate.guard`'s patterns
// anchor on `.params` and these touch `.data`. midiclock (#2187 D1) and
// midiLane both found the identical defect on promotion.
//
// ⚠ THE CHANNEL KEY IS `midiInChannel`, NEVER `channel`. `data.channel` is the
// workflow channel-column reconciler's MEMBERSHIP TRUTH, and writing a MIDI
// channel into it ejects the module from its lane or teleports it into
// another's. `midi-cv-buddy.ts`'s `midiInChannelOf` carries the full
// measurement; this file is the surface that must not re-introduce it.
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
import {
  channelForChoice,
  choiceForChannel,
  midiInChannelOf,
  priorityForChoice,
  type MidiCvBuddyApi,
  type MidiCvBuddyData,
} from '$lib/audio/modules/midi-cv-buddy';

/** The live card-api handle for a midiCvBuddy node, or null when the engine is
 *  not up / the node is gone / the handle does not answer the read key. */
export function midiCvBuddyApi(nodeId: string): MidiCvBuddyApi | null {
  const engine = getActiveEngine();
  if (!engine) return null;
  const node = patch.nodes[nodeId] as ModuleNode | undefined;
  if (!node) return null;
  return (engine.read(node, 'card-api') as MidiCvBuddyApi | undefined) ?? null;
}

/** The saved settings on a node, with nothing assumed about their presence. */
function savedData(node: ModuleNode | undefined): Partial<MidiCvBuddyData> {
  return (node?.data ?? {}) as Partial<MidiCvBuddyData>;
}

/** Persist one or more settings, through the undo-aware seam. */
function writeData(nodeId: string, values: Partial<MidiCvBuddyData>): void {
  mutateNode(nodeId, (live) => {
    if (!live.data) live.data = {};
    for (const [k, v] of Object.entries(values)) {
      (live.data as Record<string, unknown>)[k] = v as unknown;
    }
  });
}

// ── CHANNEL ────────────────────────────────────────────────────────────────

export function midiCvBuddyChannelValue(node: ModuleNode | undefined): string {
  return choiceForChannel(midiInChannelOf(savedData(node)));
}

export function midiCvBuddySetChannel(nodeId: string, choice: string): void {
  const channel = channelForChoice(choice);
  midiCvBuddyApi(nodeId)?.setChannel(channel);
  writeData(nodeId, { midiInChannel: channel });
}

// ── VOICE PRIORITY ─────────────────────────────────────────────────────────

export function midiCvBuddyPriorityValue(node: ModuleNode | undefined): string {
  return savedData(node).priority ?? 'last';
}

export function midiCvBuddySetPriority(nodeId: string, value: string): void {
  const priority = priorityForChoice(value);
  midiCvBuddyApi(nodeId)?.setPriority(priority);
  writeData(nodeId, { priority });
}

// ── RETRIGGER ──────────────────────────────────────────────────────────────

export function midiCvBuddyRetrigValue(node: ModuleNode | undefined): boolean {
  return savedData(node).retrig ?? true;
}

export function midiCvBuddySetRetrig(nodeId: string, on: boolean): void {
  midiCvBuddyApi(nodeId)?.setRetrig(on);
  writeData(nodeId, { retrig: on });
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
export function midiCvBuddyConnect(nodeId: string): boolean {
  const api = midiCvBuddyApi(nodeId);
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
