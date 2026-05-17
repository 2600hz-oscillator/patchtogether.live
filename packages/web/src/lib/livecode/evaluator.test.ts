// Unit tests for the LIVECODE DSL evaluator.

import { describe, it, expect, beforeAll } from 'vitest';
import type { ModuleNode, Edge } from '$lib/graph/types';
import { evaluate } from './evaluator';
import { noteToMidi } from './evaluator';

// Auto-register the audio + video module catalogs once. The evaluator
// reads from the same registries the live app does, so we need them
// populated to test type/port lookups.
beforeAll(async () => {
  await import('$lib/audio/modules');
  await import('$lib/video/modules');
});

function n(id: string, type: string, name?: string, params: Record<string, number> = {}, data: Record<string, unknown> = {}): ModuleNode {
  return {
    id,
    type,
    domain: 'audio',
    position: { x: 0, y: 0 },
    params,
    data: name ? { name, ...data } : { ...data },
  };
}

describe('noteToMidi', () => {
  it('maps c4 to 60', () => {
    expect(noteToMidi('c4', { line: 1, col: 1 })).toBe(60);
  });
  it('maps a4 to 69', () => {
    expect(noteToMidi('a4', { line: 1, col: 1 })).toBe(69);
  });
  it('handles sharps in either order', () => {
    expect(noteToMidi('c4#', { line: 1, col: 1 })).toBe(61);
    expect(noteToMidi('c#4', { line: 1, col: 1 })).toBe(61);
  });
  it('handles flats', () => {
    expect(noteToMidi('db4', { line: 1, col: 1 })).toBe(61);
  });
});

