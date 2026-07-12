// packages/web/src/lib/ui/workflow/workflow-surfaces.test.ts
//
// WORKFLOW MODE P2 — the pure helpers behind the topbar surfaces:
// timelorde resolution, externally-clocked detection, the MIDI-DIN
// assign/unassign wiring plans, and the tap-tempo external guard.
// (The tap INTERVAL math itself — median, 2-tap lock, timeout reset,
// clamping — is pinned by lib/electra/tap-tempo.test.ts; here we cover
// the surface-level composition incl. the 2-tap minimum through the
// guard and the disabled-when-external behavior.)

import { describe, it, expect } from 'vitest';
import { TapTempo } from '$lib/electra/tap-tempo';
import {
  resolveWorkflowTimelorde,
  hasExternalClock,
  DIN_EDGE_PAIRS,
  dinEdgeId,
  planDinAssign,
  planDinUnassign,
  isDinAssigned,
  tapWithExternalGuard,
  type SurfaceEdgeLike,
} from './workflow-surfaces';

function edge(
  id: string,
  from: [string, string],
  to: [string, string],
): SurfaceEdgeLike {
  return {
    id,
    source: { nodeId: from[0], portId: from[1] },
    target: { nodeId: to[0], portId: to[1] },
  };
}

describe('resolveWorkflowTimelorde', () => {
  it('prefers the pinned instance', () => {
    const nodes = [
      { id: 'timelorde-zz', type: 'timelorde' },
      { id: 'pinned-timelorde', type: 'timelorde' },
      { id: 'vco-1', type: 'analogVco' },
    ];
    expect(resolveWorkflowTimelorde(nodes)?.id).toBe('pinned-timelorde');
  });

  it('falls back to the lex-smallest canvas timelorde (dawless import)', () => {
    const nodes = [
      { id: 'timelorde-zz', type: 'timelorde' },
      { id: 'timelorde-aa', type: 'timelorde' },
    ];
    expect(resolveWorkflowTimelorde(nodes)?.id).toBe('timelorde-aa');
  });

  it('null when the rack has no timelorde yet', () => {
    expect(resolveWorkflowTimelorde([{ id: 'x', type: 'analogVco' }])).toBeNull();
    expect(resolveWorkflowTimelorde([])).toBeNull();
  });
});

describe('hasExternalClock', () => {
  const tl = 'pinned-timelorde';
  it('true only for an edge into <timelorde>.clock', () => {
    expect(hasExternalClock([edge('e1', ['lfo', 'out'], [tl, 'clock'])], tl)).toBe(true);
    expect(hasExternalClock([edge('e1', ['lfo', 'out'], [tl, 'start_in'])], tl)).toBe(false);
    expect(hasExternalClock([edge('e1', ['lfo', 'out'], ['other', 'clock'])], tl)).toBe(false);
    expect(hasExternalClock([], tl)).toBe(false);
  });
  it('false with no timelorde resolved', () => {
    expect(hasExternalClock([edge('e1', ['lfo', 'out'], [tl, 'clock'])], null)).toBe(false);
  });
  it('tolerates undefined holes (live record values)', () => {
    expect(hasExternalClock([undefined, edge('e1', ['a', 'clock'], [tl, 'clock'])], tl)).toBe(true);
  });
});

