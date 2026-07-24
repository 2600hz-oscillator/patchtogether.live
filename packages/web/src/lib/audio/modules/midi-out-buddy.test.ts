// packages/web/src/lib/audio/modules/midi-out-buddy.test.ts
//
// Unit tests for MIDI-OUT-BUDDY: module-def shape + the pure CV→MIDI mapping
// (pitch CV → note quantization, velocity CV → 1..127, NoteOn/NoteOff byte
// sequences) + the note-tracking state machine (NoteOff matches the held
// note even after pitch drift; retrigger / device-change flush). The live
// AudioContext + requestMIDIAccess permission path are covered by the E2E
// spec (midi-out-buddy.spec.ts) with a fake MIDIOutput.

import { describe, expect, it } from 'vitest';
import {
  midiOutBuddyDef,
  pitchCvToMidiNote,
  velocityCvToMidi,
  noteOnBytes,
  noteOffBytes,
  allNotesOffBytes,
  createMidiNoteTracker,
  clampMidiChannel,
  effectiveMidiOutChannel,
  isMidiOutChannelOverridden,
  laneChannelOf,
  midiOutChannelOverrideOf,
  DEFAULT_DATA,
  DEFAULT_MIDI_OUT_CHANNEL,
  type MidiOutBuddyData,
} from './midi-out-buddy';
import { vOctToMidi, C4_MIDI } from '$lib/audio/note-entry';
import { reconcileColumnOrder, type ColumnNodeView } from '$lib/graph/channel-columns';
import {
  planColumnWiring,
  wcolEdgeId,
  type ColumnMember,
  type ConvenienceDef,
} from '$lib/graph/patch-convenience';

describe('midiOutBuddyDef: module shape', () => {
  it('default data is "no channel override", no device', () => {
    expect(DEFAULT_DATA).toEqual({ midiOutChannel: null, lastDeviceId: null });
    // `channel` is the COLUMN system's key — this module must never seed it.
    expect('channel' in DEFAULT_DATA).toBe(false);
    expect(DEFAULT_MIDI_OUT_CHANNEL).toBe(1);
  });
});

describe('pitchCvToMidiNote: V/oct → MIDI note (C4 = 0V = MIDI 60)', () => {
  it('0 V → MIDI 60 (C4) — matches the repo C4 convention', () => {
    expect(pitchCvToMidiNote(0)).toBe(60);
    expect(C4_MIDI).toBe(60);
    expect(vOctToMidi(0)).toBe(60);
  });

  it('+1 V → MIDI 72 (C5), -1 V → MIDI 48 (C3)', () => {
    expect(pitchCvToMidiNote(1)).toBe(72);
    expect(pitchCvToMidiNote(-1)).toBe(48);
  });

  it('quantizes to the NEAREST semitone', () => {
    // 60 + 7 semitones = G4 (67). 7/12 V = 0.5833…; nudge either side.
    expect(pitchCvToMidiNote(7 / 12)).toBe(67);
    expect(pitchCvToMidiNote(7 / 12 + 0.49 / 12)).toBe(67); // < half-step up → still 67
    expect(pitchCvToMidiNote(7 / 12 + 0.51 / 12)).toBe(68); // > half-step up → 68
  });

  it('clamps to the playable 7-bit range', () => {
    expect(pitchCvToMidiNote(100)).toBeLessThanOrEqual(127);
    expect(pitchCvToMidiNote(-100)).toBeGreaterThanOrEqual(0);
  });

  it('NaN → C4 fallback (60)', () => {
    expect(pitchCvToMidiNote(NaN)).toBe(60);
  });
});

describe('velocityCvToMidi: 0..1 CV → MIDI velocity 1..127', () => {
  it('1.0 → 127', () => expect(velocityCvToMidi(1)).toBe(127));
  it('0 → 1 (never emit velocity-0, which is a NoteOff on the wire)', () => {
    expect(velocityCvToMidi(0)).toBe(1);
  });
  it('negative → 1 (floor)', () => expect(velocityCvToMidi(-0.5)).toBe(1));
  it('> 1 → 127 (clamp)', () => expect(velocityCvToMidi(2)).toBe(127));
  it('0.5 → 64 (round(0.5*127) = 64)', () => expect(velocityCvToMidi(0.5)).toBe(64));
  it('a tiny positive CV still floors to 1, not 0', () => {
    expect(velocityCvToMidi(0.001)).toBe(1);
  });
  it('NaN → 1', () => expect(velocityCvToMidi(NaN)).toBe(1));
});

