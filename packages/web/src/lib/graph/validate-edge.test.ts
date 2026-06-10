// packages/web/src/lib/graph/validate-edge.test.ts
//
// Unit tests for the FW3 pure edge/graph validator (Phase 3b). Every branch
// of validateEdge and validateGraphFragment is exercised with small fake defs
// and a fake resolveDef — no registry, no Svelte, no Yjs.

import { describe, it, expect } from 'vitest';
import {
  validateEdge,
  validateGraphFragment,
  type ValidatorDef,
  type ResolveDef,
} from './validate-edge';
import type { GroupData } from './group-projection';
import type { ModuleNode, Edge, CableType } from './types';

// ---- fixtures -------------------------------------------------------------

function n(id: string, type = 'analogVco', data?: Record<string, unknown>): ModuleNode {
  return {
    id,
    type,
    domain: type === 'group' ? 'meta' : 'audio',
    position: { x: 0, y: 0 },
    params: {},
    data,
  };
}

function e(
  id: string,
  srcN: string,
  srcP: string,
  dstN: string,
  dstP: string,
  sourceType: CableType = 'audio',
  targetType: CableType = 'audio',
): Edge {
  return {
    id,
    source: { nodeId: srcN, portId: srcP },
    target: { nodeId: dstN, portId: dstP },
    sourceType,
    targetType,
  };
}

// Fake def table. `osc` emits an audio output; `filter` takes an audio input +
// a cv input and emits audio; `videoOut` takes a video input.
const DEFS: Record<string, ValidatorDef> = {
  osc: {
    inputs: [],
    outputs: [{ id: 'out', type: 'audio' }],
  },
  filter: {
    inputs: [
      { id: 'in', type: 'audio' },
      { id: 'cutoff', type: 'cv' },
    ],
    outputs: [{ id: 'out', type: 'audio' }],
  },
  videoOut: {
    inputs: [{ id: 'in', type: 'video' }],
    outputs: [],
  },
  // `lfo` emits a cv output; `scope` has an audio probe input that `accepts` the
  // CV family (the SCOPE per-port widening — visualize LFOs/envelopes/gates).
  lfo: {
    inputs: [],
    outputs: [{ id: 'out', type: 'cv' }],
  },
  scope: {
    inputs: [{ id: 'ch1', type: 'audio', accepts: ['cv', 'pitch', 'gate'] }],
    outputs: [],
  },
};

const resolveDef: ResolveDef = (type) => DEFS[type];

// ---- validateEdge ---------------------------------------------------------

