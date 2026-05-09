// packages/web/src/lib/graph/persistence.test.ts
//
// Pure-data round-trip tests for the PatchEnvelope save/load path.
// Vitest runs in node, so this file does NOT exercise the audio engine — that
// half of the load story is covered by the @load-tagged Playwright spec.
//
// What's tested here: build a patch in a fresh ydoc, snapshot it via
// makeEnvelope, decode the envelope via parseEnvelope, then load it into a
// second fresh ydoc and assert nodes/edges/params/data round-trip exactly.
// This is the regression net for the load-patch race fix — if the envelope
// shape ever silently changes, this catches it before the e2e test even runs.

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
import type { ModuleNode, Edge } from './types';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { registerModule, getModuleDef } from '$lib/audio/module-registry';
import {
  registerVideoModule,
  type VideoModuleDef,
} from '$lib/video/module-registry';

// ---------------- Test fixtures ----------------

/** A factory stub that throws if anyone actually calls it. The persistence
 * layer only reads schemaVersion + migrate from the def; it never calls
 * factory. Wiring a throwing stub catches accidental factory invocation. */
const throwingFactory = (): never => {
  throw new Error('factory should not be called from persistence tests');
};

/** Two minimal module defs cover the round-trip surface: a source-style module
 * with params + data, and a sink-style module that just receives audio. */
const testVcoDef: AudioModuleDef = {
  type: 'analogVco',
  domain: 'audio',
  label: 'Analog VCO',
  category: 'sources',
  schemaVersion: 1,
  inputs: [{ id: 'pitch', type: 'pitch' }],
  outputs: [{ id: 'sine', type: 'audio' }],
  params: [
    { id: 'tune', label: 'Tune', defaultValue: 0, min: -36, max: 36, curve: 'linear' },
    { id: 'fine', label: 'Fine', defaultValue: 0, min: -100, max: 100, curve: 'linear' },
  ],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  factory: throwingFactory as any,
};

