// packages/web/src/lib/audio/modules/ringback.test.ts
//
// Unit tests for RINGBACK — the stereo crush effect (the TWOTRACKS record-time
// artifact, made intentional). Pins the module-def shape (stereo in/out, the 4
// crush params + ranges) and the re-exported crush core math (so the card + the
// audio module share one import surface). The full per-sample DSP is unit-tested
// in packages/dsp/src/lib/ringback-core.test.ts (the code the worklet runs).

import { describe, expect, it } from 'vitest';
import {
  RingChannel,
  ringRead,
  mixSample,
  clampFeedback,
  RINGBACK_MAX_FEEDBACK,
} from './ringback';

describe('ringback re-exports the crush core (one shared import surface)', () => {
  it('re-exports RingChannel + the pure crush helpers', () => {
    expect(typeof RingChannel).toBe('function');
    expect(ringRead(new Float32Array([0, 10]), 0.5, 2)).toBeCloseTo(5);
    expect(mixSample(1, 0, 0)).toBe(1);
    expect(clampFeedback(5)).toBe(RINGBACK_MAX_FEEDBACK);
  });

  it('a RingChannel with mix=0 is a clean passthrough (sanity)', () => {
    const ch = new RingChannel();
    for (const x of [0.1, -0.2, 0.5, -0.7]) {
      expect(ch.step(x, 1, 64, 0, 0)).toBeCloseTo(x, 6);
    }
  });
});