describe('validateEdge', () => {
  it('rejects a missing SOURCE node', () => {
    const nodes = [n('flt', 'filter')];
    const res = validateEdge(e('x', 'ghost', 'out', 'flt', 'in'), nodes, resolveDef);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/source node ghost not found/);
  });

  it('rejects a missing TARGET node', () => {
    const nodes = [n('osc', 'osc')];
    const res = validateEdge(e('x', 'osc', 'out', 'ghost', 'in'), nodes, resolveDef);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/target node ghost not found/);
  });

  it('rejects using an OUTPUT port as the target (output-as-target)', () => {
    // filter.out is an output, not an input — using it as a target must fail.
    const nodes = [n('osc', 'osc'), n('flt', 'filter')];
    const res = validateEdge(e('x', 'osc', 'out', 'flt', 'out'), nodes, resolveDef);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/not a declared input port/);
  });

  it('rejects using an INPUT port as the source (input-as-source)', () => {
    // filter.in is an input, not an output — using it as a source must fail.
    const nodes = [n('flt', 'filter'), n('flt2', 'filter')];
    const res = validateEdge(e('x', 'flt', 'in', 'flt2', 'in'), nodes, resolveDef);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/not a declared output port/);
  });

  it('rejects an unresolved source port (not on the def)', () => {
    const nodes = [n('osc', 'osc'), n('flt', 'filter')];
    const res = validateEdge(e('x', 'osc', 'nope', 'flt', 'in'), nodes, resolveDef);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/not a declared output port/);
  });

  it('rejects an unresolved target port (not on the def)', () => {
    const nodes = [n('osc', 'osc'), n('flt', 'filter')];
    const res = validateEdge(e('x', 'osc', 'out', 'flt', 'nope'), nodes, resolveDef);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/not a declared input port/);
  });

  it('rejects incompatible domains via canConnect (audio → video)', () => {
    const nodes = [n('osc', 'osc'), n('vid', 'videoOut')];
    const res = validateEdge(e('x', 'osc', 'out', 'vid', 'in'), nodes, resolveDef);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/incompatible cable types audio → video/);
  });

  it('derives cable types from the resolved PORTS, ignoring a spoofed edge.sourceType', () => {
    // Edge claims cv→cv (which canConnect would accept among the CV family),
    // but the real ports are audio.out → video.in, which must be rejected.
    const nodes = [n('osc', 'osc'), n('vid', 'videoOut')];
    const res = validateEdge(e('x', 'osc', 'out', 'vid', 'in', 'cv', 'cv'), nodes, resolveDef);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/incompatible cable types audio → video/);
  });

  it('accepts a valid audio → audio edge', () => {
    const nodes = [n('osc', 'osc'), n('flt', 'filter')];
    const res = validateEdge(e('x', 'osc', 'out', 'flt', 'in'), nodes, resolveDef);
    expect(res.ok).toBe(true);
    expect(res.reason).toBeUndefined();
  });

  it('accepts cv → SCOPE probe (per-port `accepts` widening on an audio input)', () => {
    // Regression: after FW3 wired validateEdge into the drag path, cv→scope was
    // rejected (canConnect blocks cv→audio). The scope probe opts in via accepts.
    const nodes = [n('lfo', 'lfo'), n('scp', 'scope')];
    const res = validateEdge(e('x', 'lfo', 'out', 'scp', 'ch1', 'cv', 'audio'), nodes, resolveDef);
    expect(res.ok).toBe(true);
    expect(res.reason).toBeUndefined();
  });

  it('still rejects cv → a PLAIN audio input (the global guard is intact)', () => {
    // filter.in is audio with NO accepts → cv→audio stays rejected (only the
    // scope probe opted in, not every audio input).
    const nodes = [n('lfo', 'lfo'), n('flt', 'filter')];
    const res = validateEdge(e('x', 'lfo', 'out', 'flt', 'in', 'cv', 'audio'), nodes, resolveDef);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/incompatible cable types cv → audio/);
  });

  it('accepts a valid audio → cv edge (CV-family upcast on filter.cutoff)', () => {
    // osc.out (audio) into filter.cutoff (cv) — NOT permitted: audio→cv is
    // rejected by canConnect (only modsignal accepts audio). Use a cv source.
    const cvDef: ValidatorDef = { inputs: [], outputs: [{ id: 'out', type: 'cv' }] };
    const localResolve: ResolveDef = (t) => (t === 'lfo' ? cvDef : DEFS[t]);
    const nodes = [n('lfo', 'lfo'), n('flt', 'filter')];
    const res = validateEdge(e('x', 'lfo', 'out', 'flt', 'cutoff'), nodes, localResolve);
    expect(res.ok).toBe(true);
  });

  describe('group exposed ports (resolved FIRST, mirroring handleConnect)', () => {
    const groupData: GroupData = {
      childIds: ['flt-1'],
      exposedPorts: [
        { id: 'OUT--AUDIO', childId: 'flt-1', childPortId: 'out', direction: 'output', cableType: 'audio' },
        { id: 'IN--CV', childId: 'flt-1', childPortId: 'cutoff', direction: 'input', cableType: 'cv' },
        { id: 'IN--VIDEO', childId: 'vid-1', childPortId: 'in', direction: 'input', cableType: 'video' },
      ],
    };

    it('accepts a cable from a group exposed OUTPUT port to a real input', () => {
      const nodes = [
        n('g-1', 'group', groupData as unknown as Record<string, unknown>),
        n('flt', 'filter'),
      ];
      const res = validateEdge(e('x', 'g-1', 'OUT--AUDIO', 'flt', 'in'), nodes, resolveDef);
      expect(res.ok).toBe(true);
    });

    it('accepts a cable from a real output to a group exposed INPUT port', () => {
      const nodes = [
        n('osc', 'osc'),
        n('g-1', 'group', groupData as unknown as Record<string, unknown>),
      ];
      // osc.out (audio) → group IN--CV (cv): canConnect rejects audio→cv, so
      // use a cv source to prove the group input resolves + type-checks.
      const cvDef: ValidatorDef = { inputs: [], outputs: [{ id: 'out', type: 'cv' }] };
      const localResolve: ResolveDef = (t) => (t === 'lfo' ? cvDef : DEFS[t]);
      const lfoNodes = [
        n('lfo', 'lfo'),
        n('g-1', 'group', groupData as unknown as Record<string, unknown>),
      ];
      const res = validateEdge(e('x', 'lfo', 'out', 'g-1', 'IN--CV'), lfoNodes, localResolve);
      expect(res.ok).toBe(true);
      // sanity: the audio source variant IS rejected by type-compat
      const bad = validateEdge(e('y', 'osc', 'out', 'g-1', 'IN--CV'), nodes, resolveDef);
      expect(bad.ok).toBe(false);
    });

    it('rejects using a group exposed INPUT port as a SOURCE (direction)', () => {
      const nodes = [
        n('g-1', 'group', groupData as unknown as Record<string, unknown>),
        n('flt', 'filter'),
      ];
      const res = validateEdge(e('x', 'g-1', 'IN--CV', 'flt', 'in'), nodes, resolveDef);
      expect(res.ok).toBe(false);
      expect(res.reason).toMatch(/not a declared output port/);
    });

    it('rejects an unknown group exposed handle id', () => {
      const nodes = [
        n('g-1', 'group', groupData as unknown as Record<string, unknown>),
        n('flt', 'filter'),
      ];
      const res = validateEdge(e('x', 'g-1', 'NO--SUCH--PORT', 'flt', 'in'), nodes, resolveDef);
      expect(res.ok).toBe(false);
      expect(res.reason).toMatch(/not a declared output port/);
    });
  });
});

