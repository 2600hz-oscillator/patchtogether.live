// packages/web/src/lib/ui/example-patches/gibribbon-demo.test.ts
//
// Unit coverage for the GIBRIBBON (game demo) fixture + its loader. Mirror of
// glitches.test.ts / media-burn.test.ts in shape; assertions are tailored to
// the GibRibbon demo's content:
//   TIMELORDE → MACSEQ → MACROOSCILLATOR → SYNESTHESIA(A) → GIBRIBBON
// plus the cross-domain wiring that DRIVES the game (4 slow SYNESTHESIA
// envelopes → cv1..cv4, MACSEQ gate → gate, TIMELORDE 1× → clock).
//
// We register minimal stub defs (the loader only reads schemaVersion + an
// optional migrate; it never calls factory) so loadEnvelopeIntoStore accepts
// every node + edge. The real defs live under $lib/audio/modules + $lib/video/
// modules; stubbing here avoids pulling in the AudioWorklet / WebGL2 `?url`
// loaders that don't resolve outside SvelteKit/Vite.

import { describe, it, expect, beforeAll } from 'vitest';
import { syncedStore, getYjsDoc } from '@syncedstore/core';
import * as Y from 'yjs';
import { registerModule, type AudioModuleDef } from '$lib/audio/module-registry';
import { registerVideoModule, type VideoModuleDef } from '$lib/video/module-registry';
import { parseEnvelope, ENVELOPE_VERSION, type LivePatch } from '$lib/graph/persistence';
import type { ModuleNode, Edge } from '$lib/graph/types';
import {
  GIBRIBBON_DEMO_ENVELOPE_RAW,
  getGibribbonDemoEnvelope,
  loadGibribbonDemo,
} from './gibribbon-demo';

// ---------------- Test fixtures ----------------

const throwingFactory = (): never => {
  throw new Error('factory should not be called from gibribbon-demo.test.ts');
};

function makeStubAudio(type: string, schemaVersion: number): AudioModuleDef {
  return {
    type,
    domain: 'audio',
    label: type.toUpperCase(),
    category: 'sources',
    schemaVersion,
    inputs: [],
    outputs: [],
    params: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    factory: throwingFactory as any,
  };
}

const stubGibribbonDef: VideoModuleDef = {
  type: 'gibribbon',
  domain: 'video',
  label: 'GIBRIBBON',
  category: 'sources',
  schemaVersion: 1,
  inputs: [
    { id: 'cv1', type: 'modsignal' },
    { id: 'cv2', type: 'modsignal' },
    { id: 'cv3', type: 'modsignal' },
    { id: 'cv4', type: 'modsignal' },
    { id: 'clock', type: 'gate' },
    { id: 'gate', type: 'gate' },
  ],
  outputs: [{ id: 'out', type: 'video' }],
  params: [],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  factory: throwingFactory as any,
};

function freshPatch() {
  const store = syncedStore<{ nodes: Record<string, ModuleNode>; edges: Record<string, Edge> }>({
    nodes: {},
    edges: {},
  });
  const ydoc = getYjsDoc(store);
  return { store: store as unknown as LivePatch, ydoc };
}

// Convenience: find the (single) node of a given type in a loaded store.
function nodeOfType(store: LivePatch, type: string): ModuleNode {
  const n = Object.values(store.nodes).find((m): m is ModuleNode => m?.type === type);
  if (!n) throw new Error(`no ${type} node in store`);
  return n;
}

// Convenience: does an edge from src.port → dst.port exist?
function hasEdge(
  store: LivePatch,
  srcType: string,
  srcPort: string,
  dstType: string,
  dstPort: string,
): boolean {
  const src = nodeOfType(store, srcType);
  const dst = nodeOfType(store, dstType);
  return Object.values(store.edges).some(
    (e) =>
      e?.source.nodeId === src.id &&
      e.source.portId === srcPort &&
      e.target.nodeId === dst.id &&
      e.target.portId === dstPort,
  );
}

// ---------------- Setup ----------------

beforeAll(() => {
  // schemaVersions must match the envelope's moduleSchemas so the loader
  // doesn't try to run a (nonexistent) migration. timelorde = v2.
  registerModule(makeStubAudio('timelorde', 2));
  registerModule(makeStubAudio('macseq', 1));
  registerModule(makeStubAudio('macrooscillator', 1));
  registerModule(makeStubAudio('synesthesia', 1));
  registerVideoModule(stubGibribbonDef);
});

// ---------------- Tests ----------------

