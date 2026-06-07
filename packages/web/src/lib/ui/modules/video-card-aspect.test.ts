import { describe, it, expect } from 'vitest';
import { liveEngineAspect } from './video-card-aspect';

// The in-rack preview cards (OUTPUT / Bentbox / B3ntb0x) letterbox the engine
// frame at this LIVE aspect, so after a 16:9 OUTPUT switch the thumbnail tracks
// the wider canvas instead of the stale 4:3 constant.

describe('liveEngineAspect', () => {
  it('reads the live canvas dims (4:3 = 1024×768)', () => {
    expect(liveEngineAspect({ canvas: { width: 1024, height: 768 } })).toBeCloseTo(4 / 3, 5);
  });

  it('reads the 16:9 switch res (1366×768)', () => {
    // 1366/768 = 1.7786 ≈ 16:9 (1.7778) to within the even-rounding of 1365.33.
    expect(liveEngineAspect({ canvas: { width: 1366, height: 768 } })).toBeCloseTo(16 / 9, 2);
  });

  it('falls back to 4:3 when a dimension is 0 (pre-first-frame)', () => {
    expect(liveEngineAspect({ canvas: { width: 0, height: 0 } })).toBeCloseTo(4 / 3, 5);
    expect(liveEngineAspect({ canvas: { width: 1024, height: 0 } })).toBeCloseTo(4 / 3, 5);
  });

  it('falls back to 4:3 when the engine / canvas is missing', () => {
    expect(liveEngineAspect(null)).toBeCloseTo(4 / 3, 5);
    expect(liveEngineAspect(undefined)).toBeCloseTo(4 / 3, 5);
    expect(liveEngineAspect({})).toBeCloseTo(4 / 3, 5);
  });
});
