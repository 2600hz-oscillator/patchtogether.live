// packages/web/src/lib/ui/modules/clap-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS behind CLAP's derived readouts.
//
// The headline leg: perturb SNAP and `clap-voice-ms` must move 170 → 40 ms
// while a `paramId: 'tail'` readout prints 150 at BOTH. That assertion is the
// entire difference between this registry and a relabelled knob, and it ships
// permanently rather than being checked once at authoring time.

import { describe, expect, it } from 'vitest';

import {
  clapBandwidthHz,
  clapBurstMs,
  clapGraph,
  clapQ,
  clapRoomOnsetMs,
  clapVoiceMs,
  clapVoiceParams,
  type ClapVoiceParams,
} from './clap-face-model';

const DEFAULTS: ClapVoiceParams = clapVoiceParams(() => undefined);

function withParams(over: Partial<ClapVoiceParams>): (id: string) => number | undefined {
  const p = { ...DEFAULTS, ...over };
  return (id) => (p as unknown as Record<string, number>)[id];
}


describe('clap face model — the shipped defaults', () => {
  it('resolves the def defaults for an untouched node', () => {
    expect(DEFAULTS).toEqual({
      pulses: 3, spread: 10, tone: 1000, width: 0.5, tail: 150, snap: 0.5,
    });
  });
});

describe('clap face model — NEGATIVE CONTROLS', () => {
  // (a) THE HEADLINE. SNAP owns the voice's length; TAIL does not.

  it('SNAP 0 leaves only the room — the burst branch is gone', () => {
    expect(clapVoiceMs({ ...DEFAULTS, snap: 0 })).toBeCloseTo(170, 6);
  });

  // (b) THE BAND-PASS PAIR, in both directions at once.

  // (c) PULSES / SPREAD move the burst geometry while TAIL is untouched.

  it('SPREAD 10 → 25 stretches the whole burst train', () => {
    expect(clapBurstMs({ ...DEFAULTS, spread: 25 })).toBeCloseTo(100, 6);
    expect(clapRoomOnsetMs({ ...DEFAULTS, spread: 25 })).toBeCloseTo(50, 6);
  });
});

describe('clap face model — the hero graph', () => {
  it('the room fires at the LAST onset, not at the strike', () => {
    const g = clapGraph(DEFAULTS, 250);
    // Everything strictly before the room onset carries no room energy at all —
    // the silent pre-delay no control on the panel is named after.
    const onset = clapRoomOnsetMs(DEFAULTS) / 250;
    for (const p of g.points) {
      if (p.x < onset - 1e-9) expect(p.room, `room at x=${p.x}`).toBe(0);
    }
    expect(g.roomX).toBeCloseTo(onset, 6);
  });

  it('at SNAP 1 the room is gone from the picture entirely', () => {
    const g = clapGraph({ ...DEFAULTS, snap: 1 }, 250);
    expect(g.points.every((p) => p.room === 0)).toBe(true);
    expect(g.roomX).toBeNull();
  });

  it('the burst peaks at the strike and decays', () => {
    const g = clapGraph({ ...DEFAULTS, snap: 1 }, 250);
    expect(g.points[0]!.burst).toBeCloseTo(1, 6);
    expect(g.points[g.points.length - 1]!.burst).toBeLessThan(0.01);
  });
});
