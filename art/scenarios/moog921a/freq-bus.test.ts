// art/scenarios/moog921a/freq-bus.test.ts
//
// ART scenario for the MOOG 921A Oscillator Driver (CV processor — NOT a
// sound source). The 921A emits CV (freq_bus / width_bus), not audio, but it
// is still a built worklet entry, so we pin its source SHA + a baseline .f32
// the same way as every other worklet so a worklet edit forces a baseline
// regen (memory: ART SHA-pin regenerate LAST). The render harness is the
// Phase-1 deterministic stub (see art/setup/render.ts); the load-bearing pin
// here is the SOURCE SHA, which asserts the .f32 baseline was regenerated
// whenever the 921A worklet changed.
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

describe('moog921a / freq-bus', () => {
  const scenarioId = 'moog921a/freq-bus';

  it('renders without throwing and produces non-empty buffer', async () => {
    const result = await render({
      moduleName: 'moog921a',
      durationS: 0.5,
    });
    expect(result.buffer.length).toBeGreaterThan(0);
    expect(result.sampleRate).toBe(48000);
    const badIdx = result.buffer.findIndex((v) => !Number.isFinite(v));
    expect(badIdx, `non-finite sample at index ${badIdx}: ${result.buffer[badIdx]}`).toBe(-1);
  });

  it('SHA matches between source and built artifact', async () => {
    const srcSha = await moduleSourceSha('moog921a');
    const built = await builtSha('moog921a');
    expect(built).toBe(srcSha);
  });

  it('matches baseline (RMS tier B)', async () => {
    const result = await render({
      moduleName: 'moog921a',
      durationS: 0.5,
    });
    const srcSha = await moduleSourceSha('moog921a');

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
        `Run \`npm run art:update -w art\` if the change to moog921a.ts was intentional.`,
    ).toBe(srcSha);

    const cmp = compareBuffers(result.buffer, existing, 'B');
    expect(cmp.pass, cmp.detail).toBe(true);
  });
});
