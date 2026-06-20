// packages/web/src/lib/control/launchpad/launchpad-device.test.ts
//
// Port enumeration regression test. The real-hardware bug: TWO identical
// Launchpad Mini Mk3 units enumerate with the EXACT SAME port name
// ("LPMiniMK3 MIDI In" / "… Out"). Pairing an input to an output by NAME
// collapses both units onto the first output → only one physical unit is ever
// addressed (the other stays stuck in standalone Keys mode). enumerateLaunchpadPorts
// must instead pair by enumeration index (in[i]↔out[i]), so two identical units
// resolve to TWO distinct (inputId, outputId) pairs.

import { describe, it, expect, beforeEach } from 'vitest';
import type { MidiInputLike } from '$lib/audio/modules/midi-cv-buddy';
import type { MidiOutputLike } from '$lib/audio/modules/midi-out-buddy';
import {
  enumerateLaunchpadPorts,
  isLaunchpadMidiPortName,
  __test_setAccess,
  __test_resetLaunchpad,
  type MidiFullAccessLike,
} from './launchpad-device.svelte';

function fakeInput(id: string, name: string): MidiInputLike {
  return {
    id,
    name,
    manufacturer: 'Focusrite - Novation',
    state: 'connected',
    onmidimessage: null,
  } as unknown as MidiInputLike;
}
function fakeOutput(id: string, name: string): MidiOutputLike {
  return {
    id,
    name,
    manufacturer: 'Focusrite - Novation',
    state: 'connected',
    send: () => {},
  } as unknown as MidiOutputLike;
}

/** Build a fake sysex access from input + output port lists (insertion order =
 *  enumeration order, exactly like a real MIDIAccess Map). */
function fakeAccess(
  inputs: MidiInputLike[],
  outputs: MidiOutputLike[],
): MidiFullAccessLike {
  return {
    inputs: new Map(inputs.map((p) => [p.id, p])),
    outputs: new Map(outputs.map((p) => [p.id, p])),
    onstatechange: null,
  };
}

describe('enumerateLaunchpadPorts — two identical Mini Mk3 units', () => {
  beforeEach(() => {
    __test_resetLaunchpad();
  });

  it('resolves TWO distinct port pairs from IDENTICALLY-named units (by index, not name)', () => {
    // Real macOS shape: device A then device B, identical names, distinct ids.
    // CoreMIDI/Web-MIDI list a device's input + output together + in device
    // order, so in[0]↔out[0] = unit A, in[1]↔out[1] = unit B.
    __test_setAccess(
      fakeAccess(
        [fakeInput('inA', 'LPMiniMK3 MIDI In'), fakeInput('inB', 'LPMiniMK3 MIDI In')],
        [fakeOutput('outA', 'LPMiniMK3 MIDI Out'), fakeOutput('outB', 'LPMiniMK3 MIDI Out')],
      ),
    );
    const ports = enumerateLaunchpadPorts();
    expect(ports).toHaveLength(2);
    // The bug: both pairs shared one outputId. Guard distinct ids on BOTH sides.
    expect(ports[0].inputId).not.toBe(ports[1].inputId);
    expect(ports[0].outputId).not.toBe(ports[1].outputId);
    // Index pairing: input[i] pairs with output[i] (same physical device).
    expect(ports[0]).toMatchObject({ inputId: 'inA', outputId: 'outA' });
    expect(ports[1]).toMatchObject({ inputId: 'inB', outputId: 'outB' });
  });

  it('excludes the DAW port pair (programmer mode lives on the MIDI port)', () => {
    __test_setAccess(
      fakeAccess(
        [fakeInput('mIn', 'LPMiniMK3 MIDI In'), fakeInput('dIn', 'LPMiniMK3 DAW In')],
        [fakeOutput('mOut', 'LPMiniMK3 MIDI Out'), fakeOutput('dOut', 'LPMiniMK3 DAW Out')],
      ),
    );
    const ports = enumerateLaunchpadPorts();
    expect(ports).toHaveLength(1);
    expect(ports[0]).toMatchObject({ inputId: 'mIn', outputId: 'mOut' });
    expect(isLaunchpadMidiPortName('LPMiniMK3 DAW In')).toBe(false);
    expect(isLaunchpadMidiPortName('LPMiniMK3 MIDI In')).toBe(true);
  });

  it('returns [] with no access', () => {
    __test_resetLaunchpad();
    expect(enumerateLaunchpadPorts()).toEqual([]);
  });
});
