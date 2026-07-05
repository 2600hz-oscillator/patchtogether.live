// packages/web/src/lib/audio/modules/delay.test.ts
//
// Def-shape + param-range assertions for the DELAY module. The actual
// audio behavior (delay line + feedback loop + dry/wet crossfade) is
// exercised by Playwright integration tests — vitest in node doesn't
// have a real AudioContext + DelayNode.

import { describe, it, expect } from 'vitest';
import { delayDef } from './delay';

describe('delay: module-def shape', () => {
  it('declares type/label/domain/category', () => {
    expect(delayDef.type).toBe('delay');
    expect(delayDef.label).toBe('delay');
    expect(delayDef.domain).toBe('audio');
    expect(delayDef.category).toBe('effects');
  });

  it('exposes audio in/out plus a time CV input', () => {
    expect(delayDef.inputs.map((p) => p.id).sort()).toEqual(['audio', 'time']);
    expect(delayDef.outputs.map((p) => p.id)).toEqual(['audio']);
    const audio = delayDef.inputs.find((p) => p.id === 'audio');
    const time  = delayDef.inputs.find((p) => p.id === 'time');
    expect(audio?.type).toBe('audio');
    expect(time?.type).toBe('cv');
    expect((time as { paramTarget?: string } | undefined)?.paramTarget).toBe('time');
  });

  it('declares three knobs (time / feedback / mix) with sane ranges', () => {
    const ids = delayDef.params.map((p) => p.id);
    expect(ids).toEqual(['time', 'feedback', 'mix']);
    const time = delayDef.params.find((p) => p.id === 'time')!;
    expect(time.min).toBe(0.001);
    expect(time.max).toBe(2);
    expect(time.curve).toBe('log');
    const feedback = delayDef.params.find((p) => p.id === 'feedback')!;
    expect(feedback.min).toBe(0);
    expect(feedback.max).toBe(0.95);
    expect(feedback.max).toBeLessThan(1); // self-osc protection
    const mix = delayDef.params.find((p) => p.id === 'mix')!;
    expect(mix.min).toBe(0);
    expect(mix.max).toBe(1);
  });
});
