// packages/web/src/lib/audio/input-device.svelte.ts
//
// THE INPUT-DEVICE SEAM — one roster, one writer, for AUDIO IN.
//
// The input-side twin of `./output-device.svelte.ts`, and it exists for the
// same reason that one does, one promotion later.
//
// ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
//
// The roster used to live in a SURFACE's own component lifecycle: an
// `enumerateDevices()` in `onMount`, a `devicechange` listener added there and
// removed in `onDestroy`, and a component-local `devices` array that every
// picker state (`(no inputs)`, `(pick one)`, the positional label fallback) was
// derived from.
//
// That is survivable only while one particular surface is guaranteed to be
// mounted, and AUDIO IN has no such surface. Its face ships TWO that can each
// paint a picker — the lane tile's `tileBody` and the dock full view's
// `fullViewBody` — and MEASURED on this tree, `audioIn` is in neither
// `DOM_SOURCE_LANE_TYPES` nor `CARD_PRODUCER_LANE_TYPES`
// (./../ui/workflow/dom-source-modules), so `needsHeadlessSourceMount` is FALSE
// for it and `<HeadlessSourceHost>` keeps no hidden surface alive the way it
// does for `cameraInput`. Leaving the roster on a picker would have meant:
// close that pane, and nothing enumerates the user's inputs at all.
//
// So ownership moved rather than a hidden card being kept alive:
//
//   * THE ROSTER lives here — one `enumerateDevices()` + one `devicechange`
//     listener for the whole app, however many surfaces are painting a picker.
//   * THE WRITE lives here — `setInputDevice` / `setInputMusicMode`, one
//     origin-tagged transaction each.
//   * THE STREAM stays where #1590 put it: `node-audio-input-registry`, on NODE
//     lifetime. This file never calls `getUserMedia` and never stops a track.
//
// ⚠ THE SPLIT IS THE SAME ONE THE REGISTRY ALREADY DREW, extended one step.
// Its header says "the CONSTRAINTS are the card's business — device
// enumeration, the saved device id, music mode — so they are passed in fully
// formed". Those three things are no longer any card's business; they are this
// file's. `audioInConstraints` below is that sentence's new home.
//
// ── ⚠ THE PICKS ARE DELIBERATELY NOT UNDOABLE ──────────────────────────────
//
// `AUDIO_IN_DEVICE_ORIGIN` is a NON-TRACKED origin, so Cmd-Z walks past a device
// pick and past a music-mode flip. That is `AUDIO_OUT_SINK_ORIGIN`'s argument on
// the other direction of the same wire: undo walks the PATCH, and which
// microphone the browser is capturing is not part of the patch. Undoing a filter
// tweak must not silently re-open a different physical input — and, because a
// re-acquire calls `MediaStreamTrack.stop()` on the outgoing one FIRST, an
// undoable device key would put the irreversible #1590 teardown on the undo
// stack.
//
// ⚠ This is NOT the status quo relabelled. The card's write was
// `target.data['deviceId'] = deviceId` — a bare SyncedStore proxy write, which
// transacts with NO origin and is therefore *accidentally* non-undoable, and
// (with the `if (!target.data) target.data = {}` above it) a reassignment of an
// integrated Y type. These are atomic, origin-TAGGED, in-place transactions that
// are non-undoable ON PURPOSE.

import { mutateNode } from '$lib/graph/mutate';
import type { ModuleNode } from '$lib/graph/types';
import {
  buildAudioInConstraints,
  findDefaultInputDevice,
  formatDeviceLabel,
  type MinimalDevice,
} from '$lib/audio/devices';

/** The node.data key every surface reads and this module writes. */
export const INPUT_DEVICE_KEY = 'deviceId';
/** The node.data key holding "force the browser capture DSP off". */
export const MUSIC_MODE_KEY = 'musicMode';

/**
 * The transaction origin for an input-device pick or a music-mode flip —
 * DELIBERATELY NOT TRACKED by the UndoManager (`store.ts` tracks only
 * `LOCAL_ORIGIN`). See the file header for the argument. Named rather than
 * inlined so the decision has somewhere to be asserted, and so a reader who
 * wants it undoable has one symbol to delete instead of a boolean to guess at.
 */
export const AUDIO_IN_DEVICE_ORIGIN = Symbol('audio-in-device');

// ── THE ROSTER ─────────────────────────────────────────────────────────────

let roster = $state<MinimalDevice[]>([]);
/**
 * Do the enumerated entries carry real labels?
 *
 * ⚠ THIS IS THE PERMISSION PROBE, and it is the only one the platform offers
 * without asking. Pre-permission the browser returns entries with EMPTY `label`
 * strings; a populated label means this origin has been granted a microphone at
 * some point. It is what decides whether AUDIO IN may auto-acquire on a return
 * visit or must wait for a click — see `beginAutoAcquire` on the registry.
 */
let labelled = $state(false);
let watching = false;

/** The live `audioinput` list. A plain read — start the watch with
 *  `ensureInputDeviceWatch()` from an effect, never from a render. */
