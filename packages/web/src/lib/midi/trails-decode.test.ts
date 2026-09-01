// packages/web/src/lib/midi/trails-decode.test.ts
//
// GOLDEN BYTE VECTORS for the Bela Trails wire decoder.
//
// ⚠ EVERY EXPECTED BYTE IN THIS FILE IS A LITERAL. The decoder's own constants
// (`TRAILS_CC_PAIR`, `TRAILS_AXIS_MAP`) are imported only where the test's job
// is to state what they currently ARE — the vectors themselves spell 0xB0,
// 0x0F, 0x25 by hand, so the suite cannot agree with the decoder by
// construction. That is the property that makes the hardware-verify session a
// one-line correction: when a MIDI monitor shows a different pair, the constant
// moves, THESE VECTORS GO RED, and the two are reconciled deliberately.

import { describe, it, expect } from 'vitest';
import {
  createTrailsDecoder,
  encodeTrailsAxis,
  encodeTrailsGate,
  encodeTrailsNote,
  trailsNoteToValue14,
  TRAILS_ACTIVITY_GATE_TIMEOUT_MS,
  TRAILS_AXIS_MAP,
  TRAILS_CC_FULL_SCALE,
  TRAILS_CC_PAIR,
  TRAILS_CHANNEL_COUNT,
  TRAILS_LOOP_PLAYHEAD_CHANNEL,
  TRAILS_NOTE_AXIS_RANGE,
  type TrailsEvent,
} from './trails-decode';

/** The manual's documented pairing, spelled out. If this fails, the constant
 *  moved — which is exactly what a hardware correction looks like, and the
 *  reviewer should see it in the diff rather than infer it. */
const CC_MSB = 0x0f; // 15
const CC_LSB = 0x25; // 37
const CC_STATUS_CH1 = 0xb0; // Control Change, wire channel 0
const CC_STATUS_CH2 = 0xb1; // Control Change, wire channel 1

function axes(events: readonly TrailsEvent[]): Extract<TrailsEvent, { kind: 'axis' }>[] {
  return events.filter((e): e is Extract<TrailsEvent, { kind: 'axis' }> => e.kind === 'axis');
}
function gates(events: readonly TrailsEvent[]): Extract<TrailsEvent, { kind: 'gate' }>[] {
  return events.filter((e): e is Extract<TrailsEvent, { kind: 'gate' }> => e.kind === 'gate');
}

describe('trails-decode: the documented wire constants', () => {
  it('names the manual\'s NONSTANDARD CC pair, CC15 (MSB) + CC37 (LSB)', () => {
    // The MIDI convention would pair 15 with 47 (n + 32); 37 is the fine
    // partner of 5. Both numbers are stated here so a hardware correction is a
    // reviewed, visible change rather than a silent one.
    expect(TRAILS_CC_PAIR.msb).toBe(CC_MSB);
    expect(TRAILS_CC_PAIR.lsb).toBe(CC_LSB);
    expect(TRAILS_CC_PAIR.lsb).not.toBe(TRAILS_CC_PAIR.msb + 32);
  });

  it('maps the eight MIDI channels channel-major, X before Y', () => {
    expect(TRAILS_AXIS_MAP).toHaveLength(TRAILS_CHANNEL_COUNT * 2);
    expect(TRAILS_AXIS_MAP.map((a) => `${a.axis}${a.channel}`)).toEqual([
      'x1', 'y1', 'x2', 'y2', 'x3', 'y3', 'x4', 'y4',
    ]);
  });

  it('full scale is the 14-bit maximum', () => {
    expect(TRAILS_CC_FULL_SCALE).toBe(16383);
  });
});

