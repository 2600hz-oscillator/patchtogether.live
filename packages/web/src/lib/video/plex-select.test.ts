// packages/web/src/lib/video/plex-select.test.ts
//
// Unit tests for the pure 4PLEXVID selector-advance + gate-edge logic.
// The GL-side per-output passthrough render is covered by
// e2e/tests/4plexvid.spec.ts; here we verify the JS reference for the
// rotate-on-rising-edge behavior the module factory's setParam uses.

import { describe, it, expect } from 'vitest';
import {
  PLEX_INPUTS,
  advanceSelector,
  gateEdge,
  makeGateState,
  GATE_RISE,
  GATE_FALL,
} from './plex-select';

describe('advanceSelector — wrap-around rotate', () => {
  it('rotates 0 -> 1 -> 2 -> 3 -> 0 for the default 4 inputs', () => {
    expect(advanceSelector(0)).toBe(1);
    expect(advanceSelector(1)).toBe(2);
    expect(advanceSelector(2)).toBe(3);
    expect(advanceSelector(3)).toBe(0); // wrap
  });

  it('wraps at an arbitrary count', () => {
    expect(advanceSelector(0, 3)).toBe(1);
    expect(advanceSelector(2, 3)).toBe(0); // wrap at 3
    expect(advanceSelector(0, 1)).toBe(0); // single input is a no-op rotate
  });

  it('normalizes out-of-range / non-integer indices into [0, count)', () => {
    expect(advanceSelector(4)).toBe(1); // 4 % 4 = 0 -> +1
    expect(advanceSelector(-1)).toBe(0); // -1 -> 3 -> +1 -> 0
    expect(advanceSelector(2.9)).toBe(3); // floor(2.9)=2 -> +1
  });

  it('PLEX_INPUTS is 4', () => {
    expect(PLEX_INPUTS).toBe(4);
  });
});

describe('gateEdge — hysteresis rising-edge detector', () => {
  it('fires exactly once on a clean rising edge', () => {
    const s = makeGateState();
    expect(gateEdge(s, 0)).toBe(false);
    expect(gateEdge(s, 1)).toBe(true); // low -> high
    expect(gateEdge(s, 1)).toBe(false); // held high — no re-fire
    expect(gateEdge(s, 1)).toBe(false);
  });

  it('re-arms only after the signal falls below the fall threshold', () => {
    const s = makeGateState();
    expect(gateEdge(s, 1)).toBe(true); // edge 1
    expect(gateEdge(s, 0)).toBe(false); // falls — re-arms, no fire
    expect(gateEdge(s, 1)).toBe(true); // edge 2
  });

  it('ignores chatter inside the dead band (no spurious fires)', () => {
    const s = makeGateState();
    // Dead band is (GATE_FALL, GATE_RISE) = (0.4, 0.6). A signal ringing
    // around 0.5 must never fire.
    expect(GATE_FALL).toBeLessThan(GATE_RISE);
    const dead = [0.5, 0.45, 0.55, 0.5, 0.41, 0.59];
    for (const v of dead) expect(gateEdge(s, v)).toBe(false);
    // Crossing the full rise threshold still fires.
    expect(gateEdge(s, 0.7)).toBe(true);
    // Wobbling in the dead band while latched high does not re-fire,
    // and does not re-arm (must fall below GATE_FALL to re-arm).
    for (const v of [0.55, 0.45, 0.5]) expect(gateEdge(s, v)).toBe(false);
    expect(gateEdge(s, 0.7)).toBe(false); // still latched — no re-fire
    expect(gateEdge(s, 0.3)).toBe(false); // falls below GATE_FALL — re-arm
    expect(gateEdge(s, 0.7)).toBe(true); // fires again
  });

  it('end-to-end: four gate pulses rotate a selector full circle', () => {
    const s = makeGateState();
    let sel = 0;
    const pulse = () => {
      // A pulse is a 0 -> 1 -> 0 transition; advance on the rising edge.
      if (gateEdge(s, 1)) sel = advanceSelector(sel);
      gateEdge(s, 0);
    };
    pulse(); expect(sel).toBe(1);
    pulse(); expect(sel).toBe(2);
    pulse(); expect(sel).toBe(3);
    pulse(); expect(sel).toBe(0); // wrapped
  });
});
