// MPE voice state — SYNTHETIC byte vectors (no instrument connected). Status
// bytes are spelled by hand; channels in comments are musician-facing 1..16.

import { describe, it, expect } from 'vitest';
import { createVoiceAllocator } from '$lib/audio/poly-alloc';
import { activeVoices, applyTouch, createMpeState, decodeMpe, panicMpe, resetMpe, voicePitchCv, type MpeEvent, type MpeState } from './mpe-state';

function feed(state: MpeState, messages: number[][], t0 = 0): MpeEvent[] {
  return messages.flatMap((m, i) => decodeMpe(state, m, t0 + i * 0.001));
}
const byChannel = (state: MpeState, ch1: number) => activeVoices(state).find((v) => v.channel === ch1 - 1);
/** RPN 0/0 pitch-bend sensitivity on wire channel ch1. */
const bendRange = (ch1: number, semis: number, cents = 0): number[][] => [
  [0xb0 | (ch1 - 1), 101, 0], [0xb0 | (ch1 - 1), 100, 0], [0xb0 | (ch1 - 1), 6, semis], [0xb0 | (ch1 - 1), 38, cents],
  [0xb0 | (ch1 - 1), 101, 127], [0xb0 | (ch1 - 1), 100, 127],
];
/** RPN 0/6 MPE zone configuration on the master channel. */
const zoneConfig = (masterCh1: number, members: number): number[][] => [
  [0xb0 | (masterCh1 - 1), 101, 0], [0xb0 | (masterCh1 - 1), 100, 6], [0xb0 | (masterCh1 - 1), 6, members],
  [0xb0 | (masterCh1 - 1), 101, 127], [0xb0 | (masterCh1 - 1), 100, 127],
];

describe('mpe-state: zones and RPN', () => {
  it('starts as the LinnStrument lower zone: master 1, members 2–16, ±48 member / ±2 master', () => {
    const s = createMpeState();
    expect(s.zones).toEqual([{ master: 0, members: Array.from({ length: 15 }, (_, i) => i + 1) }]);
    expect(s.channels[0]!.bendRange).toBe(2);
    expect(s.channels[1]!.bendRange).toBe(48);
  });

  it('RPN 0/6 on channel 1 with N members re-zones and releases voices first', () => {
    const s = createMpeState();
    feed(s, [[0x91, 60, 100]]);
    const ev = feed(s, zoneConfig(1, 3));
    expect(ev.map((e) => e.kind)).toEqual(['voice_end']);
    expect(s.zones).toEqual([{ master: 0, members: [1, 2, 3] }]);
    // Channel 5 (index 4) is now outside every zone: its notes are rejected.
    feed(s, [[0x94, 60, 100]]);
    expect(activeVoices(s)).toHaveLength(0);
    expect(s.counters.rejected).toBe(1);
  });

  it('RPN 0/6 on channel 16 configures an upper zone alongside the lower one', () => {
    const s = createMpeState();
    feed(s, [...zoneConfig(1, 7), ...zoneConfig(16, 7)]);
    expect(s.zones).toEqual([
      { master: 0, members: [1, 2, 3, 4, 5, 6, 7] },
      { master: 15, members: [14, 13, 12, 11, 10, 9, 8] },
    ]);
    expect(s.channels[15]!.bendRange).toBe(2);
    expect(s.channels[14]!.bendRange).toBe(48);
  });

  it('RPN 0/0 sets bend sensitivity (semitones + cents) per channel and refreshes the live voice', () => {
    const s = createMpeState();
    feed(s, [[0x91, 60, 100], [0xe1, 0, 96]]); // +50% of ±48 = +24
    expect(byChannel(s, 2)!.bend).toBeCloseTo(24, 9);
    const ev = feed(s, bendRange(2, 12, 50));
    expect(ev.at(-1)).toMatchObject({ kind: 'voice_expression' });
    expect(byChannel(s, 2)!.bend).toBeCloseTo(6.25, 9);
  });
});

