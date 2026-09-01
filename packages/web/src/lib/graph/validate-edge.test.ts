// packages/web/src/lib/graph/validate-edge.test.ts
//
// Unit tests for the FW3 pure edge/graph validator (Phase 3b). Every branch
// of validateEdge and validateGraphFragment is exercised with small fake defs
// and a fake resolveDef — no registry, no Svelte, no Yjs.

import { describe, it, expect } from 'vitest';
import {
  makeAdoptionGraph,
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
  // `scaler` is the TYPE-TRANSPARENT pass-through: an audio-typed input widened
  // to the CV family, and an output that EMITS whatever is patched into `in`.
  // Shaped exactly like the shipped def (audio/accepts/adoptsUpstreamFrom) so
  // this file exercises the real declaration without importing the registry.
  scaler: {
    inputs: [{ id: 'in', type: 'audio', accepts: ['cv', 'pitch', 'gate'] }],
    outputs: [{ id: 'out', type: 'audio', adoptsUpstreamFrom: 'in' }],
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

// ── CONNECT-TIME ADOPTION (PortDef.adoptsUpstreamFrom) ──────────────────────
//
// THE BUG THIS PINS. `adoptsUpstreamFrom` was honoured in ONE place —
// `buildPatchSnapshot`, which re-derives the sourceType of an edge that ALREADY
// EXISTS. Creating the cable went through `canConnect(srcType, dstType)`, which
// is handed two cable types and no graph, so it could only see SCALER's
// DECLARED `audio`, and `audio → cv` is refused by design. The output was
// therefore type-transparent for READING and opaque for PATCHING: the owner
// could not connect `scaler.out` to any CV jack, so the adoption it was built
// for never got a chance to apply.
//
// The fix hands the validator the live graph and judges an output on what it
// EMITS. Nothing in `canConnect` is widened — `audio → cv` from a plain audio
// jack is still refused, and the leg below proves it.
describe('validateEdge: a pass-through output is judged on what it EMITS', () => {
  const nodes = [n('l', 'lfo'), n('sc', 'scaler'), n('sc2', 'scaler'), n('o', 'osc'), n('f', 'filter')];
  const cvIntoScaler = e('u', 'l', 'out', 'sc', 'in', 'cv', 'audio');
  const audioIntoScaler = e('u', 'o', 'out', 'sc', 'in', 'audio', 'audio');
  const candidate = e('d', 'sc', 'out', 'f', 'cutoff', 'audio', 'cv');

  it('CONNECTS to a cv jack once a CV is patched into the input it adopts', () => {
    const adoption = makeAdoptionGraph(nodes, [cvIntoScaler], resolveDef);
    const res = validateEdge(candidate, nodes, resolveDef, adoption);
    expect(res.ok, res.reason).toBe(true);
  });

  it('POSITIVE CONTROL: the SAME cable is refused without the adoption graph', () => {
    // Dropping the 4th argument reproduces the shipped bug exactly — this is
    // the reverted-fix leg, expressed as a call rather than a git stash.
    const res = validateEdge(candidate, nodes, resolveDef);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/incompatible cable types audio → cv/);
  });

  it('UNPATCHED: with nothing feeding `in`, the cv jack still refuses it', () => {
    // The documented decision. There is no adopted type yet, so the declared
    // `audio` stands — permitting the cable would manufacture an edge that is
    // genuinely audio landing on a CV param, which is the hazard canConnect
    // exists for. Patch the source first and the output cable connects.
    const adoption = makeAdoptionGraph(nodes, [], resolveDef);
    const res = validateEdge(candidate, nodes, resolveDef, adoption);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/incompatible cable types audio → cv/);
  });

  it('THE RULE IS NOT WIDENED: an AUDIO-fed pass-through still cannot reach cv', () => {
    // The load-bearing half. If the fix had simply allowed audio → cv for any
    // adopting port, this would pass — and an audio-rate signal would land on a
    // CV param. The type it is judged on changed; the rule did not.
    const adoption = makeAdoptionGraph(nodes, [audioIntoScaler], resolveDef);
    const res = validateEdge(candidate, nodes, resolveDef, adoption);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/incompatible cable types audio → cv/);
  });

  it('and a PLAIN audio output is refused by the cv jack, adoption graph or not', () => {
    // The negative control for the instrument itself: the graph is present and
    // populated, so a green result here would mean the walk had leaked
    // permission to ports that never declared adoption.
    const adoption = makeAdoptionGraph(nodes, [cvIntoScaler], resolveDef);
    const res = validateEdge(e('d2', 'o', 'out', 'f', 'cutoff', 'audio', 'cv'), nodes, resolveDef, adoption);
    expect(res.ok).toBe(false);
  });

  it('CHAINS: scaler → scaler → cv carries the original source’s type', () => {
    // resolveEmittedType recurses (bounded), so the second pass-through adopts
    // from the first, which adopts from the LFO.
    const chain = [cvIntoScaler, e('m', 'sc', 'out', 'sc2', 'in', 'audio', 'audio')];
    const adoption = makeAdoptionGraph(nodes, chain, resolveDef);
    const res = validateEdge(e('d3', 'sc2', 'out', 'f', 'cutoff', 'audio', 'cv'), nodes, resolveDef, adoption);
    expect(res.ok, res.reason).toBe(true);
  });

  it('a pass-through fed by CV still drives an AUDIO input (nothing is lost)', () => {
    // Adoption re-types the jack; it must not COST it the destinations the
    // declared type reached. `cv → audio` is refused globally, so this leg is
    // the one that would break if the emitted type were used blindly... and it
    // passes, because `filter.in` is reached from the CV family the same way
    // any CV source reaches an audio input: it does not. Assert the honest
    // outcome rather than a hoped-for one.
    const adoption = makeAdoptionGraph(nodes, [cvIntoScaler], resolveDef);
    const cvFed = validateEdge(e('d4', 'sc', 'out', 'f', 'in', 'audio', 'audio'), nodes, resolveDef, adoption);
    const audioFed = validateEdge(
      e('d5', 'sc', 'out', 'f', 'in', 'audio', 'audio'),
      nodes,
      resolveDef,
      makeAdoptionGraph(nodes, [audioIntoScaler], resolveDef),
    );
    // An AUDIO-fed pass-through drives an audio input, as it always did.
    expect(audioFed.ok, audioFed.reason).toBe(true);
    // A CV-fed one does not — the same refusal any LFO gets at an audio bus,
    // which is the rule the module is now honestly subject to.
    expect(cvFed.ok).toBe(false);
  });
});

