// User-Mode raw decoder — SYNTHETIC byte vectors (no LinnStrument connected;
// contracts/acceptance-vectors.synthetic.json:3). Status bytes are spelled by
// hand so the suite cannot agree with the decoder by construction.

import { describe, it, expect } from 'vitest';
import { createRawDecodeState, decodePhysicalMidi, reconnectRawDecode, type RawDecodeState } from './raw-decode';
import type { RawEvent } from './types';

function feed(state: RawDecodeState, messages: number[][], t0 = 0): { state: RawDecodeState; events: RawEvent[] } {
  const events: RawEvent[] = [];
  let s = state;
  messages.forEach((m, i) => {
    const r = decodePhysicalMidi(s, m, t0 + i * 0.001);
    s = r.state;
    events.push(...r.events);
  });
  return { state: s, events };
}
const kinds = (events: RawEvent[]): string[] => events.map((e) => e.kind);
const rejected = (events: RawEvent[]): string[] => events.flatMap((e) => (e.kind === 'rejected' ? [e.reason] : []));

describe('raw-decode: cell press / release', () => {
  it('Note On on a row channel is a fresh cell with a new touch id; Note Off ends it', () => {
    const { state, events } = feed(createRawDecodeState(), [[0x93, 12, 100], [0x83, 12, 40]]);
    expect(events).toEqual([
      { kind: 'cell_down', epoch: 1, touch: 1, col: 12, row: 3, velocity: 100, time: 0 },
      { kind: 'cell_up', epoch: 1, touch: 1, col: 12, row: 3, releaseVelocity: 40, time: 0.001 },
    ]);
    expect(state.contacts.size).toBe(0);
  });

  it('Note On velocity 0 is a release', () => {
    const { events } = feed(createRawDecodeState(), [[0x90, 1, 100], [0x90, 1, 0]]);
    expect(kinds(events)).toEqual(['cell_down', 'cell_up']);
  });

  it('a repeated Note On on a held cell is rejected as duplicate_press and keeps the touch id', () => {
    const { state, events } = feed(createRawDecodeState(), [[0x90, 1, 100], [0x90, 1, 100]]);
    expect(rejected(events)).toEqual(['duplicate_press']);
    expect(state.contacts.get(1)?.touch).toBe(1);
    expect(state.nextTouch).toBe(2);
  });

  it('touch ids are never reused, even across a reconnect', () => {
    let r = feed(createRawDecodeState(), [[0x90, 1, 100], [0x80, 1, 0], [0x90, 2, 100]]);
    expect(r.events.filter((e) => e.kind === 'cell_down').map((e) => (e as { touch: number }).touch)).toEqual([1, 2]);
    const rc = reconnectRawDecode(r.state, 1);
    r = feed(rc.state, [[0x90, 3, 100]]);
    expect((r.events[0] as { touch: number }).touch).toBe(3);
    expect(r.events[0]!.epoch).toBe(2);
  });

  it('does not mutate the input state', () => {
    const s0 = createRawDecodeState();
    decodePhysicalMidi(s0, [0x90, 1, 100], 0);
    expect(s0.contacts.size).toBe(0);
    expect(s0.nextTouch).toBe(1);
  });
});

describe('raw-decode: X hi/lo pair assembly', () => {
  it('lo (CC col+32) then hi (CC col) publishes once with x = hi·128 + lo and initialX latched', () => {
    const { events } = feed(createRawDecodeState(), [[0x92, 20, 100], [0xb2, 52, 84], [0xb2, 20, 30]]);
    expect(kinds(events)).toEqual(['cell_down', 'cell_x']);
    expect(events[1]).toMatchObject({ kind: 'cell_x', col: 20, row: 2, x: 30 * 128 + 84, initialX: 3924 });
  });

  it('hi then lo assembles too (arrival order is a hardware question, design.md:186)', () => {
    const { events } = feed(createRawDecodeState(), [[0x92, 20, 100], [0xb2, 20, 30], [0xb2, 52, 84]]);
    expect(kinds(events)).toEqual(['cell_down', 'cell_x']);
    expect(events[1]).toMatchObject({ x: 3924 });
  });

  it('a second pair moves x but keeps initialX', () => {
    const { events } = feed(createRawDecodeState(), [
      [0x92, 20, 100], [0xb2, 52, 84], [0xb2, 20, 30], [0xb2, 52, 0], [0xb2, 20, 31],
    ]);
    const xs = events.filter((e) => e.kind === 'cell_x');
    expect(xs).toHaveLength(2);
    expect(xs[1]).toMatchObject({ x: 31 * 128, initialX: 3924 });
  });

  it('two hi bytes without a lo publish nothing; the later hi wins when the lo lands', () => {
    const { events } = feed(createRawDecodeState(), [[0x92, 20, 100], [0xb2, 20, 30], [0xb2, 20, 31], [0xb2, 52, 1]]);
    const xs = events.filter((e) => e.kind === 'cell_x');
    expect(xs).toHaveLength(1);
    expect(xs[0]).toMatchObject({ x: 31 * 128 + 1 });
  });

  it('CC 6 / CC 38 are X for wire column 6 unless an NRPN was opened by CC99+CC98', () => {
    const { events } = feed(createRawDecodeState(), [[0x90, 6, 100], [0xb0, 38, 5], [0xb0, 6, 2]]);
    expect(kinds(events)).toEqual(['cell_down', 'cell_x']);
    expect(events[1]).toMatchObject({ col: 6, x: 2 * 128 + 5 });
  });

  it('a coordinate CC for a cell with no contact is rejected (no_contact)', () => {
    const { events } = feed(createRawDecodeState(), [[0xb2, 52, 84]]);
    expect(rejected(events)).toEqual(['no_contact']);
  });
});

