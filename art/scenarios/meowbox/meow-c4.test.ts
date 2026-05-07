// art/scenarios/meowbox/meow-c4.test.ts
//
// Toolchain validation for MEOWBOX. Asserts the compiled artifacts exist
// and the source SHA matches the built SHA. The harness's render() is a
// stub (D17 stage 1) — once real OfflineAudioContext rendering lands, this
// file flips to baseline-comparison via the same setup helpers as the
// analog-vco scenario.

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