describe('planDinAssign / planDinUnassign / isDinAssigned', () => {
  const mc = 'pinned-midiclock';
  const tl = 'pinned-timelorde';

  it('the pair table is the documented midiclock→timelorde wiring', () => {
    expect(DIN_EDGE_PAIRS).toEqual([
      { from: 'clock', to: 'clock' },
      { from: 'midistart', to: 'start_in' },
      { from: 'midistop', to: 'stop_in' },
    ]);
  });

  it('assign writes the three gate edges with canonical ids', () => {
    const plan = planDinAssign([], mc, tl);
    expect(plan.deleteIds).toEqual([]);
    expect(plan.add.map((e) => e.id)).toEqual([
      dinEdgeId(mc, 'clock', tl, 'clock'),
      dinEdgeId(mc, 'midistart', tl, 'start_in'),
      dinEdgeId(mc, 'midistop', tl, 'stop_in'),
    ]);
    for (const e of plan.add) {
      expect(e.sourceType).toBe('gate');
      expect(e.targetType).toBe('gate');
      expect(e.source.nodeId).toBe(mc);
      expect(e.target.nodeId).toBe(tl);
    }
    // The canonical id format matches the canvas commit paths.
    expect(plan.add[0]!.id).toBe(`e-${mc}-clock-${tl}-clock`);
  });

  it('assign REPLACES whatever already feeds clock/start/stop (and only those)', () => {
    const existing = [
      edge('e-old-clock', ['someLfo', 'sq'], [tl, 'clock']),
      edge('e-old-start', ['pads', 'gate1'], [tl, 'start_in']),
      edge('e-unrelated', ['someLfo', 'sq'], [tl, 'gate']),
      edge('e-elsewhere', ['someLfo', 'sq'], ['vca-1', 'cv']),
    ];
    const plan = planDinAssign(existing, mc, tl);
    expect(plan.deleteIds.sort()).toEqual(['e-old-clock', 'e-old-start']);
  });

  it('unassign removes ONLY the bridge pairs, never a hand-patched cable', () => {
    const plan = planDinAssign([], mc, tl);
    const edges: SurfaceEdgeLike[] = [
      ...plan.add,
      // A hand-patched cable from another module into the wizard gate.
      edge('e-hand', ['someLfo', 'sq'], [tl, 'gate']),
      // A bridge edge to a DIFFERENT consumer (user patched midiclock.run).
      edge('e-run', [mc, 'run'], ['seq-1', 'play_cv']),
      // A bridge output into a NON-pair timelorde input.
      edge('e-mc-gate', [mc, 'clock'], [tl, 'gate']),
    ];
    expect(planDinUnassign(edges, mc, tl).sort()).toEqual(
      plan.add.map((e) => e.id).sort(),
    );
  });

  it('isDinAssigned keys on the clock pair specifically', () => {
    const clockEdge = edge(dinEdgeId(mc, 'clock', tl, 'clock'), [mc, 'clock'], [tl, 'clock']);
    const startOnly = edge(dinEdgeId(mc, 'midistart', tl, 'start_in'), [mc, 'midistart'], [tl, 'start_in']);
    expect(isDinAssigned([clockEdge], mc, tl)).toBe(true);
    expect(isDinAssigned([startOnly], mc, tl)).toBe(false);
    expect(isDinAssigned([edge('e', ['lfo', 'sq'], [tl, 'clock'])], mc, tl)).toBe(false);
    expect(isDinAssigned([clockEdge], mc, null)).toBe(false);
  });

  it('assign→unassign round-trips to zero bridge edges', () => {
    const plan = planDinAssign([], mc, tl);
    const deleteIds = planDinUnassign(plan.add, mc, tl);
    expect(deleteIds.sort()).toEqual(plan.add.map((e) => e.id).sort());
  });
});

describe('tapWithExternalGuard', () => {
  it('2-tap minimum: the first tap never writes a BPM', () => {
    const c = new TapTempo();
    expect(tapWithExternalGuard(c, 1000, false)).toBeNull();
    expect(tapWithExternalGuard(c, 1500, false)).toBe(120); // 500 ms interval
  });

  it('a >2s pause starts a fresh sequence (timeout reset through the guard)', () => {
    const c = new TapTempo();
    tapWithExternalGuard(c, 0, false);
    tapWithExternalGuard(c, 500, false);
    // Long gap: the next tap is a NEW first tap → null again.
    expect(tapWithExternalGuard(c, 10_000, false)).toBeNull();
    expect(tapWithExternalGuard(c, 10_250, false)).toBe(240); // 250 ms interval
  });

  it('disabled while externally clocked: no BPM AND the series is forgotten', () => {
    const c = new TapTempo();
    tapWithExternalGuard(c, 0, false);
    // External clock arrives mid-count → guard eats the tap + resets.
    expect(tapWithExternalGuard(c, 400, true)).toBeNull();
    expect(c.count).toBe(0);
    // Back to internal: the count restarts cleanly (2-tap minimum again).
    expect(tapWithExternalGuard(c, 1000, false)).toBeNull();
    expect(tapWithExternalGuard(c, 1400, false)).toBe(150); // 400 ms interval
  });
});
