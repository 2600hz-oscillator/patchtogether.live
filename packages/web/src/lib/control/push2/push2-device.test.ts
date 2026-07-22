// packages/web/src/lib/control/push2/push2-device.test.ts
//
// PURE port-matcher tests — the fix for the "dark pads" bug. The Push 2 must bind
// its LIVE port (default Live mode carries pad input + LED Note-Ons with no SysEx
// dance), NOT the User port, and never an IAC / virtual bus. Covers the three host
// name shapes (macOS role words, Windows numbered interfaces, Linux ALSA sub-
// devices). No Web MIDI, no hardware — the selection logic is fully pure.
import { describe, it, expect } from 'vitest';
import {
  pushPortRole,
  isPush2PortName,
  hasSecondaryInterfaceMarker,
  selectPush2Ports,
} from './push2-device.svelte';

const ref = (id: string, name: string) => ({ id, name });

describe('pushPortRole', () => {
  it('reads the explicit macOS role words', () => {
    expect(pushPortRole('Ableton Push 2 Live Port')).toBe('live');
    expect(pushPortRole('Ableton Push 2 User Port')).toBe('user');
  });
  it('disambiguates truncated CoreMIDI names by the char after "push 2"', () => {
    expect(pushPortRole('Ableton Push 2 L…')).toBe('live');
    expect(pushPortRole('Ableton Push 2 U…')).toBe('user');
  });
  it('is "other" for Windows same-named interfaces + non-Push names', () => {
    expect(pushPortRole('Ableton Push 2')).toBe('other');
    expect(pushPortRole('MIDIIN2 (Ableton Push 2)')).toBe('other');
    expect(pushPortRole('Launchpad Mini MK3')).toBe('other');
  });
});

describe('isPush2PortName — Live candidate filter', () => {
  it('accepts the LIVE port, rejects the USER port', () => {
    expect(isPush2PortName('Ableton Push 2 Live Port')).toBe(true);
    expect(isPush2PortName('Ableton Push 2 User Port')).toBe(false);
  });
  it('rejects IAC / virtual buses even if they mention push 2', () => {
    expect(isPush2PortName('IAC Driver Bus 1')).toBe(false);
    expect(isPush2PortName('IAC Push 2 Proxy')).toBe(false);
  });
  it('rejects unrelated devices', () => {
    expect(isPush2PortName('Launchpad Mini MK3 LPMiniMK3 MIDI')).toBe(false);
    expect(isPush2PortName(null)).toBe(false);
  });
  it('keeps the Windows same-named interfaces as candidates (split later)', () => {
    expect(isPush2PortName('Ableton Push 2')).toBe(true);
    expect(isPush2PortName('MIDIIN2 (Ableton Push 2)')).toBe(true);
  });
});

describe('hasSecondaryInterfaceMarker (Windows numbered interface)', () => {
  it('detects the numbered second interface', () => {
    expect(hasSecondaryInterfaceMarker('MIDIIN2 (Ableton Push 2)')).toBe(true);
    expect(hasSecondaryInterfaceMarker('MIDIOUT2 (Ableton Push 2)')).toBe(true);
  });
  it('is false for the non-numbered base name', () => {
    expect(hasSecondaryInterfaceMarker('Ableton Push 2')).toBe(false);
    expect(hasSecondaryInterfaceMarker('Ableton Push 2 Live Port')).toBe(false);
  });
});

describe('selectPush2Ports — binds the LIVE port', () => {
  it('macOS: picks Live, drops User + IAC', () => {
    const ins = [
      ref('i-live', 'Ableton Push 2 Live Port'),
      ref('i-user', 'Ableton Push 2 User Port'),
      ref('i-iac', 'IAC Driver Bus 1'),
    ];
    const outs = [
      ref('o-user', 'Ableton Push 2 User Port'),
      ref('o-live', 'Ableton Push 2 Live Port'),
    ];
    const pairs = selectPush2Ports(ins, outs);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].inputId).toBe('i-live');
    expect(pairs[0].outputId).toBe('o-live');
  });

  it('Windows: keeps the NON-numbered "Ableton Push 2" (Live), drops the numbered MIDIIN2 (User)', () => {
    const ins = [
      ref('i-base', 'Ableton Push 2'),
      ref('i-2', 'MIDIIN2 (Ableton Push 2)'),
    ];
    const outs = [
      ref('o-base', 'Ableton Push 2'),
      ref('o-2', 'MIDIOUT2 (Ableton Push 2)'),
    ];
    const pairs = selectPush2Ports(ins, outs);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].inputId).toBe('i-base');
    expect(pairs[0].outputId).toBe('o-base');
  });

  it('Linux ALSA: prefers the ":0" (Live) sub-device over ":1" (User)', () => {
    const ins = [ref('i0', 'Ableton Push 2:0'), ref('i1', 'Ableton Push 2:1')];
    const outs = [ref('o0', 'Ableton Push 2:0'), ref('o1', 'Ableton Push 2:1')];
    const pairs = selectPush2Ports(ins, outs);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].inputId).toBe('i0');
    expect(pairs[0].outputId).toBe('o0');
  });

  it('no Push present → no pairs', () => {
    expect(selectPush2Ports([ref('a', 'IAC Driver Bus 1')], [ref('b', 'Scarlett 2i2')])).toHaveLength(0);
  });
});
