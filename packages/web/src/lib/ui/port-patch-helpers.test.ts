// port-patch-helpers.test.ts
//
// Pure-function coverage for the cascading "Patch to..." menu helpers.
// canConnect's audio-vs-video-vs-cv branches are all exercised here so
// the e2e suite doesn't have to enumerate type-compat combinations.

import { describe, expect, it } from 'vitest';
import type { Edge, ModuleNode } from '$lib/graph/types';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import {
  buildModuleEntries,
  compatibleTargetPorts,
  moduleDisplayName,
  type AnyDef,
} from './port-patch-helpers';

const lfoDef: AudioModuleDef = {
  type: 'lfo',
  domain: 'audio',
  label: 'LFO',
  category: 'modulation',
  schemaVersion: 1,
  inputs: [
    { id: 'clock', type: 'gate' },
    { id: 'rate', type: 'cv' },
    { id: 'shape', type: 'cv' },
  ],
  outputs: [
    { id: 'phase0', type: 'cv' },
    { id: 'phase90', type: 'cv' },
    { id: 'phase180', type: 'cv' },
    { id: 'phase270', type: 'cv' },
  ],
  params: [],
  // factory is not exercised by these pure-function tests.
  factory: (() => undefined) as unknown as AudioModuleDef['factory'],
};

const filterDef: AudioModuleDef = {
  type: 'filter',
  domain: 'audio',
  label: 'Filter',
  category: 'filters',
  schemaVersion: 1,
  inputs: [
    { id: 'audio', type: 'audio' },
    { id: 'cutoff', type: 'cv' },
    { id: 'res', type: 'cv' },
  ],
  outputs: [{ id: 'audio', type: 'audio' }],
  params: [],
  factory: (() => undefined) as unknown as AudioModuleDef['factory'],
};

const audioOutDef: AudioModuleDef = {
  type: 'audioOut',
  domain: 'audio',
  label: 'Audio Out',
  category: 'output',
  schemaVersion: 1,
  inputs: [
    { id: 'L', type: 'audio' },
    { id: 'R', type: 'audio' },
  ],
  outputs: [],
  params: [],
  factory: (() => undefined) as unknown as AudioModuleDef['factory'],
};

const linesDef: AudioModuleDef = {
  // Treated as AnyDef for the helper; domain field doesn't affect the helper.
  type: 'lines',
  domain: 'audio',
  label: 'LINES',
  category: 'sources',
  schemaVersion: 1,
  inputs: [
    { id: 'fm', type: 'mono-video' },
    { id: 'orient', type: 'cv' },
  ],
  outputs: [{ id: 'out', type: 'mono-video' }],
  params: [],
  factory: (() => undefined) as unknown as AudioModuleDef['factory'],
};

function defs(map: Record<string, AnyDef>): (t: string) => AnyDef | undefined {
  return (t) => map[t];
}

function makeNode(id: string, type: string): ModuleNode {
  return { id, type, domain: 'audio', position: { x: 0, y: 0 }, params: {} };
}

describe('buildModuleEntries', () => {
  it('excludes the source node and labels singletons by their type label', () => {
    const nodes: Record<string, ModuleNode> = {
      lfo1: makeNode('lfo1', 'lfo'),
      filter1: makeNode('filter1', 'filter'),
    };
    const out = buildModuleEntries(nodes, defs({ lfo: lfoDef, filter: filterDef }), 'lfo1');
    expect(out).toEqual([
      { nodeId: 'filter1', displayName: 'Filter', typeLabel: 'Filter' },
    ]);
  });

  it('numbers same-type instances by insertion order with #N suffix', () => {
    const nodes: Record<string, ModuleNode> = {
      lfo1: makeNode('lfo1', 'lfo'),
      lfo2: makeNode('lfo2', 'lfo'),
      filter1: makeNode('filter1', 'filter'),
    };
    const out = buildModuleEntries(nodes, defs({ lfo: lfoDef, filter: filterDef }), 'filter1');
    expect(out.map((e) => e.displayName)).toEqual(['LFO #1', 'LFO #2']);
  });

  it('keeps stable indices when the excluded node is one of the numbered set', () => {
    const nodes: Record<string, ModuleNode> = {
      lfo1: makeNode('lfo1', 'lfo'),
      lfo2: makeNode('lfo2', 'lfo'),
    };
    const out = buildModuleEntries(nodes, defs({ lfo: lfoDef }), 'lfo1');
    expect(out.map((e) => ({ id: e.nodeId, name: e.displayName }))).toEqual([
      { id: 'lfo2', name: 'LFO #2' },
    ]);
  });
});

