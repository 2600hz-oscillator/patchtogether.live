// packages/web/src/lib/livecode/examples.test.ts
//
// Keeps the "Load example" snippets HONEST: every example must parse +
// run cleanly against the real runtime, and the owner's flagship
// re-quantizer must actually produce CHANGING, QUANTIZED notes when its
// clocked() body is re-fired tick-by-tick (exactly what the clockedRunner
// audio factory does at runtime).

import { describe, it, expect } from 'vitest';
import { run, type Mutation } from './runtime';
import type { ModuleNode, Edge, ModuleType } from '$lib/graph/types';
import { LIVECODE_EXAMPLES, FLAGSHIP_EXAMPLE_ID, getExampleById } from './examples';
// Populate the module registries (spawn() resolves real defs).
import '$lib/audio/modules';
import '$lib/video/modules';

type NodeMap = Record<string, ModuleNode>;
type EdgeMap = Record<string, Edge>;

/** Plain-object mirror of $lib/livecode/apply.applyMutation — applies a
 *  mutation to a non-store map so we can simulate runs in a unit test. */
function applyTo(nodes: NodeMap, edges: EdgeMap, mutations: readonly Mutation[]): void {
  for (const m of mutations) {
    if (m.kind === 'spawnNode') nodes[m.node.id] = m.node;
    else if (m.kind === 'addEdge') edges[m.edge.id] = m.edge;
    else if (m.kind === 'removeEdge') delete edges[m.edgeId];
    else if (m.kind === 'setParam') {
      const t = nodes[m.nodeId];
      if (t) { if (!t.params) t.params = {}; t.params[m.paramId] = m.value; }
    } else if (m.kind === 'setData') {
      const t = nodes[m.nodeId];
      if (t) { if (!t.data) t.data = {}; (t.data as Record<string, unknown>)[m.key] = m.value; }
    }
  }
}

function makeAllocator() {
  const counts: Record<string, number> = {};
  return (type: ModuleType) => {
    counts[type] = (counts[type] ?? 0) + 1;
    return `${String(type)}-${counts[type]}`;
  };
}

/** Every real rack ALWAYS has the singleton master TIMELORDE present — it's
 *  auto-dropped into any rack that opens without one and can't be deleted.
 *  Model that in the harness so clock.* ops (bpm/stop/start) resolve the
 *  ambient master clock, exactly as they do in the live app. */
function liveWithMasterClock(): NodeMap {
  return {
    tl1: { id: 'tl1', type: 'timelorde' as ModuleType, domain: 'audio', position: { x: 0, y: 0 }, params: {}, data: {} },
  };
}

describe('livecode examples — all run cleanly', () => {
  it('exposes a non-empty, uniquely-keyed set', () => {
    expect(LIVECODE_EXAMPLES.length).toBeGreaterThanOrEqual(3);
    const ids = LIVECODE_EXAMPLES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(getExampleById(FLAGSHIP_EXAMPLE_ID)).toBeDefined();
  });

  for (const ex of LIVECODE_EXAMPLES) {
    it(`example "${ex.id}" parses + runs without error`, () => {
      const result = run({
        src: ex.code,
        liveNodes: liveWithMasterClock(),
        liveEdges: {},
        ownerNodeId: 'lc1',
        allocateId: makeAllocator(),
      });
      if (!result.ok) {
        throw new Error(`example ${ex.id} failed: ${result.error.line}:${result.error.col} ${result.error.message}`);
      }
      expect(result.ok).toBe(true);
      // Every example wires at least one cable or sets at least one param.
      expect(result.mutations.length).toBeGreaterThan(0);
    });
  }
});

