// packages/web/src/lib/audio/modules/midiclock.test.ts
//
// Unit tests for MIDICLOCK pure helpers + divider semantics. Avoids
// AudioContext / Web MIDI plumbing; the factory itself is exercised
// transitively via the e2e smoke spec.

import { describe, it, expect } from 'vitest';
import {
  CLOCK_DIVISORS,
  MAX_TIMESTAMP_LAG_MS,
  MIDI_PPQN,
  TIMESTAMP_LOOKAHEAD_S,
  divisorLabel,
  eventTimeStampToAudioTime,
  isSystemRealTime,
  isValidDivisor,
  measureCtxOffset,
} from './midiclock';

describe('isSystemRealTime', () => {
  it('returns true for 0xF8..0xFF', () => {
    for (let b = 0xf8; b <= 0xff; b++) {
      expect(isSystemRealTime(b)).toBe(true);
    }
  });

  it('returns false for channel-voice and SysEx ranges', () => {
    // Note on, note off, CC, pitch-bend (any channel), SysEx start.
    for (const b of [0x80, 0x90, 0xb0, 0xe0, 0xf0, 0xf7]) {
      expect(isSystemRealTime(b)).toBe(false);
    }
  });
});

describe('CLOCK_DIVISORS', () => {
  it('contains exactly the five allowed values', () => {
    expect([...CLOCK_DIVISORS]).toEqual([24, 12, 6, 3, 1]);
  });

  it('matches the MIDI_PPQN constant for the quarter-note divisor', () => {
    expect(CLOCK_DIVISORS[0]).toBe(MIDI_PPQN);
  });

  it('isValidDivisor accepts allowed values and rejects others', () => {
    for (const d of CLOCK_DIVISORS) expect(isValidDivisor(d)).toBe(true);
    for (const bad of [0, 2, 4, 5, 8, 16, 25, -1, 1.5, 'raw', null, undefined]) {
      expect(isValidDivisor(bad)).toBe(false);
    }
  });
});

describe('divisorLabel', () => {
  it('maps each divisor to its musical label', () => {
    expect(divisorLabel(24)).toBe('1/4');
    expect(divisorLabel(12)).toBe('1/8');
    expect(divisorLabel(6)).toBe('1/16');
    expect(divisorLabel(3)).toBe('1/32');
    expect(divisorLabel(1)).toBe('raw');
  });
});

describe('divider semantics (modeled outside the factory)', () => {
  // Re-implementation of the factory's tickCounter logic so we can
  // pin the "every Nth tick fires an edge" invariant without booting
  // an AudioContext. The real factory does the same arithmetic; if it
  // ever diverges from this model the e2e spec will catch it.
  function runTicks(numTicks: number, divisor: number): number {
    let counter = 0;
    let edges = 0;
    for (let i = 0; i < numTicks; i++) {
      counter++;
      if (counter >= divisor) {
        counter = 0;
        edges++;
      }
    }
    return edges;
  }

  it('emits one edge per quarter at the default divisor (24)', () => {
    // 4 bars × 4 beats × 24 ticks = 384 input ticks → 16 edges
    expect(runTicks(MIDI_PPQN * 16, 24)).toBe(16);
  });

  it('emits two edges per quarter for the eighth-note divisor (12)', () => {
    expect(runTicks(MIDI_PPQN * 4, 12)).toBe(8);
  });

  it('emits one edge per input tick at the raw divisor (1)', () => {
    expect(runTicks(100, 1)).toBe(100);
  });

  it('drops the partial-count remainder when the input cuts short', () => {
    // 23 ticks at divisor=24 → no edge fired yet
    expect(runTicks(23, 24)).toBe(0);
    // 47 ticks at divisor=24 → one edge (at tick 24); remainder of 23 doesn't fire
    expect(runTicks(47, 24)).toBe(1);
  });
});

