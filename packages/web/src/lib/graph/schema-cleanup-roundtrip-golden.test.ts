// packages/web/src/lib/graph/schema-cleanup-roundtrip-golden.test.ts
//
// PART A #1 of the schema/persistence cleanup — the "NEW patches round-trip
// IDENTICALLY" GOLDEN. See .myrobots/schema_cleanup_proposal_260606.md §5.2
// ("New-patch round-trips identically") + §6 Phase 0 ("Establish the regression
// net, ship first, no removals").
//
// This is the regression net that guards EVERY later cleanup phase (this PR's
// safe removals + PRs 2-5's breaking removals): a representative FRESH patch,
// saved via the REAL persistence path and reloaded via the REAL load path, must
// come back STRUCTURALLY IDENTICAL — topology (which modules, where), edges
// (including a CV route), and AUTHORED/SEQUENCED params (a knob the user set, a
// sequencer's steps).
//
// WHY IT PROVES THE REMOVALS ARE NEW-PATCH-SAFE (the hard constraint):
// cleanup 5/5 collapsed the whole `schemaVersion` / `moduleSchemas` migration
// substrate (envelope v2 = lean write, tolerant read). A fresh save now stamps a
// lean v2 envelope with NO per-module version map at all, and the load path runs
// no migration — so topology + authored/sequenced values are the ONLY thing a
// round-trip can carry. This golden registers real defs (audio-out, chroma, luma)
// plus stubs, and asserts the fresh save is a lean v2 envelope AND the round-trip
// is structurally byte-stable, so it stays GREEN across the whole cleanup.
//
// Uses a REAL syncedStore + Y.Doc + persistence path — never a mock (see the
// [[yjs-save-load-real-ydoc]] discipline: never rebuild+reassign a live Y map).

import { describe, it, expect, beforeAll } from 'vitest';
import { syncedStore, getYjsDoc } from '@syncedstore/core';
import {
  makeEnvelope,
  parseEnvelope,
  serializeEnvelope,
  loadEnvelopeIntoStore,
  ENVELOPE_VERSION,
  type LivePatch,
} from './persistence';
import { registerModule, type AudioModuleDef } from '$lib/audio/module-registry';
import { registerVideoModule } from '$lib/video/module-registry';
import { audioOutDef } from '$lib/audio/modules/audio-out';
import { chromaDef } from '$lib/video/modules/chroma';
import { lumaDef } from '$lib/video/modules/luma';
import type { ModuleNode, Edge } from './types';

// The persistence layer only reads the registered TYPE + ports from a def; it
// never runs the factory. A throwing stub catches accidental invocation.
const throwingFactory = (): never => {
  throw new Error('factory must not run in a persistence round-trip test');
};

/** CV source (LFO-style) — lets us wire a REAL cv route into a video param. */
const lfoStub: AudioModuleDef = {
  type: 'goldenLfo',
  domain: 'audio',
  label: 'golden lfo',
  category: 'modulation',
  inputs: [],
  outputs: [{ id: 'cv', type: 'cv' }],
  params: [{ id: 'rate', label: 'Rate', defaultValue: 1, min: 0, max: 20, curve: 'linear' }],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  factory: throwingFactory as any,
};

/** Audio source with a knob the user sets (authored param). */
const vcoStub: AudioModuleDef = {
  type: 'goldenVco',
  domain: 'audio',
  label: 'golden vco',
  category: 'sources',
  inputs: [{ id: 'pitch', type: 'pitch' }],
  outputs: [{ id: 'out', type: 'audio' }],
  params: [{ id: 'tune', label: 'Tune', defaultValue: 0, min: -36, max: 36, curve: 'linear' }],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  factory: throwingFactory as any,
};

/** Sequencer with SEQUENCED values in node.data + an authored knob. */
const seqStub: AudioModuleDef = {
  type: 'goldenSeq',
  domain: 'audio',
  label: 'golden seq',
  category: 'sequencers',
  inputs: [{ id: 'clock', type: 'gate' }],
  outputs: [
    { id: 'pitch', type: 'pitch' },
    { id: 'gate', type: 'gate' },
  ],
  params: [{ id: 'bpm', label: 'BPM', defaultValue: 120, min: 20, max: 300, curve: 'linear' }],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  factory: throwingFactory as any,
};