describe('trails-decode: 14-bit assembly', () => {
  it('MSB then LSB assembles the two halves into one 14-bit value', () => {
    const d = createTrailsDecoder();
    // MSB 0x40 = 64 → 64 << 7 = 8192, with the LSB still at its initial 0.
    const first = axes(d.handle([CC_STATUS_CH1, CC_MSB, 0x40], 0));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ channel: 1, axis: 'x', value14: 8192 });
    // LSB 0x7F = 127 → 8192 | 127 = 8319.
    const second = axes(d.handle([CC_STATUS_CH1, CC_LSB, 0x7f], 1));
    expect(second).toHaveLength(1);
    expect(second[0]!.value14).toBe(8319);
    expect(second[0]!.unit).toBeCloseTo(8319 / 16383, 10);
  });

  it('full scale is exactly 1.0 and zero is exactly 0.0', () => {
    const d = createTrailsDecoder();
    d.handle([CC_STATUS_CH1, CC_MSB, 0x7f], 0);
    const top = axes(d.handle([CC_STATUS_CH1, CC_LSB, 0x7f], 0));
    expect(top[0]!.value14).toBe(16383);
    expect(top[0]!.unit).toBe(1);
    d.handle([CC_STATUS_CH1, CC_MSB, 0x00], 0);
    const bottom = axes(d.handle([CC_STATUS_CH1, CC_LSB, 0x00], 0));
    expect(bottom[0]!.value14).toBe(0);
    expect(bottom[0]!.unit).toBe(0);
  });

  it('an MSB-ONLY stream still moves the jack', () => {
    // The device is allowed to send only the coarse half; a strict
    // MSB-latches-LSB-completes machine would emit nothing at all here.
    const d = createTrailsDecoder();
    const values = [0x10, 0x20, 0x30].map(
      (v) => axes(d.handle([CC_STATUS_CH1, CC_MSB, v], 0))[0]!.value14,
    );
    expect(values).toEqual([0x10 << 7, 0x20 << 7, 0x30 << 7]);
  });

  it('a LEADING LSB, with no coarse half ever seen, emits NOTHING', () => {
    // Guessing a coarse half would put the finger at the left edge of the pad
    // for one frame, which reads as a real gesture.
    const d = createTrailsDecoder();
    expect(axes(d.handle([CC_STATUS_CH1, CC_LSB, 0x7f], 0))).toHaveLength(0);
    // …and the value that finally arrives carries the fine half that was
    // already latched, rather than dropping it.
    const first = axes(d.handle([CC_STATUS_CH1, CC_MSB, 0x01], 0));
    expect(first[0]!.value14).toBe((0x01 << 7) | 0x7f);
  });

  it('OUT-OF-ORDER halves converge on the same value as in-order halves', () => {
    const inOrder = createTrailsDecoder();
    inOrder.handle([CC_STATUS_CH1, CC_MSB, 0x2a], 0);
    inOrder.handle([CC_STATUS_CH1, CC_LSB, 0x33], 0);
    // Prime both decoders identically, then deliver the SECOND pair in the
    // opposite order.
    const swapped = createTrailsDecoder();
    swapped.handle([CC_STATUS_CH1, CC_MSB, 0x2a], 0);
    swapped.handle([CC_STATUS_CH1, CC_LSB, 0x33], 0);

    const a = axes(inOrder.handle([CC_STATUS_CH1, CC_MSB, 0x55], 0)).concat(
      axes(inOrder.handle([CC_STATUS_CH1, CC_LSB, 0x11], 0)),
    );
    const b = axes(swapped.handle([CC_STATUS_CH1, CC_LSB, 0x11], 0)).concat(
      axes(swapped.handle([CC_STATUS_CH1, CC_MSB, 0x55], 0)),
    );
    expect(a[a.length - 1]!.value14).toBe((0x55 << 7) | 0x11);
    expect(b[b.length - 1]!.value14).toBe((0x55 << 7) | 0x11);
  });

  it('each MIDI channel drives its own axis, and channels 9-16 are ignored', () => {
    const d = createTrailsDecoder();
    // Wire channel 1 (status 0xB1) is channel 1's Y.
    const y = axes(d.handle([CC_STATUS_CH2, CC_MSB, 0x7f], 0));
    expect(y[0]).toMatchObject({ channel: 1, axis: 'y' });
    // Wire channel 7 (status 0xB7) is channel 4's Y.
    const last = axes(d.handle([0xb7, CC_MSB, 0x7f], 0));
    expect(last[0]).toMatchObject({ channel: 4, axis: 'y' });
    // Wire channel 8 (status 0xB8) is not a Trails axis — no guess, no event.
    expect(axes(d.handle([0xb8, CC_MSB, 0x7f], 0))).toHaveLength(0);
  });

  it('a CC that is neither half of the pair is ignored', () => {
    const d = createTrailsDecoder();
    // CC47 is what the MIDI convention would pair with CC15. If the hardware
    // turns out to use it, THIS test is the one that has to change too.
    expect(axes(d.handle([CC_STATUS_CH1, 47, 0x7f], 0))).toHaveLength(0);
    expect(axes(d.handle([CC_STATUS_CH1, 1, 0x7f], 0))).toHaveLength(0);
  });

  it('a correction to the CC pair moves the WHOLE decode in one edit', () => {
    // The hardware-verify path, exercised: swap in the MIDI-convention pair and
    // the same decoder reads CC15+CC47 instead, with nothing else touched.
    const d = createTrailsDecoder({ ccPair: { msb: 15, lsb: 47 } });
    d.handle([CC_STATUS_CH1, 0x0f, 0x40], 0);
    const out = axes(d.handle([CC_STATUS_CH1, 47, 0x7f], 0));
    expect(out[0]!.value14).toBe(8319);
  });
});