describe('mpe-state: V06 / V07 — per-note bend, pressure, timbre; master broadcast', () => {
  it('V06: two voices at 60 on channels 2 and 3; E1 00 50 (raw 10240 at ±48) bends only channel 2 → pitchCV 1', () => {
    const s = createMpeState();
    const ev = feed(s, [[0x91, 60, 100], [0x92, 60, 100], [0xe1, 0x00, 0x50]]);
    expect(ev.map((e) => e.kind)).toEqual(['voice_start', 'voice_start', 'voice_expression']);
    const a = byChannel(s, 2)!;
    const b = byChannel(s, 3)!;
    expect(a.lane).not.toBe(b.lane);
    expect(voicePitchCv(a)).toBeCloseTo(1, 9);
    expect(voicePitchCv(b)).toBeCloseTo(0, 9);
  });

  it('V07: pressure 64 / 96 land in their own lanes; CC74 32 changes only channel 2\'s timbre', () => {
    const s = createMpeState();
    feed(s, [[0x91, 60, 100], [0x92, 64, 100], [0xd1, 64], [0xd2, 96], [0xb1, 74, 32]]);
    expect(byChannel(s, 2)).toMatchObject({ pressure: 64 / 127, timbre: 32 / 127 });
    expect(byChannel(s, 3)).toMatchObject({ pressure: 96 / 127, timbre: 64 / 127 });
  });

  it('master bend adds to member bend per lane (±2 master + ±48 member)', () => {
    const s = createMpeState();
    feed(s, [[0x91, 60, 100], [0x92, 60, 100], [0xe1, 0, 96], [0xe0, 0, 127]]); // member +24; master +2·(127·128−8192)/8192
    const master = ((127 * 128 - 8192) / 8192) * 2;
    expect(byChannel(s, 2)!.bend).toBeCloseTo(24 + master, 9);
    expect(byChannel(s, 3)!.bend).toBeCloseTo(master, 9);
  });

  it('master pressure / CC74 broadcast as absolute values; a later member message updates only that member', () => {
    const s = createMpeState();
    feed(s, [[0x91, 60, 100], [0x92, 64, 100], [0xd0, 100], [0xb0, 74, 10], [0xd1, 20]]);
    expect(byChannel(s, 2)).toMatchObject({ pressure: 20 / 127, timbre: 10 / 127 });
    expect(byChannel(s, 3)).toMatchObject({ pressure: 100 / 127, timbre: 10 / 127 });
  });

  it('pre-note pressure / CC74 / bend on a channel are preserved onto its Note On', () => {
    const s = createMpeState();
    const ev = feed(s, [[0xd1, 90], [0xb1, 74, 10], [0xe1, 0, 96], [0x91, 60, 100]]);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: 'voice_start', voice: { pressure: 90 / 127, timbre: 10 / 127, bend: 24, velocity: 100 / 127 } });
  });

  it('a released channel clears its cache so a reused channel does not inherit the previous finger', () => {
    const s = createMpeState();
    feed(s, [[0x91, 60, 100], [0xd1, 90], [0x81, 60, 0], [0x91, 62, 100]]);
    expect(byChannel(s, 2)).toMatchObject({ note: 62, pressure: 0, timbre: 64 / 127, bend: 0 });
  });

  it('a Note On on a channel that already holds a voice retires the old voice (channel_reuse)', () => {
    const s = createMpeState();
    const ev = feed(s, [[0x91, 60, 100], [0x91, 62, 100]]);
    expect(ev.map((e) => e.kind)).toEqual(['voice_start', 'voice_end', 'voice_start']);
    expect(ev[1]).toMatchObject({ reason: 'channel_reuse' });
    expect(activeVoices(s)).toHaveLength(1);
  });
});

