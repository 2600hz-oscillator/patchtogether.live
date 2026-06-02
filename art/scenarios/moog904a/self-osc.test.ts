// art/scenarios/moog904a/self-osc.test.ts
//
// ART scenario for the MOOG 904A VCF (Moog System 55/35 clone, slice 2).
// Exercises the 904A's signature behavior — REGENERATION at max drives the
// transistor ladder into SELF-OSCILLATION (it becomes a VC sine generator
// at the cutoff frequency) — and compares the output to a baseline .f32 in
// art/baselines/, pinned to the worklet source SHA (D17 / D19).
//
// The render harness is the Phase-1 deterministic stub (see
// art/setup/render.ts); the load-bearing pin here is the SOURCE SHA, which
// asserts the .f32 baseline was regenerated whenever the 904A worklet
// changed (memory: ART SHA-pin regenerate LAST). NOTE: the SHA hashes ONLY
// the worklet's own top-level moog904a.ts source — the shared
// lib/moog-ladder-dsp.ts is inlined by esbuild bundle:true, so a lib-only
// change doesn't move the .sha (but DOES change the built .js). Regenerate
// the .sha as the final step after ALL worklet + lib edits.
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

describe('moog904a / self-osc', () => {
  const scenarioId = 'moog904a/self-osc';

  it('renders without throwing and produces non-empty buffer', async () => {
    const result = await render({
      moduleName: 'moog904a',
      durationS: 0.5,
    });
    expect(result.buffer.length).toBeGreaterThan(0);
    expect(result.sampleRate).toBe(48000);
    const badIdx = result.buffer.findIndex((v) => !Number.isFinite(v));
    expect(badIdx, `non-finite sample at index ${badIdx}: ${result.buffer[badIdx]}`).toBe(-1);
  });

  it('SHA matches between source and built artifact', async () => {
    const srcSha = await moduleSourceSha('moog904a');
    const built = await builtSha('moog904a');
    expect(built).toBe(srcSha);
  });

  it('matches baseline (RMS tier B)', async () => {
    const result = await render({
      moduleName: 'moog904a',
      durationS: 0.5,
    });
    const srcSha = await moduleSourceSha('moog904a');

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
        `Run \`npm run art:update -w art\` if the change to moog904a.ts was intentional.`,
    ).toBe(srcSha);

    const cmp = compareBuffers(result.buffer, existing, 'B');
    expect(cmp.pass, cmp.detail).toBe(true);
  });
});
