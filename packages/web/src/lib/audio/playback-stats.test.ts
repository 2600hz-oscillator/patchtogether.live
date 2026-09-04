// packages/web/src/lib/audio/playback-stats.test.ts
//
// THE PERMANENT NEGATIVE CONTROL for the underrun readout.
//
// ⚠ WHY THIS IS A UNIT TEST AND NOT AN E2E — read before adding an e2e row.
// A counter reading zero on a healthy context proves it is READABLE, not that
// it WORKS. `expect(underruns).toBe(0)` in Playwright is VACUOUSLY GREEN
// FOREVER: headless Chromium runs a NULL AUDIO SINK (measured `outputLatency`
// ~0.072 ms vs 10–25 ms on real hardware), so a device underrun literally
// cannot occur there. That assertion would pass with the entire feature
// deleted. It is a textbook blind gate under AGENTS.md's instrument rule and
// it must not be written.
//
// What CAN fail, and does so here on every unit run:
//   (a) FORCED NON-ZERO — feed a stats object that IS underrunning and prove
//       every readout field moves and renders. This is the leg that would go
//       red if the projection were stubbed, hardcoded, or wired to the wrong
//       field.
//   (b) HEALTHY FLAT — feed the owner's real Chrome baseline and prove it
//       reads exactly zero underruns. Without (b), (a) could be satisfied by a
//       readout that always says "there is a problem".
//   (c) PER-FIELD SENSITIVITY — perturb each input field in turn and assert the
//       output MOVES. This is the negative control on the INSTRUMENT rather
//       than on the code: a projection blind to the very field under test would
//       return a clean number, and (a) alone would not catch it.
//   (d) INVARIANCE TO `minimumLatency` — perturb it and assert the snapshot is
//       byte-identical, so "let's also show min" fails the gate.

import { describe, it, expect } from 'vitest';
import {
  readPlaybackStats,
  playbackStatsSupported,
  snapshotFromStats,
  snapshotAudioHealth,
  formatAudioHealth,
  diffAudioHealth,
  UNSUPPORTED_AUDIO_HEALTH,
  UNSUPPORTED_AUDIO_HEALTH_DELTA,
  type AudioPlaybackStatsLike,
} from './playback-stats';

/**
 * The owner's REAL reading from Chrome on 2026-08-08, verbatim. This is the
 * pinned healthy baseline — a context that has been running for 18 s and has
 * dropped nothing.
 *
 * `minimumLatency: 0` is in the real object and is NOT in
 * `AudioPlaybackStatsLike`; it is carried here deliberately so leg (d) can
 * perturb it. It is not physically plausible next to a 36.6 ms average and is
 * treated as an uninitialised sentinel.
 */
const OWNER_HEALTHY_BASELINE = {
  underrunDuration: 0,
  underrunEvents: 0,
  totalDuration: 18.056818,
  averageLatency: 0.036588,
  minimumLatency: 0,
  maximumLatency: 0.041291,
};

/** The same context after a bad ten minutes. Synthetic — see the header. */
const UNDERRUNNING = {
  underrunDuration: 0.412,
  underrunEvents: 37,
  totalDuration: 612.5,
  averageLatency: 0.0491,
  minimumLatency: 0,
  maximumLatency: 0.1883,
};