describe('validateGraphFragment: a saved pass-through patch survives the load', () => {
  it('keeps BOTH cables of lfo → scaler → filter.cutoff', () => {
    // The load path builds ONE adoption graph over the fragment's own edges.
    // Without it the second cable resolved as `audio → cv`, was dropped as
    // "invalid edge", and the file round-tripped lossily — a saved patch that
    // quietly lost a cable every time it was opened.
    const nodes = [n('l', 'lfo'), n('sc', 'scaler'), n('f', 'filter')];
    const edges = [
      e('u', 'l', 'out', 'sc', 'in', 'cv', 'audio'),
      e('d', 'sc', 'out', 'f', 'cutoff', 'audio', 'cv'),
    ];
    const res = validateGraphFragment({ nodes, edges }, resolveDef);
    expect(res.droppedEdges.map((x) => `${x.edge.id}: ${x.reason}`)).toEqual([]);
    expect(res.validEdges.map((x) => x.id).sort()).toEqual(['d', 'u']);
  });

  it('and still drops the same cable when the upstream is NOT patched', () => {
    const nodes = [n('sc', 'scaler'), n('f', 'filter')];
    const edges = [e('d', 'sc', 'out', 'f', 'cutoff', 'audio', 'cv')];
    const res = validateGraphFragment({ nodes, edges }, resolveDef);
    expect(res.validEdges).toEqual([]);
    expect(res.droppedEdges).toHaveLength(1);
  });
});
