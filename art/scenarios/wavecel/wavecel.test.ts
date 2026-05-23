// art/scenarios/wavecel/wavecel.test.ts
//
// Toolchain validation for the WAVECEL TS worklet. Mirrors the
// charlottes-echos / buggles pattern: assert the build artifact exists
// and the source SHA matches what's pinned alongside it. Live audio
// behavior (spread→stereo separation, wavefolder spectral content) is
// covered by the unit tests in
// packages/web/src/lib/audio/wavecel-math.test.ts; expanding into
// real-render scenarios is gated on the render harness gaining
// AudioWorkletNode support.

import { describe, it, expect } from 'vitest';
import {
  render,
  builtSha,
  moduleSourceSha,
} from '../../setup/render';

describe('wavecel / toolchain', () => {
  it('renders without throwing and produces non-empty buffer', async () => {
    const result = await render({ moduleName: 'wavecel', durationS: 0.5 });
    expect(result.buffer.length).toBeGreaterThan(0);
    expect(result.sampleRate).toBe(48000);
    const badIdx = result.buffer.findIndex((v) => !Number.isFinite(v));
    expect(badIdx, `non-finite sample at ${badIdx}`).toBe(-1);
  });

  it('SHA matches between source and built artifact', async () => {
    const srcSha = await moduleSourceSha('wavecel');
    const built = await builtSha('wavecel');
    expect(built).toBe(srcSha);
  });
});
