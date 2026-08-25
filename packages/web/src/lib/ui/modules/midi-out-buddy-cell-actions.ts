// packages/web/src/lib/ui/modules/midi-out-buddy-cell-actions.ts
//
// The MIDI-OUT-BUDDY faceplate's cell seams — the module-owned end of both
// ranked cells, kept out of `shell-cells.ts` so the shared registry imports one
// file per module rather than the module's whole world.
//
// ── WHY THE WRITE IS A PAIR ─────────────────────────────────────────────────
//
// This module declares `params: []`. The send channel lives in TWO places at
// once and both have to move together: the ENGINE's closure state, which is
// what the note sender actually stamps into every status byte, and `node.data`,
// which is what survives a reload and syncs to collaborators. Writing only the
// first is a setting that works until you refresh; writing only the second is a
// setting that does nothing until you refresh.
//
// ⚠ THE KEY IS `midiOutChannel`, NEVER `channel` (#1168). `data.channel` is the
// workflow channel-column reconciler's MEMBERSHIP TRUTH — writing a MIDI
// channel into it silently REASSIGNS THE MODULE'S LANE and drops its clip
// assignment. The def's own `MidiOutBuddyData` header carries the full
// argument. This file is the second surface that must not re-introduce it, and
// the sibling module's promotion found the same collision live on the INPUT
// side, where it had never been fixed.
//
// ⚠ THE PERSISTENCE HALF GOES THROUGH `mutateNode`, NOT A BARE PROXY WRITE.
// `MidiOutBuddyCard.svelte`'s `writeData` assigns straight onto the SyncedStore
// proxy — no `transact`, no `LOCAL_ORIGIN` — so picking a channel or a device
// syncs to collaborators and is INVISIBLE TO Cmd-Z (`mutate.guard`'s patterns
// anchor on `.params` and these touch `.data`). midiclock (#2187 D1) and
// midiLane both found the identical defect on promotion.
//
// ⚠ THE ACTION TAKES A `nodeId` AND RESOLVES THE ENGINE ITSELF —
// `ShellCellEnv.engine` carries `write` and nothing else, and this seam needs a
// READ (`read(node, 'card-api')`). `getActiveEngine()` is the general route.

import { getActiveEngine } from '$lib/audio/engine-ref';
import { patch } from '$lib/graph/store';
import { mutateNode } from '$lib/graph/mutate';
import { recordAudition } from '$lib/ui/modules/audition-ledger';
import type { ModuleNode } from '$lib/graph/types';
import {
  channelForChoice,
  effectiveMidiOutChannel,
  type MidiOutBuddyApi,
  type MidiOutBuddyData,
} from '$lib/audio/modules/midi-out-buddy';

/** The live card-api handle for a midiOutBuddy node, or null when the engine is
 *  not up / the node is gone / the handle does not answer the read key. */
export function midiOutBuddyApi(nodeId: string): MidiOutBuddyApi | null {
  const engine = getActiveEngine();
  if (!engine) return null;
  const node = patch.nodes[nodeId] as ModuleNode | undefined;
  if (!node) return null;
  return (engine.read(node, 'card-api') as MidiOutBuddyApi | undefined) ?? null;
}

/** The saved settings on a node, with nothing assumed about their presence. */
function savedData(node: ModuleNode | undefined): Partial<MidiOutBuddyData> {
  return (node?.data ?? {}) as Partial<MidiOutBuddyData>;
}

// ── CHANNEL ────────────────────────────────────────────────────────────────

/** The channel MIDI is SENT on: the explicit override, else the lane's channel,
 *  else 1. Reading the EFFECTIVE value rather than the stored override is what
 *  makes an un-overridden module in lane 5 show `5` instead of `1` — the cell
 *  must say what the module is actually doing, not what key happens to be set. */
export function midiOutBuddyChannelValue(node: ModuleNode | undefined): string {
  return String(effectiveMidiOutChannel(savedData(node)));
}

export function midiOutBuddySetChannel(nodeId: string, choice: string): void {
  const channel = channelForChoice(choice);
  midiOutBuddyApi(nodeId)?.setChannel(channel);
  // ⚠ ONLY `midiOutChannel` — see the header.
  mutateNode(nodeId, (live) => {
    if (!live.data) live.data = {};
    (live.data as Record<string, unknown>).midiOutChannel = channel;
  });
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
 * can sit for the full prompt timeout when the browser quietly suppresses its
 * own permission dialog — the case `$lib/audio/midi-access` exists to name.
 * `delivered` is not about that OUTCOME, it is about whether the press reached
 * a callable at all, which is knowable the instant the handle answers the read
 * key. A probe that waited for the grant would be asserting "this CI runner has
 * MIDI hardware", which no runner does.
 */
export function midiOutBuddyConnect(nodeId: string): boolean {
  const api = midiOutBuddyApi(nodeId);
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
