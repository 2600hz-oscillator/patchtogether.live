// LINNSTRUMENT ARP ADAPTER — the transport over the pure arp-engine, with
// the things the engine does not carry: touch provenance, the duplicate-pitch
// refcount, the expression owner, the latch snapshot, cancellation, and a
// REAL gate-low interval on every step.
//
// ⚠ SYNTHETIC. No LinnStrument was connected; the touches here are the
// generation ids the runtime hands the adapter. V12/V13 are asserted at the
// adapter's sink — their audible half is WP-D's.

import { describe, it, expect } from 'vitest';
import { arpAdvance, arpSetHeld, arpSetParams, createArpState, type ArpParams } from '$lib/audio/arp-engine';
import { midiToVOct } from '$lib/audio/note-entry';
import { POLY_CHANNEL_PAIRS } from '$lib/audio/poly';
import { arpDirectionFromIndex, createLinnArp, type ArpSink } from './linnstrument-arp';

interface Step {
  at: number;
  lanes: { pitch: number; gate: 0 | 1 }[];
  gateOffSec: number;
}

function recorder(): ArpSink & { steps: Step[]; silenced: number[] } {
  const steps: Step[] = [];
  const silenced: number[] = [];
  return {
    steps,
    silenced,
    scheduleStep(at, lanes, gateOffSec) {
      steps.push({ at, lanes: lanes.map((l) => ({ ...l })), gateOffSec });
    },
    silence(now) {
      silenced.push(now);
    },
  };
}

const BPM = 120; // one beat = 500 ms; 1x division = one note per beat
const STEP_MS = 500;

/** Drive `n` steps of wall-clock, one service call per step boundary. */
function drive(arp: ReturnType<typeof createLinnArp>, n: number, startMs = 1000): ReturnType<typeof arp.service>[] {
  const out: ReturnType<typeof arp.service>[] = [];
  for (let i = 0; i < n; i++) out.push(arp.service({ nowMs: startMs + i * STEP_MS, audioTime: 10 + i * 0.5, bpm: BPM }));
  return out;
}

const lane0 = (s: Step) => s.lanes[0]!;
const notesOf = (sink: ReturnType<typeof recorder>) => sink.steps.map((s) => Math.round(lane0(s).pitch * 12 + 60));

describe('linnstrument arp — V12: the sequence rules are the engine\'s, unchanged', () => {
  it('held C/E/G in updown plays C E G E C (the exclusive pendulum)', () => {
    const sink = recorder();
    const arp = createLinnArp({ params: { direction: 'updown' } });
    arp.attach(sink);
    arp.setEnabled(true);
    arp.touchStart(1, 60);
    arp.touchStart(2, 64);
    arp.touchStart(3, 67);
    drive(arp, 5);
    expect(notesOf(sink)).toEqual([60, 64, 67, 64, 60]);
  });

  for (const direction of ['up', 'down', 'updown'] as const) {
    for (const octaveRangeIndex of [0, 1]) {
      it(`${direction} / range ${octaveRangeIndex}: the adapter emits exactly what arpAdvance emits`, () => {
        // The engine driven DIRECTLY, as the Launchpad drives it.
        // Held INCREMENTALLY, as fingers land one at a time — the engine's
        // cursor-stability rule (a live add keeps the cursor) is part of what
        // "unchanged" means, so the reference is built the same way.
        const params: Partial<ArpParams> = { direction, octaveRangeIndex };
        let state = createArpState(params);
        for (const held of [[62], [62, 65], [62, 65, 69]]) state = arpSetHeld(state, held);
        const reference: number[] = [];
        for (let i = 0; i < 12; i++) {
          const s = arpAdvance(state);
          state = s.state;
          if (s.noteOn !== undefined) reference.push(s.noteOn);
        }
        // The adapter, same held set, same params.
        const sink = recorder();
        const arp = createLinnArp({ params });
        arp.attach(sink);
        arp.setEnabled(true);
        arp.touchStart(1, 62);
        arp.touchStart(2, 65);
        arp.touchStart(3, 69);
        drive(arp, 12);
        expect(notesOf(sink)).toEqual(reference);
      });
    }
  }

  it('every generated note names ONE source touch and carries its expression', () => {
    const sink = recorder();
    const arp = createLinnArp({ params: { direction: 'up', octaveRangeIndex: 1 } });
    arp.attach(sink);
    arp.setEnabled(true);
    arp.touchStart(11, 60, { pressure: 0.2, timbre: 0.1 });
    arp.touchStart(12, 64, { pressure: 0.6, timbre: 0.9 });
    const played = drive(arp, 6).flat();
    // Range ±1 octave → pool 48 52 60 64 72 76; each copy is owned by the
    // touch holding its source pitch.
    expect(played.map((p) => p.note)).toEqual([48, 52, 60, 64, 72, 76]);
    expect(played.map((p) => p.owner)).toEqual([11, 12, 11, 12, 11, 12]);
    expect(played[0]!.expression.pressure).toBeCloseTo(0.2);
    expect(played[1]!.expression.timbre).toBeCloseTo(0.9);
    // A later expression update on the owner reaches the NEXT generated note.
    arp.touchExpression(11, { pressure: 0.95 });
    const next = arp.service({ nowMs: 1000 + 6 * STEP_MS, audioTime: 13, bpm: BPM });
    expect(next[0]!.owner).toBe(11);
    expect(next[0]!.expression.pressure).toBeCloseTo(0.95);
  });

  it('the owner\'s bend is in the scheduled pitch', () => {
    const sink = recorder();
    const arp = createLinnArp();
    arp.attach(sink);
    arp.setEnabled(true);
    arp.touchStart(1, 60, { bend: 2 });
    drive(arp, 1);
    expect(lane0(sink.steps[0]!).pitch).toBeCloseTo(midiToVOct(62));
  });
});

