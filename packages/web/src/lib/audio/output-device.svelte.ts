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
// ── ⚠ THE PICK LIVES IN THE PER-MACHINE RIG STORE, NOT THE Y.DOC ───────────
//
// Which speakers the browser is talking to (`setSinkId`) is a per-AudioContext,
// per-MACHINE routing fact — machine-local, and meaningless in a shared or saved
// patch. So the saved id lives in `rigBindings()` (native-shell Part-3:
// localStorage in the browser, the shell's config store under Electron) and
// NEVER rides the synced Y.Doc. Two consequences fall out of that one move, and
// both were previously listed here as unsolved:
//
//   * NOT UNDOABLE, now BY CONSTRUCTION rather than by a tagged origin. Undo
//     walks the PATCH (the Y.Doc's UndoManager); the store is not in the Y.Doc
//     at all, so Cmd-Z cannot see a device pick — a stronger guarantee than the
//     old "one origin-tagged, non-tracked transaction", which had to be asserted
//     to stay non-undoable. (`AUDIO_OUT_SINK_ORIGIN` below is retained as the
//     shared precedent — `input-device.svelte.ts` still names it — but the
//     output pick no longer needs it.)
//   * A COLLABORATOR CAN NO LONGER NUDGE YOUR SINK. The old write mirrored into
//     the Y.Doc, so a rack-mate's pick re-targeted the LOCAL `setSinkId` — the
//     card's own comment conceded it. The store is per-machine and unsynced, so
//     that cross-talk is gone; this is exactly the `clipplayer` precedent (grid
//     LED + serial I/O stay per-user local while the session syncs).
//
// It is also what makes a pick survive File→New / reload: the store outlives the
// doc swap, the audio-out handle re-reads it at boot, and Canvas's
// `runDeviceRestore` re-applies it on a later store change.

import { getActiveEngine } from '$lib/audio/engine-ref';
import { onSinkReport, readSinkReport } from '$lib/audio/output-sink-report';
import { patch } from '$lib/graph/store';
import { rigBindings } from '$lib/graph/device-slot-bindings';
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
 * A NON-TRACKED transaction origin (`store.ts` tracks only `LOCAL_ORIGIN`).
 *
 * ⚠ NO LONGER ON THE OUTPUT-DEVICE PICK PATH — that now writes the per-machine
 * `rigBindings()` store, which is outside the Y.Doc/UndoManager entirely (see
 * the header). Retained as the shared precedent `input-device.svelte.ts` names
 * for a per-machine routing fact that must stay off the patch undo stack.
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

/** The saved id, or the browser's default pseudo-id when nothing is saved.
 *
 * The master sink is a PER-MACHINE rig property held in `rigBindings()`, not on
 * `node.data`, so the saved id is read from the store — one binding for the
 * rack's master output. `node` is kept in the signature for the picker surfaces
 * that already thread it, but no longer read. */
export function outputDeviceValue(
  node: ModuleNode | undefined,
  devices: readonly MinimalDevice[] = roster,
): string {
  void node;
  return outputDeviceValueFrom(rigBindings().getAudioOut()?.outputDeviceId, devices);
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
  // ⚠ THE PICK NOW LANDS IN THE PER-MACHINE RIG STORE, NOT `node.data`.
  //
  // Which speakers the browser talks to is a per-AudioContext, per-MACHINE
  // routing fact — machine-local and meaningless in a shared or saved patch (the
  // #2045 class). So the saved id lives in `rigBindings()` (localStorage in the
  // browser, the shell's config store under Electron) and NEVER rides the synced
  // Y.Doc. That is what makes a pick survive File→New / reload: the store
  // outlives the doc swap and the audio-out handle re-reads it at boot (and
  // `runDeviceRestore` re-applies on a later store change). The store is also
  // outside the UndoManager entirely, which preserves — by construction rather
  // than by a tagged origin — the old decision that Cmd-Z walks past a device
  // pick (see this file's header).
  rigBindings().setAudioOut(deviceId === '' ? null : { outputDeviceId: deviceId });
  const live = patch.nodes[nodeId] as ModuleNode | undefined;
  if (live) getActiveEngine()?.write(live, OUTPUT_DEVICE_KEY, deviceId);
}

// ── THE SINK REPORT, MADE REACTIVE ─────────────────────────────────────────
//
// ⚠ `engine.read(node, 'outputSink')` IS A PLAIN FUNCTION CALL. A `$derived`
// over it recomputes only when its OTHER dependencies change, so a rejected
// pick would sit there unreported until something unrelated re-rendered — which
// is a PARITY REGRESSION against the card, whose own `$state` used to make the
// message appear immediately. The applier therefore PUSHES (see
// `./output-sink-report`), and this counter is the one reactive dependency both
// surfaces take.
let sinkVersion = $state(0);
let sinkSubscribed = false;

/** Subscribe to the applier's reports. IDEMPOTENT, and never torn down: it is
 *  one callback for the lifetime of the tab, and the reports outlive any
 *  particular surface by design. */
export function ensureSinkReportWatch(): void {
  if (sinkSubscribed) return;
  sinkSubscribed = true;
  onSinkReport(() => {
    sinkVersion += 1;
  });
}

/** The last `setSinkId` rejection for `node`, or null.
 *
 *  Sourced from the applier itself — the audio-out handle is the only thing in
 *  the app that calls `setSinkId` — so it cannot drift from what actually
 *  happened. A rejection is a TRANSIENT response to a gesture, not resting
 *  state: nothing paints it at rest, because at rest there is no error. */
export function outputSinkError(node: ModuleNode | undefined): string | null {
  void sinkVersion; // the reactive dependency; the value itself is meaningless
  if (!node) return null;
  const pushed = readSinkReport(node.id);
  if (pushed) return pushed.error;
  // Fall back to the PULL. The report only exists once a handle has spoken, and
  // a node whose engine never booted has no handle at all.
  const state = getActiveEngine()?.read(node, 'outputSink') as
    | { error?: string | null }
    | undefined;
  return state?.error ?? null;
}
