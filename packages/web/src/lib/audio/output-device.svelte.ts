// packages/web/src/lib/audio/output-device.svelte.ts
//
// THE OUTPUT-DEVICE SEAM — one roster, one writer, one applier.
//
// ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
//
// `AudioOutCard` used to own all three jobs, in its own component lifecycle:
// it enumerated devices, it wrote `node.data.outputDeviceId`, and it called
// `ctx.setSinkId` — from TWO places (the click, and a 100 ms x 50 retry loop
// that re-applied the saved id once the engine appeared). Two code paths that
// had to agree, plus a timer that `onDestroy` never cleared.
//
// That was survivable only while the card was guaranteed to be mounted. It is
// not any more. The PINNED audio out is canvas-hidden and its ONLY surface is
// the 🎧 topbar panel, and once `audioOut` is promoted that panel mounts the
// FACEPLATE instead of the card (`dockRailRendersFace`). MEASURED: `audioOut`
// is in neither `DOM_SOURCE_LANE_TYPES` nor `CARD_PRODUCER_LANE_TYPES`, so
// `needsHeadlessSourceMount` is false for it and `<HeadlessSourceHost>` would
// NOT have kept a copy alive the way it does for `cameraInput`. Leaving the
// apply on the card would have meant: promote the module, and the saved output
// device silently stops being restored on load.
//
// So ownership moved rather than a hidden card being kept alive:
//
//   * THE ROSTER lives here — one `enumerateDevices()` + one `devicechange`
//     listener for the whole app, however many surfaces are painting a picker.
//   * THE WRITE lives here — `setOutputDevice`, one origin-tagged transaction.
//   * THE APPLY lives in the audio-out HANDLE (`audio-out.ts`): its factory
//     applies the saved id at boot, and `write('outputDeviceId', …)` applies a
//     change. The factory RUNS ON ENGINE BOOT by construction, which is what
//     the card's retry loop was polling for — so the loop is deleted, not
//     moved, and D5 (an interval `onDestroy` never cleared) stops existing.
//
// ── ⚠ THE PICK IS DELIBERATELY NOT UNDOABLE, AND THAT IS A DECISION ────────
//
// `AUDIO_OUT_SINK_ORIGIN` is a NON-TRACKED origin, so Cmd-Z walks past a device
// pick. That is the `KRIA_VIEW_ORIGIN` precedent applied to a different fact,
// and the argument is the same shape: undo walks the PATCH, and which speakers
// the browser is talking to is not part of the patch. `setSinkId` is a
// per-AudioContext, per-MACHINE routing fact — undoing a filter tweak must not
// silently re-route your audio to a device that may not even exist here.
//
// ⚠ This is NOT the status quo relabelled. The old write was
// `target.data['outputDeviceId'] = deviceId` — a bare SyncedStore proxy write,
// which transacts with NO origin and is therefore *accidentally* non-undoable,
// untransacted, and (with the `if (!target.data) target.data = {}` above it) a
// reassignment of an integrated Y type. This is one atomic, origin-TAGGED,
// in-place transaction that is non-undoable ON PURPOSE. The model test asserts
// BOTH directions — the key changes, and the undo stack does not see it — so a
// future change to either half is red rather than silent.
//
// ⚠ WHAT IS STILL OPEN, AND IS NOT THIS FILE'S CALL: the key mirrors into the
// Y.Doc, so a COLLABORATOR's pick re-targets the local `setSinkId`. The card's
// own comment already conceded it ("at the cost of a remote user being able to
// nudge your sink choice"). An output device is a per-machine fact and the
// `clipplayer` precedent (grid LED + serial I/O stay per-user local while the
// session syncs) cuts toward making it local — but changing that changes what
// a saved rack restores, so it is an owner decision, not a face PR's.

import { getActiveEngine } from '$lib/audio/engine-ref';
import { mutateNode } from '$lib/graph/mutate';
import { patch } from '$lib/graph/store';
import type { ModuleNode } from '$lib/graph/types';
import type { MinimalDevice } from '$lib/audio/devices';
import {
  outputDeviceLabelFrom,
  outputDeviceOptionsFrom,
  outputDeviceValueFrom,
  pickerBlockFrom,
  pickerValueTextFrom,
  type OutputPickerBlock,
} from '$lib/audio/output-device-model';

export type { OutputPickerBlock };

/** The node.data key both surfaces read and this module writes. */
export const OUTPUT_DEVICE_KEY = 'outputDeviceId';

/**
 * The transaction origin for an output-device pick — DELIBERATELY NOT TRACKED
 * by the UndoManager (`store.ts` tracks only `LOCAL_ORIGIN`).
 *
 * See the file header for the argument. Named rather than inlined so the
 * decision has somewhere to be asserted, and so a reader who wants it undoable
 * has one symbol to delete instead of a boolean to guess at.
 */
export const AUDIO_OUT_SINK_ORIGIN = Symbol('audio-out-sink');

// ── THE ROSTER ─────────────────────────────────────────────────────────────

let roster = $state<MinimalDevice[]>([]);
let watching = false;

