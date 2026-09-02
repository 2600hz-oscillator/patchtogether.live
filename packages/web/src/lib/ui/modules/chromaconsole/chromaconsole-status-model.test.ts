// packages/web/src/lib/ui/modules/chromaconsole/chromaconsole-status-model.test.ts
//
// The strings the device body can produce — including the ones that are never
// painted, which is the half a VRT baseline and a human reading one cannot check.
//
// ⚠ THE PROPERTY THIS FILE IS REALLY ABOUT is the split between a NAME and a
// MEASUREMENT. On a `readBack: 'none'` device that distinction is the difference
// between a legal caption and a resting readout that also LIES (the pedal never
// reports back, so any painted value is what the app sent, not what the hardware
// holds). So the value legs below are exclusions, asserted rather than assumed.

import { describe, it, expect } from 'vitest';
import { CHROMA_CONSOLE } from '$lib/devices/hologram-chroma-console';
import { DEVICE_SLOT_IDS, type DeviceStatus } from '$lib/devices/device-module';
import { controlById, resolveSlots } from '$lib/devices/device-descriptor';
import {
  CHROMA_CHANNEL_CHOICES,
  chromaconsoleBoardDetail,
  chromaconsoleLinkDetail,
  chromaconsolePortOptions,
  chromaconsoleSlotChips,
  chromaconsoleSlotDetail,
  chromaconsoleSlotName,
} from './chromaconsole-status-model';

const DEFAULT_SLOTS = () => resolveSlots(CHROMA_CONSOLE, DEVICE_SLOT_IDS, undefined);

const STATUS = (over: Partial<DeviceStatus> = {}): DeviceStatus => ({
  connected: false,
  portId: null,
  portName: null,
  channel: 1,
  problem: '',
  staleSlots: [],
  delivered: 0,
  undelivered: 0,
  ...over,
});

describe('chromaconsoleSlotName — the painted caption', () => {
  it('falls back to the ORDINAL when a slot is empty', () => {
    // The unassigned chip must still say WHICH slot it is: the eight are
    // positional on the board and in the band below, and an empty cell with no
    // number would break the correspondence between the two surfaces.
    expect(chromaconsoleSlotName(undefined, 0)).toBe('slot 1');
    expect(chromaconsoleSlotName(undefined, 7)).toBe('slot 8');
  });

  it('drops the qualifier a picker needs and a chip does not', () => {
    // "amount · character" vs "effect vol · character": the qualifier
    // disambiguates in the 29-entry assignment roster, where both are visible at
    // once. On the chip the picker is directly behind it, and the full string
    // overlaps its neighbours at board width.
    const amount = controlById(CHROMA_CONSOLE, 'amountCharacter');
    expect(amount, 'the descriptor still carries this control').toBeTruthy();
    expect(amount!.label).toContain('·');
    expect(chromaconsoleSlotName(amount, 4)).toBe('character');
  });

  it('leaves an UNQUALIFIED label alone', () => {
    const tilt = controlById(CHROMA_CONSOLE, 'tilt');
    expect(chromaconsoleSlotName(tilt, 0)).toBe(tilt!.label);
  });
});

describe('chromaconsoleSlotDetail — the SPOKEN sentence', () => {
  it('names the control, its CC and its behaviour — and NO value', () => {
    const [slot] = DEFAULT_SLOTS();
    const detail = chromaconsoleSlotDetail(slot!, 0);
    expect(detail).toContain('slot 1');
    expect(detail).toContain('CC 64'); // TILT, transcribed from the manual
    expect(detail).toContain(slot!.control!.doc);
    // ⚠ THE EXCLUSION IS THE POINT: an accessible name that quoted the current
    // value would be the deleted readout one layer down, and on this device it
    // would additionally be asserting something about hardware that cannot be
    // asked. The chip says what the slot IS; the knob cell's own aria-valuetext
    // is where the position is speakable.
    expect(detail).not.toMatch(/\b(value|currently|set to)\b/i);
  });

  it('carries the pedal\'s snap note for a QUANTIZED control', () => {
    // RATE and TIME are snapped by the pedal to tempo subdivisions and cannot be
    // un-snapped, and the table is unpublished. Without this a player cannot
    // reconcile a smooth-looking number with a stepped-sounding result.
    const slots = DEFAULT_SLOTS();
    const rate = slots.find((s) => s.controlId === 'rate')!;
    expect(rate.control!.quantize, 'the descriptor marks RATE as quantized').toBeTruthy();
    expect(chromaconsoleSlotDetail(rate, 1)).toContain(rate.control!.quantize!.note);
  });

  it('says an UNASSIGNED slot sends nothing', () => {
    const slots = resolveSlots(CHROMA_CONSOLE, DEVICE_SLOT_IDS, { slot3: '' });
    const empty = slots.find((s) => s.slotId === 'slot3')!;
    expect(empty.control).toBeUndefined();
    expect(chromaconsoleSlotDetail(empty, 2)).toContain('sends nothing');
  });

  it('⚠ a STALE slot is LOUD, and says what is broken about it', () => {
    // A saved assignment that no longer resolves must not behave like an empty
    // one: automation keeps writing into the lane and nothing reaches the pedal.
    // The card said HOW MANY were stale; the board says WHICH, here.
    const slots = resolveSlots(CHROMA_CONSOLE, DEVICE_SLOT_IDS, { slot5: 'gonePedalKnob' });
    const stale = slots.find((s) => s.slotId === 'slot5')!;
    expect(stale.stale, 'resolveSlots reports it').toBe(true);
    const detail = chromaconsoleSlotDetail(stale, 4);
    expect(detail).toContain('gonePedalKnob');
    expect(detail).toContain('reassign it');
  });
});

