// packages/dsp/src/lib/snare-roll-dsp.test.ts
//
// The POLYPHONIC drumroll engine gate (design §6.1). Proves the two-hand 180°
// interleave, the bounce/stroke structure (single → double → buzz), the frozen
// rate map, roll determinism across sample rates, the §3.8 voice-budget bound,
// and the lowest-energy allocator. Deterministic — no Math.random anywhere.

import { describe, it, expect } from 'vitest';
import {
  ALLOC_RATE_CAP,
  FLOOR_BOUNCE_S,
  MAX_SUBSTROKES,
  MAX_VOICES,
  allocateVoice,
  bounceSchedule,
  makeRollState,
  minAllocIntervalSamples,
  rollHandHz,
  rollStep,
  type AllocSlot,
  type RollParams,
} from './snare-roll-dsp';

const P = (over: Partial<RollParams> = {}): RollParams => ({
  rollSpeed: 0.5,
  rollSpeedCv: 0,
  bounce: 0.35,
  humanize: 0,
  spread: 0.5,
  ...over,
});

interface Fired {
  sample: number;
  hand: number;
  vel: number;
  detune: number;
  pan: number;
  alloc: number;
}

/** Drive `n` samples with a constant gate; collect every fired sub-stroke. */
function runRoll(
  n: number,
  gate: number,
  p: RollParams,
  sr: number,
  rs = makeRollState(),
): Fired[] {
  const out: Fired[] = [];
  for (let i = 0; i < n; i++) {
    const c = rollStep(rs, gate, p, sr);
    for (let f = 0; f < c; f++) {
      out.push({
        sample: i,
        hand: rs.firedHand[f]!,
        vel: rs.firedVel[f]!,
        detune: rs.firedDetune[f]!,
        pan: rs.firedPan[f]!,
        alloc: rs.firedAlloc[f]!,
      });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
describe('snare-roll: rate mapping (frozen §3.4)', () => {
  it('rollHandHz(0) = 4 Hz, rollHandHz(1) = 24 Hz/hand', () => {
    expect(rollHandHz(0, 0)).toBeCloseTo(4, 6);
    expect(rollHandHz(1, 0)).toBeCloseTo(24, 6);
  });

  it('roll_speed_cv = +1 doubles the rate (1 V/oct)', () => {
    expect(rollHandHz(0.5, 1) / rollHandHz(0.5, 0)).toBeCloseTo(2, 6);
  });

  it('rate is clamped to [1, 40] Hz', () => {
    expect(rollHandHz(1, 4)).toBe(40); // 24·16 clamped
    expect(rollHandHz(0, -4)).toBe(1); // 4/16 clamped
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('snare-roll: bounce/stroke structure (§3.3)', () => {
  const sr = 48000;
  const off = new Float32Array(MAX_SUBSTROKES);
  const vel = new Float32Array(MAX_SUBSTROKES);

  it('SINGLE (bounce≈0): one sub-stroke at full velocity', () => {
    const n = bounceSchedule(0, 12, sr, off, vel);
    expect(n).toBe(1);
    expect(off[0]).toBe(0);
    expect(vel[0]).toBe(1);
  });

  it('DOUBLE (bounce≈0.2): {1.0, ~0.5} at a rebound that TIGHTENS with rate', () => {
    const nSlow = bounceSchedule(0.2, 6, sr, off, vel);
    expect(nSlow).toBe(2);
    expect(vel[0]).toBe(1);
    expect(vel[1]).toBeGreaterThan(0.4);
    expect(vel[1]).toBeLessThan(0.7);
    const reboundSlow = off[1]!;
    bounceSchedule(0.2, 18, sr, off, vel); // faster hand
    const reboundFast = off[1]!;
    expect(reboundFast).toBeLessThan(reboundSlow); // τ ∝ 1/handHz
  });

  it('BUZZ (bounce→1): N≤6 sub-strokes, geometric velocity, shrinking floored spacing', () => {
    const n = bounceSchedule(1, 6, sr, off, vel);
    expect(n).toBeGreaterThan(2);
    expect(n).toBeLessThanOrEqual(MAX_SUBSTROKES);
    // Geometric a·rᵏ velocity decay (strictly decreasing).
    for (let k = 1; k < n; k++) expect(vel[k]).toBeLessThan(vel[k - 1]!);
    // Spacing shrinks (coefficient-of-restitution) and never below the floor.
    const floorSamples = FLOOR_BOUNCE_S * sr;
    let prevGap = Infinity;
    for (let k = 1; k < n; k++) {
      const gap = off[k]! - off[k - 1]!;
      expect(gap).toBeGreaterThanOrEqual(floorSamples - 1);
      expect(gap).toBeLessThanOrEqual(prevGap + 1);
      prevGap = gap;
    }
  });

  it('N GROWS as handRate FALLS (slower hands fill the gap with more rebounds)', () => {
    const nSlow = bounceSchedule(1, 4, sr, off, vel);
    const nFast = bounceSchedule(1, 24, sr, off, vel);
    expect(nSlow).toBeGreaterThan(nFast);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('snare-roll: two-hand 180° interleave (§3.2)', () => {
  const sr = 48000;

  it('composite stroke count ≈ 2·handHz·T', () => {
    // SINGLE bounce → exactly one sub-stroke per primary stroke, so fired
    // count == composite primary-stroke count.
    const handHz = rollHandHz(0.5, 0);
    const T = 1;
    const fired = runRoll(sr * T, 1, P({ bounce: 0, humanize: 0 }), sr);
    const expected = 2 * handHz * T;
    expect(fired.length).toBeGreaterThan(expected * 0.9);
    expect(fired.length).toBeLessThan(expected * 1.15 + 2);
  });

  it('R-hand strokes land in the temporal GAPS between L-hand strokes', () => {
    const handHz = rollHandHz(0.5, 0);
    const periodSamples = sr / handHz;
    const fired = runRoll(sr, 1, P({ bounce: 0, humanize: 0 }), sr);
    const lTimes = fired.filter((f) => f.hand === 0).map((f) => f.sample);
    const rTimes = fired.filter((f) => f.hand === 1).map((f) => f.sample);
    expect(lTimes.length).toBeGreaterThan(4);
    expect(rTimes.length).toBeGreaterThan(4);
    // Each of the first few R strokes sits ~mid-way between two L strokes.
    for (let k = 0; k < 4; k++) {
      const rt = rTimes[k]!;
      const prevL = Math.max(...lTimes.filter((t) => t <= rt), 0);
      const frac = (rt - prevL) / periodSamples;
      expect(frac).toBeGreaterThan(0.3);
      expect(frac).toBeLessThan(0.7);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('snare-roll: determinism (§3.9)', () => {
  it('two runs at the same rate are bit-identical', () => {
    const a = runRoll(24000, 1, P({ humanize: 0.6 }), 48000);
    const b = runRoll(24000, 1, P({ humanize: 0.6 }), 48000);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]!.hand).toBe(b[i]!.hand);
      expect(a[i]!.vel).toBe(b[i]!.vel);
      expect(a[i]!.detune).toBe(b[i]!.detune);
    }
  });

  it('the (hand, vel, detune) stroke SEQUENCE is identical at 44.1k and 48k', () => {
    const seq = (sr: number) =>
      runRoll(Math.round(sr * 0.5), 1, P({ humanize: 0.5 }), sr)
        .slice(0, 40)
        .map((f) => `${f.hand}:${f.vel.toFixed(6)}:${f.detune.toFixed(6)}`);
    const s44 = seq(44100);
    const s48 = seq(48000);
    expect(s44.length).toBeGreaterThan(20);
    expect(s48.slice(0, s44.length)).toEqual(s44);
  });

  it('phases + PRNG RESET on the gate rising edge (each epoch reproduces)', () => {
    const sr = 48000;
    const rs = makeRollState();
    const p = P({ humanize: 0.5 });
    const collect = (n: number, gate: number): Fired[] => {
      const out: Fired[] = [];
      for (let i = 0; i < n; i++) {
        const c = rollStep(rs, gate, p, sr);
        for (let f = 0; f < c; f++) {
          out.push({ sample: i, hand: rs.firedHand[f]!, vel: rs.firedVel[f]!, detune: rs.firedDetune[f]!, pan: rs.firedPan[f]!, alloc: rs.firedAlloc[f]! });
        }
      }
      return out;
    };
    const epoch1 = collect(6000, 1); // gate high (rising at sample 0)
    collect(6000, 0); // gate low — ring out
    const epoch2 = collect(6000, 1); // gate high again (fresh rising edge)
    const sig = (fs: Fired[]) => fs.slice(0, 20).map((f) => `${f.hand}:${f.vel.toFixed(6)}`);
    expect(sig(epoch2)).toEqual(sig(epoch1));
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('snare-roll: voice-budget bound (§3.8)', () => {
  it('under a max-density buzz, alloc rate ≤ cap and excess routes to the bed', () => {
    const sr = 48000;
    const T = 1;
    const fired = runRoll(sr * T, 1, P({ bounce: 1, rollSpeed: 0.5, humanize: 0.3 }), sr);
    const allocs = fired.filter((f) => f.alloc === 1).length;
    const bedOnly = fired.filter((f) => f.alloc === 0).length;
    // The buzz genuinely produced more sub-strokes than the alloc cap allows…
    expect(fired.length).toBeGreaterThan(ALLOC_RATE_CAP);
    // …so allocations are capped and the excess became bed re-excitation.
    expect(allocs).toBeLessThanOrEqual(ALLOC_RATE_CAP + 2);
    expect(bedOnly).toBeGreaterThan(0);
  });

  it('consecutive allocations are never closer than the min interval', () => {
    const sr = 44100;
    const fired = runRoll(sr, 1, P({ bounce: 1, rollSpeed: 0.6, humanize: 0 }), sr);
    const allocSamples = fired.filter((f) => f.alloc === 1).map((f) => f.sample);
    const minI = minAllocIntervalSamples(sr);
    for (let i = 1; i < allocSamples.length; i++) {
      expect(allocSamples[i]! - allocSamples[i - 1]!).toBeGreaterThanOrEqual(minI);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('snare-roll: lowest-energy allocator (§3.7)', () => {
  const mk = (spec: [boolean, number][]): AllocSlot[] =>
    spec.map(([active, energy]) => ({ active, energy }));

  it('returns the first INACTIVE voice', () => {
    const v = mk([[true, 0.9], [true, 0.1], [false, 0], [false, 0]]);
    expect(allocateVoice(v, 4)).toBe(2);
  });

  it('all busy → steals the LOWEST-energy (least audible) voice', () => {
    const v = mk([[true, 0.9], [true, 0.05], [true, 0.5], [true, 0.7]]);
    expect(allocateVoice(v, 4)).toBe(1);
  });

  it('the returned index is always in range (pool never exceeds MAX_VOICES)', () => {
    const v = mk(Array.from({ length: MAX_VOICES }, (_, i) => [true, i / MAX_VOICES] as [boolean, number]));
    const idx = allocateVoice(v, MAX_VOICES);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(MAX_VOICES);
  });
});
