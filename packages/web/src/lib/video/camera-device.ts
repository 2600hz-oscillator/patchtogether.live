// packages/web/src/lib/video/camera-device.ts
//
// Pure decision helpers for the CAMERA card's device-recovery logic, factored
// out of CameraInputCard.svelte so the "load a patch whose saved camera is
// gone, then pick a working one" recovery path is unit-testable WITHOUT a
// getUserMedia / jsdom MediaStream shim. The live stream + GL upload path stays
// covered by e2e/tests/camera-input.spec.ts (Chromium fake device).

/** Camera card state machine — kept BYTE-IN-SYNC with the card's `State` union. */
export type CameraState =
  | 'idle'
  | 'requesting'
  | 'streaming'
  | 'paused'
  | 'permission-denied'
  | 'no-cameras-found'
  | 'device-in-use'
  | 'unsupported'
  | 'error';

/**
 * Should an EXPLICIT device pick (re)acquire the stream?
 *
 * Picking a device from the dropdown is a user gesture and an unambiguous
 * intent to use THAT camera, so we (re)acquire from every state EXCEPT the two
 * where a request can't or shouldn't fire right now:
 *   - 'requesting'  — a getUserMedia is already in flight; let it settle
 *                     (requestStream() tears the old one down, racing itself).
 *   - 'unsupported' — the browser exposes no getUserMedia at all.
 *
 * THE BUG THIS FIXES: the old guard only re-acquired from
 * streaming/paused/device-in-use/error. Loading a patch whose saved camera is
 * gone lands the card in 'no-cameras-found' (the saved deviceId no longer
 * resolves → OverconstrainedError), and 'permission-denied' / 'idle' are also
 * reachable — in ALL of those, switching to an available camera updated the
 * saved id but never started the stream. So the user "could see the cameras
 * but switching showed no data."
 */
export function shouldReacquireOnPick(state: CameraState): boolean {
  return state !== 'requesting' && state !== 'unsupported';
}

/**
 * Does the saved deviceId resolve to a currently-available camera?
 *
 * Only meaningful once device LABELS/IDS are visible (i.e. permission granted) —
 * before that, browsers redact `deviceId` to '' so nothing matches and we must
 * NOT conclude the saved camera is gone. Returns false for a null/empty saved
 * id (nothing to resolve) so callers fall back to an unconstrained request
 * (the browser's default camera).
 */
export function savedDeviceAvailable(
  savedDeviceId: string | null | undefined,
  devices: ReadonlyArray<{ deviceId: string }>,
): boolean {
  if (!savedDeviceId) return false;
  return devices.some((d) => d.deviceId === savedDeviceId);
}

/**
 * Should the card show the "saved camera not found — pick one" placeholder?
 *
 * True only when we have a saved id, the device labels are visible (so the list
 * is trustworthy), and that id is NOT among the available cameras. Drives both
 * the dropdown placeholder AND the decision to skip a doomed exact-deviceId
 * auto-request on load (which would just OverconstrainedError).
 */
export function savedDeviceMissing(
  savedDeviceId: string | null | undefined,
  devices: ReadonlyArray<{ deviceId: string }>,
  hasLabels: boolean,
): boolean {
  if (!savedDeviceId) return false;
  if (!hasLabels) return false;
  return !savedDeviceAvailable(savedDeviceId, devices);
}
