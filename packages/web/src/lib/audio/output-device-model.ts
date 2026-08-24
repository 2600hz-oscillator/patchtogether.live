// packages/web/src/lib/audio/output-device-model.ts
//
// THE OUTPUT-DEVICE PICKER'S DECISIONS — pure, so the states a player can
// actually be in are assertable without a browser.
//
// ⚠ THE POINT OF SPLITTING THIS OUT IS THE TWO DEAD STATES. `AudioOutCard`
// disabled its `<select>` on `devices.length === 0 || !setSinkIdSupported` and
// explained only the second — so a SUPPORTING browser that enumerated nothing
// showed a greyed `(no outputs)` and no reason at all. Two different causes,
// one indistinguishable dead control, and no test could tell them apart either
// because the decision was three booleans inside a component.
//
// `pickerBlockFrom` takes support and the roster as ARGUMENTS rather than
// reading `AudioContext` off the global, which is what lets both causes be
// driven in a unit test — under vitest there is no `AudioContext` at all, so a
// global read would pin every case to `'unsupported'` and the second half of the
// contract would be untestable by construction.

import { findDefaultOutputDevice, formatDeviceLabel, type MinimalDevice } from '$lib/audio/devices';

/** Why the picker is inoperable, or `null` when it is live. */
export type OutputPickerBlock = 'unsupported' | 'no-devices' | null;

/** The two speakable reasons. Exported so the test asserts the STRINGS the UI
 *  actually announces, not a paraphrase of them. */
export const PICKER_TEXT = {
  unsupported: 'output device selection is unavailable in this browser',
  noDevices: 'no output devices found',
} as const;

/**
 * Which of the two causes disables the picker.
 *
 * Order matters and is the right way round: a browser that cannot do
 * `setSinkId` AT ALL is unsupported whatever it enumerated, and reporting
 * "no output devices found" there would send the reader hunting for hardware
 * that is not the problem.
 */
export function pickerBlockFrom(
  supported: boolean,
  deviceCount: number,
): OutputPickerBlock {
  if (!supported) return 'unsupported';
  if (deviceCount === 0) return 'no-devices';
  return null;
}

/** The saved id, or the browser's default pseudo-id when nothing is saved. */
export function outputDeviceValueFrom(
  saved: unknown,
  devices: readonly MinimalDevice[],
): string {
  if (typeof saved === 'string' && saved.length > 0) return saved;
  return findDefaultOutputDevice([...devices]) ?? '';
}

/** The rendered name for one device id. `'default'` is the browser's
 *  follow-the-OS pseudo-id; everything else goes through `formatDeviceLabel`,
 *  which — since the direction fix — says `Output #N` rather than `Input #N`
 *  when the privacy gate has emptied the label. */
export function outputDeviceLabelFrom(
  deviceId: string,
  devices: readonly MinimalDevice[],
): string {
  if (deviceId === 'default') return 'Default';
  const i = devices.findIndex((d) => d.deviceId === deviceId);
  if (i < 0) return 'Default';
  return formatDeviceLabel(devices[i]!, i);
}

/** The picker's options, in enumeration order. */
export function outputDeviceOptionsFrom(
  devices: readonly MinimalDevice[],
): { value: string; label: string }[] {
  return devices.map((d, i) => ({
    value: d.deviceId,
    label: d.deviceId === 'default' ? 'Default' : formatDeviceLabel(d, i),
  }));
}

/**
 * The picker's `aria-valuetext` — the ONLY surface on which the two dead causes
 * are distinguishable, and unpainted by design.
 *
 * The resting faceplate paints no derived-state text, so the sentence lives
 * here: speakable, assertable, and absent from the picture. Note that this is
 * strictly MORE than the card ever said, not a lossy port of it.
 */
export function pickerValueTextFrom(
  block: OutputPickerBlock,
  label: string,
): string {
  if (block === 'unsupported') return PICKER_TEXT.unsupported;
  if (block === 'no-devices') return PICKER_TEXT.noDevices;
  return label;
}