// ---- validateGraphFragment ------------------------------------------------

describe('validateGraphFragment', () => {
  it('drops the bad edge + keeps the rest', () => {
    const nodes = [n('osc', 'osc'), n('flt', 'filter'), n('vid', 'videoOut')];
    const edges = [
      e('good', 'osc', 'out', 'flt', 'in'), // valid audio→audio
      e('bad', 'osc', 'out', 'vid', 'in'), // audio→video, incompatible
    ];
    const res = validateGraphFragment({ nodes, edges }, resolveDef);
    expect(res.validEdges.map((x) => x.id)).toEqual(['good']);
    expect(res.droppedEdges).toHaveLength(1);
    expect(res.droppedEdges[0].edge.id).toBe('bad');
    expect(res.droppedEdges[0].reason).toMatch(/incompatible/);
    expect(res.droppedNodes).toHaveLength(0);
  });

  it('drops a node of an unregistered type', () => {
    const nodes = [n('osc', 'osc'), n('mystery', 'notARealModule')];
    const res = validateGraphFragment({ nodes, edges: [] }, resolveDef);
    expect(res.droppedNodes).toHaveLength(1);
    expect(res.droppedNodes[0].node.id).toBe('mystery');
    expect(res.droppedNodes[0].reason).toMatch(/not registered/);
  });

  it('drops an edge touching a dropped (unregistered) node', () => {
    const nodes = [n('osc', 'osc'), n('mystery', 'notARealModule')];
    const edges = [e('e1', 'mystery', 'out', 'osc', 'in')];
    const res = validateGraphFragment({ nodes, edges }, resolveDef);
    expect(res.droppedNodes.map((x) => x.node.id)).toEqual(['mystery']);
    expect(res.validEdges).toHaveLength(0);
    expect(res.droppedEdges).toHaveLength(1);
    expect(res.droppedEdges[0].edge.id).toBe('e1');
  });

  it('keeps group nodes (no module def required) and validates cables to them', () => {
    const groupData: GroupData = {
      childIds: ['flt-1'],
      exposedPorts: [
        { id: 'OUT--AUDIO', childId: 'flt-1', childPortId: 'out', direction: 'output', cableType: 'audio' },
      ],
    };
    const nodes = [
      n('g-1', 'group', groupData as unknown as Record<string, unknown>),
      n('flt', 'filter'),
    ];
    const edges = [e('e1', 'g-1', 'OUT--AUDIO', 'flt', 'in')];
    const res = validateGraphFragment({ nodes, edges }, resolveDef);
    expect(res.droppedNodes).toHaveLength(0);
    expect(res.validEdges.map((x) => x.id)).toEqual(['e1']);
  });
});
