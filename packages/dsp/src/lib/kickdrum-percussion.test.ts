// packages/dsp/src/lib/kickdrum-percussion.test.ts
//
// P0 BLIND-SPOT coverage for the KICK DRUM voice — two behaviors the coarse
// per-module behavioral metric (an OR of RMS / spectral-centroid over the whole
// render) is STRUCTURALLY BLIND to:
//
//   (a) PERCUSSIVE DECAY. If the amp envelope silently stopped decaying (env
//       coeff → 1, a "drone" bug), the render would still have high RMS and a
//       plausible centroid — the metric passes. A kick that never decays is a
//       broken kick. We pin that the attack transient is ≥ 8× the tail
//       amplitude: the voice MUST die away.
//
//   (b) BODY PITCH-SWEEP DIRECTION. The 909 "dooo" is a body pitch that sweeps
//       DOWN (≈4× at the strike → settled). RMS/centroid over the whole buffer
//       can't tell an up-sweep from a down-sweep from a static tone. We pin the
//       INSTANTANEOUS frequency of the rendered body: f at the attack is ≥ 2×
//       f at settle, measured from the actual output's zero crossings (not the
//       frequency-law function — that's covered in kickdrum-dsp.test.ts).
//
// Uses the REAL kickdrum DSP core (kickdrumP1Step / the frozen defaults). Pure,
// deterministic (seeded click noise, phase-reset strike), < 1 s.

import { describe, it, expect } from 'vitest';
import {
  KICKDRUM_P1_DEFAULTS,
  kickdrumP1Step,
  makeKickdrumState,
  type KickdrumP1Params,
} from './kickdrum-dsp';

const SR = 48000;

const P = (over: Partial<KickdrumP1Params> = {}): KickdrumP1Params => ({
  ...KICKDRUM_P1_DEFAULTS,
  ...over,
});

/** Render n samples; the strike trigger is high for the first 10 samples. */
function render(n: number, p: KickdrumP1Params): Float32Array {
  const s = makeKickdrumState();
  const out = new Float32Array(n);
  for (let t = 0; t < n; t++) out[t] = kickdrumP1Step(t < 10 ? 1 : 0, 0, p, SR, s);
  return out;
}

/** Peak |x| over the sample window [a, b). */
function peakIn(buf: Float32Array, a: number, b: number): number {
  let m = 0;
  for (let i = a; i < b && i < buf.length; i++) m = Math.max(m, Math.abs(buf[i]!));
  return m;
}

/** Integer indices where the signal crosses zero (sign change) within [a, b). */
function zeroCrossings(buf: Float32Array, a: number, b: number): number[] {
  const out: number[] = [];
  let prev = buf[a] ?? 0;
  for (let i = a + 1; i < b && i < buf.length; i++) {
    const cur = buf[i]!;
    if ((prev < 0 && cur >= 0) || (prev >= 0 && cur < 0)) out.push(i);
    prev = cur;
  }
  return out;
}

describe('kickdrum percussion: envelope decays (not a drone)', () => {
  it('attack transient is ≥ 8× the tail amplitude (default voice)', () => {
    // The shipped default sound. bodyDecay 120 ms / subDecay 450 ms → by
    // ~400 ms the voice is deep in its tail; a percussive hit is long gone.
    const buf = render(Math.round(SR * 0.6), P());
    const attack = peakIn(buf, 0, Math.round(SR * 0.015)); // first 15 ms
    const tail = peakIn(buf, Math.round(SR * 0.4), Math.round(SR * 0.5)); // 400–500 ms
    expect(attack).toBeGreaterThan(0.2); // genuinely audible strike
    expect(attack).toBeGreaterThan(8 * tail); // and it DECAYS — no stuck drone
  });

  it('holds even with the LONGEST decays (sub 800 / body 400 ms)', () => {
    // Guards the "env coeff pinned to 1" bug at the far end of the knob range:
    // even maximal decays are still finite; the tail must fall well below the
    // strike. (Measured further out so the long tail has time to die.)
    const buf = render(Math.round(SR * 1.5), P({ subDecay: 800, bodyDecay: 400 }));
    const attack = peakIn(buf, 0, Math.round(SR * 0.015));
    const tail = peakIn(buf, Math.round(SR * 1.2), Math.round(SR * 1.4));
    expect(attack).toBeGreaterThan(8 * tail);
  });
});

describe('kickdrum percussion: body pitch sweeps DOWN', () => {
  it('instantaneous f at the attack is ≥ 2× f at settle (rendered zero-crossings)', () => {
    // Body layer ISOLATED (no sub/click), pure-sine shape, EQ/exciter/dynamics
    // neutralised, so zero crossings track the body oscillator cleanly. tune 50
    // → settled body ≈ 100 Hz; pitchAmt 24 → ≈ 400 Hz at the strike. bodyDecay
    // long enough that the settled window still rings.
    const p = P({
      subLevel: 0,
      clickLevel: 0,
      bodyLevel: 1,
      bodyShape: 0, // pure sine → clean crossings
      pitchAmt: 24,
      pitchTime: 40,
      tune: 50,
      bodyDecay: 400,
      drive: 0,
      translate: 0,
      subEq: 0,
      bodyEq: 0,
      attackEq: 0,
      tilt: 0,
      attack: 0,
      sustain: 0,
      glue: 0,
      ceiling: 0,
      level: -6,
    });
    const buf = render(Math.round(SR * 0.5), p);

    // ATTACK freq: the SHORTEST half-period among the crossings in the first
    // 20 ms captures the peak (start-of-sweep) frequency before it settles.
    const early = zeroCrossings(buf, 0, Math.round(SR * 0.02));
    expect(early.length).toBeGreaterThan(2);
    let minHalf = Infinity;
    for (let i = 1; i < early.length; i++) minHalf = Math.min(minHalf, early[i]! - early[i - 1]!);
    const attackHz = SR / (2 * minHalf);

    // SETTLE freq: median half-period in a late, fully-settled window.
    const late = zeroCrossings(buf, Math.round(SR * 0.28), Math.round(SR * 0.45));
    expect(late.length).toBeGreaterThan(4);
    const halves: number[] = [];
    for (let i = 1; i < late.length; i++) halves.push(late[i]! - late[i - 1]!);
    halves.sort((x, y) => x - y);
    const medHalf = halves[halves.length >> 1]!;
    const settleHz = SR / (2 * medHalf);

    expect(attackHz).toBeGreaterThan(2 * settleHz); // DOWNWARD sweep, ≥ 1 octave
    // Sanity: the settled body is near the expected 2×tune (≈100 Hz), not noise.
    expect(settleHz).toBeGreaterThan(70);
    expect(settleHz).toBeLessThan(140);
  });
});
