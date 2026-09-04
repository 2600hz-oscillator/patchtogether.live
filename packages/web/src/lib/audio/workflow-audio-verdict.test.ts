// packages/web/src/lib/audio/workflow-audio-verdict.test.ts
//
// The combined workflow verdict — and specifically the thing it exists to stop:
// A VERDICT THAT IS GREEN BECAUSE EVERY LEG THAT COULD HAVE FAILED WAS OFF.
//
// Each leg has a documented way of being switched off without anyone noticing:
//   device — headless CI runs a null audio sink; an underrun cannot occur.
//   graph  — moving a save to a Worker makes the audio graph green by
//            construction while the main thread still stalls.
//   main   — no module started the scheduler clock, so there are no ticks to be
//            late.
// So half of these cases assert BLINDNESS rather than a finding.

import { describe, it, expect } from 'vitest';
import {
  evaluateWorkflowAudio,
  formatWorkflowAudioVerdict,
  type WorkflowAudioInput,
} from './workflow-audio-verdict';
import {
  snapshotFromStats,
  UNSUPPORTED_AUDIO_HEALTH,
  type AudioPlaybackStatsLike,
} from './playback-stats';
import type { TickLatencyStats } from './tick-latency';
import type { ContinuityViolation } from './continuity-probe';

const health = (underrunEvents: number, totalDuration: number) =>
  snapshotFromStats({
    underrunEvents,
    underrunDuration: underrunEvents * 0.01,
    totalDuration,
    averageLatency: 0.036,
    maximumLatency: 0.041,
  } as AudioPlaybackStatsLike);

function tick(over: Partial<TickLatencyStats> = {}): TickLatencyStats {
  return {
    samples: 100,
    drained: 0,
    overBudget: 0,
    buckets: [],
    p50Ms: 1,
    p99Ms: 4,
    maxMs: 6,
    dispatchP99Ms: 0.5,
    dispatchMaxMs: 1,
    elapsedMs: 2500,
    tickMs: 25,
    ...over,
  };
}

const CLEAN: WorkflowAudioInput = {
  health: { before: health(0, 10), after: health(0, 20) },
  tick: { before: tick(), after: tick({ samples: 200 }) },
  graph: [],
};

describe('evaluateWorkflowAudio — a clean workflow', () => {
  it('passes with all three legs LIVE and nothing blind', () => {
    const v = evaluateWorkflowAudio(CLEAN);
    expect(v.pass).toBe(true);
    expect(v.findings).toEqual([]);
    expect([...v.live].sort()).toEqual(['device', 'graph', 'main']);
    expect(v.blind).toEqual([]);
    expect(formatWorkflowAudioVerdict(v)).toBe('PASS [live: device+main+graph]');
  });
});

describe('evaluateWorkflowAudio — each leg can actually fail', () => {
  it('DEVICE: underruns added during the workflow', () => {
    const v = evaluateWorkflowAudio({ ...CLEAN, health: { before: health(3, 10), after: health(7, 20) } });
    expect(v.pass).toBe(false);
    expect(v.findings).toEqual([{ leg: 'device', kind: 'underrun', value: 4, limit: 0 }]);
  });

  it('MAIN: ticks that arrived a whole period late', () => {
    const v = evaluateWorkflowAudio({
      ...CLEAN,
      tick: { before: tick(), after: tick({ samples: 200, overBudget: 9 }) },
    });
    expect(v.findings).toEqual([{ leg: 'main', kind: 'tickOverBudget', value: 9, limit: 0 }]);
  });

  it('MAIN: a p99 lateness leg, off by default and armable', () => {
    const input = { ...CLEAN, tick: { before: tick(), after: tick({ samples: 200, p99Ms: 180 }) } };
    expect(evaluateWorkflowAudio(input).pass).toBe(true); // off by default
    expect(evaluateWorkflowAudio(input, { maxTickLatenessMs: 50 }).findings).toEqual([
      { leg: 'main', kind: 'tickLateness', value: 180, limit: 50 },
    ]);
  });

  it('GRAPH: probe violations arrive with their own kinds intact', () => {
    const graph: ContinuityViolation[] = [
      { kind: 'frozen', value: 40, limit: 24, seq: 3 },
      { kind: 'click', value: 1.9, limit: 0.5, seq: 3 },
    ];
    const v = evaluateWorkflowAudio({ ...CLEAN, graph });
    expect(v.findings.map((f) => [f.leg, f.kind])).toEqual([
      ['graph', 'frozen'],
      ['graph', 'click'],
    ]);
  });

  it('reports EVERY leg that failed, not the first', () => {
    const v = evaluateWorkflowAudio({
      health: { before: health(0, 10), after: health(2, 20) },
      tick: { before: tick(), after: tick({ samples: 200, overBudget: 5 }) },
      graph: [{ kind: 'click', value: 1.9, limit: 0.5, seq: 1 }],
    });
    expect(v.findings.map((f) => f.leg).sort()).toEqual(['device', 'graph', 'main']);
  });
});