describe('raw-decode: local Y and Z', () => {
  it('CC col+64 is local Y; poly pressure at the column note is Z (zero is a held value)', () => {
    const { events } = feed(createRawDecodeState(), [[0x95, 9, 100], [0xb5, 73, 127], [0xa5, 9, 0]]);
    expect(events[1]).toMatchObject({ kind: 'cell_y', col: 9, row: 5, y: 127 });
    expect(events[2]).toMatchObject({ kind: 'cell_z', col: 9, row: 5, z: 0 });
  });
});

describe('raw-decode: malformed input', () => {
  it.each([
    [[0x90, 128, 100], 'high_bit_data'],
    [[0x90, 1, 200], 'high_bit_data'],
    [[0x70, 1, 100], 'unknown_status'],
    [[0xf8], 'malformed'],
    [[0x90, 1], 'malformed'],
    [[0x90, 1, 100, 0], 'malformed'],
    [[0x90, 1.5, 100], 'malformed'],
    [[0x90, -1, 100], 'malformed'],
    [[0xc0, 1], 'unknown_status'],
    [[0x98, 1, 100], 'row_out_of_range'],
    [[0x90, 0, 100], 'column_out_of_range'],
    [[0x90, 26, 100], 'column_out_of_range'],
    [[0xb0, 119, 0], 'column_out_of_range'],
    [[0xb0, 30, 5], 'unmapped_cc'],
  ])('%j → rejected %s', (bytes, reason) => {
    const { state, events } = feed(createRawDecodeState(), [bytes as number[]]);
    expect(rejected(events)).toEqual([reason]);
    expect(state.counters.rejected).toBe(1);
    expect(state.contacts.size).toBe(0);
  });

  it('a non-finite timestamp is rejected', () => {
    const r = decodePhysicalMidi(createRawDecodeState(), [0x90, 1, 100], Number.NaN);
    expect(rejected(r.events)).toEqual(['malformed']);
  });
});

describe('raw-decode: CC119 slide transactions', () => {
  it('CC119 source, Note On adjacent destination, Note Off source = one transferred touch, no new attack', () => {
    const { state, events } = feed(createRawDecodeState(), [[0x93, 12, 100], [0xb3, 119, 12], [0x93, 13, 100], [0x83, 12, 13]]);
    expect(kinds(events)).toEqual(['cell_down', 'cell_slide']);
    expect(events[1]).toMatchObject({ kind: 'cell_slide', touch: 1, fromCol: 12, toCol: 13, row: 3 });
    expect(state.contacts.get(3 * 32 + 13)).toMatchObject({ touch: 1, col: 13, originCol: 12 });
    expect(state.contacts.has(3 * 32 + 12)).toBe(false);
    expect(state.transfers.size).toBe(0);
  });

  it('a slide drops a half-assembled X pair so the old cell\'s lo cannot pair with the new cell\'s hi', () => {
    const { events } = feed(createRawDecodeState(), [
      [0x93, 12, 100], [0xb3, 44, 7], [0xb3, 119, 12], [0x93, 13, 100], [0x83, 12, 13], [0xb3, 13, 30],
    ]);
    expect(events.filter((e) => e.kind === 'cell_x')).toHaveLength(0);
  });

  it('a transaction interrupted by the source release is a plain release, counted as malformed', () => {
    const { state, events } = feed(createRawDecodeState(), [[0x93, 12, 100], [0xb3, 119, 12], [0x83, 12, 0]]);
    expect(kinds(events)).toEqual(['cell_down', 'rejected', 'cell_up']);
    expect(rejected(events)).toEqual(['malformed_slide']);
    expect(state.counters.malformedSlides).toBe(1);
    expect(state.contacts.size).toBe(0);
    expect(state.transfers.size).toBe(0);
  });

  it('a Note On that is not adjacent to the marked source is a fresh press and the marker dies', () => {
    const { state, events } = feed(createRawDecodeState(), [[0x93, 12, 100], [0xb3, 119, 12], [0x93, 15, 100]]);
    expect(kinds(events)).toEqual(['cell_down', 'rejected', 'cell_down']);
    expect((events[2] as { touch: number }).touch).toBe(2);
    expect(state.transfers.size).toBe(0);
  });

  it('a marker with no matching source contact is malformed, not a transfer', () => {
    const { events } = feed(createRawDecodeState(), [[0xb3, 119, 12], [0x93, 13, 100]]);
    expect(kinds(events)).toEqual(['rejected', 'cell_down']);
  });

  it('a second CC119 on the same row replaces the first and counts', () => {
    const { state } = feed(createRawDecodeState(), [[0x93, 12, 100], [0xb3, 119, 12], [0xb3, 119, 12]]);
    expect(state.counters.malformedSlides).toBe(1);
    expect(state.transfers.get(3)).toEqual({ fromCol: 12, toCol: null });
  });

  it('an ordinary Note Off with nonzero velocity and no marker ends the cell — no invented transfer (V09)', () => {
    const { events } = feed(createRawDecodeState(), [[0x90, 5, 100], [0x80, 5, 90]]);
    expect(kinds(events)).toEqual(['cell_down', 'cell_up']);
    expect(events[1]).toMatchObject({ releaseVelocity: 90 });
  });
});

