// packages/web/src/lib/audio/modules/ringback.test.ts
//
// Unit tests for RINGBACK — the stereo crush effect (the TWOTRACKS record-time
// artifact, made intentional). Pins the module-def shape (stereo in/out, the 4
// crush params + ranges) and the re-exported crush core math (so the card + the
// audio module share one import surface). The full per-sample DSP is unit-tested
// in packages/dsp/src/lib/ringback-core.test.ts (the code the worklet runs).

import { describe, expect, it } from 'vitest';
import {
  ringbackDef,
  RingChannel,
  ringRead,
  mixSample,
  clampFeedback,
  RINGBACK_MAX_FEEDBACK,
} from './ringback';

describe('ringbackDef: module-def shape', () => {
  it('declares type=ringback, label=ringback (lowercase), category=effects, domain=audio', () => {
    expect(ringbackDef.type).toBe('ringback');
    expect(ringbackDef.label).toBe('ringback');
    expect(ringbackDef.label).toBe(ringbackDef.label.toLowerCase()); // guard
    expect(ringbackDef.category).toBe('effects');
    expect(ringbackDef.domain).toBe('audio');
  });

  it('is stereo in: in_l + in_r (audio)', () => {
    const ids = ringbackDef.inputs.map((p) => p.id).sort();
    expect(ids).toEqual(['in_l', 'in_r']);
    for (const p of ringbackDef.inputs) expect(p.type).toBe('audio');
  });

  it('is stereo out: out_l + out_r (audio)', () => {
    const ids = ringbackDef.outputs.map((p) => p.id).sort();
    expect(ids).toEqual(['out_l', 'out_r']);
    for (const p of ringbackDef.outputs) expect(p.type).toBe('audio');
  });

  it('exposes the 4 crush params (rate / size / feedback / mix) with the documented ranges', () => {
    const byId = Object.fromEntries(ringbackDef.params.map((p) => [p.id, p]));
    expect(Object.keys(byId).sort()).toEqual(['feedback', 'mix', 'rate', 'size']);

    expect(byId.rate!.min).toBe(0.05);
    expect(byId.rate!.max).toBe(4);
    expect(byId.rate!.defaultValue).toBe(0.5);

    expect(byId.size!.min).toBe(2);
    expect(byId.size!.max).toBe(4096);
    expect(byId.size!.curve).toBe('log');

    expect(byId.feedback!.min).toBe(0);
    // Feedback is clamped strictly below 1 so the ring can't self-amplify to ∞.
    expect(byId.feedback!.max).toBe(0.98);
    expect(byId.feedback!.max).toBeLessThan(1);

    expect(byId.mix!.min).toBe(0);
    expect(byId.mix!.max).toBe(1);
    expect(byId.mix!.defaultValue).toBe(1);
  });

  it('has a factory + handle count 4 (2 in + 2 out)', () => {
    expect(typeof ringbackDef.factory).toBe('function');
    expect(ringbackDef.inputs.length + ringbackDef.outputs.length).toBe(4);
  });
});

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
