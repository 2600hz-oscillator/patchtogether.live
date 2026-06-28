// packages/web/src/lib/video/camera-device.test.ts
//
// Regression guard for the CAMERA device-recovery decision logic — the bug
// where loading a patch whose saved camera is gone left the card STUCK in
// 'no-cameras-found': you could SEE the available cameras in the dropdown but
// switching to one never started the stream (the re-acquire guard omitted that
// state). These are pure decisions (no getUserMedia / DOM), so they pin the fix
// deterministically; the live stream path stays in camera-input.spec.ts.

import { describe, it, expect } from 'vitest';
import {
  shouldReacquireOnPick,
  savedDeviceAvailable,
  savedDeviceMissing,
  type CameraState,
} from './camera-device';

describe('shouldReacquireOnPick — an explicit device pick (re)acquires', () => {
  it('THE BUG: re-acquires from no-cameras-found (saved camera gone → switch to a working one)', () => {
    expect(shouldReacquireOnPick('no-cameras-found')).toBe(true);
  });

  it('re-acquires from the states the old guard already handled', () => {
    expect(shouldReacquireOnPick('streaming')).toBe(true);
    expect(shouldReacquireOnPick('paused')).toBe(true);
    expect(shouldReacquireOnPick('device-in-use')).toBe(true);
    expect(shouldReacquireOnPick('error')).toBe(true);
  });

  it('also re-acquires from permission-denied and idle (a pick is a fresh intent)', () => {
    expect(shouldReacquireOnPick('permission-denied')).toBe(true);
    expect(shouldReacquireOnPick('idle')).toBe(true);
  });

  it('does NOT re-acquire while a request is already in flight', () => {
    // requestStream() tears the old stream down — re-entering mid-request races
    // itself. Let the in-flight getUserMedia settle.
    expect(shouldReacquireOnPick('requesting')).toBe(false);
  });

  it('does NOT re-acquire when getUserMedia is unsupported', () => {
    expect(shouldReacquireOnPick('unsupported')).toBe(false);
  });

  it('every state is decided (no state silently falls through)', () => {
    const ALL: CameraState[] = [
      'idle', 'requesting', 'streaming', 'paused', 'permission-denied',
      'no-cameras-found', 'device-in-use', 'unsupported', 'error',
    ];
    const stuck = ALL.filter((s) => !shouldReacquireOnPick(s));
    // Exactly the two states where a request can't/shouldn't fire.
    expect(stuck.sort()).toEqual(['requesting', 'unsupported']);
  });
});

describe('savedDeviceAvailable — does the saved id resolve to a present camera', () => {
  const devices = [{ deviceId: 'cam-a' }, { deviceId: 'cam-b' }];

  it('true when the saved id is in the list', () => {
    expect(savedDeviceAvailable('cam-b', devices)).toBe(true);
  });

  it('false when the saved id is gone', () => {
    expect(savedDeviceAvailable('cam-ZZZ', devices)).toBe(false);
  });

  it('false for a null/empty/undefined saved id (nothing to resolve)', () => {
    expect(savedDeviceAvailable(null, devices)).toBe(false);
    expect(savedDeviceAvailable('', devices)).toBe(false);
    expect(savedDeviceAvailable(undefined, devices)).toBe(false);
  });

  it('false against an empty device list', () => {
    expect(savedDeviceAvailable('cam-a', [])).toBe(false);
  });
});

describe('savedDeviceMissing — show "saved camera not found" + skip the doomed request', () => {
  const present = [{ deviceId: 'cam-a' }, { deviceId: 'cam-b' }];

  it('true: a saved id that is gone, with labels visible (the load-on-another-machine case)', () => {
    expect(savedDeviceMissing('cam-ZZZ', present, true)).toBe(true);
  });

  it('false: the saved camera is still present', () => {
    expect(savedDeviceMissing('cam-a', present, true)).toBe(false);
  });

  it('false when labels are NOT yet visible (deviceIds redacted to "" — cannot conclude it is gone)', () => {
    // Pre-permission browsers redact deviceId, so a non-matching saved id does
    // NOT mean the camera is absent. Don't flag "missing" or skip the request.
    expect(savedDeviceMissing('cam-ZZZ', present, false)).toBe(false);
    expect(savedDeviceMissing('cam-ZZZ', [{ deviceId: '' }, { deviceId: '' }], false)).toBe(false);
  });

  it('false for no saved id (unconstrained request → browser default camera)', () => {
    expect(savedDeviceMissing(null, present, true)).toBe(false);
    expect(savedDeviceMissing('', present, true)).toBe(false);
  });
});