describe('playback-stats — feature detection degrades silently', () => {
  it('a browser with no playbackStats reads as unsupported, never throws', () => {
    // Firefox / Safari today. The user must not be nagged.
    expect(readPlaybackStats({})).toBeNull();
    expect(readPlaybackStats(null)).toBeNull();
    expect(readPlaybackStats(undefined)).toBeNull();
    expect(playbackStatsSupported({ sampleRate: 48000 })).toBe(false);
    expect(snapshotAudioHealth({})).toEqual(UNSUPPORTED_AUDIO_HEALTH);
    expect(formatAudioHealth(snapshotAudioHealth({}))).toEqual({
      underruns: '—',
      dropout: '—',
      avgLatency: '—',
    });
  });

  it('a PRESENT-but-empty playbackStats is unsupported, not "healthy"', () => {
    // The shape that would let a dead readout look green: the property exists
    // and answers undefined / a non-numeric counter.
    expect(readPlaybackStats({ playbackStats: undefined })).toBeNull();
    expect(readPlaybackStats({ playbackStats: {} })).toBeNull();
    expect(readPlaybackStats({ playbackStats: { underrunEvents: '3' } })).toBeNull();
    expect(snapshotAudioHealth({ playbackStats: {} }).supported).toBe(false);
  });

  it('a throwing playbackStats getter is unsupported, not an exception', () => {
    const hostile = {
      get playbackStats(): unknown {
        throw new Error('context closed');
      },
    };
    expect(() => readPlaybackStats(hostile)).not.toThrow();
    expect(readPlaybackStats(hostile)).toBeNull();
  });

  it('a real-shaped playbackStats is detected', () => {
    const ctx = { playbackStats: OWNER_HEALTHY_BASELINE };
    expect(playbackStatsSupported(ctx)).toBe(true);
    expect(readPlaybackStats(ctx)).toBe(OWNER_HEALTHY_BASELINE);
  });
});

describe('playback-stats — the two directions', () => {
  it('(b) HEALTHY: the owner\'s real Chrome baseline reads exactly zero underruns', () => {
    const s = snapshotFromStats(OWNER_HEALTHY_BASELINE);
    expect(s.supported).toBe(true);
    expect(s.underrunEvents, 'events (count)').toBe(0);
    expect(s.underrunSec, 'starved time (seconds)').toBe(0);
    expect(s.underrunRatio, 'starved fraction (unitless)').toBe(0);
    expect(s.totalSec, 'output time (seconds)').toBeCloseTo(18.056818, 6);
    expect(s.avgLatencyMs, 'average latency (MILLISECONDS)').toBeCloseTo(36.588, 3);
    expect(s.maxLatencyMs, 'maximum latency (MILLISECONDS)').toBeCloseTo(41.291, 3);

    const f = formatAudioHealth(s);
    expect(f.underruns).toBe('0');
    expect(f.dropout).toBe('0.0ms');
    expect(f.avgLatency).toBe('36.6ms');
  });

  it('(a) FORCED: an underrunning context RAISES the count and renders it', () => {
    const s = snapshotFromStats(UNDERRUNNING);
    expect(s.underrunEvents, 'events (count) must RISE').toBe(37);
    expect(s.underrunSec, 'starved time (seconds) must RISE').toBeCloseTo(0.412, 6);
    expect(s.underrunRatio, 'starved fraction (unitless)').toBeCloseTo(0.412 / 612.5, 9);
    expect(s.maxLatencyMs, 'maximum latency (MILLISECONDS)').toBeCloseTo(188.3, 3);

    const f = formatAudioHealth(s);
    expect(f.underruns, 'the footer must SHOW the non-zero count').toBe('37');
    expect(f.dropout).toBe('412.0ms');
    expect(f.avgLatency).toBe('49.1ms');
  });

  it('a healthy snapshot and an underrunning snapshot are DISTINGUISHABLE', () => {
    // The one assertion that fails if the projection is a constant.
    const healthy = formatAudioHealth(snapshotFromStats(OWNER_HEALTHY_BASELINE));
    const bad = formatAudioHealth(snapshotFromStats(UNDERRUNNING));
    expect(healthy).not.toEqual(bad);
  });

  it('dropout over a second prints in SECONDS, not four digits of ms', () => {
    const s = snapshotFromStats({ ...UNDERRUNNING, underrunDuration: 1.834 });
    expect(formatAudioHealth(s).dropout).toBe('1.83s');
  });

  it('a zero-length context does not divide by zero', () => {
    const s = snapshotFromStats({
      underrunDuration: 0,
      underrunEvents: 0,
      totalDuration: 0,
      averageLatency: 0,
      maximumLatency: 0,
    });
    expect(s.underrunRatio).toBe(0);
    expect(Number.isFinite(s.underrunRatio)).toBe(true);
  });

  it('a partial / NaN stats object degrades to zeros instead of NaN in the UI', () => {
    const s = snapshotFromStats({
      underrunDuration: Number.NaN,
      underrunEvents: 5,
      totalDuration: Number.POSITIVE_INFINITY,
      averageLatency: 0.01,
      maximumLatency: Number.NaN,
    } as AudioPlaybackStatsLike);
    expect(s.underrunEvents).toBe(5);
    expect(s.underrunSec).toBe(0);
    expect(s.totalSec).toBe(0);
    expect(s.maxLatencyMs).toBe(0);
    expect(formatAudioHealth(s).dropout).toBe('0.0ms');
  });
});

