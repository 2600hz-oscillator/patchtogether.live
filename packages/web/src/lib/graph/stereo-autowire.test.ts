// stereo-autowire.test.ts — unit coverage for the pure stereo L/R auto-wire
// planner. No Svelte/DOM/Yjs — drives the planner with hand-built defs (naming
// deliberately non-uniform: in_l/in_r, inL/inR, L/R, odd/even, mix_l/mix_r) so
// the naming-agnostic stereoPairs resolution is exercised across the real
// module naming conventions.

import { describe, it, expect } from 'vitest';
import { findStereoSibling, planStereoAutowire, type StereoDef } from './stereo-autowire';
import type { Edge, PortDef } from './types';

function audio(id: string): PortDef {
  return { id, type: 'audio' };
}

// --- Real-module-shaped fixtures (ids match the live defs) ---

// clouds — in_l/in_r + out_l/out_r, both pairs declared.
const clouds: StereoDef = {
  inputs: [audio('in_l'), audio('in_r'), { id: 'pitch', type: 'pitch' }],
  outputs: [audio('out_l'), audio('out_r')],
  stereoPairs: [['in_l', 'in_r'], ['out_l', 'out_r']],
};

// cofefve — inL/inR + outL/outR.
const cofefve: StereoDef = {
  inputs: [audio('inL'), audio('inR'), { id: 'clock', type: 'gate' }],
  outputs: [audio('outL'), audio('outR')],
  stereoPairs: [['inL', 'inR'], ['outL', 'outR']],
};

// charlottes-echos — L/R reused for BOTH inputs and outputs.
const charlottesEchos: StereoDef = {
  inputs: [audio('L'), audio('R'), { id: 'delay', type: 'cv' }],
  outputs: [audio('L'), audio('R')],
  stereoPairs: [['L', 'R']],
};

// rings — mono input `in`, stereo OUTPUT pair odd/even (no input pair).
const rings: StereoDef = {
  inputs: [audio('in'), { id: 'pitch', type: 'pitch' }],
  outputs: [audio('odd'), audio('even')],
  stereoPairs: [['odd', 'even']],
};

// fdnQuad — a synthetic FDN-style def: stereo OUTPUT pair mix_l/mix_r among 4 mono outs; mono inputs.
const fdnQuad: StereoDef = {
  inputs: [audio('in1'), audio('in2'), audio('in3'), audio('in4')],
  outputs: [audio('out1'), audio('out2'), audio('out3'), audio('out4'), audio('mix_l'), audio('mix_r')],
  stereoPairs: [['mix_l', 'mix_r']],
};

// A mono oscillator-style source — single `out`, no stereoPairs.
const monoOsc: StereoDef = {
  inputs: [{ id: 'pitch', type: 'pitch' }],
  outputs: [audio('out')],
};

function edge(id: string, src: [string, string], dst: [string, string]): Edge {
  return {
    id,
    source: { nodeId: src[0], portId: src[1] },
    target: { nodeId: dst[0], portId: dst[1] },
    sourceType: 'audio',
    targetType: 'audio',
  };
}

describe('findStereoSibling', () => {
  it('resolves the sibling in either tuple slot (clouds in_l/in_r)', () => {
    expect(findStereoSibling(clouds, 'in_l')).toBe('in_r');
    expect(findStereoSibling(clouds, 'in_r')).toBe('in_l');
  });

  it('handles multiple pairs on one def (clouds out_l/out_r)', () => {
    expect(findStereoSibling(clouds, 'out_l')).toBe('out_r');
    expect(findStereoSibling(clouds, 'out_r')).toBe('out_l');
  });

  it('is naming-agnostic — odd/even, mix_l/mix_r, L/R, inL/inR', () => {
    expect(findStereoSibling(rings, 'odd')).toBe('even');
    expect(findStereoSibling(rings, 'even')).toBe('odd');
    expect(findStereoSibling(fdnQuad, 'mix_l')).toBe('mix_r');
    expect(findStereoSibling(charlottesEchos, 'L')).toBe('R');
    expect(findStereoSibling(cofefve, 'inL')).toBe('inR');
  });

  it('returns null for a non-paired port', () => {
    expect(findStereoSibling(rings, 'in')).toBeNull();
    expect(findStereoSibling(fdnQuad, 'out1')).toBeNull();
    expect(findStereoSibling(monoOsc, 'out')).toBeNull();
  });

  it('returns null when the def declares no stereoPairs', () => {
    expect(findStereoSibling(monoOsc, 'out')).toBeNull();
  });
});

