// art/scenarios/meowbox/meow-c4.test.ts
//
// Toolchain validation for MEOWBOX. Asserts the compiled artifacts exist,
// the source SHA matches the built SHA, and that the module actually
// renders finite audio (render() drives the real Faust DSP headlessly).
// This file does NOT yet pin a .f32 baseline — promoting it to
// baseline-comparison, the way the analog-vco scenario does, is the
// remaining step.

import { describe, it, expect } from 'vitest';
import {
  render,
  builtSha,
  moduleSourceSha,
} from '../../setup/render';

describe('meowbox / meow-c4', () => {
  it('renders without throwing and produces non-empty buffer', async () => {
    const result = await render({ moduleName: 'meowbox', durationS: 0.5 });
    expect(result.buffer.length).toBeGreaterThan(0);
    expect(result.sampleRate).toBe(48000);
    const badIdx = result.buffer.findIndex((v) => !Number.isFinite(v));
    expect(badIdx, `non-finite sample at ${badIdx}`).toBe(-1);
  });

  it('SHA matches between source and built artifact', async () => {
    const srcSha = await moduleSourceSha('meowbox');
    const built = await builtSha('meowbox');
    expect(built).toBe(srcSha);
  });
});