describe('playback-stats — the instrument itself is negative-controlled', () => {
  // (c) A projection blind to the field under test returns a clean number and
  // every other assertion in this file still passes. So: perturb each input
  // field in turn, and require the OUTPUT to move.
  const FIELDS: Array<{ field: keyof AudioPlaybackStatsLike; delta: number }> = [
    { field: 'underrunEvents', delta: 1 },
    { field: 'underrunDuration', delta: 0.25 },
    { field: 'totalDuration', delta: 10 },
    { field: 'averageLatency', delta: 0.005 },
    { field: 'maximumLatency', delta: 0.05 },
  ];

  for (const { field, delta } of FIELDS) {
    it(`the snapshot is NOT invariant to ${field}`, () => {
      const base = snapshotFromStats(UNDERRUNNING);
      const moved = snapshotFromStats({ ...UNDERRUNNING, [field]: UNDERRUNNING[field] + delta });
      expect(
        moved,
        `snapshotFromStats ignored ${field} — a readout blind to the field it ` +
          'claims to report would return exactly this clean, confident, wrong number',
      ).not.toEqual(base);
    });
  }

  it('(d) the snapshot IS invariant to minimumLatency — it is a sentinel, not data', () => {
    // `minimumLatency: 0` alongside a 36.6 ms average is not physically
    // plausible. If a future edit surfaces it, this goes red.
    const base = snapshotFromStats(OWNER_HEALTHY_BASELINE);
    for (const min of [0, 0.001, 0.035, 999]) {
      // Bound to a variable on purpose: a fresh object literal would be
      // rejected by TS's excess-property check, which is itself part of the
      // guard — `AudioPlaybackStatsLike` does not declare `minimumLatency`, so
      // reading it is a compile error, not just a convention.
      const perturbed = { ...OWNER_HEALTHY_BASELINE, minimumLatency: min };
      expect(
        snapshotFromStats(perturbed),
        'minimumLatency must never reach the UI — see playback-stats.ts header',
      ).toEqual(base);
    }
    expect(Object.keys(base)).not.toContain('minLatencyMs');
    expect(Object.keys(base)).not.toContain('minimumLatency');
  });

  it('SCOPE, stated: this file proves the PROJECTION, never the PLATFORM', () => {
    // What it cannot see: whether Chrome's own counter is accurate, whether the
    // 1 Hz poller is running, and whether the footer is mounted. Those need the
    // owner's hardware (a heavy patch, Tight vs Stable, read the counter) —
    // headless Chromium's null sink cannot underrun, so no CI lane can close
    // this gap. Asserted here so "unit-tested ✓" is not read as "verified on a
    // real device ✓".
    expect(UNSUPPORTED_AUDIO_HEALTH.supported).toBe(false);
    expect(Object.isFrozen(UNSUPPORTED_AUDIO_HEALTH)).toBe(true);
  });
});

// ── THE DELTA — "did the device starve DURING this workflow?" ─────────────
//
// ⚠ EVERY COUNTER HERE IS CUMULATIVE SINCE CONTEXT CREATION. That makes the
// obvious assertion — `underrunEvents === 0` around a save, a patch load, a
// crossfade — answer the wrong question in both directions: it fails on a
// dropout from four hours ago, and it passes a workflow that added ten to a
// counter that was already non-zero. The delta is the only shape that means
// what a continuity claim needs it to mean.
//
// ⚠ AND IT IS VACUOUS ON HEADLESS CI, for the reason this whole file's header
// gives: a null sink cannot underrun. A green delta from the headless lane is
// evidence that the lane cannot fail. It is a real-device / owner-machine leg,
// paired with the graph-continuity probe (continuity-probe.ts), which is the
// leg that CAN go red headless.

