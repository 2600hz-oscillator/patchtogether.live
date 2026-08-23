// packages/web/src/lib/audio/modules/samsloop-cv-contract.test.ts
//
// THE TWO SIDES OF SAMSLOOP'S CV CONTRACT, ASSERTED AGAINST EACH OTHER.
//
// ── THE DEFECT THIS EXISTS FOR, measured on this PR's first CI run ──────────
//
// `start_cv` and `end_cv` were declared on the DEF with `paramTarget`, and never
// added to the FACTORY's `inputs` map — the place `rate_cv` publishes its
// `AudioParam`. `AudioEngine.addEdge` reads that `param` to decide whether a
// cable is MODULATION or SIGNAL. With it absent it falls back to
// `{ node, input }`, so the cable became AUDIO into worklet input 0: the window
// CV did nothing, nothing threw, and every def-reading gate stayed green —
// because the def side was perfectly correct. It is the two-sided-contract shape
// CLAUDE.md's backdraft section is about, with a MAP standing in for the number.
//
// ── WHY IT IS SHAPED THIS WAY ───────────────────────────────────────────────
//
// DERIVED MEMBERSHIP, not a list. The subject is "every port the def declares
// with a `paramTarget`", read off the def at run time, so a THIRD CV port added
// tomorrow is covered without editing this file — and an UNCONDITIONAL
// assertion (`toEqual([])`), never a count, so it cannot go stale.
//
// ⚠ AND IT IS A PRODUCT-CONTRACT UNIT TEST, NOT A REPLACEMENT FOR THE ART
// SWEEP. `art/scenarios/cv-terminal` is the lane-level sibling and it is the one
// that actually caught this: it builds a REAL engine and asks the LIVE handle,
// so it sees things a static read cannot (an alias, a param published but never
// answered). This file is the fast, browser-free half that fails in the unit
// lane in milliseconds instead of five minutes into ART — the two are
// complementary and both should stay.

import { describe, expect, it } from 'vitest';
import { samsloopDef } from './samsloop';

/** Every input this def declares as a modulation target. Derived, so a new CV
 *  port is in scope the moment it is declared. */
function paramTargetPorts() {
  return (samsloopDef.inputs ?? []).filter((p) => !!p.paramTarget);
}

/** The factory's `inputs` map, read from SOURCE.
 *
 *  ⚠ SOURCE RATHER THAN A LIVE HANDLE, deliberately: instantiating the factory
 *  needs a real AudioContext and the worklet module, which is what makes the ART
 *  sibling a five-minute lane. The thing that went wrong here is a MISSING LINE,
 *  and a missing line is visible in the text. What this cannot see — that the
 *  published param is the RIGHT one, and that the live handle answers — is
 *  exactly what `cv-terminal` covers. Stated so nobody mistakes this for the
 *  whole gate. */
function factoryInputsSource(): string {
  // The def and its factory live in one file; reading it back is the same
  // source-level technique `card-range-source` uses for the card/def pair.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { resolve } = require('node:path') as typeof import('node:path');
  return readFileSync(resolve(__dirname, 'samsloop.ts'), 'utf8');
}

describe('samsloop CV contract — the def and the factory agree', () => {
  it('every declared paramTarget port publishes an AudioParam in the factory map', () => {
    const src = factoryInputsSource();
    const missing: string[] = [];
    for (const port of paramTargetPorts()) {
      // The entry must exist AND carry a `param:`. An entry without one is the
      // exact silent fallback this test exists for, so matching the id alone
      // would pass on the defect.
      const entry = new RegExp(
        `\\['${port.id}',[^\\]]*param:\\s*params\\.get\\('${port.paramTarget}'\\)`,
      );
      if (!entry.test(src)) {
        missing.push(
          `${port.id} → paramTarget '${port.paramTarget}': no \`param: params.get('${port.paramTarget}')\` ` +
            `entry in the factory inputs map. addEdge will fall back to {node,input} ` +
            `and the cable becomes SIGNAL into that input — silently.`,
        );
      }
    }
    expect(missing.join('\n'), 'a paramTarget port publishes no AudioParam').toEqual('');
  });

  it('every paramTarget names a param the def actually declares', () => {
    // The other direction: a `paramTarget` pointing at a param that does not
    // exist would make `params.get()` return undefined and the `!` assertion
    // above a lie.
    const ids = new Set((samsloopDef.params ?? []).map((p) => p.id));
    const dangling = paramTargetPorts()
      .filter((p) => !ids.has(p.paramTarget!))
      .map((p) => `${p.id} → '${p.paramTarget}' is not a declared param`);
    expect(dangling, 'a paramTarget names no real param').toEqual([]);
  });

  it('NEGATIVE CONTROL: the source probe really reads the factory map', () => {
    // "Found no offenders" and "looked at nothing" are the same output
    // otherwise — the blind-gate rule. Anchored on the port that was ALREADY
    // correct before this PR, so it is independent of the fix under test.
    const src = factoryInputsSource();
    expect(src).toMatch(/\['rate_cv',[^\]]*param:\s*params\.get\('rate'\)/);
    expect(paramTargetPorts().length, 'the def really declares CV ports').toBeGreaterThan(0);
  });

  it('NEGATIVE CONTROL: the predicate REJECTS an entry with no param', () => {
    // Drives the same regex the check uses against a hand-built offender, so a
    // future loosening of the pattern fails here rather than going quietly
    // permissive. This is the shape the defect actually had.
    const offender = `['start_cv', { node: workletNode, input: 0 }],`;
    const entry = /\['start_cv',[^\]]*param:\s*params\.get\('start'\)/;
    expect(entry.test(offender), 'a param-less entry must NOT satisfy the check').toBe(false);
  });
});