describe('linnstrument arp — V13: duplicate-pitch refcount and a real gate-low interval', () => {
  it('two touches of one pitch are ONE note that survives the first release', () => {
    const sink = recorder();
    const arp = createLinnArp();
    arp.attach(sink);
    arp.setEnabled(true);
    arp.touchStart(1, 60);
    arp.touchStart(2, 60);
    expect(arp.snapshot().held).toEqual([60]);
    arp.touchEnd(1);
    expect(arp.snapshot().held, 'touch 2 still holds the pitch').toEqual([60]);
    drive(arp, 2);
    expect(notesOf(sink)).toEqual([60, 60]);
    arp.touchEnd(2);
    expect(arp.snapshot().held).toEqual([]);
    const before = sink.steps.length;
    drive(arp, 2, 5000);
    expect(sink.steps.length, 'nothing plays once both fingers are up').toBe(before);
  });

  it('every step schedules gateOffSec > 0 and < the step period — real low samples between attacks', () => {
    const sink = recorder();
    const arp = createLinnArp();
    arp.attach(sink);
    arp.setEnabled(true);
    arp.touchStart(1, 60);
    drive(arp, 4);
    expect(sink.steps.length).toBe(4);
    for (const s of sink.steps) {
      expect(s.gateOffSec).toBeGreaterThan(0);
      expect(s.gateOffSec).toBeLessThan(STEP_MS / 1000);
      expect(lane0(s).gate).toBe(1);
      // Every OTHER lane is written low: the arp owns the whole bus.
      expect(s.lanes.length).toBe(POLY_CHANNEL_PAIRS);
      expect(s.lanes.slice(1).every((l) => l.gate === 0)).toBe(true);
    }
    // Consecutive attacks are a step apart, and each gate closes before the next opens.
    for (let i = 1; i < sink.steps.length; i++) {
      const prev = sink.steps[i - 1]!;
      const cur = sink.steps[i]!;
      expect(prev.at + prev.gateOffSec).toBeLessThan(cur.at);
    }
  });

  it('NEGATIVE CONTROL: the low interval never collapses, even at 8x of a fast tempo', () => {
    const sink = recorder();
    const arp = createLinnArp({ params: { divisionIndex: 0 } }); // 8x
    arp.attach(sink);
    arp.setEnabled(true);
    arp.touchStart(1, 60);
    arp.service({ nowMs: 1000, audioTime: 1, bpm: 300 });
    const s = sink.steps[0]!;
    const stepS = 60 / 300 / 8;
    expect(s.gateOffSec).toBeGreaterThan(0);
    expect(s.gateOffSec).toBeLessThan(stepS);
  });
});