describe('compatibleTargetPorts (output → ?)', () => {
  it('returns INPUTs of the target whose type accepts the source cable type', () => {
    const nodes = { filter1: makeNode('filter1', 'filter') };
    const out = compatibleTargetPorts(
      'cv',
      'output',
      filterDef,
      'filter1',
      {},
      nodes,
      defs({ filter: filterDef }),
    );
    // canConnect(cv, cv) is true and canConnect(cv, audio) is permitted as
    // an Eurorack-style same-substrate upcast (see types.ts:canConnect),
    // so 'cutoff', 'res' AND 'audio' are all valid targets for a cv source.
    expect(out.map((p) => p.portId).sort()).toEqual(['audio', 'cutoff', 'res']);
  });

  it('permits cv → audio (LFO into AudioOut: tremolo / DC test signal)', () => {
    // Pre-PR-stereovca this was rejected — the codebase split cv vs audio
    // for tooling (cvScale) reasons but the underlying voltage carrier is
    // identical. STEREOVCA needs both an LFO (cv, slow → tremolo) and an
    // oscillator (audio-rate → ring modulation) to land on the same
    // strength input without the user thinking about cable types, so
    // cv → audio is now a legal upcast.
    const nodes = { ao1: makeNode('ao1', 'audioOut') };
    const out = compatibleTargetPorts(
      'cv',
      'output',
      audioOutDef,
      'ao1',
      {},
      nodes,
      defs({ audioOut: audioOutDef }),
    );
    expect(out.map((p) => p.portId).sort()).toEqual(['L', 'R']);
  });

  it('allows cv → mono-video (cross-domain bridge)', () => {
    const nodes = { lines1: makeNode('lines1', 'lines') };
    const out = compatibleTargetPorts(
      'cv',
      'output',
      linesDef,
      'lines1',
      {},
      nodes,
      defs({ lines: linesDef }),
    );
    // canConnect(cv, mono-video) is permitted (Phase 0 type-level allow).
    // canConnect(cv, cv) for orient is permitted.
    expect(out.map((p) => p.portId).sort()).toEqual(['fm', 'orient']);
  });

  it('flags an INPUT that already has an incoming cable as occupied', () => {
    const nodes = {
      lfo1: makeNode('lfo1', 'lfo'),
      lfo2: makeNode('lfo2', 'lfo'),
      filter1: makeNode('filter1', 'filter'),
    };
    const edges: Record<string, Edge> = {
      e1: {
        id: 'e1',
        source: { nodeId: 'lfo1', portId: 'phase0' },
        target: { nodeId: 'filter1', portId: 'cutoff' },
        sourceType: 'cv',
        targetType: 'cv',
      },
    };
    const out = compatibleTargetPorts(
      'cv',
      'output',
      filterDef,
      'filter1',
      edges,
      nodes,
      defs({ lfo: lfoDef, filter: filterDef }),
    );
    const cutoff = out.find((p) => p.portId === 'cutoff');
    expect(cutoff?.occupiedBy?.sourceNodeId).toBe('lfo1');
    expect(cutoff?.occupiedBy?.sourceDisplayName).toBe('LFO #1.phase0');
    const res = out.find((p) => p.portId === 'res');
    expect(res?.occupiedBy).toBeUndefined();
  });
});

describe('compatibleTargetPorts (input → ?)', () => {
  it('returns OUTPUTs of the target whose type can drive the source input', () => {
    // Source: FILTER.cutoff (an INPUT, type cv). Target candidate: LFO.
    // LFO outputs are all cv; canConnect(cv, cv) → all four pass.
    const nodes = { lfo1: makeNode('lfo1', 'lfo') };
    const out = compatibleTargetPorts(
      'cv', // source port (FILTER.cutoff) cable type
      'input',
      lfoDef,
      'lfo1',
      {},
      nodes,
      defs({ lfo: lfoDef }),
    );
    expect(out.map((p) => p.portId)).toEqual(['phase0', 'phase90', 'phase180', 'phase270']);
    // None of these should be flagged as occupied — outputs are never
    // shown with the destructive-overwrite warning.
    expect(out.every((p) => p.occupiedBy === undefined)).toBe(true);
  });
});

describe('moduleDisplayName', () => {
  it('returns plain label for singletons', () => {
    const nodes = { lfo1: makeNode('lfo1', 'lfo') };
    expect(moduleDisplayName('lfo1', nodes, defs({ lfo: lfoDef }))).toBe('LFO');
  });
  it('numbers instances of the same type', () => {
    const nodes = {
      lfo1: makeNode('lfo1', 'lfo'),
      lfo2: makeNode('lfo2', 'lfo'),
    };
    expect(moduleDisplayName('lfo1', nodes, defs({ lfo: lfoDef }))).toBe('LFO #1');
    expect(moduleDisplayName('lfo2', nodes, defs({ lfo: lfoDef }))).toBe('LFO #2');
  });
});
