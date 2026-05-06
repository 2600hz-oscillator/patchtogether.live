// art/scenarios/analog-vco/saw-c4.test.ts
//
// First ART scenario — Phase 1 toolchain validation.
// Renders the Analog VCO at C4 (pitch CV = 0.0) with default knobs and
// compares the saw output to a baseline .f32 in art/baselines/.
//
// On first run with UPDATE_BASELINES=1 it writes the baseline + .sha companion.
// Subsequent runs compare and assert the source SHA still matches (D17 / D19).

import { describe, it, expect, beforeAll } from 'vitest';
import {
  render,
  readBaseline,
  writeBaseline,
  readBaselineSha,
  writeBaselineSha,
  builtSha,
  moduleSourceSha,
  compareBuffers,
  SHOULD_UPDATE_BASELINES,
} from '../../setup/render';

describe('analog-vco / saw-c4', () => {
  const scenarioId = 'analog-vco/saw-c4';

  it('renders without throwing and produces non-empty buffer', async () => {
    const result = await render({
      moduleName: 'analog-vco',
      durationS: 0.5,
    });
    expect(result.buffer.length).toBeGreaterThan(0);
    expect(result.sampleRate).toBe(48000);
    // No NaN / Inf — find the first bad sample (if any) instead of running 24k
    // expects, so a failure prints one readable message with the offending index.
    const badIdx = result.buffer.findIndex((v) => !Number.isFinite(v));
    expect(badIdx, `non-finite sample at index ${badIdx}: ${result.buffer[badIdx]}`).toBe(-1);
  });

  it('SHA matches between source and built artifact', async () => {
    const srcSha = await moduleSourceSha('analog-vco');
    const built = await builtSha('analog-vco');
    expect(built).toBe(srcSha);
  });

  it('matches baseline (RMS tier B)', async () => {
    const result = await render({
      moduleName: 'analog-vco',
      durationS: 0.5,
    });
    const srcSha = await moduleSourceSha('analog-vco');

    const existing = await readBaseline(scenarioId);
    const existingSha = await readBaselineSha(scenarioId);

    if (SHOULD_UPDATE_BASELINES || !existing) {
      await writeBaseline(scenarioId, result.buffer);
      await writeBaselineSha(scenarioId, srcSha);
      // First-time write or explicit update: pass.
      expect(true).toBe(true);
      return;
    }

    // Source SHA must match baseline SHA, else the user forgot art:update.
    expect(
      existingSha,
      `Baseline SHA (${existingSha}) doesn't match source SHA (${srcSha}).\n` +
        `Run \`npm run art:update -w art\` if the change to analog-vco.dsp was intentional.`
    ).toBe(srcSha);

    const cmp = compareBuffers(result.buffer, existing, 'B');
    expect(cmp.pass, cmp.detail).toBe(true);
  });
});