const testOutDef: AudioModuleDef = {
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
  params: [
    { id: 'master', label: 'Master', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
  ],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  factory: throwingFactory as any,
};

/** A second-version VCO def used by the migration test. */
const testVcoDefV2: AudioModuleDef = {
  ...testVcoDef,
  schemaVersion: 2,
  migrate(data, fromVersion) {
    if (fromVersion >= 2) return data;
    // Pretend v2 added a `wave` field defaulting to 'sine'.
    return { ...(data as object | undefined ?? {}), wave: 'sine' };
  },
};

/** Build a fresh syncedstore + ydoc + LivePatch triple for each test. */
function freshPatch() {
  const store = syncedStore<{ nodes: Record<string, ModuleNode>; edges: Record<string, Edge> }>({
    nodes: {},
    edges: {},
  });
  const ydoc = getYjsDoc(store);
  return { store: store as unknown as LivePatch, ydoc };
}

// ---------------- Tests ----------------

beforeAll(() => {
  // Register the minimal defs so loadEnvelopeIntoStore's per-node migration
  // step can find them. We deliberately don't import the real
  // $lib/audio/modules barrel here — those modules import WASM via Vite's
  // `?url` loader, which only resolves under SvelteKit's vite plugin.
  registerModule(testVcoDef);
  registerModule(testOutDef);
});

describe('persistence: round-trip', () => {
  it('produces an envelope with the documented shape', () => {
    const { ydoc, store } = freshPatch();
    ydoc.transact(() => {
      store.nodes['vco'] = {
        id: 'vco',
        type: 'analogVco',
        domain: 'audio',
        position: { x: 100, y: 200 },
        params: { tune: 5, fine: 12 },
      };
    });
    const env = makeEnvelope(ydoc);
    expect(env.envelopeVersion).toBe(ENVELOPE_VERSION);
    expect(typeof env.savedAt).toBe('string');
    expect(new Date(env.savedAt).getTime()).toBeGreaterThan(0);
    expect(env.moduleSchemas['analogVco']).toBe(getModuleDef('analogVco')!.schemaVersion);
    expect(env.update).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(env.update.length).toBeGreaterThan(0);
  });

  it('round-trips nodes, edges, params, and arbitrary data through save → JSON → load', () => {
    const a = freshPatch();
    a.ydoc.transact(() => {
      a.store.nodes['vco'] = {
        id: 'vco',
        type: 'analogVco',
        domain: 'audio',
        position: { x: 100, y: 200 },
        params: { tune: 7, fine: -3 },
        data: { customField: 'hello', nestedArray: [1, 2, 3] },
      };
      a.store.nodes['out'] = {
        id: 'out',
        type: 'audioOut',
        domain: 'audio',
        position: { x: 600, y: 200 },
        params: { master: 0.42 },
      };
      a.store.edges['e1'] = {
        id: 'e1',
        source: { nodeId: 'vco', portId: 'sine' },
        target: { nodeId: 'out', portId: 'L' },
        sourceType: 'audio',
        targetType: 'audio',
      };
      a.store.edges['e2'] = {
        id: 'e2',
        source: { nodeId: 'vco', portId: 'sine' },
        target: { nodeId: 'out', portId: 'R' },
        sourceType: 'audio',
        targetType: 'audio',
      };
    });

    const env = makeEnvelope(a.ydoc);

    // Serialize to JSON and parse back — proves the envelope survives the
    // wire format the user actually uploads, not just an in-process object.
    const reparsed = parseEnvelope(serializeEnvelope(env));

    // Load into a brand-new doc so we're not just reading what we wrote.
    const b = freshPatch();
    const result = loadEnvelopeIntoStore(reparsed, b.ydoc, b.store);

    expect(result.nodesLoaded).toBe(2);
    expect(result.edgesLoaded).toBe(2);
    expect(result.diagnostics).toEqual([]);

    const loadedVco = b.store.nodes['vco'];
    expect(loadedVco).toBeDefined();
    expect(loadedVco!.type).toBe('analogVco');
    expect(loadedVco!.position).toEqual({ x: 100, y: 200 });
    expect(loadedVco!.params).toEqual({ tune: 7, fine: -3 });
    expect(loadedVco!.data).toEqual({ customField: 'hello', nestedArray: [1, 2, 3] });

    const loadedOut = b.store.nodes['out'];
    expect(loadedOut).toBeDefined();
    expect(loadedOut!.params).toEqual({ master: 0.42 });

    const loadedE1 = b.store.edges['e1'];
    expect(loadedE1).toBeDefined();
    expect(loadedE1!.source).toEqual({ nodeId: 'vco', portId: 'sine' });
    expect(loadedE1!.target).toEqual({ nodeId: 'out', portId: 'L' });
    expect(loadedE1!.sourceType).toBe('audio');
  });

  it('replaces existing patch state (load = swap, not merge)', () => {
    // Pre-populate the destination with a stale node + edge.
    const dest = freshPatch();
    dest.ydoc.transact(() => {
      dest.store.nodes['stale'] = {
        id: 'stale',
        type: 'audioOut',
        domain: 'audio',
        position: { x: 0, y: 0 },
        params: {},
      };
      dest.store.edges['stale-e'] = {
        id: 'stale-e',
        source: { nodeId: 'stale', portId: 'L' },
        target: { nodeId: 'stale', portId: 'R' },
        sourceType: 'audio',
        targetType: 'audio',
      };
    });

    // Build a different patch in the source.
    const src = freshPatch();
    src.ydoc.transact(() => {
      src.store.nodes['fresh'] = {
        id: 'fresh',
        type: 'analogVco',
        domain: 'audio',
        position: { x: 10, y: 10 },
        params: { tune: 1, fine: 0 },
      };
    });
    const env = makeEnvelope(src.ydoc);

    const result = loadEnvelopeIntoStore(env, dest.ydoc, dest.store);
    expect(result.nodesLoaded).toBe(1);

    // Stale entries are gone; only the loaded ones remain.
    expect(dest.store.nodes['stale']).toBeUndefined();
    expect(dest.store.edges['stale-e']).toBeUndefined();
    expect(dest.store.nodes['fresh']).toBeDefined();
    expect(dest.store.nodes['fresh']!.type).toBe('analogVco');
  });

  it('runs per-module migrations when saved schemaVersion is older', () => {
    // Save under v1.
    const src = freshPatch();
    src.ydoc.transact(() => {
      src.store.nodes['vco'] = {
        id: 'vco',
        type: 'analogVco',
        domain: 'audio',
        position: { x: 0, y: 0 },
        params: { tune: 0, fine: 0 },
        // No `wave` field — that's the v1 shape.
      };
    });
    const env = makeEnvelope(src.ydoc);
    expect(env.moduleSchemas['analogVco']).toBe(1);

    // Re-register VCO at v2 to simulate a code update with a migration.
    registerModule(testVcoDefV2);

    const dest = freshPatch();
    const result = loadEnvelopeIntoStore(env, dest.ydoc, dest.store);
    expect(result.nodesLoaded).toBe(1);
    expect(result.diagnostics).toEqual([]);

    const loaded = dest.store.nodes['vco'];
    expect(loaded).toBeDefined();
    expect((loaded!.data as { wave: string }).wave).toBe('sine');

    // Restore v1 def for downstream tests.
    registerModule(testVcoDef);
  });

  it('drops nodes whose module type is not registered, plus edges referencing them', () => {
    // Save under a "future" build with an unknown module type.
    const src = freshPatch();
    src.ydoc.transact(() => {
      src.store.nodes['unknown'] = {
        id: 'unknown',
        type: 'someFutureModule',
        domain: 'audio',
        position: { x: 0, y: 0 },
        params: {},
      };
      src.store.nodes['out'] = {
        id: 'out',
        type: 'audioOut',
        domain: 'audio',
        position: { x: 100, y: 100 },
        params: { master: 0.5 },
      };
      src.store.edges['e1'] = {
        id: 'e1',
        source: { nodeId: 'unknown', portId: 'audio' },
        target: { nodeId: 'out', portId: 'L' },
        sourceType: 'audio',
        targetType: 'audio',
      };
    });
    const env = makeEnvelope(src.ydoc);

    const dest = freshPatch();
    const result = loadEnvelopeIntoStore(env, dest.ydoc, dest.store);
    expect(result.nodesLoaded).toBe(1); // only 'out' loaded
    expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);
    expect(result.diagnostics.some((d) => d.nodeId === 'unknown')).toBe(true);
    expect(dest.store.nodes['unknown']).toBeUndefined();
    expect(dest.store.nodes['out']).toBeDefined();
    expect(dest.store.edges['e1']).toBeUndefined();
  });

  it('parseEnvelope rejects malformed input', () => {
    expect(() => parseEnvelope('not json')).toThrow();
    expect(() => parseEnvelope(JSON.stringify({}))).toThrow();
    expect(() =>
      parseEnvelope(
        JSON.stringify({
          envelopeVersion: 999,
          savedAt: new Date().toISOString(),
          moduleSchemas: {},
          update: 'AAAA',
        })
      )
    ).toThrow();
  });
});