describe('linnstrument arp — latch snapshot and cancellation', () => {
  it('latch ON keeps the set and its owners\' expression after every finger lifts', () => {
    const sink = recorder();
    const arp = createLinnArp({ params: { latch: true } });
    arp.attach(sink);
    arp.setEnabled(true);
    arp.touchStart(1, 60, { pressure: 0.7 });
    arp.touchStart(2, 64, { pressure: 0.3 });
    arp.touchEnd(1);
    arp.touchEnd(2);
    expect(arp.snapshot().held, 'no live finger').toEqual([]);
    expect(arp.snapshot().effective, 'the engine froze the set').toEqual([60, 64]);
    const played = drive(arp, 2).flat();
    expect(played.map((p) => p.note)).toEqual([60, 64]);
    expect(played.map((p) => p.owner), 'snapshot owners survive the release').toEqual([1, 2]);
    expect(played[0]!.expression.pressure).toBeCloseTo(0.7);
    // Latch OFF collapses to the (empty) physical set and the snapshot goes.
    arp.setParams({ latch: false });
    expect(arp.snapshot().effective).toEqual([]);
    const before = sink.steps.length;
    drive(arp, 2, 9000);
    expect(sink.steps.length).toBe(before);
  });

  it('cancel silences the sink now and drops the step clock; the next service re-anchors', () => {
    const sink = recorder();
    const arp = createLinnArp();
    arp.attach(sink);
    arp.setEnabled(true);
    arp.touchStart(1, 60);
    drive(arp, 2);
    arp.cancel(42);
    expect(sink.silenced).toEqual([42]);
    expect(arp.snapshot().playing).toBeNull();
    // Re-anchored: exactly ONE step lands at the next service, not a backlog.
    const played = arp.service({ nowMs: 99_000, audioTime: 99, bpm: BPM });
    expect(played.length).toBe(1);
  });

  it('setEnabled(false) is a cancellation; reset also forgets the touches', () => {
    const sink = recorder();
    const arp = createLinnArp();
    arp.attach(sink);
    arp.setEnabled(true);
    arp.touchStart(1, 60);
    arp.setEnabled(false);
    expect(sink.silenced.length).toBe(1);
    expect(arp.service({ nowMs: 5000, audioTime: 5, bpm: BPM })).toEqual([]);
    arp.setEnabled(true);
    expect(arp.snapshot().held, 'disable keeps the touches').toEqual([60]);
    arp.reset(7);
    expect(arp.snapshot().held).toEqual([]);
    expect(arp.snapshot().effective).toEqual([]);
  });

  it('F01: reset FORGETS a latched pool (PANIC) — nothing plays on the next tick; cancel keeps it (arp off → on resumes)', () => {
    const sink = recorder();
    const arp = createLinnArp({ params: { latch: true } });
    arp.attach(sink);
    arp.setEnabled(true);
    arp.touchStart(1, 60);
    arp.touchEnd(1); // released: the engine froze [60]
    drive(arp, 1);
    expect(sink.steps).toHaveLength(1);
    // cancel: the pool survives — the next service re-anchors and plays it.
    arp.cancel(20);
    expect(arp.snapshot()).toMatchObject({ running: true, effective: [60] });
    expect(arp.service({ nowMs: 5000, audioTime: 5, bpm: BPM })).toHaveLength(1);
    // reset: the pool, the provenance and the touch are gone.
    arp.reset(30);
    expect(sink.silenced.at(-1)).toBe(30);
    expect(arp.snapshot()).toMatchObject({ running: false, held: [], effective: [], playing: null, owner: null });
    const before = sink.steps.length;
    for (let i = 0; i < 4; i++) expect(arp.service({ nowMs: 6000 + i * STEP_MS, audioTime: 6 + i * 0.5, bpm: BPM })).toEqual([]);
    expect(sink.steps.length).toBe(before);
    // A late release of the forgotten touch is a no-op; a fresh press latches anew.
    arp.touchEnd(1);
    arp.touchStart(2, 64);
    arp.touchEnd(2);
    expect(arp.snapshot().effective).toEqual([64]);
    expect(arp.service({ nowMs: 9000, audioTime: 9, bpm: BPM }).map((p) => p.note)).toEqual([64]);
  });

  it('a long stall re-anchors instead of replaying every missed step', () => {
    const sink = recorder();
    const arp = createLinnArp();
    arp.attach(sink);
    arp.setEnabled(true);
    arp.touchStart(1, 60);
    arp.service({ nowMs: 1000, audioTime: 1, bpm: BPM });
    const played = arp.service({ nowMs: 1000 + 60 * STEP_MS, audioTime: 31, bpm: BPM });
    expect(played.length).toBe(1);
  });
});