describe('trails-decode: gates', () => {
  it('note on / note off drive a channel gate', () => {
    const d = createTrailsDecoder();
    const on = gates(d.handle([0x90, 60, 100], 0));
    expect(on).toEqual([{ kind: 'gate', channel: 1, high: true, source: 'note' }]);
    const off = gates(d.handle([0x80, 60, 0], 1));
    expect(off).toEqual([{ kind: 'gate', channel: 1, high: false, source: 'note' }]);
  });

  it('note-on with velocity 0 is a note-off (running-status convention)', () => {
    const d = createTrailsDecoder();
    d.handle([0x90, 60, 100], 0);
    expect(gates(d.handle([0x90, 60, 0], 1))).toEqual([
      { kind: 'gate', channel: 1, high: false, source: 'note' },
    ]);
  });

  it('a second held note does not re-fire the gate, and the gate falls only when all are released', () => {
    const d = createTrailsDecoder();
    d.handle([0x90, 60, 100], 0);
    expect(gates(d.handle([0x90, 64, 100], 1))).toHaveLength(0);
    expect(gates(d.handle([0x80, 60, 0], 2))).toHaveLength(0);
    expect(gates(d.handle([0x80, 64, 0], 3))[0]!.high).toBe(false);
  });

  it('with NO notes, CC activity raises the gate and quiet drops it', () => {
    // The manual does not say what carries the gate in ordinary CC mode, so
    // this path exists to be usable if it turns out the answer is "nothing".
    const d = createTrailsDecoder();
    const rise = gates(d.handle([CC_STATUS_CH1, CC_MSB, 0x40], 1000));
    expect(rise).toEqual([{ kind: 'gate', channel: 1, high: true, source: 'activity' }]);
    // Still streaming — no fall.
    d.handle([CC_STATUS_CH1, CC_MSB, 0x41], 1050);
    expect(d.tick(1100)).toHaveLength(0);
    // Quiet for longer than the timeout — the gate falls exactly once.
    const fall = gates(d.tick(1050 + TRAILS_ACTIVITY_GATE_TIMEOUT_MS));
    expect(fall).toEqual([{ kind: 'gate', channel: 1, high: false, source: 'activity' }]);
    expect(d.tick(9999)).toHaveLength(0);
  });

  it('once a channel has EVER sent a note, the activity timeout never touches it', () => {
    const d = createTrailsDecoder();
    d.handle([CC_STATUS_CH1, CC_MSB, 0x40], 0); // activity gate up
    d.handle([0x90, 60, 100], 1); // …and now the device proves it sends notes
    // No spurious edge on the handover: the note said HIGH and it was HIGH.
    expect(gates(d.handle([CC_STATUS_CH1, CC_MSB, 0x41], 2))).toHaveLength(0);
    // …and a long silence does NOT drop a note-held gate.
    expect(d.tick(60_000)).toHaveLength(0);
  });

  it('a note-OFF as a channel\'s FIRST note LOWERS a gate that was already high', () => {
    // ⚠ THE STRANDED-HIGH HOLE. On the activity→note handover the old code
    // zeroed the level and then compared the new level against that zero, so a
    // channel that was high and whose first note message was a note-off
    // computed `false !== false` and emitted NOTHING — leaving the jack at 1
    // with nothing left to lower it, because `tick()` skips note channels
    // forever after. The loop retrigger made this reachable from a bare Start.
    const d = createTrailsDecoder();
    d.handle([0xb0, CC_MSB, 0x40], 0); // activity gate UP on channel 1
    const off = gates(d.handle([0x80, 60, 0], 1)); // …first note is a note-OFF
    expect(off).toEqual([{ kind: 'gate', channel: 1, high: false, source: 'note' }]);
  });

  it('gates are per channel', () => {
    const d = createTrailsDecoder();
    // Wire channel 2 (status 0x92) belongs to Trails channel 2.
    expect(gates(d.handle([0x92, 60, 100], 0))[0]!.channel).toBe(2);
    // Wire channel 4 (status 0x94) belongs to Trails channel 3.
    expect(gates(d.handle([0x94, 60, 100], 0))[0]!.channel).toBe(3);
  });
});

// ── The loop gate ──────────────────────────────────────────────────────────
//
// The defect this section exists for, stated: during playback the device
// streams a recorded gesture's X/Y CONTINUOUSLY, so the activity gate rises
// once at the start of the stream and — there being no gap to notice — never
// falls again. One held gate for the whole session, instead of one gate per
// loop repetition. The device DOES announce each repetition, as MIDI Start
// ("A Start message is sent every time the playhead restarts from the beginning
// of the track"), and the decoder used to spend that byte on the clock divider
// alone.

/** Stream `n` gapless axis samples on `channel`, the way a looping recording
 *  arrives. Returns every event produced. */
function glide(
  d: ReturnType<typeof createTrailsDecoder>,
  channel: number,
  n: number,
  startMs = 0,
): TrailsEvent[] {
  const out: TrailsEvent[] = [];
  const wire = (channel - 1) * 2;
  for (let i = 0; i < n; i++) {
    // 5 ms apart — a 200 Hz stream, comfortably inside the 120 ms timeout, so
    // nothing here can fall quiet by accident.
    out.push(...d.handle([0xb0 | wire, CC_MSB, (i * 7) % 128], startMs + i * 5));
  }
  return out;
}

