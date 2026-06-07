// packages/web/src/lib/audio/devices.ts
//
// Pure helpers shared by the AUDIO IN + AUDIO OUT cards for working
// with `navigator.mediaDevices.enumerateDevices()` results.
//
// Why pure: the device-picker logic is unit-testable without spinning
// up a browser-level MediaDevices stub. The card-side glue (lifecycle,
// permission flow, device-change subscription) sits in the Svelte
// components; this module is just data-shape work.
//
// Browser privacy reminder (relevant to both helpers below):
//
//   - Pre-permission, `enumerateDevices()` returns entries with EMPTY
//     `label` strings (the kind/deviceId are present but identifying
//     info is gated). After granting microphone permission, audioinput
//     labels populate; granting microphone ALSO unlocks audiooutput
//     labels on Chromium (the privacy gate is per-user-media, not
//     per-direction). So both helpers must cope with `device.label === ''`.
//
//   - `deviceId === 'default'` is the browser's pseudo-id for "follow
//     the OS default" — present on Chromium for both directions, on
//     Safari for inputs only, and absent on Firefox. We treat it as
//     the preferred default when present.

/** Minimal subset of MediaDeviceInfo we touch — keeps these helpers
 *  testable with plain JS objects rather than the full DOM type. */
export interface MinimalDevice {
  deviceId: string;
  label: string;
  kind?: MediaDeviceKind;
}

/**
 * Pick a sensible default INPUT device id from an enumerateDevices()
 * result that's already been filtered to `kind === 'audioinput'`.
 *
 *   1. If any entry has `deviceId === 'default'`, return 'default'.
 *      (Chromium emits this pseudo-id that follows the OS default.)
 *   2. Else return the first entry's deviceId.
 *   3. Empty list → null. Caller renders "no inputs found".
 *
 * The mirror helper `findDefaultOutputDevice` does the same for
 * audiooutput devices.
 */
export function findDefaultInputDevice(devices: readonly MinimalDevice[]): string | null {
  if (devices.length === 0) return null;
  const fallback = devices.find((d) => d.deviceId === 'default');
  if (fallback) return 'default';
  const first = devices[0];
  return first ? first.deviceId : null;
}

/**
 * Pick a sensible default OUTPUT device id. Identical logic to the input
 * helper — separate function for clarity at call sites + so a future
 * change (e.g. preferring 'communications' over 'default') is unambiguous.
 */
export function findDefaultOutputDevice(devices: readonly MinimalDevice[]): string | null {
  return findDefaultInputDevice(devices);
}

/** Options for {@link buildAudioInConstraints}. All optional — the
 *  zero-opts call `buildAudioInConstraints(targetId)` is byte-identical to
 *  the original stereo-pair request (channelCount: 2, browser-default DSP).
 *
 *  NOTE — there is deliberately NO `channels` option: the browser caps
 *  ES-9 capture at 2 channels. Empirically (DevTools console probe vs. a
 *  real ES-9 in Chrome): `track.getCapabilities().channelCount` →
 *  `{ max: 2, min: 1 }`, and `getUserMedia({ channelCount: { exact: 4 } })`
 *  → OverconstrainedError. So >2-in / per-channel capture is the NATIVE
 *  track (`patchtogether.es9`), not reachable in-browser. We always
 *  request a stereo pair. */
export interface AudioInConstraintOpts {
  /**
   * "Music mode" — force the browser's capture DSP OFF for a clean,
   * line-level feed: `echoCancellation`, `noiseSuppression`, and
   * `autoGainControl` all set to `false`.
   *
   * Default false (browser default DSP) because forcing AGC off
   * measurably DROPS capture level for built-in mics — a regression for
   * the casual mic user. The toggle exists for users routing line-level
   * gear (a USB interface / mixer) who want zero browser processing.
   * Chromium already leaves this DSP off for most non-communications USB
   * interfaces, so for the ES-9 this is mostly belt-and-suspenders, but
   * it makes the intent explicit + covers the OS-default-device path.
   */
  musicMode?: boolean;
}

/**
 * Build the `MediaStreamConstraints` for AUDIO IN's getUserMedia call.
 *
 * We REQUEST a stereo (2-channel) capture so a multichannel USB interface
 * (e.g. Expert Sleepers ES-9) hands us a true L/R pair rather than a
 * browser-downmixed mono signal. `channelCount` is an IDEAL constraint
 * (no `exact:`), so a mono-only device still streams — the card keys the
 * engine's mono-vs-stereo wiring off the delivered
 * `track.getSettings().channelCount`, not off this request.
 *
 *   - `targetId` null / 'default'  → no deviceId constraint (OS default).
 *   - otherwise                    → `deviceId: { exact: targetId }` so
 *     the user's pick is honoured (and getUserMedia rejects with
 *     OverconstrainedError if that device vanished, which the card
 *     surfaces).
 *
 * We always request 2 channels — the browser hard-caps ES-9 capture at 2
 * (`getCapabilities().channelCount` max=2; `channelCount:{exact:4}` →
 * OverconstrainedError). >2-in / per-channel is the native track
 * (`patchtogether.es9`); see .myrobots/plans/es9-stereo-io.md.
 *
 * `opts.musicMode` (default false) forces echoCancellation /
 * noiseSuppression / autoGainControl OFF for a clean line-level feed.
 * Off by default because forcing AGC off drops built-in-mic level.
 *
 * Back-compat: `buildAudioInConstraints(id)` === the original stereo-pair,
 * browser-default-DSP request.
 */
export function buildAudioInConstraints(
  targetId: string | null,
  opts: AudioInConstraintOpts = {},
): MediaStreamConstraints {
  const track: MediaTrackConstraints = { channelCount: 2 };
  if (opts.musicMode) {
    // Force the capture DSP chain off (clean line-level feed). Only set
    // when explicitly asked — the default path stays byte-identical to
    // the original (browser-default DSP) so existing mic users are
    // unaffected.
    track.echoCancellation = false;
    track.noiseSuppression = false;
    track.autoGainControl = false;
  }
  return {
    audio: targetId && targetId !== 'default'
      ? { deviceId: { exact: targetId }, ...track }
      : { ...track },
    video: false,
  };
}

/**
 * Render-time label for a device entry. When the browser's privacy gate
 * is in effect, `device.label` is the empty string — we fall back to a
 * positional label ("Input #2") so the dropdown still shows distinct
 * entries the user can pick between.
 *
 * `index` is the device's 0-based position in the filtered list (the
 * card just passes the array index of the {#each} loop).
 */
export function formatDeviceLabel(device: MinimalDevice, index: number): string {
  if (device.label && device.label.length > 0) return device.label;
  // Empty label = pre-permission privacy gate. Show a positional fallback
  // so the user can at least distinguish "the first input" from "the
  // second" before they grant access.
  return `Input #${index + 1}`;
}
