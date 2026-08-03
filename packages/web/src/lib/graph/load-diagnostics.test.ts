// packages/web/src/lib/graph/load-diagnostics.test.ts
//
// Pure-unit gate for the load-diagnostic summariser — the user-facing half of
// the unknown-type drop path. Zero fs, zero DOM, ~0 CI wall-time.
//
// The property that matters is that the three OUTCOMES stay distinguishable
// in the output. "1 module could not be loaded" and "1 module was migrated"
// need opposite reactions from a user (rebuild it vs. re-check its controls),
// so a summary that folded them into one count would be worse than no summary
// — it would be a confident, plausible, wrong report.

import { describe, it, expect } from 'vitest';
import { summarizeLoadDiagnostics, hasLoadDiagnostics, LOAD_DIAGNOSTIC_REASONS } from './load-diagnostics';
import type { LoadDiagnostic } from './persistence';

const dropped = (nodeId: string, type: string): LoadDiagnostic => ({
  nodeId,
  type,
  reason: LOAD_DIAGNOSTIC_REASONS.unknownType,
});
const orphanEdge = (id: string): LoadDiagnostic => ({
  nodeId: id,
  type: 'edge',
  reason: LOAD_DIAGNOSTIC_REASONS.orphanEdge,
});
const invalidEdge = (id: string): LoadDiagnostic => ({
  nodeId: id,
  type: 'edge',
  reason: 'invalid edge dropped: no such port',
});
const migrated = (nodeId: string, type: string, reason: string): LoadDiagnostic => ({
  nodeId,
  type,
  reason,
});

describe('summarizeLoadDiagnostics', () => {
  it('a clean load says NOTHING — no banner on the overwhelmingly common path', () => {
    expect(summarizeLoadDiagnostics([])).toBeNull();
    expect(hasLoadDiagnostics([])).toBe(false);
  });

  it('names the dropped TYPE, because "a module" is not actionable', () => {
    const s = summarizeLoadDiagnostics([dropped('a', 'warrenspectrum')])!;
    expect(s).toMatch(/warrenspectrum/);
    expect(s).toMatch(/could not be loaded/);
  });

  it('counts nodes of the same retired type together, and pluralises', () => {
    const one = summarizeLoadDiagnostics([dropped('a', 'grids')])!;
    expect(one).toMatch(/1 module of type `grids`/);
    const two = summarizeLoadDiagnostics([dropped('a', 'grids'), dropped('b', 'grids')])!;
    expect(two).toMatch(/2 modules of type `grids`/);
  });

  it('keeps DROPPED and MIGRATED as separate, differently-worded facts', () => {
    const s = summarizeLoadDiagnostics([
      migrated('cs', 'callsine', 'migrated from callsine; patch a source into audio_in'),
      dropped('ws', 'warrenspectrum'),
    ])!;
    expect(s).toMatch(/migrated from callsine/);
    expect(s).toMatch(/could not be loaded/);
    // The two clauses are distinct — a summary that merged them would hide
    // which of the two reactions the user needs.
    expect(s.indexOf('migrated')).toBeLessThan(s.indexOf('could not be loaded'));
  });

  it('the migration wording reaches the user VERBATIM, not flattened to "changed"', () => {
    const note = 'migrated from callsine; warren\'s spectrum ANALYSES audio — patch a source into audio_in';
    expect(summarizeLoadDiagnostics([migrated('cs', 'callsine', note)])!).toContain(note);
  });

  it('folds ORPHANED and INVALID edges into one cable count (both mean "no cord")', () => {
    const s = summarizeLoadDiagnostics([
      dropped('ws', 'warrenspectrum'),
      orphanEdge('e1'),
      orphanEdge('e2'),
      invalidEdge('e3'),
    ])!;
    expect(s).toMatch(/3 cables removed/);
  });

  it('reports cables even when NO node was lost (a stale portId on a live node)', () => {
    // The alias path produces exactly this shape: the node survives, some of
    // its cables do not. A summariser keyed only on dropped nodes would say
    // nothing here.
    const s = summarizeLoadDiagnostics([invalidEdge('e-morph_cv')])!;
    expect(s).toMatch(/1 cable removed/);
  });

  it('INSTRUMENT CONTROL: an unrecognised NODE reason is surfaced, never swallowed', () => {
    // A future diagnostic reason that matches neither bucket must still reach
    // the user. Silently dropping it is how a summariser starts lying.
    const s = summarizeLoadDiagnostics([migrated('x', 'someModule', 'something new happened')])!;
    expect(s).toMatch(/something new happened/);
  });
});
