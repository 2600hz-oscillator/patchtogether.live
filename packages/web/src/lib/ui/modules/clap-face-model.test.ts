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

function readout(id: string, over: Partial<ClapVoiceParams> = {}): string {
  const fn = faceReadoutValueFor(id);
  expect(fn, `${id} is not registered in face-readout-values.ts`).not.toBeNull();
  return fn!(withParams(over));
}

describe('clap face model — the shipped defaults', () => {
  it('resolves the def defaults for an untouched node', () => {
    expect(DEFAULTS).toEqual({
      pulses: 3, spread: 10, tone: 1000, width: 0.5, tail: 150, snap: 0.5,
    });
  });

  it('prints the face’s own figures', () => {
    expect(readout('clap-burst-ms')).toBe('40 ms');
    expect(readout('clap-room-onset-ms')).toBe('20 ms');
    expect(readout('clap-voice-ms')).toBe('170 ms');
    expect(readout('clap-bandwidth-hz')).toBe('890 Hz');
    expect(readout('clap-q')).toBe('1.12');
  });
});

describe('clap face model — NEGATIVE CONTROLS', () => {
  // (a) THE HEADLINE. SNAP owns the voice's length; TAIL does not.
  it('SNAP 0.5 → 1.0 collapses the voice 170 → 40 ms while TAIL reads 150 at both', () => {
    expect(readout('clap-voice-ms', { snap: 0.5 })).toBe('170 ms');
    expect(readout('clap-voice-ms', { snap: 1 })).toBe('40 ms');
    // …and the knob a naive readout would have followed sits perfectly still.
    expect(DEFAULTS.tail).toBe(150);
    expect(clapVoiceMs({ ...DEFAULTS, snap: 1 })).toBe(40);
  });

  it('SNAP 0 leaves only the room — the burst branch is gone', () => {
    expect(clapVoiceMs({ ...DEFAULTS, snap: 0 })).toBeCloseTo(170, 6);
  });

  // (b) THE BAND-PASS PAIR, in both directions at once.
  it('TONE moves the BANDWIDTH and must NOT move Q', () => {
    expect(readout('clap-bandwidth-hz', { tone: 3000 })).toBe('2.7 kHz');
    expect(readout('clap-q', { tone: 3000 })).toBe(readout('clap-q'));
    // …and the other half: WIDTH moves BOTH.
    expect(clapQ({ ...DEFAULTS, width: 0 })).toBeCloseTo(5.556, 3);
    expect(clapBandwidthHz({ ...DEFAULTS, width: 0 })).toBeCloseTo(180, 3);
  });

  // (c) PULSES / SPREAD move the burst geometry while TAIL is untouched.
  it('PULSES 3 → 5 moves burst 40 → 60 ms and room-at 20 → 40 ms', () => {
    expect(readout('clap-burst-ms', { pulses: 5 })).toBe('60 ms');
    expect(readout('clap-room-onset-ms', { pulses: 5 })).toBe('40 ms');
    expect(readout('clap-voice-ms', { pulses: 5 })).toBe('190 ms');
  });

  it('SPREAD 10 → 25 stretches the whole burst train', () => {
    expect(clapBurstMs({ ...DEFAULTS, spread: 25 })).toBeCloseTo(100, 6);
    expect(clapRoomOnsetMs({ ...DEFAULTS, spread: 25 })).toBeCloseTo(50, 6);
  });

  it('TAIL owns the room’s length and nothing else', () => {
    expect(readout('clap-voice-ms', { tail: 800 })).toBe('820 ms');
    expect(clapBurstMs({ ...DEFAULTS, tail: 800 })).toBe(clapBurstMs(DEFAULTS));
    expect(clapRoomOnsetMs({ ...DEFAULTS, tail: 800 })).toBe(clapRoomOnsetMs(DEFAULTS));
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
