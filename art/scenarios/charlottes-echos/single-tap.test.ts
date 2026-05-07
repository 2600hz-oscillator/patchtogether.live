// art/scenarios/charlottes-echos/single-tap.test.ts
//
// Toolchain validation for CHARLOTTE'S ECHOS TS worklet. Once the render
// harness gains stereo I/O, expands to scenarios `single-tap`,
// `decaying-loop`, `pitch-rising`, `decay-rate`.

import { describe, it, expect } from 'vitest';
import {
  render,
  builtSha,
  moduleSourceSha,
} from '../../setup/render';

describe("charlottes-echos / single-tap", () => {
  it('renders without throwing and produces non-empty buffer', async () => {
    const result = await render({ moduleName: 'charlottes-echos', durationS: 0.5 });
    expect(result.buffer.length).toBeGreaterThan(0);
    expect(result.sampleRate).toBe(48000);
    const badIdx = result.buffer.findIndex((v) => !Number.isFinite(v));
    expect(badIdx, `non-finite sample at ${badIdx}`).toBe(-1);
  });

  it('SHA matches between source and built artifact', async () => {
    const srcSha = await moduleSourceSha('charlottes-echos');
    const built = await builtSha('charlottes-echos');
    expect(built).toBe(srcSha);
  });
});