// ── THE POINT OF THE FILE ─────────────────────────────────────────────────
describe('evaluateWorkflowAudio — a green verdict must state what it could not see', () => {
  it('NO LEGS LIVE is "NO EVIDENCE", never a pass', () => {
    const v = evaluateWorkflowAudio({});
    expect(v.pass).toBe(false);
    expect(v.live).toEqual([]);
    expect(v.blind.map((b) => b.leg).sort()).toEqual(['device', 'graph', 'main']);
    expect(formatWorkflowAudioVerdict(v)).toBe('NO EVIDENCE [live: none] [blind: device+main+graph]');
  });

  it('HEADLESS CI: a null sink makes the device leg blind, not clean', () => {
    // totalDuration did not advance → nothing could have been starved. The
    // arithmetic zero is not evidence, and this is the exact shape a headless
    // runner produces.
    const v = evaluateWorkflowAudio({ ...CLEAN, health: { before: health(0, 10), after: health(0, 10) } });
    expect(v.live).not.toContain('device');
    expect(v.blind.find((b) => b.leg === 'device')?.reason).toMatch(/null sink cannot underrun/);
    // The other two legs still carry the verdict.
    expect(v.pass).toBe(true);
    expect(formatWorkflowAudioVerdict(v)).toContain('[blind: device]');
  });

  it('FIREFOX/SAFARI: unsupported playbackStats is blind, not clean', () => {
    const v = evaluateWorkflowAudio({
      ...CLEAN,
      health: { before: UNSUPPORTED_AUDIO_HEALTH, after: UNSUPPORTED_AUDIO_HEALTH },
    });
    expect(v.live).not.toContain('device');
    expect(v.blind.find((b) => b.leg === 'device')?.reason).toMatch(/unsupported/);
  });

  it('⚠ THE WORKER TRAP: no probe mounted is blind, not clean', () => {
    // A save moved to a Worker leaves the audio graph untouched, so an
    // audio-only gate goes green BY CONSTRUCTION. `graph: undefined` must not
    // read the same as `graph: []`.
    const missing = evaluateWorkflowAudio({ ...CLEAN, graph: undefined });
    const ran = evaluateWorkflowAudio({ ...CLEAN, graph: [] });
    expect(missing.live).not.toContain('graph');
    expect(missing.blind.find((b) => b.leg === 'graph')?.reason).toMatch(/no continuity probe/);
    expect(ran.live).toContain('graph');
    // Both "pass", but only one of them means anything — which is why `blind`
    // is part of the verdict and not a debug aside.
    expect([missing.pass, ran.pass]).toEqual([true, true]);
    expect(missing.blind).not.toEqual(ran.blind);
  });

  it('a scheduler clock that never ticked is blind, not on time', () => {
    const v = evaluateWorkflowAudio({ ...CLEAN, tick: { before: tick(), after: tick() } });
    expect(v.live).not.toContain('main');
    expect(v.blind.find((b) => b.leg === 'main')?.reason).toMatch(/did not tick/);
  });

  it('no clock at all is blind, and says so differently', () => {
    const v = evaluateWorkflowAudio({ ...CLEAN, tick: { before: null, after: null } });
    expect(v.blind.find((b) => b.leg === 'main')?.reason).toMatch(/no scheduler clock/);
  });

  it('the summary line ALWAYS carries the live and blind legs', () => {
    // So a pass can never be quoted out of context — the caveat travels with it.
    const s = formatWorkflowAudioVerdict(
      evaluateWorkflowAudio({ ...CLEAN, graph: [{ kind: 'stalled', value: 900, limit: 500, seq: 0 }] }),
    );
    expect(s).toContain('FAIL');
    expect(s).toContain('graph:stalled(900>500)');
    expect(s).toContain('[live: device+main+graph]');
  });
});
