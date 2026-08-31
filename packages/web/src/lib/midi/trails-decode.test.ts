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
  TRAILS_ACTIVITY_GATE_TIMEOUT_MS,
  TRAILS_AXIS_MAP,
  TRAILS_CC_FULL_SCALE,
  TRAILS_CC_PAIR,
  TRAILS_CHANNEL_COUNT,
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

  it('gates are per channel', () => {
    const d = createTrailsDecoder();
    // Wire channel 2 (status 0x92) belongs to Trails channel 2.
    expect(gates(d.handle([0x92, 60, 100], 0))[0]!.channel).toBe(2);
    // Wire channel 4 (status 0x94) belongs to Trails channel 3.
    expect(gates(d.handle([0x94, 60, 100], 0))[0]!.channel).toBe(3);
  });
});

describe('trails-decode: transport', () => {
  it('decodes clock, start, continue and stop', () => {
    const d = createTrailsDecoder();
    expect(d.handle([0xf8], 0)).toEqual([{ kind: 'clock' }]);
    expect(d.handle([0xfa], 0)).toEqual([{ kind: 'transport', running: true, reset: true }]);
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