describe('trails-decode: the loop gate', () => {
  it('NEGATIVE CONTROL: gapless playback alone yields exactly ONE gate, forever', () => {
    // This is the reported bug, reproduced. Two hundred samples of continuous
    // motion — several loops' worth — and the activity mechanism has exactly
    // one edge to offer, because a loop restart is a value discontinuity and
    // not a gap. No timeout value could change this.
    const d = createTrailsDecoder();
    const events = glide(d, 1, 200);
    expect(gates(events)).toHaveLength(1);
    expect(gates(events)[0]).toMatchObject({ high: true, source: 'activity' });
    // …and it never falls while the stream keeps flowing.
    expect(d.tick(200 * 5)).toHaveLength(0);
  });

  it('a Start during gapless playback produces a LOOP gate even though the level never changed', () => {
    const d = createTrailsDecoder();
    glide(d, 1, 20);
    const restart = d.handle([0xfa], 100);
    expect(restart).toContainEqual({ kind: 'transport', running: true, reset: true });
    expect(gates(restart)).toEqual([{ kind: 'gate', channel: 1, high: true, source: 'loop' }]);
  });

  it('N loop repetitions produce exactly N loop gates — the 1:1 the owner asked for', () => {
    const d = createTrailsDecoder();
    // The gesture is playing BEFORE the first repetition is announced, which is
    // the order it happens in on hardware: a channel has to have a recording on
    // it before its playhead can restart.
    glide(d, 1, 20, 0);
    let loops = 0;
    for (let rep = 1; rep <= 6; rep++) {
      const ev = d.handle([0xfa], rep * 500);
      loops += gates(ev).filter((g) => g.source === 'loop').length;
      glide(d, 1, 20, rep * 500);
    }
    expect(loops).toBe(6);
  });

  it('a loop restart REFRESHES activity, so the next tick cannot drop the gate it just raised', () => {
    // Without this the restart would raise a gate on a channel whose
    // `lastAxisMs` is stale (or −Infinity, on a channel that has never
    // streamed) and the very next tick would drop it again.
    const d = createTrailsDecoder();
    glide(d, 1, 4, 0); // a gesture exists, and its stream then stops
    d.handle([0xfa], 1000);
    expect(d.tick(1000 + TRAILS_ACTIVITY_GATE_TIMEOUT_MS - 1)).toHaveLength(0);
    // …and it is still a normal activity gate afterwards: quiet drops it.
    expect(gates(d.tick(1000 + TRAILS_ACTIVITY_GATE_TIMEOUT_MS))).toEqual([
      { kind: 'gate', channel: 1, high: false, source: 'activity' },
    ]);
  });

  it('scope ACTIVE reaches every streaming channel; scope FIRST reaches only channel 1', () => {
    const active = createTrailsDecoder({ loopRetriggerScope: 'active' });
    glide(active, 1, 4);
    glide(active, 3, 4);
    expect(gates(active.handle([0xfa], 50)).map((g) => g.channel)).toEqual([1, 3]);

    const first = createTrailsDecoder({ loopRetriggerScope: 'first' });
    glide(first, 1, 4);
    glide(first, 3, 4);
    expect(gates(first.handle([0xfa], 50)).map((g) => g.channel)).toEqual([1]);
  });

  it('a channel in a SILENT SECTION still re-strikes, and channel 1 is NOT struck in its place', () => {
    // ⚠ THE REGRESSION THIS SELECTOR EXISTS FOR. The hardware gate also strikes
    // "after each silent section in the recording", so a recorded gesture goes
    // quiet mid-cycle and its activity gate legitimately falls. Selecting loop
    // targets on the LIVE GATE LEVEL found nothing active, fell through to
    // channel 1, and struck an EMPTY jack while the channel that actually
    // restarted got nothing at all.
    const d = createTrailsDecoder({ loopRetriggerScope: 'active' });
    glide(d, 3, 4, 0);
    // The silence: long enough for channel 3's activity gate to fall.
    expect(gates(d.tick(TRAILS_ACTIVITY_GATE_TIMEOUT_MS * 4))).toEqual([
      { kind: 'gate', channel: 3, high: false, source: 'activity' },
    ]);
    // …and the restart still finds it.
    expect(gates(d.handle([0xfa], 1000))).toEqual([
      { kind: 'gate', channel: 3, high: true, source: 'loop' },
    ]);
  });

  it('with NOTHING recorded, a restart strikes no gate at all in ACTIVE scope', () => {
    // A Start with no gesture on any channel is not a gesture repetition.
    // Striking channel 1 regardless would put a pulse train on an empty jack
    // for as long as the transport ran.
    const d = createTrailsDecoder({ loopRetriggerScope: 'active' });
    expect(gates(d.handle([0xfa], 0))).toHaveLength(0);
    // The transport event itself still lands — the clock divider still resets.
    expect(d.handle([0xfa], 1)).toContainEqual({
      kind: 'transport',
      running: true,
      reset: true,
    });
  });

  it('FIRST scope always speaks for the one playhead the device reports', () => {
    // The escape hatch for a player in polymeter: strictly what the message
    // asserts, whether or not anything has streamed.
    const d = createTrailsDecoder({ loopRetriggerScope: 'first' });
    expect(gates(d.handle([0xfa], 0))).toEqual([
      { kind: 'gate', channel: 1, high: true, source: 'loop' },
    ]);
    expect(TRAILS_LOOP_PLAYHEAD_CHANNEL).toBe(1);
  });

  it('a NOTE-mode channel is left alone — the notes are already the articulation', () => {
    const d = createTrailsDecoder();
    d.handle([0x90, 60, 100], 0); // channel 1 proves it sends notes
    glide(d, 2, 4, 10);
    // Channel 1 is skipped; channel 2, which only ever streamed CC, is not.
    expect(gates(d.handle([0xfa], 50)).map((g) => g.channel)).toEqual([2]);
  });

  it('CONTINUE is not a loop restart — only Start is', () => {
    // 0xFB resumes a transport; the manual attaches the per-repetition meaning
    // to Start alone, and treating both alike would double-fire on any device
    // that sends a Continue.
    const d = createTrailsDecoder();
    glide(d, 1, 4);
    expect(gates(d.handle([0xfb], 50))).toHaveLength(0);
    expect(gates(d.handle([0xfc], 60))).toHaveLength(0);
  });
});

