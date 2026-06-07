// art/scenarios/polyhelm/sha-pin.test.ts
//
// SHA-pin ART scenario for the POLYHELM worklet (matches the moog SHA-pin
// pattern + the repo's "regenerate the .sha LAST" discipline). The load-bearing
// signal coverage of POLYHELM's poly path is the property-based poly-chord.test.ts
// next door (it drives the shared engine directly); THIS file pins the worklet
// ARTIFACTS so a baseline regen is enforced whenever the worklet source OR its
// shared engine lib changes.
//
// COMBINED SOURCE SHA: POLYHELM is a thin worklet (polyhelm.ts) over the shared
// engine (lib/helm-engine.ts) which esbuild INLINES into the bundle. moduleSourceSha()
// only hashes the top-level entry, so a lib-only change wouldn't move the pin
// though it DOES change the built .js — so we hash BOTH (the treeohvox pattern).
// Regenerate the baseline + .sha as the FINAL edit step (memory:
// art-sha-pin-regenerate-last) and confirm only the .sha (not the .f32) changed.

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  render,
  readBaseline,
  writeBaseline,
  readBaselineSha,
  writeBaselineSha,
  compareBuffers,
  SHOULD_UPDATE_BASELINES,
} from '../../setup/render';

/** SHA over BOTH polyhelm.ts (worklet entry) AND lib/helm-engine.ts (the
 *  inlined engine) — a change to either must invalidate the baseline. */
async function combinedSourceSha(): Promise<string> {
  const srcDir = new URL('../../../packages/dsp/src/', import.meta.url).pathname;
  const w = await readFile(join(srcDir, 'polyhelm.ts'), 'utf8');
  const l = await readFile(join(srcDir, 'lib', 'helm-engine.ts'), 'utf8');
  return createHash('sha256').update(w).update(l).digest('hex').slice(0, 16);
}

describe('polyhelm / sha-pin', () => {
  const scenarioId = 'polyhelm/sha-pin';

  it('renders without throwing and produces a finite, non-empty buffer', async () => {
    const result = await render({ moduleName: 'polyhelm', durationS: 0.5 });
    expect(result.buffer.length).toBeGreaterThan(0);
    expect(result.sampleRate).toBe(48000);
    const badIdx = result.buffer.findIndex((v) => !Number.isFinite(v));
    expect(badIdx, `non-finite sample at index ${badIdx}`).toBe(-1);
  });

  it('matches baseline (RMS tier B) + worklet+engine SHA is current', async () => {
    const result = await render({ moduleName: 'polyhelm', durationS: 0.5 });
    const srcSha = await combinedSourceSha();

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
      `Baseline SHA (${existingSha}) doesn't match worklet+engine SHA (${srcSha}).\n` +
        `Run \`npm run art:update -w art\` if the change to polyhelm.ts / helm-engine.ts was intentional.`,
    ).toBe(srcSha);

    const cmp = compareBuffers(result.buffer, existing, 'B');
    expect(cmp.pass, cmp.detail).toBe(true);
  });
});
