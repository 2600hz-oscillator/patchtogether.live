// art/scenarios/lfo-shared-clock/deterministic-phase.test.ts
//
// Phase 1 of the shared-state-sync plan, ART tier: assert that the
// deterministic LFO phase formula produces identical samples on
// independent invocations with the same (epoch, params). The render
// harness is currently a stub (see art/setup/render.ts), so we exercise
// the deterministic path directly via computeLfoState — the same
// function the worklet's sharedDerivedPhase helper implements. When the
// harness gains real OfflineAudioContext + worklet support, this test
// stays valid: computeLfoState is the spec the worklet implements.

import { describe, it, expect } from 'vitest';
import { computeLfoState } from '$lib/audio/modules/lfo-state';

describe('lfo / shared-clock deterministic phase', () => {
  it('two clients with the same epoch produce identical phase samples', () => {
    const rate = 1.5;
    const sampleStepMs = 1000 / 48000;
    const sampleCount = 4800;
    let mismatch = 0;
    for (let i = 0; i < sampleCount; i++) {
      const t = i * sampleStepMs;
      const a = computeLfoState(t, { rate });
      const b = computeLfoState(t, { rate });
      if (a.phase !== b.phase) mismatch++;
    }
    expect(mismatch).toBe(0);
  });

  it('phase is monotonically increasing within each cycle', () => {
    const rate = 0.5;
    let prev = -Infinity;
    let resets = 0;
    for (let t = 0; t < 1000; t += 5) {
      const phase = computeLfoState(t, { rate }).phase;
      if (phase < prev) resets++;
      prev = phase;
    }
    expect(resets).toBe(0);
  });

  it('rate=2 Hz at t=125 ms yields phase=0.25', () => {
    const phase = computeLfoState(125, { rate: 2 }).phase;
    expect(phase).toBeCloseTo(0.25, 12);
  });

  it('quadrature outputs satisfy (phase + 0.25) mod 1 = phase90', () => {
    for (let t = 0; t < 5000; t += 173) {
      const s = computeLfoState(t, { rate: 1.5 });
      expect(((s.phase + 0.25) % 1)).toBeCloseTo(s.phase90, 12);
      expect(((s.phase + 0.5) % 1)).toBeCloseTo(s.phase180, 12);
      expect(((s.phase + 0.75) % 1)).toBeCloseTo(s.phase270, 12);
    }
  });

  it('three "clients" computing at the same shared-time agree', () => {
    const t = 4321.567;
    const rate = 3.7;
    const a = computeLfoState(t, { rate });
    const b = computeLfoState(t, { rate });
    const c = computeLfoState(t, { rate });
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });
});