// ── NOTE MODE ──────────────────────────────────────────────────────────────
//
// THE DEFECT, in the owner's words: "when i hit scale i am just getting one
// continuous note output even when i select other notes in the scale."
//
// The mechanism, from the quick reference: "When both pitch and temporal
// quantisation are enabled, Trails transmits MIDI Notes. Otherwise it sends
// high-resolution MIDI CC." Note mode REPLACES the CC stream — same two axes,
// same per-axis MIDI channels, quantised to a scale. The note branch used to
// maintain only `held` and emit a gate, so the instant a player enabled
// quantisation every X/Y jack froze at its last CC value and every touch
// produced the same held pitch downstream.
//
// ⚠ THE LOAD-BEARING ASSERTION IN THIS SECTION IS THAT THE VALUE CHANGES
// BETWEEN TWO DIFFERENT NOTES. A test that only checked a gate fired was green
// throughout the entire life of the bug.

/** The eight wire channels as note-on statuses, spelled as literals so the
 *  vectors cannot agree with TRAILS_AXIS_MAP by construction. */
const NOTE_ON_CH1_X = 0x90; // wire channel 0 = channel 1's X
const NOTE_ON_CH1_Y = 0x91; // wire channel 1 = channel 1's Y
const NOTE_ON_CH3_X = 0x94; // wire channel 4 = channel 3's X

