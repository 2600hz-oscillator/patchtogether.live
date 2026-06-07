// art/scenarios/pentemelodica/poly-triad.test.ts
//
// ART scenario for PENTEMELODICA (5-voice polyphonic analog synth). Renders
// the module through the deterministic render harness and compares to a
// baseline .f32 pinned to the worklet source SHA (D17 / D19). The load-bearing
// pin is the source SHA, which asserts the .f32 baseline was regenerated
// whenever the pentemelodica worklet OR its shared DSP lib changed (memory:
// ART SHA-pin regenerate LAST — re-pin the .sha as the FINAL edit step and
// confirm only the .sha changed when audio is unchanged).
//
// On first run with UPDATE_BASELINES=1 it writes the baseline + .sha companion.
// Subsequent runs compare + assert the source SHA still matches.

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

describe('pentemelodica / poly-triad', () => {
  const scenarioId = 'pentemelodica/poly-triad';

  it('renders without throwing and produces non-empty buffer', async () => {
    const result = await render({
      moduleName: 'pentemelodica',
      durationS: 0.5,
    });
    expect(result.buffer.length).toBeGreaterThan(0);
    expect(result.sampleRate).toBe(48000);
    const badIdx = result.buffer.findIndex((v) => !Number.isFinite(v));
    expect(badIdx, `non-finite sample at index ${badIdx}: ${result.buffer[badIdx]}`).toBe(-1);
  });

  it('SHA matches between source and built artifact', async () => {
    const srcSha = await moduleSourceSha('pentemelodica');
    const built = await builtSha('pentemelodica');
    expect(built).toBe(srcSha);
  });

  it('matches baseline (RMS tier B)', async () => {
    const result = await render({
      moduleName: 'pentemelodica',
      durationS: 0.5,
    });
    const srcSha = await moduleSourceSha('pentemelodica');

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
        `Run \`npm run art:update -w art\` if the change to pentemelodica.ts was intentional.`,
    ).toBe(srcSha);

    const cmp = compareBuffers(result.buffer, existing, 'B');
    expect(cmp.pass, cmp.detail).toBe(true);
  });
});
