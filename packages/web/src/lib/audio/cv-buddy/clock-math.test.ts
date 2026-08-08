// packages/web/src/lib/audio/cv-buddy/clock-math.test.ts
//
// PURE unit coverage for CV Buddy's generated-clock scheduling math.
// (Flake-check REPEAT=3 pre-MR per CLAUDE.md.)
//
// The headline test is `phase survives a tempo change`, with the OLD absolute
// grid reimplemented alongside it as a negative control — a regression test
// that cannot pass vacuously, because the same assertion is shown FAILING
// against the design it replaced.

import { describe, it, expect } from 'vitest';
import {
  pulsePeriodS,
  advanceClock,
  idleClockPhase,
  CLOCK_PULSE_HIGH_S,
  type ClockPhase,
} from './clock-math';

/** The REPLACED design, kept only as a negative control: pulse k at k·period. */
function legacyGridNextPulse(bpm: number, ppqn: number, offsetMs: number, winStart: number) {
  const period = pulsePeriodS(bpm, ppqn);
  const offsetS = offsetMs / 1000;
  const k = Math.max(0, Math.ceil((winStart - offsetS) / period));
  return k * period + offsetS;
}

/** Run the clock over `count` back-to-back windows of `win` seconds each. */
function runWindows(
  opts: { bpm: number | ((i: number) => number); ppqn: number; offsetMs?: number },
  start: number,
  win: number,
  count: number,
): { pulses: number[]; skipped: number } {
  let phase: ClockPhase = idleClockPhase();
  const pulses: number[] = [];
  let skipped = 0;
  for (let i = 0; i < count; i++) {
    const bpm = typeof opts.bpm === 'function' ? opts.bpm(i) : opts.bpm;
    const r = advanceClock(phase, bpm, opts.ppqn, opts.offsetMs ?? 0, start + i * win, start + (i + 1) * win);
    pulses.push(...r.pulses);
    skipped += r.skipped;
    phase = r.phase;
  }
  return { pulses, skipped };
}

const gaps = (xs: number[]) => xs.slice(1).map((x, i) => x - xs[i]!);

describe('pulsePeriodS', () => {
  it('120 BPM @ 24 PPQN → 60/120/24 s', () => {
    expect(pulsePeriodS(120, 24)).toBeCloseTo(60 / 120 / 24, 12); // ~20.833 ms
  });
  it('scales inversely with BPM and PPQN', () => {
    expect(pulsePeriodS(60, 1)).toBeCloseTo(1, 12); // 1 pulse/sec
    expect(pulsePeriodS(120, 1)).toBeCloseTo(0.5, 12);
    expect(pulsePeriodS(120, 48)).toBeCloseTo(0.5 / 48, 12);
  });
  it('returns Infinity for degenerate tempo', () => {
    expect(pulsePeriodS(0, 24)).toBe(Infinity);
    expect(pulsePeriodS(120, 0)).toBe(Infinity);
    expect(pulsePeriodS(-1, 24)).toBe(Infinity);
    expect(pulsePeriodS(NaN, 24)).toBe(Infinity);
  });
});

describe('advanceClock — steady state', () => {
  it('anchors the first pulse at the start of the first window', () => {
    // The train begins WITH the transport, not at an arbitrary t=0 grid phase.
    const r = advanceClock(idleClockPhase(), 60, 1, 0, 10, 13);
    expect(r.pulses).toEqual([10, 11, 12]);
    expect(r.skipped).toBe(0);
  });

  it('half-open window: winStart inclusive, winEnd exclusive', () => {
    const r = advanceClock({ next: 1 }, 60, 1, 0, 1, 3);
    expect(r.pulses).toEqual([1, 2]);
    expect(r.phase.next).toBe(3);
  });

  it('is seamless across contiguous windows — no gap, no double, no drift', () => {
    const { pulses } = runWindows({ bpm: 120, ppqn: 24 }, 0, 0.2, 50); // 10 s
    expect(pulses.length).toBeGreaterThan(400);
    for (const g of gaps(pulses)) expect(g).toBeCloseTo(60 / 120 / 24, 9);
  });

  it('does not accumulate rounding drift over a long run', () => {
    // `next` is advanced by exact addition of an absolute time, so the last
    // pulse must still land where closed-form arithmetic says it should.
    const period = pulsePeriodS(120, 24);
    const { pulses } = runWindows({ bpm: 120, ppqn: 24 }, 0, 0.2, 500); // 100 s
    const last = pulses[pulses.length - 1]!;
    expect(last).toBeCloseTo((pulses.length - 1) * period, 6);
  });

  it('applies the ± offset trim to each edge', () => {
    expect(advanceClock({ next: 0 }, 60, 1, 100, 0, 3).pulses).toEqual([0.1, 1.1, 2.1]);
    // A trim nudge moves pulses by EXACTLY the trim delta — it must not drag
    // the underlying phase along with it.
    const a = advanceClock({ next: 5 }, 60, 1, 0, 5, 8).pulses;
    const b = advanceClock({ next: 5 }, 60, 1, 20, 5, 8).pulses;
    for (const d of b.map((x, i) => x - a[i]!)) expect(d).toBeCloseTo(0.02, 9);
  });

  it('returns [] for a backwards/empty window or degenerate tempo, holding phase', () => {
    expect(advanceClock({ next: 3 }, 60, 1, 0, 3, 3).pulses).toEqual([]);
    expect(advanceClock({ next: 3 }, 60, 1, 0, 3, 1).pulses).toEqual([]);
    // A degenerate tempo must HOLD the phase, so recovering resumes rather
    // than jumping.
    expect(advanceClock({ next: 3 }, 0, 24, 0, 0, 10)).toEqual({
      pulses: [], phase: { next: 3 }, skipped: 0,
    });
  });

  it('a realistic lookahead window yields the expected pulse count', () => {
    const r = advanceClock({ next: 0 }, 120, 24, 0, 0, 0.2);
    expect(r.pulses.length).toBeGreaterThanOrEqual(9);
    expect(r.pulses.length).toBeLessThanOrEqual(10);
  });
});