describe('trails-decode: note mode drives the AXES', () => {
  it('THE BUG: two different notes produce two DIFFERENT axis values', () => {
    // The whole defect in four lines. Before the fix both of these produced a
    // gate and nothing else, so `axes()` was empty and the jack never moved.
    const d = createTrailsDecoder();
    const low = axes(d.handle([NOTE_ON_CH1_X, 40, 100], 0));
    const high = axes(d.handle([NOTE_ON_CH1_X, 100, 100], 1));
    expect(low, 'a note emits an axis value at all').toHaveLength(1);
    expect(high).toHaveLength(1);
    expect(low[0]).toMatchObject({ channel: 1, axis: 'x' });
    expect(high[0]).toMatchObject({ channel: 1, axis: 'x' });
    expect(
      high[0]!.unit,
      'a HIGHER note must read higher — the jack has to track the scale',
    ).toBeGreaterThan(low[0]!.unit);
    // …and it is not merely different, it is the documented mapping.
    expect(low[0]!.unit).toBeCloseTo(40 / 127, 4);
    expect(high[0]!.unit).toBeCloseTo(100 / 127, 4);
  });

  it('THE OWNER\'S OWN CAPTURE: the notes their hardware sent move the jack', () => {
    // From the 2026-09-01 MON paste, note mode with both quantisations on:
    // ch1 carried 77, 80, 82, 88, 89 and ch2 carried 81, 83, 89, 93. Those are
    // channel 1's X and channel 1's Y — the SAME Trails channel, two axes, two
    // MIDI channels, exactly as in CC mode.
    const d = createTrailsDecoder();
    const xUnits = [77, 80, 82, 88, 89].map(
      (n) => axes(d.handle([NOTE_ON_CH1_X, n, 100], 0))[0]!.unit,
    );
    const yUnits = [81, 83, 89, 93].map(
      (n) => axes(d.handle([NOTE_ON_CH1_Y, n, 100], 0))[0]!.unit,
    );
    // Every strike moved the jack, and the order is monotone with the pitch.
    expect(new Set(xUnits).size, 'five distinct notes, five distinct values').toBe(5);
    expect([...xUnits].sort((a, b) => a - b)).toEqual(xUnits);
    expect(new Set(yUnits).size).toBe(4);
    // The travel that spread buys, stated as a number so a window change is
    // visible as a change to THIS expectation and not only to a constant.
    expect(Math.max(...xUnits) - Math.min(...xUnits)).toBeCloseTo(12 / 127, 4);
    expect(Math.max(...yUnits) - Math.min(...yUnits)).toBeCloseTo(12 / 127, 4);
  });

  it('each axis keeps its OWN MIDI channel in note mode, as in CC mode', () => {
    const d = createTrailsDecoder();
    expect(axes(d.handle([NOTE_ON_CH1_Y, 60, 100], 0))[0]).toMatchObject({
      channel: 1,
      axis: 'y',
    });
    expect(axes(d.handle([NOTE_ON_CH3_X, 60, 100], 0))[0]).toMatchObject({
      channel: 3,
      axis: 'x',
    });
    // A wire channel Trails does not use is still not guessed at.
    expect(axes(d.handle([0x98, 60, 100], 0))).toHaveLength(0);
  });

  it('note mode works from a COLD START, with no CC ever received', () => {
    // The realistic case: the player enables quantisation before ever streaming
    // CC on that channel, so there is no latched coarse half for `emitAxis` to
    // fall back on. A fix that only updated a fine half would emit nothing here.
    const d = createTrailsDecoder();
    const out = axes(d.handle([NOTE_ON_CH1_X, 127, 100], 0));
    expect(out).toHaveLength(1);
    expect(out[0]!.unit).toBe(1);
  });

  it('the gate still behaves EXACTLY as before — the axis is added, not swapped in', () => {
    const d = createTrailsDecoder();
    const on = d.handle([NOTE_ON_CH1_X, 60, 100], 0);
    expect(gates(on)).toEqual([{ kind: 'gate', channel: 1, high: true, source: 'note' }]);
    // A second held note still does not re-fire the gate…
    expect(gates(d.handle([NOTE_ON_CH1_X, 64, 100], 1))).toHaveLength(0);
    // …and the gate still falls only when the last one is released.
    expect(gates(d.handle([0x80, 60, 0], 2))).toHaveLength(0);
    expect(gates(d.handle([0x80, 64, 0], 3))[0]!.high).toBe(false);
  });

  it('AXIS BEFORE GATE — a downstream envelope sees the pitch already set', () => {
    const d = createTrailsDecoder();
    const out = d.handle([NOTE_ON_CH1_X, 60, 100], 0);
    expect(out.map((e) => e.kind)).toEqual(['axis', 'gate']);
  });

  it('a RELEASE holds the axis rather than dropping it to zero', () => {
    // The jack behaves the same way it does when a CC stream goes quiet: it
    // holds. Emitting 0 on release would slam every destination to the bottom
    // of its range between notes.
    const d = createTrailsDecoder();
    d.handle([NOTE_ON_CH1_X, 100, 100], 0);
    expect(axes(d.handle([NOTE_ON_CH1_X, 100, 0], 1)), 'vel-0 release').toHaveLength(0);
    expect(axes(d.handle([0x80, 100, 0], 2)), '0x80 note-off').toHaveLength(0);
  });

  it('LAST-NOTE PRIORITY: releasing a stacked note does not jump the jack back', () => {
    // One axis carries one coordinate, so stacked notes are not something the
    // device produces — but if one arrives, the newest wins and a release moves
    // nothing, which is the standard mono behaviour and the only one that
    // cannot make a jack lurch backwards on a key lift.
    const d = createTrailsDecoder();
    d.handle([NOTE_ON_CH1_X, 40, 100], 0);
    const second = axes(d.handle([NOTE_ON_CH1_X, 100, 100], 1));
    expect(second[0]!.unit).toBeCloseTo(100 / 127, 4);
    expect(axes(d.handle([0x80, 100, 0], 2))).toHaveLength(0);
  });

  it('a velocity-0 note-on is a RELEASE, not a strike at the bottom of the pad', () => {
    // The running-status shape the owner's hardware actually sends. Treating it
    // as a strike would emit an axis value for a note that is being let go.
    const d = createTrailsDecoder();
    d.handle([NOTE_ON_CH1_X, 100, 100], 0);
    const release = d.handle([NOTE_ON_CH1_X, 100, 0], 1);
    expect(axes(release)).toHaveLength(0);
    expect(gates(release)).toEqual([{ kind: 'gate', channel: 1, high: false, source: 'note' }]);
  });

  it('the note WINDOW is one constant, and moving it moves the whole mapping', () => {
    // The hardware-correction path, exercised: the shipped window is the full
    // MIDI range because it is the only span the wire guarantees, and a player
    // who wants more travel narrows it in one line.
    expect(TRAILS_NOTE_AXIS_RANGE).toEqual({ lo: 0, hi: 127 });
    const wide = createTrailsDecoder();
    const narrow = createTrailsDecoder({ noteRange: { lo: 60, hi: 72 } });
    const w = axes(wide.handle([NOTE_ON_CH1_X, 66, 100], 0))[0]!.unit;
    const n = axes(narrow.handle([NOTE_ON_CH1_X, 66, 100], 0))[0]!.unit;
    expect(w).toBeCloseTo(66 / 127, 6);
    expect(n, 'the midpoint of a one-octave window').toBeCloseTo(0.5, 4);
    // …and the narrow window clamps rather than running off the end of the jack.
    expect(axes(narrow.handle([NOTE_ON_CH1_X, 127, 100], 1))[0]!.unit).toBe(1);
    expect(axes(narrow.handle([NOTE_ON_CH1_X, 0, 100], 2))[0]!.unit).toBe(0);
  });

  it('the mapping is LINEAR IN SEMITONES — the same shape a V/oct CV has', () => {
    // Stated as a property rather than as three magic numbers: a MIDI note is
    // linear in semitones and so is volt-per-octave, so equal pitch intervals
    // must produce equal jack intervals. That is what makes this mapping
    // already V/oct-SHAPED; only the constant of proportionality is a choice,
    // and TRAILS_NOTE_AXIS_RANGE is where it lives.
    const d = createTrailsDecoder();
    const at = (n: number) => axes(d.handle([NOTE_ON_CH1_X, n, 100], 0))[0]!.unit;
    const octave1 = at(72) - at(60);
    const octave2 = at(96) - at(84);
    // Precision 4, not more: a note lands on the SAME 14-bit integer scale the
    // CC path uses, so every value here is quantised to 1/16383 = 6.1e-5 and a
    // tighter tolerance would be asserting against the rounding rather than
    // against the mapping.
    expect(octave2).toBeCloseTo(octave1, 4);
    // A ten-octave window is exactly 0.1 per octave — the 1 V/oct shape if full
    // scale is read as 10 V, which is the alternative the constant documents.
    const voct = createTrailsDecoder({ noteRange: { lo: 0, hi: 120 } });
    const vAt = (n: number) => axes(voct.handle([NOTE_ON_CH1_X, n, 100], 0))[0]!.unit;
    expect(vAt(72) - vAt(60)).toBeCloseTo(0.1, 4);
  });

  it('trailsNoteToValue14 lands on the same 14-bit scale the CC path uses', () => {
    expect(trailsNoteToValue14(0)).toBe(0);
    expect(trailsNoteToValue14(127)).toBe(TRAILS_CC_FULL_SCALE);
    // Out-of-window notes clamp instead of wrapping or going negative.
    expect(trailsNoteToValue14(-5)).toBe(0);
    expect(trailsNoteToValue14(999)).toBe(TRAILS_CC_FULL_SCALE);
    // A degenerate window holds at the bottom rather than dividing by zero.
    expect(trailsNoteToValue14(60, { lo: 60, hi: 60 })).toBe(0);
    expect(Number.isFinite(trailsNoteToValue14(60, { lo: 90, hi: 10 }))).toBe(true);
  });

  it('a mode SWITCH back to CC resumes from a coherent value', () => {
    // Note mode writes the same latches the CC assembler reads, so a device
    // that leaves quantisation lands on a real position rather than on whatever
    // was stale from before the notes.
    const d = createTrailsDecoder();
    d.handle([NOTE_ON_CH1_X, 100, 100], 0);
    const back = axes(d.handle([CC_STATUS_CH1, CC_MSB, 0x10], 1));
    expect(back).toHaveLength(1);
    // ⚠ THE DOCUMENTED COST, ASSERTED RATHER THAN HIDDEN. The first coarse half
    // after the switch combines with the fine half the note left behind, so it
    // reads up to one full LSB (127/16383 = 0.78 %) high — the same tolerance
    // the 14-bit assembler's header already states for an MSB-only stream.
    const coarseOnly = (0x10 << 7) / TRAILS_CC_FULL_SCALE;
    expect(back[0]!.unit).toBeGreaterThanOrEqual(coarseOnly);
    expect(back[0]!.unit - coarseOnly).toBeLessThanOrEqual(127 / TRAILS_CC_FULL_SCALE);
    // …and the very next fine half makes it exact, so the residue lasts one
    // message rather than until the channel next moves.
    const exact = axes(d.handle([CC_STATUS_CH1, CC_LSB, 0x00], 2));
    expect(exact[0]!.unit).toBe(coarseOnly);
  });

  it('note mode still leaves the loop retrigger and the activity timeout alone', () => {
    // AGENTS.md rule 7 and the existing loop fix: a note channel is the
    // articulation, so neither mechanism may double-trigger it. Adding an axis
    // emit must not have changed that.
    const d = createTrailsDecoder();
    d.handle([NOTE_ON_CH1_X, 60, 100], 0);
    glide(d, 2, 4, 10);
    expect(gates(d.handle([0xfa], 50)).map((g) => g.channel)).toEqual([2]);
    // Channel 2 is a CC channel and its activity gate falls on silence, as it
    // always did. Channel 1 is holding a note, and no timeout may touch it.
    const fell = gates(d.tick(60_000));
    expect(fell.map((g) => g.channel), 'only the CC channel timed out').toEqual([2]);
    expect(d.tick(120_000), 'a held note is never dropped by the timeout').toHaveLength(0);
  });

  it('encodeTrailsNote produces the golden note-mode bytes', () => {
    // Literal expectations: channel 1's Y is wire channel 1, channel 3's X is
    // wire channel 4 — and a release is a note-ON at velocity 0, which is the
    // shape the owner's capture shows.
    expect(encodeTrailsNote({ channel: 1, axis: 'y' }, 81, 100)).toEqual([0x91, 81, 100]);
    expect(encodeTrailsNote({ channel: 3, axis: 'x' }, 60, 0)).toEqual([0x94, 60, 0]);
  });

  it('the encoder feeds the REAL decoder end to end', () => {
    const d = createTrailsDecoder();
    for (const note of [24, 60, 108]) {
      const out = axes(d.handle(encodeTrailsNote({ channel: 4, axis: 'y' }, note), 0));
      expect(out[0]).toMatchObject({ channel: 4, axis: 'y' });
      expect(out[0]!.unit).toBeCloseTo(note / 127, 4);
    }
  });

  it('a note frame is RECOGNISED whether or not it moved anything', () => {
    const d = createTrailsDecoder();
    expect(d.handleFrame([NOTE_ON_CH1_X, 60, 100], 0).recognised).toBe(true);
    // A repeat of the SAME note: the gate does not change and the axis lands on
    // the same value, but the frame was understood completely.
    expect(d.handleFrame([NOTE_ON_CH1_X, 60, 100], 1).recognised).toBe(true);
  });
});