describe('byte builders: NoteOn / NoteOff / AllNotesOff', () => {
  it('NoteOn channel 1 → status 0x90', () => {
    expect(noteOnBytes(1, 60, 100)).toEqual([0x90, 60, 100]);
  });
  it('NoteOn channel 16 → status 0x9F', () => {
    expect(noteOnBytes(16, 64, 80)).toEqual([0x9f, 64, 80]);
  });
  it('NoteOff channel 1 → status 0x80, velocity 0', () => {
    expect(noteOffBytes(1, 60)).toEqual([0x80, 60, 0]);
  });
  it('NoteOff channel 10 → status 0x89', () => {
    expect(noteOffBytes(10, 60)).toEqual([0x89, 60, 0]);
  });
  it('AllNotesOff → CC 123 value 0 on the channel', () => {
    expect(allNotesOffBytes(1)).toEqual([0xb0, 123, 0]);
    expect(allNotesOffBytes(16)).toEqual([0xbf, 123, 0]);
  });
  it('channel is clamped to 1..16', () => {
    expect(noteOnBytes(0, 60, 100)[0]).toBe(0x90); // clamps up to 1
    expect(noteOnBytes(99, 60, 100)[0]).toBe(0x9f); // clamps down to 16
  });
  it('note + velocity are masked to 7 bits', () => {
    expect(noteOnBytes(1, 200, 200)).toEqual([0x90, 200 & 0x7f, 200 & 0x7f]);
  });
});

describe('createMidiNoteTracker: gate edges → byte sequences + note tracking', () => {
  it('starts silent', () => {
    expect(createMidiNoteTracker().soundingNote).toBeNull();
  });

  it('gate rise → single NoteOn, tracks the sounding note', () => {
    const t = createMidiNoteTracker();
    const msgs = t.onGateRise(1, 64, 100);
    expect(msgs).toEqual([[0x90, 64, 100]]);
    expect(t.soundingNote).toBe(64);
  });

  it('rise then fall → NoteOn then matching NoteOff', () => {
    const t = createMidiNoteTracker();
    expect(t.onGateRise(3, 67, 90)).toEqual([[0x92, 67, 90]]);
    expect(t.onGateFall(3)).toEqual([[0x82, 67, 0]]);
    expect(t.soundingNote).toBeNull();
  });

  it('NoteOff targets the HELD note even if a different note is requested later (pitch drift)', () => {
    const t = createMidiNoteTracker();
    // Gate rose on MIDI 60.
    t.onGateRise(1, 60, 100);
    // Pitch drifted to 64 while gate held — but no new rise, so no NoteOn.
    // The fall must close note 60, NOT 64.
    expect(t.onGateFall(1)).toEqual([[0x80, 60, 0]]);
    expect(t.soundingNote).toBeNull();
  });

  it('retrigger (rise while already sounding) closes the old note before the new NoteOn', () => {
    const t = createMidiNoteTracker();
    t.onGateRise(1, 60, 100);
    // A second rise with no observed fall (sub-tick pulse): close 60, open 62.
    expect(t.onGateRise(1, 62, 110)).toEqual([
      [0x80, 60, 0], // NoteOff old
      [0x90, 62, 110], // NoteOn new
    ]);
    expect(t.soundingNote).toBe(62);
  });

  it('fall while silent is a no-op (no spurious NoteOff)', () => {
    const t = createMidiNoteTracker();
    expect(t.onGateFall(1)).toEqual([]);
  });

  it('flush sends matched NoteOff + AllNotesOff and clears tracking', () => {
    const t = createMidiNoteTracker();
    t.onGateRise(5, 72, 64);
    expect(t.flush(5)).toEqual([
      [0x84, 72, 0], // NoteOff held note on channel 5
      [0xb4, 123, 0], // AllNotesOff on channel 5
    ]);
    expect(t.soundingNote).toBeNull();
  });

  it('flush while silent sends only AllNotesOff', () => {
    const t = createMidiNoteTracker();
    expect(t.flush(1)).toEqual([[0xb0, 123, 0]]);
  });

  it('end-to-end: CV → bytes — pitch+velocity CV feed the NoteOn', () => {
    const t = createMidiNoteTracker();
    // pitch CV +1 V → MIDI 72; velocity CV 0.5 → 64; channel 2.
    const note = pitchCvToMidiNote(1);
    const vel = velocityCvToMidi(0.5);
    expect(t.onGateRise(2, note, vel)).toEqual([[0x91, 72, 64]]);
    expect(t.onGateFall(2)).toEqual([[0x81, 72, 0]]);
  });
});

