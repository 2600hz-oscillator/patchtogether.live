// art/scenarios/moog921-vco/saw-c4.test.ts
//
// ART scenario for the MOOG 921 VCO (first Moog System 55/35 clone module).
// Renders the 921 at C4 (pitch CV = 0.0) with default knobs and compares the
// output to a baseline .f32 in art/baselines/, pinned to the worklet source
// SHA (D17 / D19). The render harness is the Phase-1 deterministic stub (see
// art/setup/render.ts) — the load-bearing pin here is the source SHA, which
// asserts the .f32 baseline was regenerated whenever the 921 worklet OR its
// shared DSP lib changed (memory: ART SHA-pin regenerate LAST).
//
// On first run with UPDATE_BASELINES=1 it writes the baseline + .sha
// companion. Subsequent runs compare + assert the source SHA still matches.

import { describe, it, expect } from 'vitest';
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

describe('moog921-vco / saw-c4', () => {
  const scenarioId = 'moog921-vco/saw-c4';

  it('renders without throwing and produces non-empty buffer', async () => {
    const result = await render({
      moduleName: 'moog921-vco',
      durationS: 0.5,
    });
    expect(result.buffer.length).toBeGreaterThan(0);
    expect(result.sampleRate).toBe(48000);
    const badIdx = result.buffer.findIndex((v) => !Number.isFinite(v));
    expect(badIdx, `non-finite sample at index ${badIdx}: ${result.buffer[badIdx]}`).toBe(-1);
  });

  it('SHA matches between source and built artifact', async () => {
    const srcSha = await moduleSourceSha('moog921-vco');
    const built = await builtSha('moog921-vco');
    expect(built).toBe(srcSha);
  });

  it('matches baseline (RMS tier B)', async () => {
    const result = await render({
      moduleName: 'moog921-vco',
      durationS: 0.5,
    });
    const srcSha = await moduleSourceSha('moog921-vco');

    const existing = await readBaseline(scenarioId);
    const existingSha = await readBaselineSha(scenarioId);

    if (SHOULD_UPDATE_BASELINES || !existing) {
      await writeBaseline(scenarioId, result.buffer);
      await writeBaselineSha(scenarioId, srcSha);
      expect(true).toBe(true);
      return;
    }

    expect(
      existingSha,
      `Baseline SHA (${existingSha}) doesn't match source SHA (${srcSha}).\n` +
        `Run \`npm run art:update -w art\` if the change to moog921-vco.ts was intentional.`,
    ).toBe(srcSha);

    const cmp = compareBuffers(result.buffer, existing, 'B');
    expect(cmp.pass, cmp.detail).toBe(true);
  });
});