describe('raw-decode: epoch invalidation', () => {
  it('reconnect ends every contact with reason session, bumps the epoch and emits a mode event', () => {
    const r0 = feed(createRawDecodeState(), [[0x90, 3, 100], [0x91, 4, 100]]);
    const rc = reconnectRawDecode(r0.state, 5, true);
    expect(kinds(rc.events)).toEqual(['cell_up', 'cell_up', 'mode']);
    expect(rc.events[0]).toMatchObject({ epoch: 1, reason: 'session', touch: 1 });
    expect(rc.events[2]).toMatchObject({ kind: 'mode', epoch: 2, userMode: true });
    expect(rc.state.epoch).toBe(2);
    expect(rc.state.contacts.size).toBe(0);
  });

  it('an old queued release after reconnect is rejected — nothing to resurrect (V14)', () => {
    const r0 = feed(createRawDecodeState(), [[0x90, 3, 100]]);
    const rc = reconnectRawDecode(r0.state, 1);
    const r1 = feed(rc.state, [[0x80, 3, 0], [0xb0, 35, 4], [0xa0, 3, 9]]);
    expect(rejected(r1.events)).toEqual(['no_contact', 'no_contact', 'no_contact']);
    expect(r1.events.every((e) => e.epoch === 2)).toBe(true);
  });

  it('NRPN 245 readback on the wire is a mode notification and opens a new epoch', () => {
    const r0 = feed(createRawDecodeState(), [[0x90, 3, 100]]);
    const r1 = feed(r0.state, [[0xb0, 99, 1], [0xb0, 98, 117], [0xb0, 6, 0], [0xb0, 38, 1], [0xb0, 101, 127], [0xb0, 100, 127]]);
    expect(kinds(r1.events)).toEqual(['cell_up', 'mode']);
    expect(r1.events[1]).toMatchObject({ kind: 'mode', userMode: true, epoch: 2 });
    expect(r1.state.userMode).toBe(true);
    expect(r1.state.nrpn.size).toBe(0);
  });

  it("the firmware's own echo rides CHANNEL 9 (0xB8, ls_settings.ino `midiSendNRPN(245, …, 9)`) — a channel beyond the eight rows is still a mode notification", () => {
    const r0 = feed(createRawDecodeState(), [[0x90, 3, 100]]);
    const r1 = feed(r0.state, [[0xb8, 99, 1], [0xb8, 98, 117], [0xb8, 6, 0], [0xb8, 38, 1], [0xb8, 101, 127], [0xb8, 100, 127]]);
    expect(kinds(r1.events)).toEqual(['cell_up', 'mode']);
    expect(r1.events[1]).toMatchObject({ kind: 'mode', userMode: true, epoch: 2 });
    // …and the answer to an NRPN 299 read comes back on the ASKING channel
    // with the current value: the same notification, value 0 = mode off.
    const r2 = feed(r1.state, [[0xb0, 99, 1], [0xb0, 98, 117], [0xb0, 6, 0], [0xb0, 38, 0], [0xb0, 101, 127], [0xb0, 100, 127]]);
    expect(kinds(r2.events)).toEqual(['mode']);
    expect(r2.events[0]).toMatchObject({ kind: 'mode', userMode: false, epoch: 3 });
  });

  it('a different NRPN parameter completes silently and CC6/38 for column 6 resume their X meaning', () => {
    const { events } = feed(createRawDecodeState(), [
      [0xb0, 99, 1], [0xb0, 98, 118], [0xb0, 6, 0], [0xb0, 38, 1], // NRPN 246
      [0x90, 6, 100], [0xb0, 38, 5], [0xb0, 6, 2],
    ]);
    expect(kinds(events)).toEqual(['cell_down', 'cell_x']);
  });
});