// ================================================================
// LANE vs MIDI-OUT CHANNEL (#1168)
// ================================================================
//
// `node.data.channel` is the WORKFLOW CHANNEL-COLUMN membership scalar; the
// card used to write it to set the MIDI output channel, which handed the value
// to the column reconciler as a LANE REASSIGNMENT (prune from the old column,
// adopt into the new one → the lane's clip note-tap edges were re-planned, or
// dropped entirely for a channel > 8). The MIDI channel now lives on its own
// `midiOutChannel` key and only DEFAULTS from the lane.
//
// These tests drive the REAL column reconciler (reconcileColumnOrder) and the
// REAL note-tap planner (planColumnWiring) against the LIVE midiOutBuddy def,
// so they fail if the coupling ever comes back.

describe('midi-out channel: derivation from the lane', () => {
  it('clampMidiChannel keeps 1..16 and survives junk', () => {
    expect(clampMidiChannel(1)).toBe(1);
    expect(clampMidiChannel(16)).toBe(16);
    expect(clampMidiChannel(0)).toBe(1);
    expect(clampMidiChannel(99)).toBe(16);
    expect(clampMidiChannel(3.4)).toBe(3);
    expect(clampMidiChannel(NaN)).toBe(1);
    expect(clampMidiChannel(undefined)).toBe(1);
  });

  it('(a) ADD-TO-LANE defaults the MIDI channel to the lane channel', () => {
    // The column system's add-to-lane writes ONLY data.channel (membership).
    for (const lane of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const data: Partial<MidiOutBuddyData> = { lastDeviceId: null, channel: lane };
      expect(effectiveMidiOutChannel(data)).toBe(lane);
      expect(laneChannelOf(data)).toBe(lane);
      // Defaulting is DERIVED — no override is persisted.
      expect(midiOutChannelOverrideOf(data)).toBeNull();
      expect(isMidiOutChannelOverridden(data)).toBe(false);
    }
  });

  it('no lane and no override → channel 1', () => {
    expect(effectiveMidiOutChannel({ lastDeviceId: null })).toBe(1);
    expect(effectiveMidiOutChannel(undefined)).toBe(1);
    expect(laneChannelOf({ lastDeviceId: null })).toBeNull();
  });

  it('an explicit override WINS over the lane default', () => {
    const data: Partial<MidiOutBuddyData> = { lastDeviceId: null, channel: 3, midiOutChannel: 11 };
    expect(effectiveMidiOutChannel(data)).toBe(11);
    expect(laneChannelOf(data)).toBe(3); // the lane is untouched
  });

  it('a free (lane-less) module can still be set to any MIDI channel', () => {
    const data: Partial<MidiOutBuddyData> = { lastDeviceId: null, midiOutChannel: 14 };
    expect(effectiveMidiOutChannel(data)).toBe(14);
    // No lane → nothing to diverge from → no highlight.
    expect(isMidiOutChannelOverridden(data)).toBe(false);
  });

  it('(c) the OVERRIDE HIGHLIGHT is true ONLY when the channel differs from the lane', () => {
    const flag = (channel?: number, midiOutChannel?: number | null) =>
      isMidiOutChannelOverridden({ lastDeviceId: null, channel, midiOutChannel });

    expect(flag(3, undefined)).toBe(false); // following the lane
    expect(flag(3, null)).toBe(false); // explicitly "follow the lane"
    expect(flag(3, 3)).toBe(false); // overridden to the SAME channel
    expect(flag(3, 4)).toBe(true); // diverged
    expect(flag(3, 16)).toBe(true);
    expect(flag(undefined, 9)).toBe(false); // no lane → no divergence to show
    expect(flag(undefined, undefined)).toBe(false);
    // Clamping applies on BOTH sides, so an out-of-range override that clamps
    // back onto the lane is not a divergence.
    expect(flag(1, 0)).toBe(false);
    expect(flag(16, 99)).toBe(false);
  });
});