/** The live `audiooutput` list. A plain read — start the watch with
 *  `ensureOutputDeviceWatch()` from an effect, never from a render. */
export function outputDeviceRoster(): MinimalDevice[] {
  return roster;
}

/** Re-enumerate. Never throws: a browser that refuses enumeration produces an
 *  EMPTY roster, which is a state the picker names (`no-devices`) rather than a
 *  crash. */
export async function refreshOutputDevices(): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
    roster = [];
    return;
  }
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    roster = all.filter((d) => d.kind === 'audiooutput');
  } catch (err) {
    console.warn('[audioOut] enumerateDevices failed:', err);
    roster = [];
  }
}

/**
 * Start the roster watch. IDEMPOTENT — the card and the faceplate can both be
 * mounted (they are, in the 🎧 panel's neighbour column and the dock) and the
 * app still holds exactly one `devicechange` listener and does exactly one
 * enumeration per change.
 *
 * Deliberately never torn down: the listener is one function on
 * `navigator.mediaDevices` for the lifetime of the tab, and the whole reason
 * this moved off the card is that surface lifetime must stop deciding whether
 * the rack knows what its outputs are.
 */
export function ensureOutputDeviceWatch(): void {
  if (watching) return;
  watching = true;
  void refreshOutputDevices();
  navigator?.mediaDevices?.addEventListener?.('devicechange', () => {
    void refreshOutputDevices();
  });
}

// ── THE TWO DISABLED CAUSES, WHICH THE CARD COULD NOT TELL APART ───────────
//
// The DECISIONS live in `./output-device-model` (pure, and testable without a
// browser — under vitest there is no `AudioContext` at all, so a global read
// would pin every case to `'unsupported'` and make the second cause untestable
// by construction). These wrappers only bind them to the live roster.

/** STATIC platform feature-detect, not an engine-instance probe.
 *  `AudioContext.setSinkId` is a prototype member; its presence does not need a
 *  booted engine, and the old instance-probe reported "unsupported" on every
 *  browser whenever the engine had not booted inside a 5 s window. */
export function outputDeviceSelectionSupported(): boolean {
  return typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
}

export function outputPickerBlock(devices: readonly MinimalDevice[] = roster): OutputPickerBlock {
  return pickerBlockFrom(outputDeviceSelectionSupported(), devices.length);
}

/** The picker's speakable state — the ONLY place the two dead causes are
 *  distinguishable, and unpainted by design. */
export function outputPickerValueText(
  node: ModuleNode | undefined,
  devices: readonly MinimalDevice[] = roster,
): string {
  return pickerValueTextFrom(
    outputPickerBlock(devices),
    outputDeviceLabel(outputDeviceValue(node, devices), devices),
  );
}

// ── VALUE + OPTIONS ────────────────────────────────────────────────────────

/** The saved id, or the browser's default pseudo-id when nothing is saved. */
export function outputDeviceValue(
  node: ModuleNode | undefined,
  devices: readonly MinimalDevice[] = roster,
): string {
  return outputDeviceValueFrom(node?.data?.[OUTPUT_DEVICE_KEY], devices);
}

/** The rendered name for one device id. */
export function outputDeviceLabel(
  deviceId: string,
  devices: readonly MinimalDevice[] = roster,
): string {
  return outputDeviceLabelFrom(deviceId, devices);
}

/** The picker's options, in enumeration order. */
export function outputDeviceOptions(
  devices: readonly MinimalDevice[] = roster,
): { value: string; label: string }[] {
  return outputDeviceOptionsFrom(devices);
}

// ── THE WRITE ──────────────────────────────────────────────────────────────

/**
 * Pick an output device for `nodeId`: ONE origin-tagged transaction writing the
 * saved key, then ONE call into the node's own handle to apply it.
 *
 * The saved key is the source of truth — the handle applies it at engine boot
 * too — so the click path and the reload path are literally the same code
 * rather than two paths that agree. That is what makes the behaviour
 * well-defined when the engine boots after the pick, which the card's
 * apply-then-also-retry pair could only approximate.
 */
export function setOutputDevice(nodeId: string, deviceId: string): void {
  mutateNode(
    nodeId,
    (live) => {
      if (!live.data) live.data = {};
      if (deviceId === '') delete live.data[OUTPUT_DEVICE_KEY];
      else live.data[OUTPUT_DEVICE_KEY] = deviceId;
    },
    { origin: AUDIO_OUT_SINK_ORIGIN },
  );
  const live = patch.nodes[nodeId] as ModuleNode | undefined;
  if (live) getActiveEngine()?.write(live, OUTPUT_DEVICE_KEY, deviceId);
}

/** The last `setSinkId` rejection for `nodeId`, or null. Read off the handle,
 *  which is the only thing that calls `setSinkId` — so this cannot drift from
 *  what actually happened. A rejection is a TRANSIENT response to a gesture,
 *  not resting state: nothing paints it, the picker announces it. */
export function outputSinkError(node: ModuleNode | undefined): string | null {
  if (!node) return null;
  const state = getActiveEngine()?.read(node, 'outputSink') as
    | { error?: string | null }
    | undefined;
  return state?.error ?? null;
}