describe('mpe-state: sustain and zone controllers', () => {
  it('sustain on the master holds a released member voice; sustain off ends it', () => {
    const s = createMpeState();
    feed(s, [[0xb0, 64, 127], [0x91, 60, 100], [0x81, 60, 0]]);
    expect(byChannel(s, 2)).toMatchObject({ held: false });
    const ev = feed(s, [[0xb0, 64, 0]]);
    expect(ev).toMatchObject([{ kind: 'voice_end', reason: 'release' }]);
    expect(activeVoices(s)).toHaveLength(0);
  });

  it('CC123 all notes off releases every zone voice; CC120 all sound off ends them even under sustain', () => {
    const s = createMpeState();
    feed(s, [[0x91, 60, 100], [0x92, 64, 100], [0xb0, 123, 0]]);
    expect(activeVoices(s)).toHaveLength(0);
    feed(s, [[0xb0, 64, 127], [0x91, 60, 100], [0xb0, 123, 0]]);
    expect(activeVoices(s)).toHaveLength(1); // sustained: released, not ended
    const ev = feed(s, [[0xb0, 120, 0]]);
    expect(ev).toMatchObject([{ kind: 'voice_end', reason: 'all_sound_off' }]);
  });

  it('CC121 reset all controllers zeroes the channel\'s expression', () => {
    const s = createMpeState();
    feed(s, [[0x91, 60, 100], [0xd1, 100], [0xe1, 0, 96], [0xb1, 121, 0]]);
    expect(byChannel(s, 2)).toMatchObject({ pressure: 0, bend: 0 });
  });

  it('Note Off must match the held note; a stray Note Off is counted and ignored', () => {
    const s = createMpeState();
    feed(s, [[0x91, 60, 100], [0x81, 61, 0]]);
    expect(activeVoices(s)).toHaveLength(1);
    expect(s.counters.rejected).toBe(1);
  });

  it('notes on the master channel are not voices', () => {
    const s = createMpeState();
    feed(s, [[0x90, 60, 100]]);
    expect(activeVoices(s)).toHaveLength(0);
  });
});

describe('mpe-state: malformed / version rejection (V14 half)', () => {
  it.each([
    [[0x91, 60]],
    [[0x91, 60, 100, 0]],
    [[0x91, 128, 100]],
    [[0x91, 60, 200]],
    [[0xf0, 0x7d, 0xf7]],
    [[0x71, 60, 100]],
    [[0xd1]],
    [[0xd1, 64, 0]],
  ])('%j is rejected without a voice', (bytes) => {
    const s = createMpeState();
    expect(decodeMpe(s, bytes as number[], 0)).toEqual([]);
    expect(s.counters.rejected).toBe(1);
    expect(activeVoices(s)).toHaveLength(0);
  });

  it('a non-finite timestamp is rejected', () => {
    const s = createMpeState();
    expect(decodeMpe(s, [0x91, 60, 100], Number.NaN)).toEqual([]);
    expect(activeVoices(s)).toHaveLength(0);
  });
});

describe('mpe-state: lanes — createVoiceAllocator with generation keys', () => {
  it('V10: lane exhaustion LRU-steals; the stolen voice\'s later release is a NO-OP on the stealer\'s lane', () => {
    const s = createMpeState({ lanes: 1 });
    const ev = feed(s, [[0x91, 60, 100], [0x92, 64, 100], [0x81, 60, 0]]);
    expect(ev.map((e) => e.kind)).toEqual(['voice_start', 'voice_end', 'voice_start']);
    expect(ev[1]).toMatchObject({ kind: 'voice_end', reason: 'stolen', voice: { note: 60, lane: 0 } });
    expect(activeVoices(s)).toEqual([expect.objectContaining({ note: 64, lane: 0, held: true })]);
    expect(s.counters.steals).toBe(1);
    expect(s.alloc.ownerOf(0)).toBe(2);
  });

  it('lanes are stable: releasing a low lane never moves the others', () => {
    const s = createMpeState({ lanes: 4 });
    feed(s, [[0x91, 60, 100], [0x92, 62, 100], [0x93, 64, 100], [0x81, 60, 0]]);
    expect(byChannel(s, 3)!.lane).toBe(1);
    expect(byChannel(s, 4)!.lane).toBe(2);
    feed(s, [[0x94, 66, 100]]);
    expect(byChannel(s, 5)!.lane).toBe(0);
  });

  it('the allocator contract this file relies on: release-after-steal returns null', () => {
    const a = createVoiceAllocator(1);
    a.noteOn(1);
    a.noteOn(2);
    expect(a.noteOff(1)).toBeNull();
    expect(a.ownerOf(0)).toBe(2);
  });
});