describe('diffAudioHealth — the workflow-scoped device leg', () => {
  const snap = (s: typeof OWNER_HEALTHY_BASELINE) => snapshotFromStats(s as AudioPlaybackStatsLike);

  it('a clean workflow reads zero events while the context total keeps rising', () => {
    const before = snap(OWNER_HEALTHY_BASELINE);
    const after = snap({ ...OWNER_HEALTHY_BASELINE, totalDuration: 40.5 });
    const d = diffAudioHealth(before, after);
    expect(d.supported).toBe(true);
    expect(d.underrunEvents).toBe(0);
    expect(d.underrunSec).toBe(0);
    expect(d.totalSec).toBeCloseTo(40.5 - 18.056818, 6);
  });

  it('THE POSITIVE CONTROL: a workflow that starved reports only ITS starvation', () => {
    // The context already had 37 events before the workflow started. A bare
    // "underrunEvents === 0" would call this red for the WRONG reason and would
    // be unable to tell 37→37 from 37→40.
    const before = snap(UNDERRUNNING);
    const after = snap({ ...UNDERRUNNING, underrunEvents: 40, underrunDuration: 0.5, totalDuration: 620 });
    const d = diffAudioHealth(before, after);
    expect(d.underrunEvents).toBe(3); // not 40
    expect(d.underrunSec).toBeCloseTo(0.088, 6);
    expect(d.totalSec).toBeCloseTo(7.5, 6);
  });

  it('a dirty-but-unchanged context is CLEAN for this workflow', () => {
    const before = snap(UNDERRUNNING);
    const d = diffAudioHealth(before, snap({ ...UNDERRUNNING, totalDuration: 700 }));
    expect(d.underrunEvents).toBe(0);
    expect(d.underrunSec).toBe(0);
  });

  it('UNSUPPORTED IS NOT CLEAN: "could not see" never reads as "nothing happened"', () => {
    // The failure this prevents: a Firefox run reporting a zero delta and being
    // recorded as device-level evidence.
    const good = snap(OWNER_HEALTHY_BASELINE);
    expect(diffAudioHealth(UNSUPPORTED_AUDIO_HEALTH, good).supported).toBe(false);
    expect(diffAudioHealth(good, UNSUPPORTED_AUDIO_HEALTH).supported).toBe(false);
    expect(diffAudioHealth(UNSUPPORTED_AUDIO_HEALTH, UNSUPPORTED_AUDIO_HEALTH)).toEqual(
      UNSUPPORTED_AUDIO_HEALTH_DELTA,
    );
  });

  it('a CONTEXT REBUILD mid-workflow clamps at zero, never a negative count', () => {
    // The counters are monotonic only within ONE AudioContext. A negative
    // underrun count would read as "better than clean", which is nonsense.
    const before = snap(UNDERRUNNING);
    const after = snap({ ...OWNER_HEALTHY_BASELINE, totalDuration: 2 }); // fresh context
    const d = diffAudioHealth(before, after);
    expect(d.underrunEvents).toBe(0);
    expect(d.underrunSec).toBe(0);
    expect(d.totalSec).toBe(0);
  });

  it('SENSITIVITY: each field of the delta moves with its own input', () => {
    // The instrument's own negative control, matching leg (c) above: a delta
    // blind to the field under test would return a confident clean number.
    const before = snap(OWNER_HEALTHY_BASELINE);
    expect(
      diffAudioHealth(before, snap({ ...OWNER_HEALTHY_BASELINE, underrunEvents: 1 })).underrunEvents,
    ).toBe(1);
    expect(
      diffAudioHealth(before, snap({ ...OWNER_HEALTHY_BASELINE, underrunDuration: 0.25 })).underrunSec,
    ).toBeCloseTo(0.25, 6);
    expect(
      diffAudioHealth(before, snap({ ...OWNER_HEALTHY_BASELINE, totalDuration: 19 })).totalSec,
    ).toBeCloseTo(0.943182, 5);
  });
});
