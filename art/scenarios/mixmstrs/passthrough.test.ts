// art/scenarios/mixmstrs/passthrough.test.ts
//
// Toolchain validation for MIXMSTRS — same shape as the analog-vco
// scenario. Once the render harness gains stereo + multi-input support,
// this file expands to scenarios `passthrough`, `eq-bass-boost`,
// `comp-attack`, `send-routing` per the spec.

import { describe, it, expect } from 'vitest';
import {
  render,
  builtSha,
  moduleSourceSha,
} from '../../setup/render';

describe('mixmstrs / passthrough', () => {
  it('renders without throwing and produces non-empty buffer', async () => {
    const result = await render({ moduleName: 'mixmstrs', durationS: 0.5 });
    expect(result.buffer.length).toBeGreaterThan(0);
    expect(result.sampleRate).toBe(48000);
    const badIdx = result.buffer.findIndex((v) => !Number.isFinite(v));
    expect(badIdx, `non-finite sample at ${badIdx}`).toBe(-1);
  });

  it('SHA matches between source and built artifact', async () => {
    const srcSha = await moduleSourceSha('mixmstrs');
    const built = await builtSha('mixmstrs');
    expect(built).toBe(srcSha);
  });
});
