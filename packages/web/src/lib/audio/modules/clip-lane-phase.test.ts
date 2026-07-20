// packages/web/src/lib/audio/modules/clip-lane-phase.test.ts
//
// The per-machine lane-phase channel (redesign §4.1) — publish/read/clear,
// keyed by nodeId + lane, mirroring clip-playhead.ts.

import { describe, it, expect } from 'vitest';
import { setLanePhase, getLanePhase, clearLanePhases } from './clip-lane-phase';
import type { LaneCapturePhase } from './clip-record-capture';

const P = (over: Partial<LaneCapturePhase> = {}): LaneCapturePhase => ({
  anchorStep: 3,
  anchorTime: 1.5,
  laneDur: 0.125,
  lengthSteps: 16,
  ctxTime: 2,
  perfNow: 2000,
  ...over,
});

describe('clip-lane-phase', () => {
  it('reads back what was published, per lane', () => {
    setLanePhase('n1', 0, P({ anchorStep: 3 }));
    setLanePhase('n1', 2, P({ anchorStep: 9 }));
    expect(getLanePhase('n1', 0)?.anchorStep).toBe(3);
    expect(getLanePhase('n1', 2)?.anchorStep).toBe(9);
    expect(getLanePhase('n1', 1)).toBeNull(); // never published
    clearLanePhases('n1');
  });
  it('null publish clears a lane (silent → fall back to the audible step)', () => {
    setLanePhase('n2', 0, P());
    setLanePhase('n2', 0, null);
    expect(getLanePhase('n2', 0)).toBeNull();
    clearLanePhases('n2');
  });
  it('is isolated per node and cleared on dispose', () => {
    setLanePhase('a', 0, P({ anchorStep: 1 }));
    setLanePhase('b', 0, P({ anchorStep: 2 }));
    expect(getLanePhase('a', 0)?.anchorStep).toBe(1);
    clearLanePhases('a');
    expect(getLanePhase('a', 0)).toBeNull();
    expect(getLanePhase('b', 0)?.anchorStep).toBe(2); // unaffected
    clearLanePhases('b');
  });
  it('an unknown node reads null', () => {
    expect(getLanePhase('nope', 0)).toBeNull();
  });
});