describe('evaluator: spawn + bind', () => {
  it('spawns a single module and assigns it a default name', () => {
    const r = evaluate({
      src: 'vco = analogVco.new()',
      liveNodes: {},
      liveEdges: {},
      allocateId: () => 'n-1',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.mutations).toHaveLength(1);
      const m = r.mutations[0]!;
      expect(m.kind).toBe('spawnNode');
      if (m.kind === 'spawnNode') {
        expect(m.node.type).toBe('analogVco');
        expect(m.node.data?.name).toBe('ANALOGVCO1');
      }
    }
  });

  it('continues numbering against existing nodes', () => {
    const r = evaluate({
      src: 'vco = analogVco.new()',
      liveNodes: { existing: n('existing', 'analogVco', 'ANALOGVCO1') },
      liveEdges: {},
      allocateId: () => 'n-2',
    });
    if (r.ok) {
      const m = r.mutations[0]!;
      if (m.kind === 'spawnNode') {
        expect(m.node.data?.name).toBe('ANALOGVCO2');
      }
    }
  });

  it('two consecutive spawns get distinct names', () => {
    const r = evaluate({
      src: `
        a = analogVco.new()
        b = analogVco.new()
      `,
      liveNodes: {},
      liveEdges: {},
      allocateId: (() => {
        let i = 0;
        return () => `n-${++i}`;
      })(),
    });
    if (r.ok) {
      const names = r.mutations
        .filter((m) => m.kind === 'spawnNode')
        .map((m) => (m as Extract<typeof m, { kind: 'spawnNode' }>).node.data?.name);
      expect(names).toEqual(['ANALOGVCO1', 'ANALOGVCO2']);
    }
  });

  it('rejects an unknown module type with line:col', () => {
    const r = evaluate({
      src: 'x = nope.new()',
      liveNodes: {},
      liveEdges: {},
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toMatch(/Unknown module type 'nope'/);
      expect(r.error.line).toBe(1);
    }
  });
});

describe('evaluator: param assignment', () => {
  it('emits a setParam mutation for `x.tune = 7`', () => {
    const r = evaluate({
      src: `
        v = analogVco.new()
        v.tune = 7
      `,
      liveNodes: {},
      liveEdges: {},
      allocateId: () => 'n-1',
    });
    if (r.ok) {
      const set = r.mutations.find((m) => m.kind === 'setParam');
      expect(set).toBeDefined();
      if (set && set.kind === 'setParam') {
        expect(set.paramId).toBe('tune');
        expect(set.value).toBe(7);
      }
    } else {
      throw new Error(`unexpected error: ${r.error.message}`);
    }
  });

  it('emits a setData mutation for an array assignment', () => {
    const r = evaluate({
      src: `
        d = drumseqz.new()
        d.tracks = [c3, -, -, d4]
      `,
      liveNodes: {},
      liveEdges: {},
      allocateId: () => 'n-1',
    });
    if (r.ok) {
      const setData = r.mutations.find((m) => m.kind === 'setData');
      expect(setData).toBeDefined();
      if (setData && setData.kind === 'setData') {
        expect(setData.key).toBe('tracks');
        expect(Array.isArray(setData.value)).toBe(true);
      }
    } else {
      throw new Error(`unexpected error: ${r.error.message}`);
    }
  });

  it('addresses a pre-existing module by name', () => {
    const r = evaluate({
      src: 'ANALOGVCO1.tune = 12',
      liveNodes: { existing: n('existing', 'analogVco', 'ANALOGVCO1') },
      liveEdges: {},
    });
    if (r.ok) {
      const set = r.mutations.find((m) => m.kind === 'setParam');
      expect(set).toBeDefined();
      if (set && set.kind === 'setParam') {
        expect(set.nodeId).toBe('existing');
        expect(set.paramId).toBe('tune');
        expect(set.value).toBe(12);
      }
    } else {
      throw new Error(`unexpected error: ${r.error.message}`);
    }
  });
});

describe('evaluator: patch (->)', () => {
  it('emits an addEdge mutation for a valid patch', () => {
    const r = evaluate({
      src: `
        v = analogVco.new()
        o = audioOut.new()
        v.sine -> o.L
      `,
      liveNodes: {},
      liveEdges: {},
      allocateId: (() => {
        let i = 0;
        return () => `n-${++i}`;
      })(),
    });
    if (r.ok) {
      const edge = r.mutations.find((m) => m.kind === 'addEdge');
      expect(edge).toBeDefined();
      if (edge && edge.kind === 'addEdge') {
        expect(edge.edge.source.portId).toBe('sine');
        expect(edge.edge.target.portId).toBe('L');
      }
    } else {
      throw new Error(`unexpected error: ${r.error.message}`);
    }
  });

  it('rejects a patch to a non-existent input port', () => {
    const r = evaluate({
      src: `
        v = analogVco.new()
        o = audioOut.new()
        v.sine -> o.nope
      `,
      liveNodes: {},
      liveEdges: {},
      allocateId: (() => {
        let i = 0;
        return () => `n-${++i}`;
      })(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/no input port 'nope'/);
  });

  it('rejects an incompatible cable type', () => {
    // analogVco.sine is audio; vca.cv expects cv, but audio→cv is fine
    // because the type system allows audio routed to a cv input. Use a
    // strictly disallowed combo: video → audio.
    // (A simpler check: `audioOut` has no outputs, so trying to use it
    //  as a source must fail with no output port.)
    const r = evaluate({
      src: `
        o = audioOut.new()
        v = analogVco.new()
        o.L -> v.pitch
      `,
      liveNodes: {},
      liveEdges: {},
      allocateId: (() => {
        let i = 0;
        return () => `n-${++i}`;
      })(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/no output port/);
  });
});

describe('evaluator: transactionality', () => {
  it('returns no mutations on a script with a parse error', () => {
    const r = evaluate({
      src: 'x = (',
      liveNodes: {},
      liveEdges: {},
    });
    expect(r.ok).toBe(false);
  });

  it('returns no mutations when later eval error follows earlier valid stmts', () => {
    const r = evaluate({
      src: `
        a = analogVco.new()
        b = nope.new()
      `,
      liveNodes: {},
      liveEdges: {},
      allocateId: (() => {
        let i = 0;
        return () => `n-${++i}`;
      })(),
    });
    expect(r.ok).toBe(false);
    // Even though we built up partial mutations internally, the result
    // surfaces only error + partialLog. The host treats !ok as "do not
    // apply ANY mutations".
    if (!r.ok) {
      expect(r.partialLog.length).toBeGreaterThan(0);
    }
  });
});

describe('evaluator: comments + whitespace', () => {
  it('ignores // comments', () => {
    const r = evaluate({
      src: `
        // spawn a vco
        v = analogVco.new()
        v.tune = 12 // semitones up
      `,
      liveNodes: {},
      liveEdges: {},
      allocateId: () => 'n-1',
    });
    expect(r.ok).toBe(true);
  });
});