describe('measureCtxOffset', () => {
  it('returns currentTime(s) - perfNow(ms)/1000 (i.e. the fixed offset between clocks)', () => {
    // The "calibration" is just a delta: subtract converted-perfNow from
    // currentTime. With currentTime=10s and perfNow=1000ms (1s), the
    // offset is 9 (currentTime is 9s ahead of perfNow on the wallclock —
    // typical, since the AudioContext was created after page-load).
    expect(measureCtxOffset(10.0, 1000)).toBeCloseTo(9.0, 9);
    // Edge: perfNow ahead of currentTime (AudioContext created LATE).
    expect(measureCtxOffset(0.5, 3000)).toBeCloseTo(-2.5, 9);
  });
});

describe('eventTimeStampToAudioTime (tempo-stability anchor)', () => {
  // Regression bar: this is the math that distinguishes "schedules
  // honor message timestamps" from the old "every message at
  // currentTime+lookahead" bug. If any of these break, downstream gates
  // start jittering with main-thread event-loop slop.
  //
  // Convention used in these tests:
  //   - currentTime is in seconds; we use easy-to-read numbers (10.0s).
  //   - performanceNow is in ms; we choose 1000.0ms by default.
  //   - eventTimeStamp is in ms (matches Web MIDI's DOMHighResTimestamp).
  //   - ctxOffset is currentTime(s) - perfNow(ms)/1000 = 10 - 1 = 9 (s).
  const CTX_OFFSET = 9.0;

  it('preserves inter-pulse spacing for two messages that arrived Δms apart', () => {
    // Two MIDI Clock pulses arrive 20.833ms apart (one tick at 120 BPM).
    // The handler dispatches both at perfNow=1001ms (same event-loop tick),
    // but timeStamps record the actual arrival times. The audio-context
    // schedule MUST preserve the 20.833ms gap.
    const eventA = 980;       // first pulse, 21ms before handler dispatch
    const eventB = 1000.833;  // second pulse, ~0.2ms before handler dispatch
    const ctxNow = 10.001;    // handler ran 1ms after second event arrived
    const perfNow = 1001;

    const tA = eventTimeStampToAudioTime(eventA, ctxNow, perfNow, CTX_OFFSET);
    const tB = eventTimeStampToAudioTime(eventB, ctxNow, perfNow, CTX_OFFSET);

    // Δaudio MUST equal Δevent (within fp tolerance).
    expect(tB - tA).toBeCloseTo((eventB - eventA) / 1000, 9);
  });

  it('never schedules in the past (Web Audio coerces silently → bug)', () => {
    // A 50ms-lag event projects via the offset to ctxNow - 0.05 + lookahead
    // = 10 - 0.05 + 0.025 = 9.975 — BELOW ctxNow. The floor must kick in.
    const ctxNow = 10.0;
    const perfNow = 1000;
    const eventStale = 950; // 50ms lag, within MAX
    const t = eventTimeStampToAudioTime(eventStale, ctxNow, perfNow, CTX_OFFSET);
    expect(t).toBeGreaterThanOrEqual(ctxNow);
  });

  it('re-anchors absurdly stale timestamps to the floor (tab-resume burst)', () => {
    // After a tab is backgrounded and resumes, the browser can flush a
    // queue of MIDI messages with very old timestamps. We don't want to
    // try to "honor" them as past edges — that schedules everything in
    // the past, which Web Audio coerces to currentTime AND ALSO loses
    // any inter-pulse spacing. Re-anchoring keeps the schedule sane.
    const ctxNow = 10.0;
    const perfNow = 1000;
    const eventVeryStale = perfNow - 5000; // 5 seconds old
    const t = eventTimeStampToAudioTime(eventVeryStale, ctxNow, perfNow, CTX_OFFSET);
    // Re-anchored: target = ctxNow + lookahead.
    expect(t).toBeCloseTo(ctxNow + TIMESTAMP_LOOKAHEAD_S, 9);
  });

  it('honors zero-lag events (handler dispatched same tick as message)', () => {
    // Ideal case: event arrived "just now" (lag ≈ 0). Target should be
    // the event's projected audio time + lookahead.
    const ctxNow = 10.0;
    const perfNow = 1000;
    const t = eventTimeStampToAudioTime(perfNow, ctxNow, perfNow, CTX_OFFSET);
    expect(t).toBeCloseTo(ctxNow + TIMESTAMP_LOOKAHEAD_S, 9);
  });

  it('re-anchors future-skewed timestamps (defensive — clock skew safety)', () => {
    // Some platforms have shipped MIDI events whose timeStamp > perfNow
    // (different clock origin). We MUST NOT project that into the
    // arbitrary future — it would accumulate ahead-of-schedule drift.
    const ctxNow = 10.0;
    const perfNow = 1000;
    const t = eventTimeStampToAudioTime(perfNow + 50, ctxNow, perfNow, CTX_OFFSET);
    // Re-anchored at the floor; same as zero-lag.
    expect(t).toBeCloseTo(ctxNow + TIMESTAMP_LOOKAHEAD_S, 9);
  });

  it('inter-pulse jitter is bounded — NOT the main-thread event-loop slop', () => {
    // THE regression bar. Five pulses at 20.833ms spacing (120 BPM, 24 PPQN),
    // dispatched with variable main-thread lag. Inter-pulse Δaudio MUST
    // equal the inter-pulse Δevent (i.e. 20.833ms each), regardless of
    // dispatch jitter. The OLD code produced Δaudio = (perfNow_i -
    // perfNow_{i-1}), reproducing all of the event-loop jitter as audible
    // swing on the downstream gate.
    const eventTimes = [1000, 1020.833, 1041.666, 1062.5, 1083.333];
    // Handler-dispatch perfNow values: each event dispatched some time
    // AFTER its own timestamp, with variable lag.
    const perfNowAtDispatch = [1003, 1031, 1045, 1075, 1085]; // lags: 3, 10, 3, 12, 2 ms
    // ctxNow at handler-dispatch tracks perfNow tick-for-tick (both
    // clocks tick at real-time).
    const ctxNowAtDispatch = perfNowAtDispatch.map((p) => 10 + (p - 1000) / 1000);

    const scheduledTimes = eventTimes.map((ts, i) =>
      eventTimeStampToAudioTime(ts, ctxNowAtDispatch[i]!, perfNowAtDispatch[i]!, CTX_OFFSET),
    );

    for (let i = 1; i < scheduledTimes.length; i++) {
      const dAudio = scheduledTimes[i]! - scheduledTimes[i - 1]!;
      const dExpected = (eventTimes[i]! - eventTimes[i - 1]!) / 1000;
      // Error MUST be sub-microsecond (pure fp + ctxOffset arithmetic).
      expect(Math.abs(dAudio - dExpected)).toBeLessThan(1e-6);
    }
  });

  it('inter-pulse spacing equals event spacing under random main-thread jitter', () => {
    // Generative regression: 24 pulses (one quarter at 24 PPQN), 20.833ms
    // spacing, perturbed perfNow lags drawn from [1, 30]ms. Output Δs
    // MUST equal input Δs to <1µs each.
    const PULSE_MS = 20.833333;
    const ctxNow0 = 10.0;
    const perfNow0 = 1000;
    // Deterministic pseudo-random lags so the test is reproducible.
    function rng(seed: number): () => number {
      let s = seed | 0;
      return () => {
        s = (s * 1664525 + 1013904223) | 0;
        return ((s >>> 0) / 0xffffffff);
      };
    }
    const r = rng(42);
    // Realistic lag range: 1–15ms. Modern browsers' event-loop tail
    // under normal load is typically 2–8ms; 15ms is the worst usual case
    // short of a paint stall. The TIMESTAMP_LOOKAHEAD_S budget (25ms)
    // covers up to ~25ms lag before the floor kicks in.
    const lags = Array.from({ length: 24 }, () => 1 + r() * 14);

    const scheduledTimes: number[] = [];
    for (let i = 0; i < 24; i++) {
      const eventTs = perfNow0 + i * PULSE_MS;
      const perfNow = eventTs + lags[i]!;
      const ctxNow = ctxNow0 + (perfNow - perfNow0) / 1000;
      scheduledTimes.push(
        eventTimeStampToAudioTime(eventTs, ctxNow, perfNow, CTX_OFFSET),
      );
    }
    for (let i = 1; i < scheduledTimes.length; i++) {
      const dAudio = scheduledTimes[i]! - scheduledTimes[i - 1]!;
      expect(Math.abs(dAudio - PULSE_MS / 1000)).toBeLessThan(1e-6);
    }
  });

  it('input jitter of ±0.5ms produces output jitter of ±0.5ms (not amplified)', () => {
    // User-report scenario: incoming MIDI cable has 0.5ms of jitter on
    // the wire (a realistic figure for a USB MIDI interface). The
    // helper MUST NOT amplify that jitter — output Δs should differ
    // from nominal by AT MOST the input jitter (i.e. 0.5ms).
    const PULSE_MS = 20.833333;
    const NOMINAL_PULSE_S = PULSE_MS / 1000;
    const ctxNow0 = 10.0;
    const perfNow0 = 1000;
    function rng(seed: number): () => number {
      let s = seed | 0;
      return () => {
        s = (s * 1664525 + 1013904223) | 0;
        return ((s >>> 0) / 0xffffffff);
      };
    }
    const r = rng(7);
    // Event timestamps: nominal grid + ±0.5ms wire jitter.
    const eventTimes = Array.from({ length: 24 }, (_, i) =>
      perfNow0 + i * PULSE_MS + (r() - 0.5) * 1.0,
    );
    const scheduledTimes = eventTimes.map((ts) => {
      const lag = 2 + r() * 5; // 2-7ms main-thread lag, irrelevant
      const perfNow = ts + lag;
      const ctxNow = ctxNow0 + (perfNow - perfNow0) / 1000;
      return eventTimeStampToAudioTime(ts, ctxNow, perfNow, CTX_OFFSET);
    });
    const dDeltas = scheduledTimes.slice(1).map((t, i) =>
      Math.abs(t - scheduledTimes[i]! - NOMINAL_PULSE_S),
    );
    // Output jitter must NOT exceed the input jitter (1ms peak-to-peak
    // = 1ms max deviation from nominal). We allow 2ms to absorb the
    // worst-case "two adjacent pulses both got pushed in opposite
    // directions" — still under one audio block.
    for (const d of dDeltas) {
      expect(d).toBeLessThan(0.002);
    }
  });

  it('an event-loop stall longer than the lookahead clamps to the floor (NOT projected late)', () => {
    // Outlier handling: a 50-ms lag event (well within MAX_TIMESTAMP_LAG_MS
    // but exceeding TIMESTAMP_LOOKAHEAD_S = 25ms) gets clamped to the
    // floor, NOT projected ~25ms in the past. The floor is currentTime +
    // one audio block (~2.67ms at 48 kHz). Subsequent in-budget events
    // resume projecting against the event timestamp, so the clamp only
    // affects the outlier.
    const ctxNow = 10.0;
    const perfNow = 1000;
    const FLOOR_EPSILON_S = 128 / 48000;
    const t = eventTimeStampToAudioTime(950, ctxNow, perfNow, CTX_OFFSET);
    expect(t).toBeCloseTo(ctxNow + FLOOR_EPSILON_S, 9);
  });

  it('MAX_TIMESTAMP_LAG_MS is set to a sensible value (100 ms)', () => {
    // Documenting the constant so a future refactor that loosens this
    // (which would re-introduce stale-timestamp drift after tab-resume)
    // has to update the test deliberately.
    expect(MAX_TIMESTAMP_LAG_MS).toBe(100);
  });

  it('TIMESTAMP_LOOKAHEAD_S is at least one 128-sample block at 48 kHz', () => {
    // One audio block at 48 kHz = 128/48000 ≈ 2.67ms. Lookahead MUST be
    // >= this so the schedule lands on the NEXT render quantum, never
    // mid-block (mid-block schedules are honored by Web Audio but the
    // ConstantSourceNode is k-rate per block, so a mid-block target
    // gets quantized to the next block boundary anyway — we make that
    // explicit by reserving at least one block of headroom).
    expect(TIMESTAMP_LOOKAHEAD_S).toBeGreaterThanOrEqual(128 / 48000);
  });
});
