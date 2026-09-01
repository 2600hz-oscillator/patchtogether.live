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
    expect(describeTrailsFrame([0xb0, 15, 64]).label).toBe('ch1[1X] CC15');
    expect(describeTrailsFrame([0xb7, 15, 64]).label).toBe('ch8[4Y] CC15');
  });

  it('names the transport bytes rather than printing them raw', () => {
    expect(describeTrailsFrame([0xf8]).label).toContain('CLOCK');
    expect(describeTrailsFrame([0xfa]).label).toContain('START');
    expect(describeTrailsFrame([0xfc]).label).toContain('STOP');
  });

  it('an UNKNOWN status is reported by its hex rather than guessed at', () => {
    expect(describeTrailsFrame([0xf1, 0x20]).label).toBe('SYSTEM 0xF1');
    expect(describeTrailsFrame([0xe0, 0, 64]).label).toBe('ch1[1X] PITCH-BEND');
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
    const row = snap.rows.find((r) => r.label === 'ch1[1X] CC47')!;
    expect(row.count).toBe(9);
    expect(row.decoded).toBe(false);
    expect(snap.summary).toContain('ch1[1X] CC47');
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
    expect(snap.rows.map((r) => r.label).sort()).toEqual(['ch1[1X] CC20', 'ch1[1X] CC21', 'ch1[1X] CC22']);
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

// ── ⚠ THE INSTRUMENT LIED — the two defects the first real capture exposed ──
//
// Both were found by pasting a live Trails MON readout (owner, 2026-09-01, note
// mode with both quantisations enabled) and nearly reporting its contents as a
// hardware fact:
//
//   ch2 NOTE 81 on   x106   last=0
//
// A device struck 53 times, reading "velocity 0". Neither half of that line was
// true: `last=` was the RELEASE'S velocity, and "on" was a label frozen at row
// creation. A diagnostic that reports a hardware question incorrectly is worse
// than none, because its answer is believed — so these two are pinned.

/** The running-status shape the owner's hardware actually sends: a strike is a
 *  note-ON with velocity, its release is a note-ON with velocity 0 — the SAME
 *  status byte and the SAME note number, so the same row. */
const NOTE_ON_CH2 = 0x91;

describe('trails-monitor: the readout must not lie about velocity', () => {
  it('BUG A: a release does NOT overwrite the strike velocity', () => {
    // The exact sequence in the capture: 53 strike/release pairs on one note.
    // Before the fix the row's only value field held the release's zero, and
    // the open hardware question — does this pad transmit touch force? — was
    // answered "no" by the instrument rather than by the device.
    const m = createTrailsMonitor();
    for (let i = 0; i < 53; i++) {
      m.observe([NOTE_ON_CH2, 81, 97], true);
      m.observe([NOTE_ON_CH2, 81, 0], true);
    }
    const row = m.snapshot().rows.find((r) => r.label === 'ch2[1Y] NOTE 81')!;
    expect(row.count, 'strikes and releases share one row').toBe(106);
    expect(row.lastValue, 'the raw last byte really was the release').toBe(0);
    expect(row.lastOnVelocity, 'THE FIX: the last STRIKE velocity survives').toBe(97);
    // …and it is the strike velocity that reaches the page.
    expect(m.snapshot().summary).toContain('vel=97');
    expect(m.snapshot().summary).not.toContain('vel=0');
  });

  it('a CHANGING velocity is visible — this is how the owner settles touch force', () => {
    // The whole point of the column: if pressing harder moves this number, the
    // pad transmits force; if it never moves, it does not. Either answer is a
    // finding, and neither is reachable while a release can clobber it.
    const m = createTrailsMonitor();
    for (const v of [40, 0, 80, 0, 120, 0]) m.observe([NOTE_ON_CH2, 81, v], true);
    expect(m.snapshot().rows[0]!.lastOnVelocity).toBe(120);
    // The readout says what the number means, so a reader does not have to
    // guess whether a constant value is a device fact or an instrument fault.
    expect(m.snapshot().summary).toContain('last NOTE-ON velocity');
  });

  it('a note row that has ONLY seen releases says so rather than printing 0', () => {
    // "No strike has been observed" and "the strike velocity was zero" are
    // different facts, and the second one is the one that would be believed.
    const m = createTrailsMonitor();
    m.observe([NOTE_ON_CH2, 81, 0], true);
    expect(m.snapshot().rows[0]!.lastOnVelocity).toBeNull();
    expect(m.snapshot().summary).toContain('vel=?');
  });

  it('BUG B: the LABEL tracks the stream instead of freezing at row creation', () => {
    // `observe()` updated count, value, decoded and seq — and never the label.
    // So a row born from a strike read "… on" for the rest of the session, which
    // is why the capture showed a label in one state beside a value from the
    // other. The state has been taken out of the label entirely: a row is a
    // SHAPE, not a moment.
    const m = createTrailsMonitor();
    m.observe([NOTE_ON_CH2, 81, 97], true);
    m.observe([NOTE_ON_CH2, 81, 0], true);
    const row = m.snapshot().rows[0]!;
    expect(row.label).toBe('ch2[1Y] NOTE 81');
    expect(row.label, 'no momentary state smuggled into the name').not.toContain('on');
    expect(row.label).not.toContain('off');
  });

  it('the frozen-label class is fixed generally, not just for notes', () => {
    // The eviction/decoded fields already tracked the stream; the label now
    // does too, so a shape whose display name depends on the frame cannot
    // describe only its first message. A row's DECODED verdict has always been
    // per-message and stays that way.
    const m = createTrailsMonitor();
    m.observe([CC_CH1, 15, 10], true);
    m.observe([CC_CH1, 15, 99], false);
    const row = m.snapshot().rows[0]!;
    expect(row.label).toBe('ch1[1X] CC15');
    expect(row.lastValue).toBe(99);
    expect(row.decoded).toBe(false);
  });

  it('a non-note row still prints `last=`, not a velocity it does not have', () => {
    const m = createTrailsMonitor();
    m.observe([CC_CH1, 15, 64], true);
    expect(m.snapshot().rows[0]!.valueLabel).toBe('last');
    expect(m.snapshot().summary).toContain('last=64');
    // …and the velocity footnote only appears when there is a note row to
    // explain, so a CC-mode paste is not cluttered with advice about notes.
    expect(m.snapshot().summary).not.toContain('NOTE-ON velocity');
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
    expect(snap.rows.find((r) => r.label === 'ch1[1X] CC47')!.decoded).toBe(false);
    expect(snap.rows.find((r) => r.label === 'ch9[--] CC15')!.decoded).toBe(false);
    expect(snap.rows.find((r) => r.label === `ch1[1X] CC${TRAILS_CC_PAIR.msb}`)!.decoded).toBe(true);
  });

  it('NOTE-MODE traffic reads as decoded, and the strike velocity is on the page', () => {
    // The note-mode capture, reproduced through the real decoder: a strike and
    // its running-status release on one axis channel. Both frames are
    // understood, so neither may inflate the "not decoded" tally and make a
    // healthy device look like a wrong CC pair.
    const d = createTrailsDecoder();
    const m = createTrailsMonitor();
    for (const f of [[0x90, 77, 97], [0x90, 77, 0], [0x91, 81, 88], [0x91, 81, 0]]) {
      m.observe(f, d.handleFrame(f, 0).recognised);
    }
    const snap = m.snapshot();
    expect(snap.unrecognised).toBe(0);
    expect(snap.rows.find((r) => r.label === 'ch1[1X] NOTE 77')!.lastOnVelocity).toBe(97);
    expect(snap.rows.find((r) => r.label === 'ch2[1Y] NOTE 81')!.lastOnVelocity).toBe(88);
  });
});