describe('advanceClock — THE REGRESSION: a tempo change must not teleport the phase', () => {
  // Owner-reported: "Pam's locks to it but not flawlessly", with a Mandala MK2
  // downstream showing obvious missed triggers.
  const PPQN = 24;
  const PERIOD = pulsePeriodS(120, PPQN); // ~20.83 ms

  it('a 0.001 BPM nudge moves the next pulse by less than 1% of a period', () => {
    // The exact scenario timelorde.ts produces when following an external
    // clock: it rewrites livePatch.params.bpm on every >0.1 BPM drift.
    for (const ctxAge of [10, 60, 600, 3600, 7200]) {
      const phase: ClockPhase = { next: ctxAge };
      const before = advanceClock(phase, 120.0, PPQN, 0, ctxAge, ctxAge + 0.05).pulses[0]!;
      const after = advanceClock(phase, 120.001, PPQN, 0, ctxAge, ctxAge + 0.05).pulses[0]!;
      expect(
        Math.abs(after - before),
        `at ${ctxAge}s of context age the next pulse moved`,
      ).toBeLessThan(PERIOD * 0.01);
    }
  });

  it('NEGATIVE CONTROL: the REPLACED absolute grid fails that same assertion', () => {
    // Proves the test above is not vacuous — it is measuring the thing that
    // was actually broken. The old grid displaces the next pulse by a large
    // fraction of a period, and worsens with context age.
    const displacements = [10, 60, 600, 3600, 7200].map((ctxAge) =>
      Math.abs(
        legacyGridNextPulse(120.001, PPQN, 0, ctxAge) - legacyGridNextPulse(120.0, PPQN, 0, ctxAge),
      ),
    );
    const worst = Math.max(...displacements);
    expect(worst, 'the old grid teleported the phase by a big slice of a period').toBeGreaterThan(
      PERIOD * 0.25,
    );
  });

  it('a tempo ramp changes the INTERVAL smoothly and never emits a short/long gap', () => {
    // Drag the BPM knob: 120 → 140 over 60 windows. Every gap must equal the
    // period in force when that pulse was scheduled — never a teleport.
    const { pulses, skipped } = runWindows(
      { bpm: (i) => 120 + (20 * i) / 60, ppqn: PPQN },
      0,
      0.2,
      60,
    );
    expect(skipped).toBe(0);
    const fastest = pulsePeriodS(140, PPQN);
    const slowest = pulsePeriodS(120, PPQN);
    for (const g of gaps(pulses)) {
      expect(g).toBeGreaterThanOrEqual(fastest - 1e-9);
      expect(g).toBeLessThanOrEqual(slowest + 1e-9);
    }
  });

  it('a large deliberate tempo change takes effect from the next pulse, not retroactively', () => {
    const half = advanceClock({ next: 100 }, 60, 1, 0, 100, 102).pulses; // 1 s period
    expect(half).toEqual([100, 101]);
    // Double the tempo from here: the already-due pulse at 102 stays put, the
    // interval after it halves.
    const r = advanceClock({ next: 102 }, 120, 1, 0, 102, 104);
    expect(r.pulses).toEqual([102, 102.5, 103, 103.5]);
  });
});

describe('advanceClock — a LATE tick is counted, never silently dropped', () => {
  it('counts the pulses that came due before the window could reach them', () => {
    // Phase says the next pulse was due at t=10; the tick did not arrive until
    // t=15. At 1 pulse/s that is 5 lost pulses.
    const r = advanceClock({ next: 10 }, 60, 1, 0, 15, 16);
    expect(r.skipped).toBe(5);
    expect(r.pulses).toEqual([15]);
  });

  it('catches the phase up so the train resumes ON the window, not behind it', () => {
    const r = advanceClock({ next: 10 }, 60, 1, 0, 15, 18);
    expect(r.pulses).toEqual([15, 16, 17]);
    expect(r.phase.next).toBe(18);
  });

  it('NEGATIVE CONTROL: an on-time tick reports zero skipped', () => {
    // If this ever fired, `skipped` would be noise and the UI readout built on
    // it would cry wolf on every healthy clock.
    const { skipped } = runWindows({ bpm: 120, ppqn: 24 }, 0, 0.2, 100);
    expect(skipped).toBe(0);
  });

  it('a stall of many thousands of pulses is counted in O(1), not looped', () => {
    // 300 BPM @ 48 PPQN is ~4.2 ms/pulse; a 60 s stall is ~14 400 pulses.
    const r = advanceClock({ next: 0 }, 300, 48, 0, 60, 60.01);
    expect(r.skipped).toBeGreaterThan(14000);
    expect(r.pulses.length).toBeLessThanOrEqual(3);
  });
});

describe('CLOCK_PULSE_HIGH_S', () => {
  it('is a short ~5 ms gate pulse', () => {
    expect(CLOCK_PULSE_HIGH_S).toBeCloseTo(0.005, 6);
  });
});