describe('linnstrument arp — the late-step policy (F07): one step per service, distinct instants, a real gate-low interval', () => {
  /** Every attack strictly after the previous attack's gate-down, by at least one render quantum. */
  function assertRealLowIntervals(steps: Step[]): void {
    for (let i = 1; i < steps.length; i++) {
      const prevOff = steps[i - 1]!.at + steps[i - 1]!.gateOffSec;
      expect(steps[i]!.at, `attack ${i} at ${steps[i]!.at} after the previous gate-down at ${prevOff}`).toBeGreaterThanOrEqual(prevOff + 128 / 48000);
    }
    expect(new Set(steps.map((s) => s.at)).size, 'no two attacks share an instant').toBe(steps.length);
  }

  it('a moderate stall (three steps due) plays ONE step at now + lookahead and re-anchors the grid to now', () => {
    const sink = recorder();
    const arp = createLinnArp({ params: { divisionIndex: 1 } }); // 4× at 120 bpm = 125 ms
    arp.attach(sink);
    arp.setEnabled(true);
    arp.touchStart(1, 60);
    arp.touchStart(2, 64);
    arp.touchStart(3, 67);
    arp.service({ nowMs: 1000, audioTime: 1, bpm: BPM }); // 60 at 1.025; next due 1125
    const late = arp.service({ nowMs: 1400, audioTime: 1.4, bpm: BPM }); // 1125, 1250, 1375 all due
    expect(late.map((p) => p.note)).toEqual([64]); // the NEXT note, once — nothing skipped, nothing burst
    expect(late[0]!.at).toBeCloseTo(1.425, 9);
    // Re-anchored: the following step is 125 ms after the stalled service, not on the old grid (1500).
    expect(arp.service({ nowMs: 1500, audioTime: 1.5, bpm: BPM })).toEqual([]);
    expect(arp.service({ nowMs: 1524, audioTime: 1.524, bpm: BPM })).toEqual([]);
    expect(arp.service({ nowMs: 1525, audioTime: 1.525, bpm: BPM }).map((p) => p.note)).toEqual([67]);
    assertRealLowIntervals(sink.steps);
  });

  it('an in-time tick (exactly one step due, small jitter) keeps its grid — jitter does not drift the pattern', () => {
    const sink = recorder();
    const arp = createLinnArp({ params: { divisionIndex: 1 } });
    arp.attach(sink);
    arp.setEnabled(true);
    arp.touchStart(1, 60);
    arp.service({ nowMs: 1000, audioTime: 1, bpm: BPM });
    // Ticks 7 ms late every step: each plays once, and the grid stays 1125, 1250, …
    for (let i = 1; i <= 4; i++) expect(arp.service({ nowMs: 1000 + i * 125 + 7, audioTime: 1 + i * 0.125 + 0.007, bpm: BPM })).toHaveLength(1);
    expect(arp.service({ nowMs: 1624, audioTime: 1.624, bpm: BPM })).toEqual([]);
    expect(arp.service({ nowMs: 1625, audioTime: 1.625, bpm: BPM })).toHaveLength(1);
    assertRealLowIntervals(sink.steps);
  });

  it('a tempo change mid-run: the step period follows the bpm, still one attack per due step, real low intervals', () => {
    const sink = recorder();
    const arp = createLinnArp();
    arp.attach(sink);
    arp.setEnabled(true);
    arp.touchStart(1, 60);
    arp.service({ nowMs: 1000, audioTime: 1, bpm: 120 }); // next due 1500
    arp.service({ nowMs: 1500, audioTime: 1.5, bpm: 120 }); // next due 2000
    // Halve the tempo: the next step is still due at 2000; after it, steps are 1000 ms apart.
    expect(arp.service({ nowMs: 1999, audioTime: 1.999, bpm: 60 })).toEqual([]);
    expect(arp.service({ nowMs: 2000, audioTime: 2, bpm: 60 })).toHaveLength(1);
    expect(sink.steps.at(-1)!.gateOffSec).toBeCloseTo(0.5, 9); // half of the new 1 s step
    expect(arp.service({ nowMs: 2500, audioTime: 2.5, bpm: 60 })).toEqual([]);
    expect(arp.service({ nowMs: 3000, audioTime: 3, bpm: 60 })).toHaveLength(1);
    // Double it again: a grid point 1 s away is now MORE than one 500 ms step late → one step, re-anchored.
    expect(arp.service({ nowMs: 4000, audioTime: 4, bpm: 120 })).toHaveLength(1);
    expect(arp.service({ nowMs: 4499, audioTime: 4.499, bpm: 120 })).toEqual([]);
    expect(arp.service({ nowMs: 4500, audioTime: 4.5, bpm: 120 })).toHaveLength(1);
    assertRealLowIntervals(sink.steps);
  });

  it('a division change mid-run (1× → 8×): the shorter period takes effect without a burst; 8× → 1× without a stall', () => {
    const sink = recorder();
    const arp = createLinnArp({ params: { divisionIndex: 3 } }); // 1× = 500 ms
    arp.attach(sink);
    arp.setEnabled(true);
    arp.touchStart(1, 60);
    arp.service({ nowMs: 1000, audioTime: 1, bpm: BPM }); // next due 1500
    arp.setParams({ divisionIndex: 0 }); // 8× = 62.5 ms
    // The old grid point (1500) is 8 new steps away when the tick lands on it: ONE step, re-anchored.
    expect(arp.service({ nowMs: 1500, audioTime: 1.5, bpm: BPM })).toHaveLength(1);
    let played = 0;
    for (let ms = 1525; ms <= 1750; ms += 25) played += arp.service({ nowMs: ms, audioTime: ms / 1000, bpm: BPM }).length;
    expect(played).toBe(4); // 1562.5, 1625, 1687.5, 1750 — one per 62.5 ms, no double-scheduling on the 25 ms tick
    arp.setParams({ divisionIndex: 3 }); // back to 1×: next due 1812.5, then every 500 ms
    expect(arp.service({ nowMs: 1800, audioTime: 1.8, bpm: BPM })).toEqual([]);
    expect(arp.service({ nowMs: 1825, audioTime: 1.825, bpm: BPM })).toHaveLength(1);
    expect(arp.service({ nowMs: 2300, audioTime: 2.3, bpm: BPM })).toEqual([]);
    expect(arp.service({ nowMs: 2325, audioTime: 2.325, bpm: BPM })).toHaveLength(1);
    assertRealLowIntervals(sink.steps);
  });
});