describe('mpe-state: the touch door', () => {
  const start = (s: MpeState, touch: number, note: number, epoch = 1) => applyTouch(s, { kind: 'touch_start', epoch, touch, region: 'keys', col: 0, row: 0, localCol: 0, localRow: 0, note, velocity: 100, time: 0 });

  it('the touch id is the allocator key: two touches, one pitch, two lanes', () => {
    const s = createMpeState();
    start(s, 7, 41);
    start(s, 8, 41);
    expect(s.alloc.laneOf(7)).toBe(0);
    expect(s.alloc.laneOf(8)).toBe(1);
  });

  it('expression maps bend/pressure/timbre onto the voice; a touch_slide keeps the voice', () => {
    const s = createMpeState();
    start(s, 1, 60);
    const ev = applyTouch(s, { kind: 'touch_expression', epoch: 1, touch: 1, region: 'keys', bendSemitones: 2.5, pressure: 0.5, timbre: 0.25, time: 1 });
    expect(ev).toMatchObject([{ kind: 'voice_expression', voice: { bend: 2.5, pressure: 0.5, timbre: 0.25 } }]);
    expect(applyTouch(s, { kind: 'touch_slide', epoch: 1, touch: 1, region: 'keys', fromCol: 0, toCol: 1, row: 0, time: 2 })).toEqual([]);
    expect(s.voices.get(1)).toMatchObject({ note: 60, held: true });
  });

  it('V14: an event from an older epoch is rejected — reset ends voices and opens the next epoch', () => {
    const s = createMpeState({ epoch: 1 });
    start(s, 1, 60);
    const ended = resetMpe(s, 5);
    expect(ended).toMatchObject([{ kind: 'voice_end', reason: 'session' }]);
    expect(s.epoch).toBe(2);
    expect(applyTouch(s, { kind: 'touch_end', epoch: 1, touch: 1, region: 'keys', reason: 'release', time: 6 })).toEqual([]);
    expect(start(s, 1, 60, 1)).toEqual([]); // old epoch: no resurrection
    expect(s.counters.rejected).toBe(2);
    expect(start(s, 2, 60, 2)).toHaveLength(1);
  });

  it('a stolen touch\'s release is a NO-OP; pointer/control events map to nothing', () => {
    const s = createMpeState({ lanes: 1 });
    start(s, 1, 60);
    start(s, 2, 64);
    expect(applyTouch(s, { kind: 'touch_end', epoch: 1, touch: 1, region: 'keys', reason: 'release', time: 1 })).toEqual([]);
    expect(s.voices.get(2)).toMatchObject({ lane: 0, held: true });
    expect(applyTouch(s, { kind: 'pointer', epoch: 1, touch: 2, phase: 'move', u: 0, v: 0, pressure: 0, time: 1 })).toEqual([]);
    expect(applyTouch(s, { kind: 'control_edge', epoch: 1, control: 'r', down: true, time: 1 })).toEqual([]);
  });

  it('panic ends every voice without moving the epoch', () => {
    const s = createMpeState();
    start(s, 1, 60);
    start(s, 2, 62);
    expect(panicMpe(s, 3).map((e) => e.kind)).toEqual(['voice_end', 'voice_end']);
    expect(s.epoch).toBe(1);
    expect(s.alloc.activeCount()).toBe(0);
  });
});