/** Fresh isolated syncedstore + ydoc + LivePatch triple (never the singleton). */
function freshPatch() {
  const store = syncedStore<{ nodes: Record<string, ModuleNode>; edges: Record<string, Edge> }>({
    nodes: {},
    edges: {},
  });
  const ydoc = getYjsDoc(store);
  return { store: store as unknown as LivePatch, ydoc };
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// A representative FRESH patch: several modules (audio + video), a CV route, an
// audio route, a sequenced-value module, and knobs the user set. Everything the
// cleanup must NOT perturb on a fresh save.
const NODES: ModuleNode[] = [
  // Sequenced values live in node.data; bpm is an authored knob.
  {
    id: 'seq',
    type: 'goldenSeq',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: { bpm: 128 },
    data: {
      steps: [
        { on: true, midi: 60 },
        { on: false, midi: 0 },
        { on: true, midi: 64 },
        { on: true, midi: 67 },
      ],
      loopLen: 4,
    },
  },
  { id: 'vco', type: 'goldenVco', domain: 'audio', position: { x: 220, y: 0 }, params: { tune: 7 } },
  { id: 'lfo', type: 'goldenLfo', domain: 'audio', position: { x: 0, y: 220 }, params: { rate: 2.5 } },
  // Real video defs whose migrate/version THIS PR removes — with authored params.
  { id: 'chr', type: 'chroma', domain: 'video', position: { x: 440, y: 0 }, params: { hue: 90, saturation: 1.4, tintMix: 0.25 } },
  { id: 'lum', type: 'luma', domain: 'video', position: { x: 440, y: 220 }, params: { gamma: 1.7, contrast: 1.2 } },
  // Real audio-out def whose no-op migrate THIS PR removes.
  { id: 'out', type: 'audioOut', domain: 'audio', position: { x: 660, y: 0 }, params: { master: 0.42 } },
];

const EDGES: Edge[] = [
  // Audio route.
  { id: 'e-vco-out', source: { nodeId: 'vco', portId: 'out' }, target: { nodeId: 'out', portId: 'L' }, sourceType: 'audio', targetType: 'audio' },
  // Pitch route (seq → vco).
  { id: 'e-seq-vco', source: { nodeId: 'seq', portId: 'pitch' }, target: { nodeId: 'vco', portId: 'pitch' }, sourceType: 'pitch', targetType: 'pitch' },
  // CV routes into the two real video params (cross-domain cv → video).
  { id: 'e-lfo-hue', source: { nodeId: 'lfo', portId: 'cv' }, target: { nodeId: 'chr', portId: 'hue' }, sourceType: 'cv', targetType: 'cv' },
  { id: 'e-lfo-gamma', source: { nodeId: 'lfo', portId: 'cv' }, target: { nodeId: 'lum', portId: 'gamma' }, sourceType: 'cv', targetType: 'cv' },
];

beforeAll(() => {
  registerModule(audioOutDef);
  registerModule(vcoStub);
  registerModule(lfoStub);
  registerModule(seqStub);
  registerVideoModule(chromaDef);
  registerVideoModule(lumaDef);
});

describe('schema-cleanup golden: a fresh patch round-trips identically', () => {
  it('a fresh save is a LEAN v2 envelope — no per-module moduleSchemas map', () => {
    const src = freshPatch();
    src.ydoc.transact(() => {
      for (const n of NODES) src.store.nodes[n.id] = clone(n);
    });
    const env = makeEnvelope(src.ydoc);
    expect(env.envelopeVersion).toBe(ENVELOPE_VERSION);
    expect(ENVELOPE_VERSION).toBe(2);
    // The migration substrate was collapsed: a fresh save carries only savedAt +
    // the Yjs update, never a per-module version map. Nothing on load can reshape
    // the recovered node.data, so authored/sequenced values are all that survive.
    expect('moduleSchemas' in env).toBe(false);
    expect(JSON.parse(serializeEnvelope(env))).not.toHaveProperty('moduleSchemas');
  });

  it('save → JSON → load returns topology + edges + AUTHORED/SEQUENCED params unchanged', () => {
    const src = freshPatch();
    src.ydoc.transact(() => {
      for (const n of NODES) src.store.nodes[n.id] = clone(n);
      for (const e of EDGES) src.store.edges[e.id] = clone(e);
    });

    // REAL save path → wire format → REAL load path into a brand-new doc.
    const reparsed = parseEnvelope(serializeEnvelope(makeEnvelope(src.ydoc)));
    const dst = freshPatch();
    const result = loadEnvelopeIntoStore(reparsed, dst.ydoc, dst.store);

    // Nothing dropped or migrated away.
    expect(result.diagnostics).toEqual([]);
    expect(result.nodesLoaded).toBe(NODES.length);
    expect(result.edgesLoaded).toBe(EDGES.length);

    // Topology + authored/sequenced values identical for every node.
    for (const n of NODES) {
      const loaded = dst.store.nodes[n.id];
      expect(loaded, `node ${n.id} present`).toBeDefined();
      expect(loaded!.type).toBe(n.type);
      expect(loaded!.domain).toBe(n.domain);
      expect(loaded!.position).toEqual(n.position);
      expect(loaded!.params).toEqual(n.params);
      if (n.data !== undefined) expect(loaded!.data).toEqual(n.data);
    }

    // Edges (topology of the routing, including the CV route) identical.
    for (const e of EDGES) {
      const loaded = dst.store.edges[e.id];
      expect(loaded, `edge ${e.id} present`).toBeDefined();
      expect(loaded!.source).toEqual(e.source);
      expect(loaded!.target).toEqual(e.target);
      expect(loaded!.sourceType).toBe(e.sourceType);
      expect(loaded!.targetType).toBe(e.targetType);
    }

    // Re-saving the loaded patch is a FIXPOINT: still a lean v2 envelope, and it
    // reloads into the same topology (no per-module version to perturb).
    const reEnv = makeEnvelope(dst.ydoc);
    expect(reEnv.envelopeVersion).toBe(ENVELOPE_VERSION);
    expect('moduleSchemas' in reEnv).toBe(false);
    const dst2 = freshPatch();
    const reResult = loadEnvelopeIntoStore(
      parseEnvelope(serializeEnvelope(reEnv)),
      dst2.ydoc,
      dst2.store,
    );
    expect(reResult.diagnostics).toEqual([]);
    expect(reResult.nodesLoaded).toBe(NODES.length);
    expect(reResult.edgesLoaded).toBe(EDGES.length);
  });
});
