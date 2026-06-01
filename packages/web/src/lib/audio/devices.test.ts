// packages/web/src/lib/audio/devices.test.ts
//
// Unit tests for the device-picker pure helpers shared between AUDIO IN
// and AUDIO OUT. No DOM / MediaDevices required.

import { describe, expect, it } from 'vitest';
import {
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
