// art/scenarios/timelorde/bpm-120-internal.test.ts
//
// Toolchain validation for TIMELORDE TS worklet. Once the render harness
// gains AudioWorklet + multi-output support, this scenario expands to the
// timing assertions from the spec (5s @120 BPM = 10 pulses on 1x, 40 on
// 4x, 5 on 1/2, etc.).

import { describe, it, expect } from 'vitest';
import {
  render,
  builtSha,
  moduleSourceSha,
} from '../../setup/render';

describe('timelorde / bpm-120-internal', () => {
  it('renders without throwing and produces non-empty buffer', async () => {
    const result = await render({ moduleName: 'timelorde', durationS: 0.5 });
    expect(result.buffer.length).toBeGreaterThan(0);
    expect(result.sampleRate).toBe(48000);
    const badIdx = result.buffer.findIndex((v) => !Number.isFinite(v));
    expect(badIdx, `non-finite sample at ${badIdx}`).toBe(-1);
  });

  it('SHA matches between source and built artifact', async () => {
    const srcSha = await moduleSourceSha('timelorde');
    const built = await builtSha('timelorde');
    expect(built).toBe(srcSha);
  });
});
