// packages/web/src/lib/ui/modules/audioIn/audio-in-status.ts
//
// AUDIO IN's status, as PURE FUNCTIONS — the lamp's lit state, the sentence
// that lamp announces, and which action its button offers.
//
// ── WHY IT IS A MODULE AND NOT THREE TERNARIES IN A COMPONENT ──────────────
//
// Three surfaces render this status: the lane tile's `tileBody`, the dock full
// view's `fullViewBody` and the legacy card (still the lane surface under
// `?shell=legacy`). The card used to hold the whole state machine's PRESENTATION
// inline — a `STATE_LABEL` record and four ternaries — so a face that
// re-expressed it would have been a second copy of an eight-state machine, and
// the two would agree only for as long as nobody edited one.
//
// Being pure also puts the interesting half in front of `vitest`:
// `audioin-face-model.test.ts` asserts every one of the eight states maps to a
// sentence, and NEGATIVE-controls the caption/detail split — which is the part
// the resting-text ruling is actually about and which no rendering test sees.
//
// ── ⚠ WHAT WAS DELETED HERE, RATHER THAN MOVED ────────────────────────────
//
// The card painted the STATE WORD (`idle` / `requesting…` / `active` /
// `permission denied` / `no inputs` / `device in use` / `unsupported` / `error`)
// as a text node beside its LED, and a `stereo` / `mono` BADGE beside that. Both
// are derived values outside a control — the exact shape the 2026-08-19 resting
// text rulings deleted fleet-wide, three mechanisms running. Neither is hidden
// here: the state word is GONE as painted text and survives only inside
// `statusDetail`, which `StatusLed` places on `aria-label`/`title` and nowhere
// else, and the channel layout is a clause of that same sentence.
//
// PURE: no Svelte imports, no DOM, no engine — both halves are node-env
// testable.

import type { AudioInputState, AudioInputView } from '$lib/ui/modules/node-audio-input-registry.svelte';

/** The states in which the capture is not running AND something is wrong —
 *  as opposed to `idle` (nothing is wrong, nothing has been asked for) and
 *  `requesting` (in flight). Drives the FAULT lamp. */
const FAULT_STATES: ReadonlySet<AudioInputState> = new Set<AudioInputState>([
  'permission-denied',
  'no-inputs-found',
  'device-in-use',
  'unsupported',
  'error',
]);

/** LIVE lamp: lit only while a real stream is attached. */
export function inputLiveLit(view: AudioInputView): boolean {
  return view.streaming;
}

/** FAULT lamp: lit when the capture is stopped for a REASON. Dark at `idle`
 *  and while `requesting`, because a red lamp for "you have not switched it on
 *  yet" cries wolf (the `cameraInput` lamp's own rule). */
export function inputFaultLit(view: AudioInputView): boolean {
  return FAULT_STATES.has(view.state);
}

/**
 * The whole sentence a lamp announces. This is where the eight-state machine
 * lives now — `StatusLed` puts it on `aria-label` and `title`, so it is
 * speakable, hoverable, assertable and never a text node.
 *
 * The channel layout is a CLAUSE rather than a badge for exactly that reason:
 * `stereo` painted beside a lamp is a measurement on the faceplate, and the
 * player who wants it can hover the thing it describes.
 */
export function inputStatusDetail(view: AudioInputView): string {
  switch (view.state) {
    case 'streaming': {
      const layout = view.liveChannels >= 2
        ? 'a stereo pair (device channels 1 and 2)'
        : 'one mono channel, duplicated to both outputs';
      return `Capturing ${layout}.`;
    }
    case 'requesting':
      return 'Asking the browser for this input…';
    case 'idle':
      return 'No input open yet — choose a device and switch it on.';
    case 'permission-denied':
      return view.errorMsg ?? 'Microphone permission was denied — retry to ask again.';
    case 'no-inputs-found':
      return view.errorMsg ?? 'No audio input matches — nothing to capture from.';
    case 'device-in-use':
      return view.errorMsg ?? 'That input is in use by another tab or application.';
    case 'unsupported':
      return view.errorMsg ?? 'This browser cannot capture audio input.';
    case 'error':
    default:
      return view.errorMsg ?? 'The input stopped — retry to open it again.';
  }
}

/** Which gesture the action button offers, or `null` while a request is in
 *  flight (nothing to press, and pressing would tear down the attempt). */
export type InputActionKind = 'enable' | 'retry-permission' | 'retry' | 'stop';

export function inputActionKind(view: AudioInputView): InputActionKind | null {
  switch (view.state) {
    case 'streaming':
      return 'stop';
    case 'requesting':
      return null;
    case 'permission-denied':
      return 'retry-permission';
    case 'device-in-use':
    case 'error':
      return 'retry';
    case 'unsupported':
      return null;
    case 'no-inputs-found':
    case 'idle':
    default:
      return 'enable';
  }
}

/**
 * Is the action button dead? PURE, and it is a function rather than a ternary in
 * the component because the shape it refuses shipped once and no rendering test
 * saw it.
 *
 * ⚠ AN EMPTY ROSTER MUST NEVER DISABLE **STOP**. One button serves ENABLE /
 * RETRY / STOP, so the obvious guard — "no devices ⇒ nothing to press" — also
 * kills the only control that CLOSES a live microphone. The legacy card never
 * did this: `AudioinCard` gated `audioin-enable` on the roster and gave
 * `audioin-disable` no `disabled` attribute at all.
 *
 * ⚠ AND THE STATE IS REACHABLE, not theoretical. `refreshInputDevices()` empties
 * the roster on ANY `enumerateDevices()` rejection and runs on every
 * `devicechange`; the registry leaves `streaming` only on a track `'ended'`
 * event. So a hub unplug that makes enumeration throw leaves a node STREAMING
 * with a roster of zero — a live capture, the OS microphone indicator lit, and
 * no UI route to switch it off. That is the #1590 harm class through a new door.
 *
 * An empty roster still disables ENABLE and RETRY, which is the original and
 * correct half: those call `getUserMedia` for a device that is not there.
 */
export function inputActionDisabled(
  action: InputActionKind | null,
  deviceCount: number,
): boolean {
  if (action === null) return true;
  if (action === 'stop') return false;
  return deviceCount === 0;
}

/**
 * The button's own CAPTION — permitted face text, because it names what
 * pressing it does. `compact` is the 192 px lane tile, where the words are the
 * same gesture with fewer letters (the `cameraInput` precedent, which ships
 * `ENABLE`/`RETRY`/`RE-ACQ` against `REQUEST ACCESS`/`RETRY IN SETTINGS`/
 * `RE-ACQUIRE`).
 */
export function inputActionLabel(kind: InputActionKind, compact: boolean): string {
  switch (kind) {
    case 'stop':
      return 'STOP';
    case 'retry-permission':
      return compact ? 'RETRY' : 'RETRY PERMISSION';
    case 'retry':
      return 'RETRY';
    case 'enable':
    default:
      return compact ? 'ENABLE' : 'ENABLE INPUT';
  }
}

/** The picker's own accessible value text — which device is open, or why none
 *  is. Unpainted, like every other derived string on this surface. */
export function inputPickerValueText(
  view: AudioInputView,
  deviceCount: number,
  pickedLabel: string | null,
): string {
  if (deviceCount === 0) return 'No audio inputs were found on this machine.';
  if (!pickedLabel) return 'No input chosen yet — pick one from the list.';
  return view.streaming ? `Capturing from ${pickedLabel}.` : `${pickedLabel} is selected.`;
}
