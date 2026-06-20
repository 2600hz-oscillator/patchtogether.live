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
  bindUnit,
  onKey,
  isUnitBound,
  __test_setAccess,
  __test_resetLaunchpad,
  type MidiFullAccessLike,
  type LaunchpadKeyEvent,
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

describe('bindUnit — swapping L↔R inputs keeps BOTH inputs live (real-hardware pairing)', () => {
  beforeEach(() => {
    __test_resetLaunchpad();
  });

  // The pairing handshake binds the two candidates provisionally (L=inA, R=inB),
  // then — if the user presses the unit that was provisional R — re-binds with
  // the order SWAPPED (L=inB, R=inA). The detach-by-object logic in bindUnit
  // used to null the input handler of the OTHER unit during that swap, killing
  // the freshly-wired L input. On real hardware that left the LEFT unit's pads
  // completely dead (no launch / no edit) while the RIGHT unit kept working.
  it('after a provisional bind then a SWAPPED re-bind, both inputs dispatch to the right unit', () => {
    const inA = fakeInput('inA', 'LPMiniMK3 MIDI In');
    const inB = fakeInput('inB', 'LPMiniMK3 MIDI In');
    __test_setAccess(
      fakeAccess([inA, inB], [fakeOutput('outA', 'LPMiniMK3 MIDI Out'), fakeOutput('outB', 'LPMiniMK3 MIDI Out')]),
    );

    const seen: LaunchpadKeyEvent[] = [];
    onKey((e) => seen.push(e));

    // (1) provisional bind: L=inA, R=inB.
    bindUnit('L', 'inA', 'outA');
    bindUnit('R', 'inB', 'outB');

    // (2) SWAP (the user picked the provisional-R unit to be LEFT): L=inB, R=inA.
    bindUnit('L', 'inB', 'outB');
    bindUnit('R', 'inA', 'outA');

    expect(isUnitBound('L'), 'L bound').toBe(true);
    expect(isUnitBound('R'), 'R bound').toBe(true);

    // BOTH physical inputs must still have a live handler after the swap.
    expect(typeof inA.onmidimessage, 'inA still has a handler').toBe('function');
    expect(typeof inB.onmidimessage, 'inB still has a handler (NOT nulled by the swap)').toBe('function');

    // A pad press on inB (now LEFT) must dispatch tagged unit:'L'.
    inB.onmidimessage!({ data: new Uint8Array([0x90, 81, 100]), timeStamp: 0 } as never); // padNote(0,7)=81
    // A pad press on inA (now RIGHT) must dispatch tagged unit:'R'.
    inA.onmidimessage!({ data: new Uint8Array([0x90, 11, 100]), timeStamp: 0 } as never); // padNote(0,0)=11

    const lEv = seen.find((e) => e.ev.type === 'pad' && e.unit === 'L');
    const rEv = seen.find((e) => e.ev.type === 'pad' && e.unit === 'R');
    expect(lEv, 'inB press dispatched as unit L (LEFT matrix alive)').toBeTruthy();
    expect(rEv, 'inA press dispatched as unit R').toBeTruthy();
  });
});