describe('(b) changing the MIDI channel leaves LANE MEMBERSHIP + CLIP ASSIGNMENT intact', () => {
  const LANE = 3;
  const MO = 'mo-1';
  const liveMidiOutDef = midiOutBuddyDef as unknown as ConvenienceDef;

  /** The card's ONLY channel write — writeData({ midiOutChannel: ch }). */
  const cardSetChannel = (data: Partial<MidiOutBuddyData>, ch: number): void => {
    data.midiOutChannel = ch;
  };

  /** The column reconciler's view of the node (id + membership scalars). */
  const columnView = (data: Partial<MidiOutBuddyData>): Map<string, ColumnNodeView> =>
    new Map([[MO, { id: MO, channel: data.channel, sendSlot: undefined }]]);

  /** The reconciler-owned clip note-tap edge set for the lane. */
  const laneEdgeIds = (order: readonly string[]): string[] => {
    const members: ColumnMember[] = order.map((nodeId) => ({ nodeId, def: liveMidiOutDef }));
    return planColumnWiring({
      channel: LANE,
      members,
      clipPlayerId: 'clip',
      mixerId: 'mix',
      headNodeId: null,
    })
      .map((e) => e.id)
      .sort();
  };

  it('membership order + clip note-taps are IDENTICAL across a channel change', () => {
    const data: Partial<MidiOutBuddyData> = { lastDeviceId: null, channel: LANE };

    // BEFORE — in lane 3, MIDI channel defaulted to 3.
    const orderBefore = reconcileColumnOrder([MO], LANE, columnView(data));
    const edgesBefore = laneEdgeIds(orderBefore);
    expect(orderBefore).toEqual([MO]);
    expect(effectiveMidiOutChannel(data)).toBe(LANE);
    expect(edgesBefore).toEqual(
      [
        wcolEdgeId('clip', `pitch${LANE}`, MO, 'pitch'),
        wcolEdgeId('clip', `gate${LANE}`, MO, 'gate'),
        wcolEdgeId('clip', `vel${LANE}`, MO, 'velocity'),
      ].sort(),
    );

    // THE ACTION — the user picks MIDI channel 11 on the card.
    cardSetChannel(data, 11);

    // AFTER — MIDI routes to 11; lane + clip taps are untouched.
    expect(effectiveMidiOutChannel(data)).toBe(11);
    expect(data.channel).toBe(LANE); // the membership scalar was NOT written
    const orderAfter = reconcileColumnOrder([MO], LANE, columnView(data));
    expect(orderAfter).toEqual(orderBefore);
    expect(laneEdgeIds(orderAfter)).toEqual(edgesBefore);
    // And the override reads as a divergence for the card highlight.
    expect(isMidiOutChannelOverridden(data)).toBe(true);
  });

  it('every 1..16 channel choice keeps the module in its lane', () => {
    for (let ch = 1; ch <= 16; ch++) {
      const data: Partial<MidiOutBuddyData> = { lastDeviceId: null, channel: LANE };
      cardSetChannel(data, ch);
      expect(reconcileColumnOrder([MO], LANE, columnView(data))).toEqual([MO]);
      expect(laneEdgeIds([MO]).length).toBe(3);
      expect(effectiveMidiOutChannel(data)).toBe(ch);
    }
  });

  it('moving lanes re-defaults an UN-overridden channel but never touches an override', () => {
    const following: Partial<MidiOutBuddyData> = { lastDeviceId: null, channel: LANE };
    following.channel = 6; // the reconciler moved it to lane 6
    expect(effectiveMidiOutChannel(following)).toBe(6);

    const overridden: Partial<MidiOutBuddyData> = {
      lastDeviceId: null,
      channel: LANE,
      midiOutChannel: 11,
    };
    overridden.channel = 6;
    expect(effectiveMidiOutChannel(overridden)).toBe(11);
    expect(isMidiOutChannelOverridden(overridden)).toBe(true);
  });

  it('REGRESSION GUARD: writing data.channel (the OLD card behaviour) DOES break the lane', () => {
    // Proves the assertions above are meaningful — this is the bug being fixed.
    const broken: Partial<MidiOutBuddyData> = { lastDeviceId: null, channel: LANE };
    broken.channel = 11; // what the old writeData({ channel: ch }) did
    // Pruned out of lane 3 entirely → the lane's clip note-taps vanish.
    const order = reconcileColumnOrder([MO], LANE, columnView(broken));
    expect(order).toEqual([]);
    expect(laneEdgeIds(order)).toEqual([]);
  });
});