describe('trails-decode: transport', () => {
  it('decodes clock, start, continue and stop', () => {
    const d = createTrailsDecoder();
    expect(d.handle([0xf8], 0)).toEqual([{ kind: 'clock' }]);
    // With no gesture recorded on any channel, Start is ONLY a divider reset —
    // there is no playhead repetition to articulate.
    expect(d.handle([0xfa], 0)).toEqual([{ kind: 'transport', running: true, reset: true }]);
    // Once a channel has a gesture, the same byte ALSO retriggers its gate.
    glide(d, 1, 4, 10);
    expect(d.handle([0xfa], 20)).toEqual([
      { kind: 'transport', running: true, reset: true },
      { kind: 'gate', channel: 1, high: true, source: 'loop' },
    ]);
    expect(d.handle([0xfb], 0)).toEqual([{ kind: 'transport', running: true, reset: false }]);
    expect(d.handle([0xfc], 0)).toEqual([{ kind: 'transport', running: false, reset: false }]);
  });

  it('real-time bytes bypass the channel map entirely', () => {
    // 0xF8 has no channel nibble; a decoder that masked it as one would read
    // wire channel 8 and drop the tick.
    const d = createTrailsDecoder();
    expect(d.handle([0xf8], 0)).toHaveLength(1);
  });
});

