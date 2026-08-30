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
  portConnections,
  type AnyDef,
} from './port-patch-helpers';

const lfoDef: AudioModuleDef = {
  type: 'lfo',
  domain: 'audio',
  label: 'LFO',
  category: 'modulation',
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

function makeNode(id: string, type: string, name?: string): ModuleNode {
  // `name` mirrors the live app: `migrateAssignNames` runs on every rack
  // load, so a real node virtually always carries `data.name` — either the
  // auto-namer's reserved `<TYPE>`/`<TYPE>N` default or a user rename.
  return {
    id,
    type,
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: {},
    ...(name !== undefined ? { data: { name } } : {}),
  };
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

  // ---- rename-aware display names (#2264) ----------------------------------

  it('prefers a RENAMED node\'s name VERBATIM — no #N (renames are unique by construction)', () => {
    // The owner\'s case: among several instances, one is renamed. The renamed
    // one shows its name; its un-renamed sibling keeps EXACTLY the numbering
    // it had before the rename (the renamed node still counts toward the
    // type\'s total).
    const nodes: Record<string, ModuleNode> = {
      lfo1: makeNode('lfo1', 'lfo', 'feedback'),
      lfo2: makeNode('lfo2', 'lfo'),
      filter1: makeNode('filter1', 'filter'),
    };
    const out = buildModuleEntries(nodes, defs({ lfo: lfoDef, filter: filterDef }), 'filter1');
    expect(out.map((e) => e.displayName)).toEqual(['feedback', 'LFO #2']);
    // typeLabel survives beside the rename — the picker renders it as
    // secondary text whenever it differs from displayName.
    expect(out[0]).toEqual({ nodeId: 'lfo1', displayName: 'feedback', typeLabel: 'LFO' });
  });

  it('treats the auto-namer\'s reserved default (any case) as NO rename — byte-identical fallback', () => {
    // `migrateAssignNames` gives every node a `<TYPE>`/`<TYPE>N` name on
    // load, so "data.name is set" is NOT the rename signal. A rack where
    // every node carries its auto default must label exactly as before.
    const nodes: Record<string, ModuleNode> = {
      lfo1: makeNode('lfo1', 'lfo', 'LFO'),
      lfo2: makeNode('lfo2', 'lfo', 'lfo2'), // case-insensitive, like validateRename
      filter1: makeNode('filter1', 'filter', 'FILTER'),
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
    // canConnect(cv, audio) is false; canConnect(cv, cv) is true. So 'cutoff'
    // and 'res' are kept; 'audio' is filtered out.
    expect(out.map((p) => p.portId)).toEqual(['cutoff', 'res']);
  });

  it('rejects cv → audio (LFO into AudioOut)', () => {
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
    expect(out).toEqual([]);
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

describe('compatibleTargetPorts — a collapsed stereo target DRILLS INTO ITS LEGS', () => {
  // THE MISSING GESTURE (owner, 2026-08-07). A collapsed stereo input renders
  // as ONE jack, so a MONO source — an ES-9 hardware point — had no way to say
  // "just the L leg": the picker's source-side only-L/only-R rows require the
  // SOURCE to carry a stereo image, and a mono point does not. Three rows per
  // pair is the other half of that control.
  const nodes = { ao1: makeNode('ao1', 'audioOut') };

  it('offers the pair, then its L, then its R', () => {
    const out = compatibleTargetPorts(
      'audio', 'output', audioOutDef, 'ao1', {}, nodes, defs({ audioOut: audioOutDef }),
    );
    // audioOut declares a bare `L`/`R` pair, which has no stem of its own, so
    // the collapsed jack takes THE RAIL as its name — 'IN' on an input rail.
    // (`collapsedPairLabel`; the leg rows suffix that same label.)
    expect(out.map((p) => ({ label: p.label, portId: p.portId, leg: p.leg }))).toEqual([
      { label: 'IN', portId: 'L', leg: undefined },
      { label: 'IN L', portId: 'L', leg: 'left' },
      { label: 'IN R', portId: 'L', leg: 'right' },
    ]);
  });

  it('EVERY row addresses the pair\'s LEFT port — the side travels in `leg`', () => {
    // Not an implementation detail: `planAudioCommit` anchors the clicked leg on
    // the SOURCE side when the source is paired, so addressing `R` directly here
    // would land the surviving leg on `L` for a stereo source — the opposite of
    // what the row says. See per-leg-patching.test.ts for that cross-check.
    const out = compatibleTargetPorts(
      'audio', 'output', audioOutDef, 'ao1', {}, nodes, defs({ audioOut: audioOutDef }),
    );
    expect(new Set(out.map((p) => p.portId)), 'no row may address R directly').toEqual(
      new Set(['L']),
    );
  });

  it('gives every row a UNIQUE key (three rows share one portId)', () => {
    // The list is keyed on this. Without it the two leg rows and the pair row
    // collide and the menu renders whichever one Svelte kept.
    const out = compatibleTargetPorts(
      'audio', 'output', audioOutDef, 'ao1', {}, nodes, defs({ audioOut: audioOutDef }),
    );
    expect(new Set(out.map((p) => p.key)).size).toBe(out.length);
  });

  it('an UNPAIRED input is a single row with no leg', () => {
    // Scope control: without it, "the legs are there" would be untested for the
    // case where they must NOT be, and a blanket 3× expansion would pass above.
    const out = compatibleTargetPorts(
      'audio', 'output', filterDef, 'filter1', {}, { filter1: makeNode('filter1', 'filter') },
      defs({ filter: filterDef }),
    );
    const audio = out.filter((p) => p.portId === 'audio');
    expect(audio).toHaveLength(1);
    expect(audio[0]?.leg).toBeUndefined();
    expect(audio[0]?.key).toBe('audio');
  });

  it('OCCUPANCY is per-leg on the leg rows and either-leg on the pair row', () => {
    // An only-L cable must not flag the R row as a destructive overwrite —
    // patching R alongside it is exactly the coexistence the leg-level
    // occupancy rule allows.
    const edges: Record<string, Edge> = {
      e1: {
        id: 'e1',
        source: { nodeId: 'filter1', portId: 'audio' },
        target: { nodeId: 'ao1', portId: 'L' },
        sourceType: 'audio',
        targetType: 'audio',
      },
    };
    const out = compatibleTargetPorts(
      'audio', 'output', audioOutDef, 'ao1', edges,
      { ...nodes, filter1: makeNode('filter1', 'filter') },
      defs({ audioOut: audioOutDef, filter: filterDef }),
    );
    const byKey = Object.fromEntries(out.map((p) => [p.key, p]));
    expect(byKey['L|stereo']?.occupiedBy?.sourcePortId, 'the pair row sees the L cable').toBe('audio');
    expect(byKey['L|left']?.occupiedBy?.sourcePortId, 'the L row sees it').toBe('audio');
    expect(byKey['L|right']?.occupiedBy, 'the R row is FREE — nothing is on R').toBeUndefined();
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

// ----------------------------------------------------------------------------
// CV-family interchange (cv ↔ pitch ↔ gate ↔ polyPitchGate). canConnect
// permits any cross-family direction at the type level; the patch-to
// cascade has to surface every compatible candidate. Earlier the cascade
// only listed type-equal candidates and a SEQUENCER.gate cable couldn't
// land on an ADSR.attack (cv) target via the menu even though dragging
// it worked at the engine level.
// ----------------------------------------------------------------------------

const sequencerDef: AudioModuleDef = {
  type: 'kria',
  domain: 'audio',
  label: 'Sequencer',
  category: 'sources',
  inputs: [{ id: 'clock', type: 'gate' }],
  outputs: [
    { id: 'clock', type: 'gate' },
    { id: 'gate', type: 'gate' },
    { id: 'pitch', type: 'pitch' },
  ],
  params: [],
  factory: (() => undefined) as unknown as AudioModuleDef['factory'],
};

const adsrDef: AudioModuleDef = {
  type: 'adsr',
  domain: 'audio',
  label: 'ADSR',
  category: 'modulation',
  inputs: [
    { id: 'gate', type: 'gate' },
    { id: 'attack', type: 'cv' },
    { id: 'decay', type: 'cv' },
    { id: 'sustain', type: 'cv' },
    { id: 'release', type: 'cv' },
  ],
  outputs: [
    { id: 'env', type: 'cv' },
    { id: 'env_inv', type: 'cv' },
  ],
  params: [],
  factory: (() => undefined) as unknown as AudioModuleDef['factory'],
};

const analogVcoDef: AudioModuleDef = {
  type: 'analogVco',
  domain: 'audio',
  label: 'Analog VCO',
  category: 'sources',
  inputs: [
    { id: 'pitch_cv', type: 'pitch' },
    { id: 'fm', type: 'audio' },
    { id: 'tune', type: 'cv' },
    { id: 'fmAmount', type: 'cv' },
  ],
  outputs: [
    { id: 'saw', type: 'audio' },
    { id: 'square', type: 'audio' },
  ],
  params: [],
  factory: (() => undefined) as unknown as AudioModuleDef['factory'],
};

describe('compatibleTargetPorts — cv-family interchange (output → input)', () => {
  it('SEQUENCER.gate (gate) → ADSR lists gate AND every cv input', () => {
    // Pre-fix: only ADSR.gate would appear (gate→gate equality).
    // Post-fix: gate also routes to attack/decay/sustain/release (cv).
    const nodes = { adsr1: makeNode('adsr1', 'adsr') };
    const out = compatibleTargetPorts(
      'gate',
      'output',
      adsrDef,
      'adsr1',
      {},
      nodes,
      defs({ adsr: adsrDef }),
    );
    expect(out.map((p) => p.portId).sort()).toEqual(
      ['attack', 'decay', 'gate', 'release', 'sustain'],
    );
  });

  it('SEQUENCER.pitch (pitch) → AnalogVCO lists pitch_cv AND cv params', () => {
    // pitch → pitch (pitch_cv) + pitch → cv (tune / fmAmount).
    // 'fm' is audio and stays excluded (audio family is strict).
    const nodes = { vco1: makeNode('vco1', 'analogVco') };
    const out = compatibleTargetPorts(
      'pitch',
      'output',
      analogVcoDef,
      'vco1',
      {},
      nodes,
      defs({ analogVco: analogVcoDef }),
    );
    expect(out.map((p) => p.portId).sort()).toEqual(['fmAmount', 'pitch_cv', 'tune']);
  });

  it('LFO.phase0 (cv) → ADSR lists gate AND every cv input', () => {
    // cv → gate (drive ADSR.gate as a threshold trigger from LFO) is
    // a previously-blocked patch.
    const nodes = { adsr1: makeNode('adsr1', 'adsr') };
    const out = compatibleTargetPorts(
      'cv',
      'output',
      adsrDef,
      'adsr1',
      {},
      nodes,
      defs({ adsr: adsrDef }),
    );
    expect(out.map((p) => p.portId).sort()).toEqual(
      ['attack', 'decay', 'gate', 'release', 'sustain'],
    );
  });
});

describe('compatibleTargetPorts — cv-family interchange (input → output)', () => {
  it('ADSR.attack (cv) input ← SEQUENCER lists every cv-family output', () => {
    // Right-clicking ADSR.attack and choosing SEQUENCER: every output
    // whose type lands in cv (gate / pitch / cv) should be listed —
    // SEQUENCER ships clock + gate (gate) + pitch (pitch).
    const nodes = { seq1: makeNode('seq1', 'kria') };
    const out = compatibleTargetPorts(
      'cv', // source = ADSR.attack
      'input',
      sequencerDef,
      'seq1',
      {},
      nodes,
      defs({ sequencer: sequencerDef }),
    );
    expect(out.map((p) => p.portId).sort()).toEqual(['clock', 'gate', 'pitch']);
  });

  it('AnalogVCO.tune (cv) input ← LFO lists every cv-family output', () => {
    const nodes = { lfo1: makeNode('lfo1', 'lfo') };
    const out = compatibleTargetPorts(
      'cv',
      'input',
      lfoDef,
      'lfo1',
      {},
      nodes,
      defs({ lfo: lfoDef }),
    );
    // All four LFO phase outputs are cv → already passed; this test
    // pins the same behaviour as a regression guard.
    expect(out.map((p) => p.portId).sort()).toEqual(
      ['phase0', 'phase180', 'phase270', 'phase90'],
    );
  });

  it('ADSR.gate (gate) input ← LFO lists every cv-family output', () => {
    // Pre-fix: empty (cv → gate rejected).
    // Post-fix: every LFO cv output is a candidate.
    const nodes = { lfo1: makeNode('lfo1', 'lfo') };
    const out = compatibleTargetPorts(
      'gate',
      'input',
      lfoDef,
      'lfo1',
      {},
      nodes,
      defs({ lfo: lfoDef }),
    );
    expect(out.map((p) => p.portId).sort()).toEqual(
      ['phase0', 'phase180', 'phase270', 'phase90'],
    );
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

  it('prefers a RENAME verbatim over label + #N (#2264)', () => {
    const nodes = {
      lfo1: makeNode('lfo1', 'lfo', 'feedback'),
      lfo2: makeNode('lfo2', 'lfo'),
    };
    expect(moduleDisplayName('lfo1', nodes, defs({ lfo: lfoDef }))).toBe('feedback');
    // The un-renamed sibling keeps its pre-rename numbering.
    expect(moduleDisplayName('lfo2', nodes, defs({ lfo: lfoDef }))).toBe('LFO #2');
  });

  it('a reserved auto-default name is NOT a rename — falls back to label + #N', () => {
    const nodes = {
      lfo1: makeNode('lfo1', 'lfo', 'LFO'),
      lfo2: makeNode('lfo2', 'lfo', 'LFO2'),
    };
    expect(moduleDisplayName('lfo1', nodes, defs({ lfo: lfoDef }))).toBe('LFO #1');
    expect(moduleDisplayName('lfo2', nodes, defs({ lfo: lfoDef }))).toBe('LFO #2');
  });
});

// ----------------------------------------------------------------------------
// portConnections — live patched/unpatched + remote-endpoint strings for the
// on-card patch-menu jack indicator + hover overlay.
// ----------------------------------------------------------------------------

function edge(
  id: string,
  source: { nodeId: string; portId: string },
  target: { nodeId: string; portId: string },
  type = 'cv',
): Edge {
  return { id, source, target, sourceType: type as Edge['sourceType'], targetType: type as Edge['targetType'] };
}

describe('portConnections', () => {
  it('maps an INPUT port to its single incoming remote source (uppercased)', () => {
    const nodes = {
      lfo1: makeNode('lfo1', 'lfo'),
      filter1: makeNode('filter1', 'filter'),
    };
    const edges = {
      e1: edge('e1', { nodeId: 'lfo1', portId: 'phase0' }, { nodeId: 'filter1', portId: 'cutoff' }),
    };
    const { inputs, outputs } = portConnections(
      edges,
      'filter1',
      nodes,
      defs({ lfo: lfoDef, filter: filterDef }),
    );
    expect(inputs.get('cutoff')).toEqual(['LFO.PHASE0']);
    // The unpatched 'res' input is absent (a miss = hollow ring).
    expect(inputs.get('res')).toBeUndefined();
    // filter1 drives nothing here.
    expect(outputs.size).toBe(0);
  });

  it('maps an OUTPUT port fanning out to two targets (both listed)', () => {
    const nodes = {
      lfo1: makeNode('lfo1', 'lfo'),
      filter1: makeNode('filter1', 'filter'),
      filter2: makeNode('filter2', 'filter'),
    };
    const edges = {
      e1: edge('e1', { nodeId: 'lfo1', portId: 'phase0' }, { nodeId: 'filter1', portId: 'cutoff' }),
      e2: edge('e2', { nodeId: 'lfo1', portId: 'phase0' }, { nodeId: 'filter2', portId: 'res' }),
    };
    const { inputs, outputs } = portConnections(
      edges,
      'lfo1',
      nodes,
      defs({ lfo: lfoDef, filter: filterDef }),
    );
    // Two distinct Filter instances → numbered display names; both endpoints.
    expect(outputs.get('phase0')?.sort()).toEqual(['Filter #1.CUTOFF', 'Filter #2.RES']);
    // lfo1 receives nothing.
    expect(inputs.size).toBe(0);
  });

  it('names a RENAMED remote by its rename — the owner\'s exact case (#2264)', () => {
    // "← FROM camera #1.OUT" while the module\'s tile said "feedback". The
    // remote endpoint string must carry the rename (the FROM word is the
    // title builder\'s half of the fix — remoteEndpointsTitle\'s own test).
    const nodes = {
      lfo1: makeNode('lfo1', 'lfo', 'feedback'),
      filter1: makeNode('filter1', 'filter'),
    };
    const edges = {
      e1: edge('e1', { nodeId: 'lfo1', portId: 'phase0' }, { nodeId: 'filter1', portId: 'cutoff' }),
    };
    const { inputs } = portConnections(
      edges,
      'filter1',
      nodes,
      defs({ lfo: lfoDef, filter: filterDef }),
    );
    // The rename stays VERBATIM (not uppercased) — it is the user\'s string;
    // only the port half keeps the panel\'s uppercase convention.
    expect(inputs.get('cutoff')).toEqual(['feedback.PHASE0']);
  });

  it('leaves an unpatched module with empty maps', () => {
    const nodes = {
      lfo1: makeNode('lfo1', 'lfo'),
      filter1: makeNode('filter1', 'filter'),
    };
    const { inputs, outputs } = portConnections(
      {},
      'filter1',
      nodes,
      defs({ lfo: lfoDef, filter: filterDef }),
    );
    expect(inputs.size).toBe(0);
    expect(outputs.size).toBe(0);
    expect(inputs.get('cutoff')).toBeUndefined();
  });

  // Regression: the rear-view back panel derives port-connection status for
  // EVERY card on EVERY render (front-view used to evaluate this lazily, only on
  // the open patch menu). A half-formed edge in the live store — endpoints
  // absent, or still flat strings rather than `{ nodeId, portId }` objects mid-
  // reconcile — must be SKIPPED, not throw: a throw here tore down every card on
  // screen (SvelteFlow unmounts the whole NodeRenderer). See bentbox.spec /
  // rear-view-patching regression.
  it('skips malformed edges (missing / non-object endpoints) without throwing', () => {
    const nodes = {
      lfo1: makeNode('lfo1', 'lfo'),
      filter1: makeNode('filter1', 'filter'),
    };
    const edges = {
      // both endpoints undefined
      bad1: { id: 'bad1', source: undefined, target: undefined } as unknown as Edge,
      // endpoints are flat strings, not { nodeId, portId } objects
      bad2: { id: 'bad2', source: 'lfo1', target: 'filter1' } as unknown as Edge,
      // one good edge alongside the bad ones still resolves
      good: edge('good', { nodeId: 'lfo1', portId: 'phase0' }, { nodeId: 'filter1', portId: 'cutoff' }),
    };
    let result!: ReturnType<typeof portConnections>;
    expect(() => {
      result = portConnections(edges, 'filter1', nodes, defs({ lfo: lfoDef, filter: filterDef }));
    }).not.toThrow();
    // The single well-formed edge is still mapped; the malformed ones are dropped.
    expect(result.inputs.get('cutoff')).toEqual(['LFO.PHASE0']);
    expect(result.outputs.size).toBe(0);
  });
});
