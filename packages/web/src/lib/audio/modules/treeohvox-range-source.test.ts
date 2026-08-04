// packages/web/src/lib/audio/modules/treeohvox-range-source.test.ts
//
// ONE SOURCE OF TRUTH for TREE.oh.VOX's CUTOFF range — the def, the worklet's
// AudioParam descriptor, and the value the ladder actually clamps to.
//
// The shipped defect this closes: the def offered CUTOFF from 40 Hz and the
// TB_303 coefficient helper clamped everything below 200 Hz, so the bottom
// ~25 % of a log knob was BIT-EXACTLY dead (measured by bisection at ENVELOPE
// 0: every setting from 40 Hz to 139.5 Hz rendered byte-identical output).
//
// Why no gate could see it — the same shape as the backdraft card/def
// divergence in CLAUDE.md, one layer down: `contract-lock` pins the def's
// min/max, `module-docs-lint` checks the prose exists, `per-module-per-port`
// proves cutoff_cv materialises an edge. EVERY ONE OF THEM READS THE
// DECLARATION. None of them asks whether the DSP honours it. A gate that reads
// one side of a two-sided contract proves nothing about the other side — so
// this test reads BOTH sides and joins them.
//
// Deliberately source-level for the descriptor: the worklet entry
// top-level-exports nothing (ART's classic-script eval breaks if it does), and
// the number we care about is a literal in a `parameterDescriptors` array. A
// regex over the real file is the observable that exists.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { treeohvoxDef } from './treeohvox';
import {
  TB303_CUTOFF_FLOOR_HZ,
  TB303_CUTOFF_CEILING_HZ,
  tb303Coeffs,
  resonanceSkew,
} from '../../../../../dsp/src/lib/treeohvox-dsp';

const WORKLET = join(
  new URL('../../../../../dsp/src/', import.meta.url).pathname,
  'treeohvox.ts',
);

function cutoffParam() {
  const p = treeohvoxDef.params.find((x) => x.id === 'cutoff');
  if (!p) throw new Error('treeohvox has no `cutoff` param');
  return p;
}

describe('treeohvox CUTOFF range comes from ONE place', () => {
  it('the def MATCHES the DSP constants (never re-typed)', () => {
    const p = cutoffParam();
    expect(
      p.min,
      `def cutoff.min = ${p.min} Hz but the ladder floors at ${TB303_CUTOFF_FLOOR_HZ} Hz — ` +
      'travel below the floor is a DEAD control',
    ).toBe(TB303_CUTOFF_FLOOR_HZ);
    expect(p.max).toBe(TB303_CUTOFF_CEILING_HZ);
  });

  it('the WORKLET AudioParam descriptor matches the same constants', () => {
    const src = readFileSync(WORKLET, 'utf8');
    const line = src
      .split('\n')
      .find((l) => l.includes("name: 'cutoff'"));
    expect(line, "no `name: 'cutoff'` descriptor found in the worklet entry").toBeTruthy();
    const min = Number(/minValue:\s*(-?[\d.]+)/.exec(line!)?.[1]);
    const max = Number(/maxValue:\s*(-?[\d.]+)/.exec(line!)?.[1]);
    expect(min, `worklet cutoff minValue = ${min}`).toBe(TB303_CUTOFF_FLOOR_HZ);
    expect(max, `worklet cutoff maxValue = ${max}`).toBe(TB303_CUTOFF_CEILING_HZ);
  });

  it('THE DSP HONOURS IT · coefficients still move at the very bottom of the knob', () => {
    // The join that matters: a matching pair of numbers proves nothing if the
    // filter clamps them away. Two settings a hair above the floor must give
    // DIFFERENT coefficients.
    const r = resonanceSkew(0.5);
    const a = tb303Coeffs(TB303_CUTOFF_FLOOR_HZ, r, 48000);
    const b = tb303Coeffs(TB303_CUTOFF_FLOOR_HZ * 1.5, r, 48000);
    expect(a.b0).not.toBe(b.b0);
    expect(a.k).not.toBe(b.k);
  });

  it('NEGATIVE CONTROL · below the floor the clamp DOES engage (identical coefficients)', () => {
    // The other direction, so the previous leg cannot pass by the clamp simply
    // having been deleted: two settings BELOW the floor must still collapse.
    const r = resonanceSkew(0.5);
    const a = tb303Coeffs(TB303_CUTOFF_FLOOR_HZ * 0.5, r, 48000);
    const b = tb303Coeffs(TB303_CUTOFF_FLOOR_HZ * 0.1, r, 48000);
    expect(a.b0).toBe(b.b0);
    expect(a.b0).toBe(tb303Coeffs(TB303_CUTOFF_FLOOR_HZ, r, 48000).b0);
  });
});