describe('flagship: re-quantizing sequence produces changing, quantized notes', () => {
  const SCALE_SETS: Record<string, ReadonlySet<number>> = {
    major: new Set([0, 2, 4, 5, 7, 9, 11]),
    minor: new Set([0, 2, 3, 5, 7, 8, 10]),
    pentatonic: new Set([0, 3, 5, 7, 10]),
    wholetone: new Set([0, 2, 4, 6, 8, 10]),
  };

  function setup() {
    const nodes: NodeMap = {
      // The owning LIVECODE card must exist so the clocked body's state.*
      // (beat counter / current scale) persists across ticks — it lives on
      // node.data.state of the ownerNodeId, mirroring the real app.
      lc1: { id: 'lc1', type: 'livecode' as ModuleType, domain: 'audio', position: { x: 0, y: 0 }, params: {}, data: {} },
    };
    const edges: EdgeMap = {};
    const alloc = makeAllocator();

    const flagship = getExampleById(FLAGSHIP_EXAMPLE_ID)!;
    const top = run({ src: flagship.code, liveNodes: nodes, liveEdges: edges, ownerNodeId: 'lc1', allocateId: alloc });
    expect(top.ok, top.ok ? '' : (top as { error: { message: string } }).error.message).toBe(true);
    applyTo(nodes, edges, top.mutations);
    return { nodes, edges };
  }

  function findSeqSteps(nodes: NodeMap): { on: boolean; midi: number }[] {
    const seq = Object.values(nodes).find((n) => n.type === 'sequencer');
    expect(seq, 'sequencer should be spawned').toBeDefined();
    return ((seq!.data as { steps?: { on: boolean; midi: number }[] }).steps) ?? [];
  }

  function findRunnerBody(nodes: NodeMap): { body: string; division: string } {
    const runner = Object.values(nodes).find((n) => n.type === 'clockedRunner');
    expect(runner, 'clockedRunner should be spawned by clocked()').toBeDefined();
    const d = runner!.data as { source?: string; division?: string };
    return { body: d.source ?? '', division: d.division ?? '' };
  }

  it('spawns the full voice + an immediate C-major melody on Run', () => {
    const { nodes } = setup();
    const types = Object.values(nodes).map((n) => n.type).sort();
    expect(types).toContain('sequencer');
    expect(types).toContain('analogVco');
    expect(types).toContain('adsr');
    expect(types).toContain('vca');
    expect(types).toContain('audioOut');
    expect(types).toContain('clockedRunner');

    const steps = findSeqSteps(nodes);
    expect(steps.length).toBe(8);
    expect(steps.map((s) => s.midi)).toEqual([48, 52, 55, 52, 57, 55, 52, 48]);
    expect(steps.every((s) => s.on)).toBe(true);
  });

  it('the clocked runner re-quantizes the melody scale every 4 beats', () => {
    const { nodes, edges } = setup();
    const { body, division } = findRunnerBody(nodes);
    expect(division).toBe('1');
    expect(body).toContain('SCALES');
    expect(body).toContain('setData');
    expect(body).toContain('state.set');

    // Simulate 17 division-'1' ticks (the audio clockedRunner re-runs the
    // body each tick via the same runtime).
    const scaleAtBeat: string[] = [];
    const melodyAtBeat: number[][] = [];
    for (let tick = 0; tick < 17; tick++) {
      const r = run({ src: body, liveNodes: nodes, liveEdges: edges, ownerNodeId: 'lc1' });
      expect(r.ok, r.ok ? '' : (r as { error: { message: string } }).error.message).toBe(true);
      applyTo(nodes, edges, r.mutations);
      const lc = nodes.lc1!.data as { state?: { beat?: number; scale?: string } };
      scaleAtBeat.push(lc.state?.scale ?? '?');
      melodyAtBeat.push(findSeqSteps(nodes).map((s) => s.midi));
      expect(lc.state?.beat).toBe(tick + 1); // counter advances each tick
    }

    // Scale rotates major (beats 1-4) → minor (5-8) → pentatonic (9-12) →
    // whole-tone (13-16) → major (17).
    expect(scaleAtBeat[0]).toBe('major');
    expect(scaleAtBeat[4]).toBe('minor');
    expect(scaleAtBeat[8]).toBe('pentatonic');
    expect(scaleAtBeat[12]).toBe('wholetone');
    expect(scaleAtBeat[16]).toBe('major');

    // The notes ACTUALLY CHANGE between scales (not just the label).
    const majorMelody = melodyAtBeat[0]!;
    const minorMelody = melodyAtBeat[4]!;
    const pentMelody = melodyAtBeat[8]!;
    expect(minorMelody).not.toEqual(majorMelody);
    expect(pentMelody).not.toEqual(minorMelody);

    // Every emitted note is QUANTIZED to the current scale (pitch class in
    // the scale's set), at every beat.
    for (let beat = 1; beat <= 17; beat++) {
      const scaleName = scaleAtBeat[beat - 1]!;
      const set = SCALE_SETS[scaleName];
      expect(set, `unknown scale ${scaleName}`).toBeDefined();
      for (const midi of melodyAtBeat[beat - 1]!) {
        expect(set!.has(((midi % 12) + 12) % 12), `midi ${midi} not in ${scaleName}`).toBe(true);
      }
    }
  });
});
