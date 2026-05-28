// packages/web/src/lib/audio/modules/lfo.test.ts
//
// Phase 1 of the shared-state-sync plan: assert that the LFO's pure
// phase computation is a deterministic function of (t_ms, params).
// We test the leaf module (lfo-state.ts) rather than lfo.ts because the
// latter imports the worklet via `?url`, which Vite resolves but Node
// (the vitest test runner) can't.

import { describe, it, expect } from 'vitest';
import { computeLfoState, computeLfoOutput, lfoDepthGain } from './lfo-state';

describe('computeLfoState', () => {
  it('is deterministic for the same (t, params)', () => {
    const a = computeLfoState(1234.5, { rate: 1.0 });
    const b = computeLfoState(1234.5, { rate: 1.0 });
    expect(a).toEqual(b);
  });

  it('returns phase=0 at t=0 (rack epoch)', () => {
    const s = computeLfoState(0, { rate: 1.0 });
    expect(s.phase).toBe(0);
    expect(s.phase90).toBe(0.25);
    expect(s.phase180).toBe(0.5);
    expect(s.phase270).toBe(0.75);
  });

  it('returns phase=0.5 at t=500 ms with rate=1 Hz', () => {
    const s = computeLfoState(500, { rate: 1.0 });
    expect(s.phase).toBeCloseTo(0.5, 12);
  });

  it('wraps cleanly across cycle boundaries', () => {
    const s1 = computeLfoState(999, { rate: 1.0 });
    const s2 = computeLfoState(1001, { rate: 1.0 });
    expect(s1.phase).toBeCloseTo(0.999, 6);
    expect(s2.phase).toBeCloseTo(0.001, 6);
  });

  it('scales linearly with rate', () => {
    const a = computeLfoState(100, { rate: 2.0 });
    const b = computeLfoState(200, { rate: 1.0 });
    expect(a.phase).toBeCloseTo(b.phase, 12);
  });

  it('produces phase180 = (phase + 0.5) mod 1', () => {
    for (let t = 0; t < 5000; t += 173) {
      const s = computeLfoState(t, { rate: 1.5 });
      expect(((s.phase + 0.5) % 1)).toBeCloseTo(s.phase180, 12);
    }
  });

  it('two clients with the same epoch + rate match across "client A" and "client B"', () => {
    // Two clients independently compute phase at the same shared time.
    // The function is the only mechanism — no shared state — so they
    // must produce identical values.
    const epochMs = 1_700_000_000_000;
    const sharedNow = epochMs + 1234.567;

    const tA = sharedNow - epochMs;
    const tB = sharedNow - epochMs;
    const a = computeLfoState(tA, { rate: 4.2 });
    const b = computeLfoState(tB, { rate: 4.2 });
    expect(a).toEqual(b);
  });

  it('default rate falls back to 1 Hz', () => {
    const s = computeLfoState(500, {});
    expect(s.phase).toBeCloseTo(0.5, 12);
  });
});

describe('lfoDepthGain', () => {
  it('maps depth=0 → gain 0 (still)', () => {
    expect(lfoDepthGain(0)).toBe(0);
  });
  it('maps depth=0.5 → gain 1 (unity / legacy)', () => {
    expect(lfoDepthGain(0.5)).toBe(1);
  });
  it('maps depth=1 → gain 2 (200%, deliberately out of range, not clamped)', () => {
    expect(lfoDepthGain(1)).toBe(2);
  });
});

describe('computeLfoOutput (depth scaling)', () => {
  // A quarter-cycle into a 1 Hz sine puts the LFO at its peak (+1 at unity).
  const peakT = 250;
  const phases = ['phase0', 'phase90', 'phase180', 'phase270'] as const;

  it('depth=0 → output is flat/still at the resting centre value (0) for all phases', () => {
    for (let t = 0; t < 1000; t += 137) {
      const out = computeLfoOutput(t, { rate: 1, shape: 0, depth: 0 });
      // toBeCloseTo treats -0 and +0 as equal — the LFO emits zero swing
      // (still) regardless of which sign the underlying morph produced.
      for (const p of phases) expect(out[p]).toBeCloseTo(0, 12);
    }
  });

  it('depth=0.5 → exactly the legacy unity output (morph value, gain 1)', () => {
    const out = computeLfoOutput(peakT, { rate: 1, shape: 0, depth: 0.5 });
    // sine at phase 0.25 = sin(pi/2) = +1
    expect(out.phase0).toBeCloseTo(1, 12);
  });

  it('depth=1 → 2× the unity swing on every phase (out of range, not clamped)', () => {
    for (let t = 0; t < 1000; t += 91) {
      const unity = computeLfoOutput(t, { rate: 1.3, shape: 0.7, depth: 0.5 });
      const full = computeLfoOutput(t, { rate: 1.3, shape: 0.7, depth: 1 });
      for (const p of phases) {
        expect(full[p]).toBeCloseTo(unity[p] * 2, 12);
      }
    }
    // Peak deliberately exceeds the normal [-1,1] range.
    const peak = computeLfoOutput(peakT, { rate: 1, shape: 0, depth: 1 });
    expect(peak.phase0).toBeCloseTo(2, 12);
  });

  it('default depth (0.5) preserves legacy unity output', () => {
    const def = computeLfoOutput(peakT, { rate: 1, shape: 0 });
    const unity = computeLfoOutput(peakT, { rate: 1, shape: 0, depth: 0.5 });
    expect(def).toEqual(unity);
  });

  it('depth is orthogonal to shape — scales swing for saw/square too', () => {
    for (const shape of [0, 0.5, 1, 1.5, 2]) {
      const unity = computeLfoOutput(333, { rate: 2, shape, depth: 0.5 });
      const half = computeLfoOutput(333, { rate: 2, shape, depth: 0.25 });
      for (const p of phases) {
        expect(half[p]).toBeCloseTo(unity[p] * 0.5, 12);
      }
    }
  });
});