export function inputDeviceRoster(): MinimalDevice[] {
  return roster;
}

/** True once any enumerated input carries a real label — i.e. this origin has a
 *  prior microphone grant. */
export function inputDevicesHaveLabels(): boolean {
  return labelled;
}

/** Re-enumerate. Never throws: a browser that refuses enumeration produces an
 *  EMPTY roster, which is a state the picker names rather than a crash. */
export async function refreshInputDevices(): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
    roster = [];
    labelled = false;
    return;
  }
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const ins = all.filter((d) => d.kind === 'audioinput');
    roster = ins;
    labelled = ins.some((d) => d.label !== '');
  } catch (err) {
    console.warn('[audioIn] enumerateDevices failed:', err);
    roster = [];
    labelled = false;
  }
}

/**
 * Start the roster watch. IDEMPOTENT — the lane tile and the dock full view can
 * both be mounted at once (they are, whenever a docked AUDIO IN is expanded)
 * and the app still holds exactly one `devicechange` listener and does exactly
 * one enumeration per change.
 *
 * Deliberately never torn down: the listener is one function on
 * `navigator.mediaDevices` for the lifetime of the tab, and the whole reason it
 * lives outside every component is that surface lifetime must stop deciding
 * whether the rack knows what its inputs are.
 *
 * ⚠ A `devicechange` REFRESHES THE LIST AND NOTHING ELSE. Browsers may hand the
 * SAME physical device a new `deviceId` across a plug event; if the saved id no
 * longer matches, the next acquire reports `OverconstrainedError` and the player
 * re-picks. Re-acquiring here — on an event the user did not ask for — would
 * call `MediaStreamTrack.stop()` on a live capture, which is the irreversible
 * #1590 teardown through a new door.
 */
export function ensureInputDeviceWatch(): void {
  if (watching) return;
  watching = true;
  void refreshInputDevices();
  navigator?.mediaDevices?.addEventListener?.('devicechange', () => {
    void refreshInputDevices();
  });
}

// ── VALUE + OPTIONS ────────────────────────────────────────────────────────

/** The saved input id, or null when the player has not picked one yet. Null is
 *  a real state the picker names (`(pick one)`) — it is NOT "the default", and
 *  collapsing the two is what would silently start a capture nobody chose. */
export function inputDeviceValue(node: ModuleNode | undefined): string | null {
  const v = node?.data?.[INPUT_DEVICE_KEY];
  return typeof v === 'string' ? v : null;
}

/** The picker's options, in enumeration order, with the positional fallback the
 *  browser's pre-permission privacy gate makes necessary. */
export function inputDeviceOptions(
  devices: readonly MinimalDevice[] = roster,
): { value: string; label: string }[] {
  return devices.map((d, i) => ({ value: d.deviceId, label: formatDeviceLabel(d, i) }));
}

/** "Force the browser capture DSP off" for this node. */
export function inputMusicMode(node: ModuleNode | undefined): boolean {
  return node?.data?.[MUSIC_MODE_KEY] === true;
}

/**
 * The `MediaStreamConstraints` for this node's next acquire — the saved device
 * (or the roster's default when nothing is saved) plus music mode.
 *
 * ⚠ ONE HOME, because the alternative already bit. The card built these inline
 * and the auto-acquire path built them again from the same two keys; a face with
 * three surfaces would have made that three. The stereo-pair request and the
 * DSP flags live in `./devices`, and this only chooses the target.
 */
export function audioInConstraints(
  node: ModuleNode | undefined,
  devices: readonly MinimalDevice[] = roster,
): MediaStreamConstraints {
  const targetId = inputDeviceValue(node) ?? findDefaultInputDevice(devices);
  return buildAudioInConstraints(targetId, { musicMode: inputMusicMode(node) });
}

// ── THE WRITES ─────────────────────────────────────────────────────────────

/** Save the picked input for `nodeId`. ONE origin-tagged transaction; the
 *  acquire is the caller's separate step, so a pick that cannot be opened still
 *  persists and can be retried. */
export function setInputDevice(nodeId: string, deviceId: string | null): void {
  mutateNode(
    nodeId,
    (live) => {
      if (!live.data) live.data = {};
      if (deviceId === null || deviceId === '') delete live.data[INPUT_DEVICE_KEY];
      else live.data[INPUT_DEVICE_KEY] = deviceId;
    },
    { origin: AUDIO_IN_DEVICE_ORIGIN },
  );
}

/** Save music mode for `nodeId`. Absent means off, so the key is DELETED rather
 *  than written `false` — a saved rack carries only what was chosen. */
export function setInputMusicMode(nodeId: string, on: boolean): void {
  mutateNode(
    nodeId,
    (live) => {
      if (!live.data) live.data = {};
      if (on) live.data[MUSIC_MODE_KEY] = true;
      else delete live.data[MUSIC_MODE_KEY];
    },
    { origin: AUDIO_IN_DEVICE_ORIGIN },
  );
}
