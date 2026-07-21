// packages/web/src/lib/graph/cv-buddy-es9-reconcile.test.ts
//
// PURE unit coverage for the CV Buddy → ES-9 planner (planCvBuddyEs9). Plain
// object fixtures — no Yjs, no AudioContext. (Flake-check REPEAT=3 pre-MR.)

import { describe, it, expect } from 'vitest';
import { planCvBuddyEs9, type CvBuddyEs9Plan } from './cv-buddy-es9-reconcile';
import type { Edge } from '$lib/graph/types';
import { ES9_AUDIO, ES9_CV, ES9_PITCH, ES9_GATE } from '$lib/audio/cv-buddy/slot-alloc';

type NodeLike = { id?: string; type?: string; params?: Record<string, number> };

function es9(id = 'es9-1', params: Record<string, number> = {}): NodeLike {
  return { id, type: 'es9', params };
}
function cb(id: string): NodeLike {
  return { id, type: 'cvBuddy', params: {} };
}
function nodesOf(...ns: NodeLike[]): Record<string, NodeLike> {
  const out: Record<string, NodeLike> = {};
  for (const n of ns) out[n.id!] = n;
  return out;
}
function edgesOf(...es: Edge[]): Record<string, Edge> {
  const out: Record<string, Edge> = {};
  for (const e of es) out[e.id] = e;
  return out;
}
/** Reduce a plan's edgesToAdd to a comparable (src.port → target.port) map. */
function addedMap(plan: CvBuddyEs9Plan): Record<string, string> {
  const m: Record<string, string> = {};
  for (const e of plan.edgesToAdd) m[`${e.source.nodeId}.${e.source.portId}`] = e.target.portId;
  return m;
}
/** Reduce classSets to paramId → value. */
function classMap(plan: CvBuddyEs9Plan): Record<string, number> {
  const m: Record<string, number> = {};
  for (const c of plan.classSets) m[c.paramId] = c.value;
  return m;
}

describe('planCvBuddyEs9 — lazy ES-9 resolve', () => {
  it('is empty when no ES-9 exists (CV Buddy inert)', () => {
    const plan = planCvBuddyEs9(nodesOf(cb('cb-a')), {});
    expect(plan).toEqual({ edgesToAdd: [], edgeIdsToRemove: [], classSets: [] });
  });

  it('never force-creates an ES-9 (no es9 node in the output)', () => {
    const plan = planCvBuddyEs9(nodesOf(cb('cb-a')), {});
    expect(plan.classSets).toEqual([]); // nothing to write onto a non-existent ES-9
  });

  it('removes lingering cv-buddy edges when the ES-9 is gone', () => {
    const stale: Edge = {
      id: 'e-cvbuddy-cb-a-pitchCv',
      source: { nodeId: 'cb-a', portId: 'pitchCv' },
      target: { nodeId: 'es9-1', portId: 'out1' },
      sourceType: 'cv',
      targetType: 'audio',
    };
    const plan = planCvBuddyEs9(nodesOf(cb('cb-a')), edgesOf(stale));
    expect(plan.edgeIdsToRemove).toEqual(['e-cvbuddy-cb-a-pitchCv']);
    expect(plan.edgesToAdd).toEqual([]);
  });
});

describe('planCvBuddyEs9 — single instance (owner)', () => {
  const plan = planCvBuddyEs9(nodesOf(es9(), cb('cb-a')), {});

  it('wires all five outputs to jacks 1-3 + RUN 7 + CLOCK 8', () => {
    expect(addedMap(plan)).toEqual({
      'cb-a.pitchCv': 'out1',
      'cb-a.gate': 'out2',
      'cb-a.velCv': 'out3',
      'cb-a.run': 'out7',
      'cb-a.clock': 'out8',
    });
  });

  it('sets each driven jack\'s class (pitch/gate/cv + run/clock = gate)', () => {
    expect(classMap(plan)).toEqual({
      out1_class: ES9_PITCH,
      out2_class: ES9_GATE,
      out3_class: ES9_CV,
      out7_class: ES9_GATE,
      out8_class: ES9_GATE,
    });
  });

  it('gives edges the right cable types (cv/gate source → audio target)', () => {
    const pitch = plan.edgesToAdd.find((e) => e.source.portId === 'pitchCv')!;
    expect(pitch.sourceType).toBe('cv');
    expect(pitch.targetType).toBe('audio');
    const clock = plan.edgesToAdd.find((e) => e.source.portId === 'clock')!;
    expect(clock.sourceType).toBe('gate');
  });
});

describe('planCvBuddyEs9 — two instances', () => {
  const plan = planCvBuddyEs9(nodesOf(es9(), cb('cb-a'), cb('cb-b')), {});

  it('second instance takes jacks 4-6 and owns NO run/clock', () => {
    const m = addedMap(plan);
    expect(m['cb-b.pitchCv']).toBe('out4');
    expect(m['cb-b.gate']).toBe('out5');
    expect(m['cb-b.velCv']).toBe('out6');
    expect(m['cb-b.run']).toBeUndefined();
    expect(m['cb-b.clock']).toBeUndefined();
  });

  it('drives all eight jack classes', () => {
    expect(classMap(plan)).toEqual({
      out1_class: ES9_PITCH, out2_class: ES9_GATE, out3_class: ES9_CV,
      out4_class: ES9_PITCH, out5_class: ES9_GATE, out6_class: ES9_CV,
      out7_class: ES9_GATE, out8_class: ES9_GATE,
    });
  });

  it('id-sort is authoritative: cb-a (owner) drives run/clock regardless of node order', () => {
    const plan2 = planCvBuddyEs9(nodesOf(cb('cb-b'), es9(), cb('cb-a')), {});
    const m = addedMap(plan2);
    expect(m['cb-a.run']).toBe('out7');
    expect(m['cb-a.clock']).toBe('out8');
    expect(m['cb-b.run']).toBeUndefined();
  });
});

