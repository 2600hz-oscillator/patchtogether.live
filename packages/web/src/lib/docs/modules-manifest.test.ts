// Sanity-check that the auto-generated module manifest covers every module
// the registry exports. The generator is a regex parser; this test catches
// the failure mode where someone adds a new module but the parser doesn't
// pick it up (silent skip) and the docs site shows a stale catalog.

import { describe, expect, it } from 'vitest';
import { moduleManifest } from './modules-manifest';
import type { ManifestModule } from './types';

const REQUIRED_FIELDS: Array<keyof ManifestModule> = [
  'type',
  'label',
  'category',
  'description',
  'inputs',
  'outputs',
  'params',
  'file',
  'sourceUrl',
];

describe('docs/modules-manifest', () => {
  it('generated 19+ modules (matches the audio registry)', () => {
    expect(moduleManifest.moduleCount).toBeGreaterThanOrEqual(19);
    expect(moduleManifest.modules.length).toBe(moduleManifest.moduleCount);
  });

  it('every module carries the required fields', () => {
    for (const m of moduleManifest.modules) {
      for (const f of REQUIRED_FIELDS) {
        expect(m[f], `missing ${String(f)} on ${m.type}`).toBeDefined();
      }
      expect(typeof m.type).toBe('string');
      expect(m.type).not.toBe('');
      expect(typeof m.label).toBe('string');
      expect(m.label).not.toBe('');
    }
  });

  it('module types are unique', () => {
    const seen = new Set<string>();
    for (const m of moduleManifest.modules) {
      expect(seen.has(m.type), `dup module type ${m.type}`).toBe(false);
      seen.add(m.type);
    }
  });

  it('emitted no parser warnings', () => {
    expect(moduleManifest.warnings).toEqual([]);
  });

  it('source URLs point at the GitHub repo', () => {
    for (const m of moduleManifest.modules) {
      expect(m.sourceUrl).toMatch(
        /^https:\/\/github\.com\/2600hz-oscillator\/patchtogether\.live\/blob\/main\/packages\/web\/src\/lib\/audio\/modules\//,
      );
      expect(m.sourceUrl.endsWith(m.file)).toBe(true);
    }
  });

  // Ports + params for five well-known modules. Spot-check that the parser
  // isn't quietly dropping ports — these are stable and load-bearing for the
  // catalog accuracy the README/PR brief calls out.
  const SPOT_CHECKS: Record<string, { inputs: string[]; outputs: string[]; minParams: number }> = {
    analogVco:    { inputs: ['pitch', 'fm'],                                      outputs: ['saw', 'square', 'triangle', 'sine'], minParams: 1 },
    audioOut:     { inputs: ['L', 'R'],                                           outputs: [],                                   minParams: 0 },
    vca:          { inputs: ['audio', 'cv'],                                      outputs: ['audio'],                            minParams: 1 },
    adsr:         { inputs: ['gate', 'attack', 'decay', 'sustain', 'release'],    outputs: ['env'],                              minParams: 4 },
    sequencer:    { inputs: ['clock'],                                            outputs: ['pitch', 'gate', 'clock'],           minParams: 5 },
  };
  for (const [type, expected] of Object.entries(SPOT_CHECKS)) {
    it(`spot-check: ${type} ports + params`, () => {
      const m = moduleManifest.modules.find((mm) => mm.type === type);
      expect(m, `module ${type} missing from manifest`).toBeDefined();
      if (!m) return;
      expect(m.inputs.map((p) => p.id)).toEqual(expected.inputs);
      expect(m.outputs.map((p) => p.id)).toEqual(expected.outputs);
      expect(m.params.length).toBeGreaterThanOrEqual(expected.minParams);
    });
  }
});
