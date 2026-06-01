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