/** Build the fully-applied edge set + es9 params for a given CV Buddy set, so we
 *  can test idempotence + unclaim from a realistic "already reconciled" state. */
function apply(nodes: Record<string, NodeLike>): { edges: Record<string, Edge>; es9Params: Record<string, number> } {
  const plan = planCvBuddyEs9(nodes, {});
  const edges = edgesOf(...plan.edgesToAdd);
  const es9Params: Record<string, number> = {};
  for (const c of plan.classSets) es9Params[c.paramId] = c.value;
  return { edges, es9Params };
}

describe('planCvBuddyEs9 — idempotence', () => {
  it('a fully-reconciled graph yields an empty plan', () => {
    const two = nodesOf(es9(), cb('cb-a'), cb('cb-b'));
    const { edges, es9Params } = apply(two);
    const reconciled = nodesOf(es9('es9-1', es9Params), cb('cb-a'), cb('cb-b'));
    const plan = planCvBuddyEs9(reconciled, edges);
    expect(plan).toEqual({ edgesToAdd: [], edgeIdsToRemove: [], classSets: [] });
  });
});

describe('planCvBuddyEs9 — reset on unclaim', () => {
  it('removing the 2nd instance deletes its edges AND resets jacks 4-6 to audio', () => {
    // Applied state: two instances.
    const { edges, es9Params } = apply(nodesOf(es9(), cb('cb-a'), cb('cb-b')));
    // Now cb-b is gone (its edges still linger this reconcile tick).
    const after = nodesOf(es9('es9-1', es9Params), cb('cb-a'));
    const plan = planCvBuddyEs9(after, edges);
    expect(plan.edgeIdsToRemove.sort()).toEqual([
      'e-cvbuddy-cb-b-gate',
      'e-cvbuddy-cb-b-pitchCv',
      'e-cvbuddy-cb-b-velCv',
    ]);
    expect(classMap(plan)).toEqual({ out4_class: ES9_AUDIO, out5_class: ES9_AUDIO, out6_class: ES9_AUDIO });
  });

  it('cascade case: cb-b removed AND its edges already gone → jacks 4-6 still reset (owner remains active)', () => {
    // cb-b's edges cascaded away; only cb-a's edges remain, but the es9 still
    // carries cb-b's old non-audio classes on 4-6.
    const { edges: allEdges, es9Params } = apply(nodesOf(es9(), cb('cb-a'), cb('cb-b')));
    const onlyA: Record<string, Edge> = {};
    for (const [id, e] of Object.entries(allEdges)) if (id.includes('cb-a')) onlyA[id] = e;
    const after = nodesOf(es9('es9-1', es9Params), cb('cb-a'));
    const plan = planCvBuddyEs9(after, onlyA);
    expect(classMap(plan)).toEqual({ out4_class: ES9_AUDIO, out5_class: ES9_AUDIO, out6_class: ES9_AUDIO });
    expect(plan.edgeIdsToRemove).toEqual([]); // cb-b's edges already gone
  });

  it('owner removed → survivor inherits jacks 1-3 + RUN/CLOCK; only 4-6 reset', () => {
    // Applied: cb-a owner (1-3,7,8), cb-b (4-6). Remove cb-a; cb-b shifts up.
    const { edges, es9Params } = apply(nodesOf(es9(), cb('cb-a'), cb('cb-b')));
    // cb-a gone; keep cb-b's OLD edges (targeting 4-6) so the shift is visible.
    const survivorEdges: Record<string, Edge> = {};
    for (const [id, e] of Object.entries(edges)) if (id.includes('cb-b')) survivorEdges[id] = e;
    const after = nodesOf(es9('es9-1', es9Params), cb('cb-b'));
    const plan = planCvBuddyEs9(after, survivorEdges);
    // cb-b's edges retarget from 4-6 to 1-3 (+ new run7/clock8) — this is how the
    // survivor visibly INHERITS jacks 1-3 + RUN/CLOCK.
    const m = addedMap(plan);
    expect(m['cb-b.pitchCv']).toBe('out1');
    expect(m['cb-b.gate']).toBe('out2');
    expect(m['cb-b.velCv']).toBe('out3');
    expect(m['cb-b.run']).toBe('out7');
    expect(m['cb-b.clock']).toBe('out8');
    // Jacks 4-6 freed → reset to audio. Jacks 1-3/7/8 were ALREADY at their
    // (pitch/gate/cv/gate/gate) classes from the applied 2-instance state and are
    // re-claimed with the SAME class → no rewrite (idempotent), so they are
    // absent from classSets (NOT reset to audio).
    const classes = classMap(plan);
    expect(classes.out4_class).toBe(ES9_AUDIO);
    expect(classes.out5_class).toBe(ES9_AUDIO);
    expect(classes.out6_class).toBe(ES9_AUDIO);
    expect(classes.out1_class).toBeUndefined();
    expect(classes.out7_class).toBeUndefined();
    expect(classes.out8_class).toBeUndefined();
    // And NONE of the re-claimed jacks were reset to audio.
    for (const s of [1, 2, 3, 7, 8]) expect(classes[`out${s}_class`]).not.toBe(ES9_AUDIO);
  });
});