describe('planStereoAutowire', () => {
  it('plans the sibling edge for stereo source → stereo target (clouds out_l → cofefve inL)', () => {
    // clouds.out_l → cofefve.inL just committed. Expect out_r → inR planned.
    const plan = planStereoAutowire({
      fromPortId: 'out_l',
      fromDef: clouds,
      toNodeId: 'coco1',
      toPortId: 'inL',
      toDef: cofefve,
      edges: { e1: edge('e1', ['cl1', 'out_l'], ['coco1', 'inL']) },
    });
    expect(plan).toEqual({
      siblingFromPortId: 'out_r',
      siblingToPortId: 'inR',
      sourceType: 'audio',
      targetType: 'audio',
    });
  });

  it('plans from the R side too (clouds out_r → cofefve inR ⇒ out_l → inL)', () => {
    const plan = planStereoAutowire({
      fromPortId: 'out_r',
      fromDef: clouds,
      toNodeId: 'coco1',
      toPortId: 'inR',
      toDef: cofefve,
      edges: { e1: edge('e1', ['cl1', 'out_r'], ['coco1', 'inR']) },
    });
    expect(plan?.siblingFromPortId).toBe('out_l');
    expect(plan?.siblingToPortId).toBe('inL');
  });

  it('is naming-agnostic across the source/target pair (rings odd/even → cofefve inL/inR)', () => {
    const plan = planStereoAutowire({
      fromPortId: 'odd',
      fromDef: rings,
      toNodeId: 'coco1',
      toPortId: 'inL',
      toDef: cofefve,
      edges: { e1: edge('e1', ['r1', 'odd'], ['coco1', 'inL']) },
    });
    expect(plan?.siblingFromPortId).toBe('even');
    expect(plan?.siblingToPortId).toBe('inR');
  });

  it('alt-naming target (charlottes-echos L/R) proves naming-agnostic on the target', () => {
    // clouds.out_l → charlottes-echos.L (input) ⇒ out_r → R.
    const plan = planStereoAutowire({
      fromPortId: 'out_l',
      fromDef: clouds,
      toNodeId: 'ce1',
      toPortId: 'L',
      toDef: charlottesEchos,
      edges: { e1: edge('e1', ['cl1', 'out_l'], ['ce1', 'L']) },
    });
    expect(plan?.siblingFromPortId).toBe('out_r');
    expect(plan?.siblingToPortId).toBe('R');
  });

  it('returns null for a MONO source into a stereo target (engine normals R←L)', () => {
    // monoOsc.out → cofefve.inL — source has no matching pair.
    const plan = planStereoAutowire({
      fromPortId: 'out',
      fromDef: monoOsc,
      toNodeId: 'coco1',
      toPortId: 'inL',
      toDef: cofefve,
      edges: { e1: edge('e1', ['osc1', 'out'], ['coco1', 'inL']) },
    });
    expect(plan).toBeNull();
  });

  it('returns null when the target port is not a stereo-pair member', () => {
    // clouds.out_l → cofefve.clock (not paired).
    const plan = planStereoAutowire({
      fromPortId: 'out_l',
      fromDef: clouds,
      toNodeId: 'coco1',
      toPortId: 'clock',
      toDef: cofefve,
      edges: {},
    });
    expect(plan).toBeNull();
  });

  it('skips when the sibling TARGET input is already occupied (does not overwrite)', () => {
    // clouds.out_l → cofefve.inL, but inR already has a cable from elsewhere.
    const plan = planStereoAutowire({
      fromPortId: 'out_l',
      fromDef: clouds,
      toNodeId: 'coco1',
      toPortId: 'inL',
      toDef: cofefve,
      edges: {
        e1: edge('e1', ['cl1', 'out_l'], ['coco1', 'inL']),
        eOcc: edge('eOcc', ['other', 'out'], ['coco1', 'inR']),
      },
    });
    expect(plan).toBeNull();
  });

  it('autowires when only the PRIMARY side is occupied (the just-made edge)', () => {
    // The just-committed primary edge occupies inL; inR is free → autowire.
    const plan = planStereoAutowire({
      fromPortId: 'out_l',
      fromDef: clouds,
      toNodeId: 'coco1',
      toPortId: 'inL',
      toDef: cofefve,
      edges: { e1: edge('e1', ['cl1', 'out_l'], ['coco1', 'inL']) },
    });
    expect(plan).not.toBeNull();
  });

  it('returns null when the source declares the wrong direction of pair (output-only source pair, target also output-only — no input sibling exists)', () => {
    // fdnQuad.mix_l (output) → rings... rings has no stereo INPUT pair, only
    // a mono `in`. So target `in` is not paired ⇒ null.
    const plan = planStereoAutowire({
      fromPortId: 'mix_l',
      fromDef: fdnQuad,
      toNodeId: 'r1',
      toPortId: 'in',
      toDef: rings,
      edges: {},
    });
    expect(plan).toBeNull();
  });
});
