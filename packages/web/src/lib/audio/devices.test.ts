// packages/web/src/lib/audio/devices.test.ts
//
// Unit tests for the device-picker pure helpers shared between AUDIO IN
// and AUDIO OUT. No DOM / MediaDevices required.

import { describe, expect, it } from 'vitest';
import {
  buildAudioInConstraints,
  findDefaultInputDevice,
  findDefaultOutputDevice,
  formatDeviceLabel,
  type MinimalDevice,
} from './devices';

describe('findDefaultInputDevice', () => {
  it('returns null for an empty list', () => {
    expect(findDefaultInputDevice([])).toBeNull();
  });

  it("prefers the 'default' pseudo-id when present", () => {
    const devices: MinimalDevice[] = [
      { deviceId: 'abc123', label: 'Built-in Microphone' },
      { deviceId: 'default', label: 'Default - Built-in Microphone' },
      { deviceId: 'xyz789', label: 'External USB Mic' },
    ];
    expect(findDefaultInputDevice(devices)).toBe('default');
  });

  it("returns the first deviceId when no 'default' entry is present", () => {
    const devices: MinimalDevice[] = [
      { deviceId: 'abc123', label: 'Built-in Microphone' },
      { deviceId: 'xyz789', label: 'External USB Mic' },
    ];
    expect(findDefaultInputDevice(devices)).toBe('abc123');
  });

  it("handles a single 'default' entry", () => {
    const devices: MinimalDevice[] = [
      { deviceId: 'default', label: '' },
    ];
    expect(findDefaultInputDevice(devices)).toBe('default');
  });
});

describe('findDefaultOutputDevice', () => {
  // Same logic as input — single sanity test that the output helper
  // delegates to the shared chooser. (Kept as a separate export so
  // call sites read clearly + a future divergence is unambiguous.)
  it('mirrors findDefaultInputDevice (same selection rules)', () => {
    const devices: MinimalDevice[] = [
      { deviceId: 'speakers-1', label: 'External Speakers' },
      { deviceId: 'default', label: 'Default - Headphones' },
    ];
    expect(findDefaultOutputDevice(devices)).toBe('default');
    expect(findDefaultOutputDevice([])).toBeNull();
  });
});

describe('buildAudioInConstraints', () => {
  // Helper: narrow the `audio` member to a constraints object (it's
  // `boolean | MediaTrackConstraints` in the DOM type; we always emit
  // the object form).
  function audioOf(c: MediaStreamConstraints): MediaTrackConstraints {
    expect(typeof c.audio).toBe('object');
    return c.audio as MediaTrackConstraints;
  }

  it('always requests a stereo (2-channel) pair (no channels opt — browser caps ES-9 at 2)', () => {
    // The browser hard-caps ES-9 capture at 2 channels (getCapabilities
    // max=2; channelCount:{exact:4} → OverconstrainedError), so we always
    // request a stereo pair — 4-in / per-channel is native-only. The opts
    // (musicMode) must NOT change the requested channelCount.
    expect(audioOf(buildAudioInConstraints(null)).channelCount).toBe(2);
    expect(audioOf(buildAudioInConstraints('usb-es9')).channelCount).toBe(2);
    expect(audioOf(buildAudioInConstraints('usb-es9', { musicMode: true })).channelCount).toBe(2);
    expect(audioOf(buildAudioInConstraints('usb-es9', { musicMode: false })).channelCount).toBe(2);
  });

  it('leaves browser DSP at the browser default when musicMode is off (default)', () => {
    // Default path must NOT force echoCancellation/noiseSuppression/
    // autoGainControl — forcing AGC off drops built-in-mic capture level
    // for casual mic users.
    const a = audioOf(buildAudioInConstraints('usb-es9'));
    expect(a.echoCancellation).toBeUndefined();
    expect(a.noiseSuppression).toBeUndefined();
    expect(a.autoGainControl).toBeUndefined();
    // Explicit musicMode:false is the same as omitting it.
    const b = audioOf(buildAudioInConstraints('usb-es9', { musicMode: false }));
    expect(b.echoCancellation).toBeUndefined();
    expect(b.noiseSuppression).toBeUndefined();
    expect(b.autoGainControl).toBeUndefined();
  });

  it('forces all capture DSP OFF when musicMode is true', () => {
    // Clean line-level feed for users routing a USB interface / mixer.
    const a = audioOf(buildAudioInConstraints('usb-es9', { musicMode: true }));
    expect(a.echoCancellation).toBe(false);
    expect(a.noiseSuppression).toBe(false);
    expect(a.autoGainControl).toBe(false);
    // musicMode leaves the stereo-pair request intact.
    expect(a.channelCount).toBe(2);
  });

  it('pins the picked device with an EXACT deviceId constraint', () => {
    const a = audioOf(buildAudioInConstraints('usb-es9'));
    expect(a.deviceId).toEqual({ exact: 'usb-es9' });
  });

  it('omits the deviceId constraint for null / the "default" pseudo-id', () => {
    // OS-default path: no deviceId so getUserMedia follows the system
    // default rather than over-constraining.
    expect(audioOf(buildAudioInConstraints(null)).deviceId).toBeUndefined();
    expect(audioOf(buildAudioInConstraints('default')).deviceId).toBeUndefined();
  });

  it('never requests video', () => {
    expect(buildAudioInConstraints('usb-es9').video).toBe(false);
    expect(buildAudioInConstraints(null).video).toBe(false);
  });
});

describe('formatDeviceLabel', () => {
  it('returns the device label verbatim when non-empty', () => {
    const device: MinimalDevice = { deviceId: 'abc', label: 'Built-in Microphone' };
    expect(formatDeviceLabel(device, 0)).toBe('Built-in Microphone');
  });

  it('falls back to a 1-based positional label when the label is empty', () => {
    // Pre-permission privacy gate: enumerateDevices returns empty labels.
    const device: MinimalDevice = { deviceId: 'abc', label: '' };
    expect(formatDeviceLabel(device, 0)).toBe('Input #1');
    expect(formatDeviceLabel(device, 4)).toBe('Input #5');
  });

  it('treats whitespace-only labels as non-empty (browser-provided is preserved)', () => {
    // Defensive — we don't want to second-guess what the browser hands us.
    // If the OS reports a single-space label we still show it; it's the
    // user's funky audio interface, not our problem to normalize.
    const device: MinimalDevice = { deviceId: 'abc', label: ' ' };
    expect(formatDeviceLabel(device, 0)).toBe(' ');
  });
});