// ---------------- Asset-bytes round-trip ----------------
//
// Regression net for the rackspace-persistence audit (see
// .myrobots/plans/rackspace-persistence.md). The audit's working assumption
// is that every "asset" (PICTUREBOX bytes, DX7 SYX user banks, sequencer
// step data, ...) survives the export/import path because each one already
// rides in `node.data`. These tests pin that assumption by stuffing
// asset-shaped payloads into node.data and asserting the round-trip
// preserves them byte-for-byte.

describe('persistence: asset round-trip (rackspace-persistence audit)', () => {
  it('preserves PICTUREBOX-shaped image bytes through save → JSON → load', () => {
    // PICTUREBOX is a VIDEO-domain module — registered via registerVideoModule,
    // not registerModule. Pinning this here also covers the audit's finding
    // that pre-fix, the persistence loader only consulted the audio registry,
    // so video-domain nodes round-tripped as "unknown module" and got dropped.
    registerVideoModule({
      type: 'picturebox',
      domain: 'video',
      label: 'PICTUREBOX',
      category: 'sources',
      schemaVersion: 2,
      inputs: [],
      outputs: [],
      params: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      factory: throwingFactory as any,
    } satisfies VideoModuleDef);

    // Build a long, deterministic base64 payload — wider than the chunked
    // base64 encoder's 32 KB chunk size to exercise the multi-chunk path.
    const payloadBase64 = btoa(
      Array.from({ length: 4096 }, (_, i) => String.fromCharCode((i * 31 + 7) & 0xff)).join(''),
    ).repeat(4); // ~24 KB of base64 text

    const src = freshPatch();
    src.ydoc.transact(() => {
      src.store.nodes['pb'] = {
        id: 'pb',
        type: 'picturebox',
        domain: 'video',
        position: { x: 0, y: 0 },
        params: { gain: 1 },
        data: {
          imageBytes: payloadBase64,
          imageMime: 'image/jpeg',
          imageName: 'photo.jpg',
          creatorId: 'user_123',
        },
      };
    });
    const env = makeEnvelope(src.ydoc);

    // Round-trip through serialize → parse → load to prove the bytes survive
    // both the Yjs encode and the JSON encode.
    const reparsed = parseEnvelope(serializeEnvelope(env));
    const dest = freshPatch();
    const result = loadEnvelopeIntoStore(reparsed, dest.ydoc, dest.store);
    expect(result.nodesLoaded).toBe(1);
    expect(result.diagnostics).toEqual([]);

    const loaded = dest.store.nodes['pb'];
    expect(loaded).toBeDefined();
    const loadedData = loaded!.data as {
      imageBytes: string;
      imageMime: string;
      imageName: string;
      creatorId: string;
    };
    expect(loadedData.imageBytes).toBe(payloadBase64);
    expect(loadedData.imageBytes.length).toBe(payloadBase64.length); // sanity
    expect(loadedData.imageMime).toBe('image/jpeg');
    expect(loadedData.imageName).toBe('photo.jpg');
    expect(loadedData.creatorId).toBe('user_123');
  });

  it('preserves DX7 SYX userPatches arrays through save → JSON → load', () => {
    // DX7 stores user-uploaded SYX banks as an array of DX7Voice objects
    // under node.data.userPatches (see lib/audio/modules/dx7.ts). Each voice
    // is structurally rich (6 operators, pitch-eg, lfo, ...) so we use a
    // realistic-shaped fixture rather than a flat dict.
    registerModule({
      type: 'dx7',
      domain: 'audio',
      label: 'DX7',
      category: 'sources',
      schemaVersion: 1,
      inputs: [],
      outputs: [],
      params: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      factory: throwingFactory as any,
    });

    const fakeVoice = (i: number) => ({
      name: `USER ${String(i).padStart(2, '0')}`,
      algorithm: (i % 32) + 1,
      feedback: i % 8,
      operators: Array.from({ length: 6 }, (_, opIdx) => ({
        r: [99 - opIdx, 50, 30, 60],
        l: [99, 70, 50, 0],
        ratio: opIdx === 0 ? 1 : opIdx + 1,
        level: 99 - opIdx * 8,
        detune: 7,
        detuneFactor: 1.0,
        velocitySens: 4,
        fixedMode: false,
      })),
      pitchEg: { r: [99, 99, 99, 99], l: [50, 50, 50, 50] },
      lfo: {
        speed: 35, delay: 0, pmd: 0, amd: 0,
        sync: false, waveform: 0, pitchModSens: 0,
      },
      transpose: 24,
    });
    const userPatches = Array.from({ length: 32 }, (_, i) => fakeVoice(i));

    const src = freshPatch();
    src.ydoc.transact(() => {
      src.store.nodes['dx'] = {
        id: 'dx',
        type: 'dx7',
        domain: 'audio',
        position: { x: 100, y: 200 },
        params: { algorithm: 5, voiceCount: 5, level: 0.7, transpose: 0 },
        data: { preset: 'USER 03', userPatches },
      };
    });
    const env = makeEnvelope(src.ydoc);

    const reparsed = parseEnvelope(serializeEnvelope(env));
    const dest = freshPatch();
    const result = loadEnvelopeIntoStore(reparsed, dest.ydoc, dest.store);
    expect(result.nodesLoaded).toBe(1);
    expect(result.diagnostics).toEqual([]);

    const loaded = dest.store.nodes['dx'];
    expect(loaded).toBeDefined();
    const loadedData = loaded!.data as {
      preset: string;
      userPatches: typeof userPatches;
    };
    // Selected preset name preserved.
    expect(loadedData.preset).toBe('USER 03');
    // Full bank length + name + algorithm + per-op shape preserved.
    expect(loadedData.userPatches).toHaveLength(32);
    expect(loadedData.userPatches[0]?.name).toBe('USER 00');
    expect(loadedData.userPatches[31]?.name).toBe('USER 31');
    expect(loadedData.userPatches[3]?.algorithm).toBe(4);
    // Operator-level structural integrity (6 ops × per-op fields).
    expect(loadedData.userPatches[0]?.operators).toHaveLength(6);
    expect(loadedData.userPatches[0]?.operators[0]?.r).toEqual([99, 50, 30, 60]);
    expect(loadedData.userPatches[0]?.operators[5]?.level).toBe(99 - 5 * 8);
    expect(loadedData.userPatches[0]?.lfo.speed).toBe(35);
  });
});