describe('trails-decode: RECOGNITION is not the same as emitting an event', () => {
  // The monitor's whole value is flagging traffic this module does not
  // understand. Inferring that from "produced no event" flags a pile of frames
  // the decoder understands perfectly and deliberately says nothing about —
  // and then prints "your CC pair is wrong" at a player whose device is fine.

  it('understood-but-silent frames are RECOGNISED', () => {
    const d = createTrailsDecoder();
    // A second held note produces no GATE event — the level did not change —
    // and the frame was understood completely.
    //
    // ⚠ IT DOES NOW PRODUCE AN AXIS EVENT, and that is the note-mode fix rather
    // than a weakening of this test: in note mode the note IS the axis, so a
    // second note is a new coordinate even when the contact level is unchanged.
    // This assertion used to read `events` as a whole and was one of the places
    // the frozen-axis defect looked correct.
    d.handle([0x90, 60, 100], 0);
    const second = d.handleFrame([0x90, 64, 100], 1);
    expect(gates(second.events), 'no gate edge — the channel was already held').toHaveLength(0);
    expect(axes(second.events), 'but the axis moved to the new note').toHaveLength(1);
    expect(second.recognised).toBe(true);

    // A note-OFF for a note that is not held: nothing changes in either
    // direction, and the frame is still perfectly understood.
    const quiet = createTrailsDecoder();
    const stray = quiet.handleFrame([0x80, 60, 0], 0);
    expect(stray.events).toHaveLength(0);
    expect(stray.recognised).toBe(true);

    // An LSB before its axis has ever sent an MSB: understood, and deliberately
    // emits no AXIS event rather than guessing a coarse half. (It is still real
    // activity on that channel, so the contact gate does rise — which is the
    // point: "produced some event" and "was understood" are independent, in
    // both directions.)
    const e = createTrailsDecoder();
    const lsbFirst = e.handleFrame([CC_STATUS_CH1, CC_LSB, 0x7f], 0);
    expect(axes(lsbFirst.events), 'no axis value is invented').toHaveLength(0);
    expect(lsbFirst.recognised).toBe(true);
  });

  it('IGNORED real-time bytes are recognised — Active Sense must not read as a fault', () => {
    // Many USB-MIDI devices emit Active Sense at ~3 Hz. Counting it as
    // unrecognised would make the monitor's headline climb forever and show the
    // CC-pair warning on correct firmware.
    const d = createTrailsDecoder();
    for (const status of [0xfe, 0xff, 0xf9, 0xfd]) {
      expect(d.handleFrame([status], 0).recognised, `status 0x${status.toString(16)}`).toBe(true);
    }
  });

  it('genuinely foreign traffic is NOT recognised', () => {
    const d = createTrailsDecoder();
    // The MIDI-convention fine partner this firmware does not use — the shape a
    // wrong CC_PAIR constant makes, and the one the monitor must surface.
    expect(d.handleFrame([CC_STATUS_CH1, 47, 0x40], 0).recognised).toBe(false);
    // A MIDI channel Trails does not use.
    expect(d.handleFrame([0xb8, CC_MSB, 0x40], 0).recognised).toBe(false);
    // System COMMON (SysEx / MTC / Song Position) — undocumented for Trails, so
    // if one appears it is news.
    expect(d.handleFrame([0xf0, 0x7e], 0).recognised).toBe(false);
    expect(d.handleFrame([0xf2, 0x00, 0x01], 0).recognised).toBe(false);
    expect(d.handleFrame([], 0).recognised).toBe(false);
  });

  it('the events it reports are the SAME ones `handle` would have produced', () => {
    const a = createTrailsDecoder();
    const b = createTrailsDecoder();
    const frame = [CC_STATUS_CH1, CC_MSB, 0x40];
    expect(a.handleFrame(frame, 0).events).toEqual(b.handle(frame, 0));
  });
});

describe('trails-decode: encoders feed the real decoder', () => {
  it('encodeTrailsAxis produces the golden byte pairs', () => {
    // Literal expectation: channel 1 X is wire channel 0, so status 0xB0, and
    // full scale is 127 / 127.
    expect(encodeTrailsAxis({ channel: 1, axis: 'x' }, 1)).toEqual([
      [0xb0, CC_MSB, 0x7f],
      [0xb0, CC_LSB, 0x7f],
    ]);
    // Channel 3 Y is wire channel 5 → status 0xB5.
    expect(encodeTrailsAxis({ channel: 3, axis: 'y' }, 0)).toEqual([
      [0xb5, CC_MSB, 0x00],
      [0xb5, CC_LSB, 0x00],
    ]);
  });

  it('encodeTrailsGate produces note on / note off on the channel\'s X wire', () => {
    expect(encodeTrailsGate(2, true)).toEqual([0x92, 60, 100]);
    expect(encodeTrailsGate(2, false)).toEqual([0x82, 60, 0]);
  });

  it('a full round trip lands within one 14-bit step of the requested position', () => {
    const d = createTrailsDecoder();
    for (const want of [0, 0.25, 0.5, 0.75, 1]) {
      let last = -1;
      for (const frame of encodeTrailsAxis({ channel: 4, axis: 'x' }, want)) {
        const out = axes(d.handle(frame, 0));
        if (out.length > 0) last = out[out.length - 1]!.unit;
      }
      expect(last).toBeCloseTo(want, 4);
    }
  });
});