describe('linnstrument arp — two instances are independent', () => {
  it('keys and pad carry different sets, params and clocks', () => {
    const keysSink = recorder();
    const padSink = recorder();
    const keys = createLinnArp({ params: { direction: 'up' } });
    const pad = createLinnArp({ params: { direction: 'down' } });
    keys.attach(keysSink);
    pad.attach(padSink);
    keys.setEnabled(true);
    pad.setEnabled(true);
    keys.touchStart(1, 60);
    keys.touchStart(2, 64);
    pad.touchStart(1, 72); // the SAME touch id on the other region is a different touch
    pad.touchStart(2, 76);
    drive(keys, 2);
    drive(pad, 2);
    expect(notesOf(keysSink)).toEqual([60, 64]);
    // `down` seeds at the top of the FIRST pool ([72]) and a live add keeps
    // the cursor (arp-engine cursor stability), so 72 then 76.
    expect(notesOf(padSink)).toEqual([72, 76]);
    keys.cancel(1);
    expect(padSink.silenced, 'cancelling one leaves the other running').toEqual([]);
    pad.setParams({ direction: 'up' });
    expect(keys.snapshot().params.direction).toBe('up');
    expect(pad.snapshot().params.direction).toBe('up');
  });
});

describe('linnstrument arp — param vocabulary', () => {
  it('direction indexes resolve to the engine\'s own union, clamped', () => {
    expect(arpDirectionFromIndex(0)).toBe('up');
    expect(arpDirectionFromIndex(1)).toBe('down');
    expect(arpDirectionFromIndex(2)).toBe('updown');
    expect(arpDirectionFromIndex(9)).toBe('updown');
    expect(arpDirectionFromIndex(undefined)).toBe('up');
    expect(arpDirectionFromIndex(Number.NaN)).toBe('up');
  });

  it('setParams is the engine\'s arpSetParams (a division change is cursor-transparent)', () => {
    const sink = recorder();
    const arp = createLinnArp();
    arp.attach(sink);
    arp.setEnabled(true);
    arp.touchStart(1, 60);
    arp.touchStart(2, 64);
    arp.touchStart(3, 67);
    drive(arp, 1);
    arp.setParams({ divisionIndex: 1 });
    const ref = arpSetParams(arpSetHeld(createArpState(), [60, 64, 67]), { divisionIndex: 1 });
    expect(arp.snapshot().params).toEqual(ref.params);
    const played = arp.service({ nowMs: 1000 + STEP_MS, audioTime: 11, bpm: BPM });
    expect(played[0]!.note, 'the cursor kept its place').toBe(64);
  });
});
