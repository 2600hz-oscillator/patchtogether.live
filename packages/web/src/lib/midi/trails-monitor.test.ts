// packages/web/src/lib/midi/trails-monitor.test.ts
//
// The monitor's job is to be BELIEVABLE ABOUT TRAFFIC IT DOES NOT UNDERSTAND,
// because that is the only kind of traffic that can correct this module's wire
// constants. So the load-bearing tests here are the ones that drive it with
// messages the decoder rejects and check they are counted, named and flagged —
// a monitor that quietly dropped them would show a healthy-looking page on a
// device whose firmware disagreed with us, which is the exact failure a
// hardware session is convened to catch.

import { describe, it, expect } from 'vitest';
import { createTrailsMonitor, describeTrailsFrame, TRAILS_MONITOR_MAX_ROWS } from './trails-monitor';
import { createTrailsDecoder, TRAILS_CC_PAIR } from './trails-decode';

const CC_CH1 = 0xb0;

describe('trails-monitor: naming a frame', () => {
  it('prints channels 1-BASED, matching the manual\'s MIDI table', () => {
    // The wire nibble is 0-based and the manual's table starts at 1. A monitor
    // that printed the nibble would have its reader arguing about an off-by-one
    // with the one document it is being compared against.
    expect(describeTrailsFrame([0xb0, 15, 64]).label).toBe('ch1 CC15');
    expect(describeTrailsFrame([0xb7, 15, 64]).label).toBe('ch8 CC15');
  });

  it('names the transport bytes rather than printing them raw', () => {
    expect(describeTrailsFrame([0xf8]).label).toContain('CLOCK');
    expect(describeTrailsFrame([0xfa]).label).toContain('START');
    expect(describeTrailsFrame([0xfc]).label).toContain('STOP');
  });

  it('an UNKNOWN status is reported by its hex rather than guessed at', () => {
    expect(describeTrailsFrame([0xf1, 0x20]).label).toBe('SYSTEM 0xF1');
    expect(describeTrailsFrame([0xe0, 0, 64]).label).toBe('ch1 PITCH-BEND');
    expect(describeTrailsFrame([]).label).toBe('(empty frame)');
  });

  it('one shape is one KEY — the value does not split a row', () => {
    const a = describeTrailsFrame([CC_CH1, 15, 1]);
    const b = describeTrailsFrame([CC_CH1, 15, 127]);
    expect(a.key).toBe(b.key);
    expect(a.value).toBe(1);
    expect(b.value).toBe(127);
  });
});

describe('trails-monitor: tallying', () => {
  it('collapses a stream into rows with counts and the LAST value', () => {
    const m = createTrailsMonitor();
    for (let i = 0; i < 500; i++) m.observe([CC_CH1, 15, i % 128], true);
    const snap = m.snapshot();
    expect(snap.total).toBe(500);
    expect(snap.rows).toHaveLength(1);
    expect(snap.rows[0]!.count).toBe(500);
    expect(snap.rows[0]!.lastValue).toBe(499 % 128);
  });

  it('THE POINT: undecoded traffic is counted, flagged and visible in the paste', () => {
    const m = createTrailsMonitor();
    m.observe([CC_CH1, TRAILS_CC_PAIR.msb, 64], true);
    // CC47 is what the MIDI convention would pair with CC15. A firmware using
    // it would look exactly like this, and the summary has to say so.
    for (let i = 0; i < 9; i++) m.observe([CC_CH1, 47, i], false);
    const snap = m.snapshot();
    expect(snap.unrecognised).toBe(9);
    const row = snap.rows.find((r) => r.label === 'ch1 CC47')!;
    expect(row.count).toBe(9);
    expect(row.decoded).toBe(false);
    expect(snap.summary).toContain('ch1 CC47');
    expect(snap.summary).toContain('9 not decoded');
    // The advice that turns the observation into an action is on the page.
    expect(snap.summary).toContain('trails-decode.ts');
  });

  it('the summary of an untouched device says NOTHING RECEIVED rather than looking healthy', () => {
    const snap = createTrailsMonitor().snapshot();
    expect(snap.total).toBe(0);
    expect(snap.summary).toContain('nothing received');
  });

  it('evicts the LEAST RECENTLY SEEN shape, never the least frequent', () => {
    // A rare shape that just arrived is the interesting one. A monitor that
    // protected a CC row with ten thousand hits would throw away the single
    // message its reader is hunting for.
    const m = createTrailsMonitor(3);
    for (let i = 0; i < 1000; i++) m.observe([CC_CH1, 15, i % 128], true); // busy row
    m.observe([CC_CH1, 20, 1], false);
    m.observe([CC_CH1, 21, 1], false);
    // A fourth shape evicts CC15 — the least recently seen — not one of the
    // singletons.
    m.observe([CC_CH1, 22, 1], false);
    const snap = m.snapshot();
    expect(snap.truncated).toBe(true);
    expect(snap.rows.map((r) => r.label).sort()).toEqual(['ch1 CC20', 'ch1 CC21', 'ch1 CC22']);
  });

  it('is bounded — an unbounded firmware cannot grow the table without limit', () => {
    const m = createTrailsMonitor();
    for (let cc = 0; cc < 128; cc++) m.observe([CC_CH1, cc, 0], false);
    expect(m.snapshot().rows.length).toBeLessThanOrEqual(TRAILS_MONITOR_MAX_ROWS);
  });

  it('reset() zeroes it so a player can isolate a single gesture', () => {
    const m = createTrailsMonitor();
    m.observe([CC_CH1, 15, 1], true);
    m.reset();
    const snap = m.snapshot();
    expect(snap.total).toBe(0);
    expect(snap.rows).toHaveLength(0);
    expect(snap.truncated).toBe(false);
  });
});

describe('trails-monitor: driven by the REAL decoder', () => {
  it('agrees with the decoder about what was understood — and about what was not', () => {
    // The verdict is the DECODER'S, passed in rather than re-derived, so this
    // pairing is the thing under test: a monitor that re-implemented the decode
    // could never report a disagreement, which is the only reason it exists.
    const d = createTrailsDecoder();
    const m = createTrailsMonitor();
    const frames: number[][] = [
      [CC_CH1, TRAILS_CC_PAIR.msb, 0x40], // decoded — an axis
      [CC_CH1, TRAILS_CC_PAIR.lsb, 0x10], // decoded — its fine half
      [CC_CH1, 47, 0x10], // NOT decoded — wrong controller
      [0xb8, TRAILS_CC_PAIR.msb, 0x40], // NOT decoded — channel 9 is not an axis
      [0xf8], // decoded — clock
    ];
    for (const f of frames) m.observe(f, d.handle(f, 0).length > 0);

    const snap = m.snapshot();
    expect(snap.total).toBe(5);
    expect(snap.unrecognised).toBe(2);
    expect(snap.rows.find((r) => r.label === 'ch1 CC47')!.decoded).toBe(false);
    expect(snap.rows.find((r) => r.label === 'ch9 CC15')!.decoded).toBe(false);
    expect(snap.rows.find((r) => r.label === `ch1 CC${TRAILS_CC_PAIR.msb}`)!.decoded).toBe(true);
  });
});