describe('chromaconsoleSlotChips — the board', () => {
  it('is eight chips in slot order, with the snap marker on exactly the two', () => {
    const chips = chromaconsoleSlotChips(DEFAULT_SLOTS());
    expect(chips.map((c) => c.slotId)).toEqual([...DEVICE_SLOT_IDS]);
    expect(chips.filter((c) => c.snapped).map((c) => c.name)).toEqual(['rate', 'time']);
  });

  it('marks a stale chip and leaves the rest alone', () => {
    const chips = chromaconsoleSlotChips(
      resolveSlots(CHROMA_CONSOLE, DEVICE_SLOT_IDS, { slot2: 'notAControl' }),
    );
    expect(chips.filter((c) => c.stale).map((c) => c.slotId)).toEqual(['slot2']);
  });

  it('the PAINTED name and the SPOKEN detail are different strings', () => {
    // The `control-grid` role's permanent leg, at the source: a body may not
    // paint its own accessible name. Structurally different rather than
    // accidentally so — two functions, two shapes.
    for (const chip of chromaconsoleSlotChips(DEFAULT_SLOTS())) {
      expect(chip.detail).not.toBe(chip.name);
      expect(chip.detail.length).toBeGreaterThan(chip.name.length);
    }
  });
});

describe('chromaconsoleLinkDetail — what LIT means, and what it does not', () => {
  it('unlit says nothing is being sent, and what to do', () => {
    const detail = chromaconsoleLinkDetail(STATUS());
    expect(detail).toContain('No MIDI output selected');
    expect(detail).toContain('Connect MIDI');
  });

  it('⚠ LIT NEVER CLAIMS THE PEDAL IS THERE', () => {
    // The card's header is emphatic and the face inherits it: "connected" means
    // A PORT IS SELECTED. It does not mean the pedal is present, powered, on
    // this channel, or showing these values — and a reassuring indicator would
    // be a lie the device makes permanently uncheckable.
    const detail = chromaconsoleLinkDetail(
      STATUS({ connected: true, portId: 'p1', portName: 'HOLOGRAM Chroma Console MIDI', channel: 3 }),
    );
    expect(detail).toContain('HOLOGRAM Chroma Console MIDI');
    expect(detail).toContain('channel 3');
    expect(detail).toContain('not what the pedal holds');
    expect(detail).not.toMatch(/\b(synced|in sync|confirmed|verified)\b/i);
  });
});

describe('the two rosters', () => {
  it('the channel roster is the sixteen MIDI channels, 1-based on both sides', () => {
    // `DeviceCardApi.setChannel` takes a 1-BASED channel and clamps to 1..16.
    // The input side of other modules stores the 0..15 wire nibble; getting the
    // base wrong here would transpose every message by one channel.
    expect(CHROMA_CHANNEL_CHOICES.length).toBe(16);
    expect(CHROMA_CHANNEL_CHOICES[0]).toEqual({ value: '1', label: 'ch 1' });
    expect(CHROMA_CHANNEL_CHOICES[15]).toEqual({ value: '16', label: 'ch 16' });
  });

  it('the port roster paints the device NAME and keys on the port id', () => {
    expect(
      chromaconsolePortOptions([{ id: 'out-2', name: 'HOLOGRAM Chroma Console MIDI' }]),
    ).toEqual([{ value: 'out-2', label: 'HOLOGRAM Chroma Console MIDI' }]);
    expect(chromaconsolePortOptions([]), 'no grant, no ports, no synthetic row').toEqual([]);
  });

  it('the board detail counts assignments and names the stale ones', () => {
    expect(chromaconsoleBoardDetail(DEFAULT_SLOTS())).toBe('Slot board: 8 of 8 slots assigned.');
    const withStale = resolveSlots(CHROMA_CONSOLE, DEVICE_SLOT_IDS, { slot1: 'gone', slot2: '' });
    expect(chromaconsoleBoardDetail(withStale)).toBe(
      'Slot board: 6 of 8 slots assigned, 1 pointing at a control this device no longer has.',
    );
  });
});