describe('gibribbon-demo: envelope shape', () => {
  it('imports as a non-null JSON object', () => {
    expect(GIBRIBBON_DEMO_ENVELOPE_RAW).toBeTypeOf('object');
    expect(GIBRIBBON_DEMO_ENVELOPE_RAW).not.toBeNull();
  });

  it('parses into a PatchEnvelope (v1, moduleSchemas + update present)', () => {
    const env = getGibribbonDemoEnvelope();
    expect(env.envelopeVersion).toBe(ENVELOPE_VERSION);
    expect(typeof env.savedAt).toBe('string');
    expect(new Date(env.savedAt).getTime()).toBeGreaterThan(0);
    expect(env.moduleSchemas).toBeTypeOf('object');
    expect(typeof env.update).toBe('string');
    expect(env.update.length).toBeGreaterThan(0);
    expect(env.update).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it('moduleSchemas advertises the 5 patch types with the pinned versions', () => {
    const env = getGibribbonDemoEnvelope();
    expect(env.moduleSchemas).toMatchObject({
      timelorde: 2,
      macseq: 1,
      macrooscillator: 1,
      synesthesia: 1,
      gibribbon: 1,
    });
  });

  it('re-validates through parseEnvelope cleanly (idempotent shape check)', () => {
    const env = getGibribbonDemoEnvelope();
    const reparsed = parseEnvelope(JSON.stringify(env));
    expect(reparsed.envelopeVersion).toBe(env.envelopeVersion);
    expect(reparsed.savedAt).toBe(env.savedAt);
    expect(reparsed.update).toBe(env.update);
  });

  it('the encoded Y update decodes to exactly 5 nodes + 11 edges', () => {
    // Round-trip directly from the raw envelope (independent of the loader's
    // registry-aware path) so this also guards the generator's output.
    const env = parseEnvelope(JSON.stringify(GIBRIBBON_DEMO_ENVELOPE_RAW));
    const doc = new Y.Doc();
    Y.applyUpdate(
      doc,
      Uint8Array.from(atob(env.update), (c) => c.charCodeAt(0)),
    );
    const nodes = doc.getMap('nodes').toJSON();
    const edges = doc.getMap('edges').toJSON();
    expect(Object.keys(nodes).length).toBe(5);
    expect(Object.keys(edges).length).toBe(11);
  });

  it('the SYNESTHESIA gains in the blob match the build script (no drift)', () => {
    // Guard against script↔blob drift: build-gibribbon-demo-envelope.mjs writes
    // these SYNESTHESIA copy-A gains, and gibribbon-demo-calibration.test.ts
    // proves they keep all four GIBRIBBON channels alive. If someone edits the
    // gains in the script but forgets to regenerate the committed .imp.json (or
    // vice-versa), the live demo silently diverges from the calibration this PR
    // (#701) locked in — fail CI here so the two can never drift apart.
    const env = parseEnvelope(JSON.stringify(GIBRIBBON_DEMO_ENVELOPE_RAW));
    const doc = new Y.Doc();
    Y.applyUpdate(
      doc,
      Uint8Array.from(atob(env.update), (c) => c.charCodeAt(0)),
    );
    const nodes = doc.getMap('nodes').toJSON();
    const syn = Object.values(nodes).find(
      (n): n is { params?: Record<string, number> } =>
        (n as { type?: string })?.type === 'synesthesia',
    );
    expect(syn, 'synesthesia node present in blob').toBeTruthy();
    // These are the retuned (#698) gains the build script writes; keep this
    // object in lock-step with the `params` block in
    // scripts/build-gibribbon-demo-envelope.mjs.
    expect(syn!.params).toMatchObject({
      a_mode: 0,
      a_master: 1.2,
      a_gain1: 1.4,
      a_gain2: 2.35,
      a_gain3: 3.9,
      a_gain4: 1.9,
    });
  });
});

describe('gibribbon-demo: loadGibribbonDemo against a fake store', () => {
  it('lands all 5 nodes + 11 edges with no dropped-node diagnostics', () => {
    const { store, ydoc } = freshPatch();
    const result = loadGibribbonDemo(ydoc, store);
    expect(result.nodesLoaded).toBe(5);
    expect(result.edgesLoaded).toBe(11);
    expect(result.diagnostics).toEqual([]);
  });

  it('contains exactly one of each expected node type', () => {
    const { store, ydoc } = freshPatch();
    loadGibribbonDemo(ydoc, store);
    for (const type of ['timelorde', 'macseq', 'macrooscillator', 'synesthesia', 'gibribbon']) {
      const matches = Object.values(store.nodes).filter((n): n is ModuleNode => n?.type === type);
      expect(matches.length, `exactly one ${type}`).toBe(1);
    }
    // gibribbon lives in the video domain; the rest are audio.
    expect(nodeOfType(store, 'gibribbon').domain).toBe('video');
    expect(nodeOfType(store, 'timelorde').domain).toBe('audio');
  });

  it('wires the audio signal chain TIMELORDE→MACSEQ→MACROOSCILLATOR→SYNESTHESIA', () => {
    const { store, ydoc } = freshPatch();
    loadGibribbonDemo(ydoc, store);
    // TIMELORDE 2× (8th) clocks the sequencer.
    expect(hasEdge(store, 'timelorde', '2x', 'macseq', 'clock')).toBe(true);
    // MACSEQ pitch/gate/modelcv → MACROOSCILLATOR.
    expect(hasEdge(store, 'macseq', 'pitch', 'macrooscillator', 'pitch')).toBe(true);
    expect(hasEdge(store, 'macseq', 'gate', 'macrooscillator', 'trig')).toBe(true);
    expect(hasEdge(store, 'macseq', 'modelcv', 'macrooscillator', 'model_cv')).toBe(true);
    // Voice → analysis.
    expect(hasEdge(store, 'macrooscillator', 'out', 'synesthesia', 'a_in')).toBe(true);
  });

  it('wires the 4 SLOW SYNESTHESIA (copy A) envelopes → GIBRIBBON cv1..cv4', () => {
    const { store, ydoc } = freshPatch();
    loadGibribbonDemo(ydoc, store);
    expect(hasEdge(store, 'synesthesia', 'a_band1_env_slow', 'gibribbon', 'cv1')).toBe(true);
    expect(hasEdge(store, 'synesthesia', 'a_band2_env_slow', 'gibribbon', 'cv2')).toBe(true);
    expect(hasEdge(store, 'synesthesia', 'a_band3_env_slow', 'gibribbon', 'cv3')).toBe(true);
    expect(hasEdge(store, 'synesthesia', 'a_band4_env_slow', 'gibribbon', 'cv4')).toBe(true);
  });

  it('wires the GIBRIBBON transport: MACSEQ gate → gate, TIMELORDE 1× → clock', () => {
    const { store, ydoc } = freshPatch();
    loadGibribbonDemo(ydoc, store);
    expect(hasEdge(store, 'macseq', 'gate', 'gibribbon', 'gate')).toBe(true);
    expect(hasEdge(store, 'timelorde', '1x', 'gibribbon', 'clock')).toBe(true);
  });

  it('MACSEQ free-runs (isPlaying=1, length=128) with a 128-step pattern', () => {
    const { store, ydoc } = freshPatch();
    loadGibribbonDemo(ydoc, store);
    const ms = nodeOfType(store, 'macseq');
    expect(ms.params.isPlaying).toBe(1);
    expect(ms.params.length).toBe(128);
    const steps = (ms.data as { steps?: unknown })?.steps as
      | Array<{ on: boolean; midi: number | null; model: number | null }>
      | undefined;
    expect(Array.isArray(steps)).toBe(true);
    expect(steps!.length).toBe(128);
    // KICK (model 8) on every 8th step, forced to c2 (midi 36).
    for (let i = 0; i < 128; i += 8) {
      expect(steps![i]!.model, `step ${i} kick`).toBe(8);
      expect(steps![i]!.midi, `step ${i} kick = c2`).toBe(36);
      expect(steps![i]!.on).toBe(true);
    }
    // SNARE (model 9) on the alternating back-beat 8s, forced to c3 (midi 48).
    for (let i = 4; i < 128; i += 8) {
      expect(steps![i]!.model, `step ${i} snare`).toBe(9);
      expect(steps![i]!.midi, `step ${i} snare = c3`).toBe(48);
      expect(steps![i]!.on).toBe(true);
    }
    // Voice steps only ever use 2OP / STRING / WAVESHAPE (2/6/1) or empty.
    const allowed = new Set([1, 2, 6, 8, 9, null]);
    for (const s of steps!) expect(allowed.has(s.model)).toBe(true);
    // Some steps are empty (~40% of the non-drum steps) and some are gated.
    const empty = steps!.filter((s) => !s.on).length;
    expect(empty).toBeGreaterThan(0);
    expect(steps!.filter((s) => s.on).length).toBeGreaterThan(64);
  });

  it('TIMELORDE + MACROOSCILLATOR carry sensible free-run params', () => {
    const { store, ydoc } = freshPatch();
    loadGibribbonDemo(ydoc, store);
    expect(nodeOfType(store, 'timelorde').params.running).toBe(1);
    const macro = nodeOfType(store, 'macrooscillator');
    expect(macro.params.level).toBeGreaterThan(0.5);
  });

  it('is idempotent — second load yields the same 5 node ids', () => {
    const { store, ydoc } = freshPatch();
    loadGibribbonDemo(ydoc, store);
    const firstIds = Object.values(store.nodes).map((n) => n?.id).filter(Boolean).sort();
    loadGibribbonDemo(ydoc, store);
    const secondIds = Object.values(store.nodes).map((n) => n?.id).filter(Boolean).sort();
    expect(secondIds).toEqual(firstIds);
    expect(firstIds.length).toBe(5);
  });
});
