// packages/web/src/lib/audio/breathe-mutation.test.ts
//
// Unit tests for the BREATHE gate mutator. Pure JS; no Web Audio. Covers the
// Euclidean index picker, the per-pass flip semantics, direction alternation,
// and edge cases (all-off / all-on / pct=0).

import { describe, it, expect } from 'vitest';
import {
  breathePass,
  coerceBreatheDirection,
  euclideanIndices,
} from './breathe-mutation';

describe('euclideanIndices', () => {
  it('k=0 → empty', () => {
    expect(euclideanIndices(0, 16)).toEqual([]);
  });
  it('k negative → empty', () => {
    expect(euclideanIndices(-3, 16)).toEqual([]);
  });
  it('totalSteps=0 → empty', () => {
    expect(euclideanIndices(4, 0)).toEqual([]);
  });
  it('k=totalSteps → every index', () => {
    expect(euclideanIndices(16, 16)).toEqual(
      Array.from({ length: 16 }, (_, i) => i),
    );
  });
  it('k > totalSteps → every index (clamped)', () => {
    expect(euclideanIndices(50, 8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
  it('k=8 n=32 → evenly spaced indices 0,4,8,...,28', () => {
    expect(euclideanIndices(8, 32)).toEqual([0, 4, 8, 12, 16, 20, 24, 28]);
  });
  it('k=4 n=16 → 0,4,8,12', () => {
    expect(euclideanIndices(4, 16)).toEqual([0, 4, 8, 12]);
  });
  it('k=3 n=8 → 0, 3, 5 (pulse iff i*3 mod 8 < 3)', () => {
    // i=0:0<3 ✓; i=1:3<3 ✗; i=2:6<3 ✗; i=3:1<3 ✓; i=4:4<3 ✗; i=5:7<3 ✗;
    // i=6:2<3 ✓; i=7:5<3 ✗ → [0, 3, 6]
    expect(euclideanIndices(3, 8)).toEqual([0, 3, 6]);
  });
  it('always returns exactly k indices for 0<k<n', () => {
    for (let k = 1; k < 32; k++) {
      const out = euclideanIndices(k, 32);
      expect(out.length, `k=${k}`).toBe(k);
    }
  });
});

describe('breathePass: exhale (direction=off)', () => {
  it('flips 8-of-16 ON gates OFF spread evenly when percent=0.5', () => {
    const gates = new Array<boolean>(16).fill(true);
    const { gates: after, nextDirection } = breathePass(gates, 'off', 0.5);
    expect(after.filter((g) => g).length).toBe(8);
    expect(nextDirection).toBe('on');
    // Even spread: candidates are all 16 indices; pickCount=8; euclideanIndices(8,16)
    // = [0,2,4,6,8,10,12,14] → those flip to OFF; survivors are odd indices.
    for (let i = 0; i < 16; i++) {
      expect(after[i], `idx=${i}`).toBe(i % 2 === 1);
    }
  });

  it('percent=1 → all ON gates go OFF', () => {
    const gates = new Array<boolean>(16).fill(true);
    const { gates: after } = breathePass(gates, 'off', 1);
    expect(after.every((g) => !g)).toBe(true);
  });

  it('all OFF + direction=off → unchanged, direction flips to on', () => {
    const gates = new Array<boolean>(16).fill(false);
    const { gates: after, nextDirection } = breathePass(gates, 'off', 0.5);
    expect(after).toEqual(gates);
    expect(nextDirection).toBe('on');
  });
});

describe('breathePass: inhale (direction=on)', () => {
  it('flips 8-of-16 OFF gates ON spread evenly when percent=0.5', () => {
    const gates = new Array<boolean>(16).fill(false);
    const { gates: after, nextDirection } = breathePass(gates, 'on', 0.5);
    expect(after.filter((g) => g).length).toBe(8);
    expect(nextDirection).toBe('off');
    for (let i = 0; i < 16; i++) {
      expect(after[i], `idx=${i}`).toBe(i % 2 === 0);
    }
  });

  it('all ON + direction=on → unchanged, direction flips to off', () => {
    const gates = new Array<boolean>(16).fill(true);
    const { gates: after, nextDirection } = breathePass(gates, 'on', 0.5);
    expect(after).toEqual(gates);
    expect(nextDirection).toBe('off');
  });
});

describe('breathePass: alternating sequence', () => {
  it('exhale then inhale restores ON count toward the start, evenly', () => {
    let gates = new Array<boolean>(16).fill(true);
    let direction: 'on' | 'off' = 'off';

    // Exhale 50%: 8 turn off.
    const r1 = breathePass(gates, direction, 0.5);
    gates = r1.gates;
    direction = r1.nextDirection;
    expect(gates.filter((g) => g).length).toBe(8);
    expect(direction).toBe('on');

    // Inhale 50%: 8 turn ON from the 8 currently-off candidates → all 16 on.
    const r2 = breathePass(gates, direction, 0.5);
    gates = r2.gates;
    direction = r2.nextDirection;
    expect(gates.filter((g) => g).length).toBe(16);
    expect(direction).toBe('off');
  });

  it('alternating exhale/inhale at 25%: ON-count oscillates around mid', () => {
    // percent=0.25 → 4 flips/pass. Starting all-on:
    //   pass 0 (exhale): 16 → 12
    //   pass 1 (inhale): 12 → 16
    //   pass 2 (exhale): 16 → 12
    //   ...
    // Verify ON-count never goes negative + direction flips each step.
    let gates = new Array<boolean>(16).fill(true);
    let direction: 'on' | 'off' = 'off';
    for (let step = 0; step < 6; step++) {
      const r = breathePass(gates, direction, 0.25);
      gates = r.gates;
      direction = r.nextDirection;
      const on = gates.filter((g) => g).length;
      expect(on, `step=${step}`).toBeGreaterThanOrEqual(0);
      expect(on, `step=${step}`).toBeLessThanOrEqual(16);
      // direction alternates unconditionally.
      expect(direction, `step=${step}`).toBe(step % 2 === 0 ? 'on' : 'off');
    }
  });
});

describe('breathePass: edges + boundaries', () => {
  it('percent=0 → no change, direction still flips', () => {
    const gates = [true, false, true, false, true, false];
    const { gates: after, nextDirection } = breathePass(gates, 'off', 0);
    expect(after).toEqual(gates);
    expect(nextDirection).toBe('on');
  });
  it('percent=0 inhale → no change', () => {
    const gates = [true, false, true, false];
    const { gates: after, nextDirection } = breathePass(gates, 'on', 0);
    expect(after).toEqual(gates);
    expect(nextDirection).toBe('off');
  });
  it('percent>1 clamps to 1 (flips every candidate)', () => {
    const gates = [true, true, true, true];
    const { gates: after } = breathePass(gates, 'off', 2.5);
    expect(after).toEqual([false, false, false, false]);
  });
  it('percent<0 clamps to 0 (no change)', () => {
    const gates = [true, false, true, false];
    const { gates: after } = breathePass(gates, 'off', -1);
    expect(after).toEqual(gates);
  });
  it('empty gates array → no change', () => {
    const { gates: after, nextDirection } = breathePass([], 'off', 0.5);
    expect(after).toEqual([]);
    expect(nextDirection).toBe('on');
  });
  it('returns a NEW array (does not mutate input)', () => {
    const gates = [true, false, true, false];
    const before = gates.slice();
    breathePass(gates, 'off', 0.5);
    expect(gates).toEqual(before);
  });
  it('preserves array length', () => {
    for (const len of [4, 16, 32, 64]) {
      const gates = new Array<boolean>(len).fill(true);
      const { gates: after } = breathePass(gates, 'off', 0.5);
      expect(after.length).toBe(len);
    }
  });
});

describe('breathePass: 32-step + 64-cell sizes', () => {
  it('32-step all-on, percent=0.25 exhale → 8 OFF at indices 0,4,8,...', () => {
    const gates = new Array<boolean>(32).fill(true);
    const { gates: after } = breathePass(gates, 'off', 0.25);
    const offIdx = after
      .map((g, i) => (g ? -1 : i))
      .filter((i) => i >= 0);
    expect(offIdx).toEqual([0, 4, 8, 12, 16, 20, 24, 28]);
  });
  it('64-cell (DRUMSEQZ-sized) all-on, percent=0.5 exhale → 32 OFF evenly', () => {
    const gates = new Array<boolean>(64).fill(true);
    const { gates: after } = breathePass(gates, 'off', 0.5);
    expect(after.filter((g) => !g).length).toBe(32);
  });
});

describe('coerceBreatheDirection', () => {
  it("'on' → 'on'", () => {
    expect(coerceBreatheDirection('on')).toBe('on');
  });
  it("'off' → 'off'", () => {
    expect(coerceBreatheDirection('off')).toBe('off');
  });
  it('unknown → off (default first pass)', () => {
    expect(coerceBreatheDirection(undefined)).toBe('off');
    expect(coerceBreatheDirection(null)).toBe('off');
    expect(coerceBreatheDirection(0)).toBe('off');
    expect(coerceBreatheDirection('inhale')).toBe('off');
  });
});
