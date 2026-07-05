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
import * as Y from 'yjs';
import { syncedStore, getYjsDoc } from '@syncedstore/core';
import {
  makeEnvelope,
  makePortableEnvelope,
  parseEnvelope,
  serializeEnvelope,
  loadEnvelopeIntoStore,
  migrateEdgeEndpoints,
  sanitizeFilename,
  ENVELOPE_VERSION,
  DEFAULT_FILENAME,
  readVideoAspectFromDoc,
  writeVideoAspectToDoc,
  SETTINGS_MAP_KEY,
  SETTINGS_VIDEO_ASPECT,
  type LivePatch,
} from './persistence';
import { setNodePosition } from '$lib/multiplayer/layouts';
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

  it('drops a structurally-invalid edge (both nodes exist) + records a diagnostic, while valid nodes/edges/params still load (Phase 4d)', () => {
    // An aged / hand-edited import: BOTH endpoint nodes exist (so the
    // missing-node drop doesn't catch it), but one edge is structurally
    // malformed in three independent ways — proving validateEdge runs on the
    // import path. The reconciler's engine.addEdge would THROW on each and
    // abort the whole pass; the import-path validation drops the bad edge so
    // every valid node/edge/param after it still lands.
    const src = freshPatch();
    src.ydoc.transact(() => {
      src.store.nodes['vco'] = {
        id: 'vco',
        type: 'analogVco',
        domain: 'audio',
        position: { x: 0, y: 0 },
        params: { tune: 3, fine: -2 },
      };
      src.store.nodes['out'] = {
        id: 'out',
        type: 'audioOut',
        domain: 'audio',
        position: { x: 200, y: 0 },
        params: { master: 0.7 },
      };
      // VALID — source is the VCO's declared output, target a declared input.
      src.store.edges['good'] = {
        id: 'good',
        source: { nodeId: 'vco', portId: 'sine' },
        target: { nodeId: 'out', portId: 'L' },
        sourceType: 'audio',
        targetType: 'audio',
      };
      // INVALID #1 — target port does not exist on audioOut (both nodes DO
      // exist, so this passes the missing-node check but fails validateEdge).
      src.store.edges['bad-port'] = {
        id: 'bad-port',
        source: { nodeId: 'vco', portId: 'sine' },
        target: { nodeId: 'out', portId: 'doesNotExist' },
        sourceType: 'audio',
        targetType: 'audio',
      };
      // INVALID #2 — direction reversed: an INPUT used as the source endpoint.
      src.store.edges['bad-direction'] = {
        id: 'bad-direction',
        source: { nodeId: 'out', portId: 'L' },
        target: { nodeId: 'vco', portId: 'pitch' },
        sourceType: 'audio',
        targetType: 'pitch',
      };
    });
    const env = makeEnvelope(src.ydoc);

    const dest = freshPatch();
    const result = loadEnvelopeIntoStore(env, dest.ydoc, dest.store);

    // Both nodes + their params land in full.
    expect(result.nodesLoaded).toBe(2);
    expect(dest.store.nodes['vco']).toBeDefined();
    expect(dest.store.nodes['vco']!.params).toEqual({ tune: 3, fine: -2 });
    expect(dest.store.nodes['out']).toBeDefined();
    expect(dest.store.nodes['out']!.params).toEqual({ master: 0.7 });

    // The valid edge survives.
    expect(dest.store.edges['good']).toBeDefined();
    // Both invalid edges are dropped...
    expect(dest.store.edges['bad-port']).toBeUndefined();
    expect(dest.store.edges['bad-direction']).toBeUndefined();
    // ...with a diagnostic for each, tagged type 'edge'.
    const edgeDiags = result.diagnostics.filter((d) => d.type === 'edge');
    expect(edgeDiags.map((d) => d.nodeId).sort()).toEqual(['bad-direction', 'bad-port']);
    for (const d of edgeDiags) {
      expect(d.reason).toMatch(/invalid edge dropped/);
    }
    // edgesLoaded counts only the valid edge.
    expect(result.edgesLoaded).toBe(1);
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

// ---------------- DOOM transient-data stripping ----------------
//
// DOOM persists multiplayer lobby state (mpMode / mpLive / players / pending)
// onto its node.data so every peer in the rack converges on the host's
// session state via Yjs sync. But that state is SESSION-scoped, not
// TOPOLOGY: a saved patch is a rack snapshot, not a particular game's live
// status. If those fields ride a saved envelope into a future load, the
// host's start-game dialog is gated on `mpMode === undefined` and so it
// never re-renders — the user lands on a stuck "Single-user rack" splash
// with no way to launch. The loader strips a per-module whitelist of these
// transient fields off `node.data` post-migration so the load is a clean
// topology restore (Bug #1 — the load-from-patch repro).
describe('persistence: DOOM transient-field stripping', () => {
  /** Minimal DOOM def — only needed so the loader sees `doom` as a known
   *  type and runs its migration / strip pass. We register under the audio
   *  domain because DOOM's real registry slot is video, but persistence
   *  doesn't care which registry as long as some lookup matches; using audio
   *  here avoids depending on the real video registry def's evolving shape. */
  const doomStub: AudioModuleDef = {
    type: 'doom',
    domain: 'audio',
    label: 'DOOM',
    category: 'sources',
    schemaVersion: 2,
    inputs: [],
    outputs: [],
    params: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    factory: throwingFactory as any,
  };

  beforeAll(() => {
    registerModule(doomStub);
  });

  it('strips mpMode / mpLive / players / pending off a loaded DOOM node', () => {
    const src = freshPatch();
    src.ydoc.transact(() => {
      src.store.nodes['d'] = {
        id: 'd',
        type: 'doom',
        domain: 'audio',
        position: { x: 10, y: 20 },
        params: {},
        data: {
          name: 'DOOM',
          mpMode: 'multi',
          mpLive: true,
          players: { p1: { userId: 'u-1' } },
          pending: { p2: { userId: 'u-2' } },
        },
      };
    });
    const env = makeEnvelope(src.ydoc);

    const dest = freshPatch();
    const result = loadEnvelopeIntoStore(env, dest.ydoc, dest.store);
    expect(result.nodesLoaded).toBe(1);
    expect(result.diagnostics).toEqual([]);

    const loaded = dest.store.nodes['d'];
    expect(loaded).toBeDefined();
    const data = loaded!.data as Record<string, unknown>;
    expect(data.name).toBe('DOOM'); // persistent name preserved
    expect('mpMode' in data).toBe(false);
    expect('mpLive' in data).toBe(false);
    expect('players' in data).toBe(false);
    expect('pending' in data).toBe(false);
  });

  it('preserves DOOM persistent fields (position / params / data.name)', () => {
    const src = freshPatch();
    src.ydoc.transact(() => {
      src.store.nodes['d'] = {
        id: 'd',
        type: 'doom',
        domain: 'audio',
        position: { x: 123, y: 456 },
        params: { volume: 0.42 },
        data: {
          name: 'My DOOM',
          mpMode: 'single', // transient — should disappear
        },
      };
    });
    const env = makeEnvelope(src.ydoc);

    const dest = freshPatch();
    const result = loadEnvelopeIntoStore(env, dest.ydoc, dest.store);
    expect(result.nodesLoaded).toBe(1);

    const loaded = dest.store.nodes['d'];
    expect(loaded).toBeDefined();
    expect(loaded!.position).toEqual({ x: 123, y: 456 });
    expect(loaded!.params).toEqual({ volume: 0.42 });
    expect((loaded!.data as Record<string, unknown>).name).toBe('My DOOM');
    expect('mpMode' in (loaded!.data as object)).toBe(false);
  });

  it('does NOT strip the same field names off other module types', () => {
    // Confidence check: the strip is type-keyed, so a hypothetical non-DOOM
    // module that happens to carry an `mpMode` field on its data keeps it.
    // Uses the existing testVcoDef (analogVco). This guards against the next
    // person turning the whitelist into a global field filter.
    const src = freshPatch();
    src.ydoc.transact(() => {
      src.store.nodes['v'] = {
        id: 'v',
        type: 'analogVco',
        domain: 'audio',
        position: { x: 0, y: 0 },
        params: { tune: 0, fine: 0 },
        data: { mpMode: 'should-stay' },
      };
    });
    const env = makeEnvelope(src.ydoc);

    const dest = freshPatch();
    const result = loadEnvelopeIntoStore(env, dest.ydoc, dest.store);
    expect(result.nodesLoaded).toBe(1);
    const loaded = dest.store.nodes['v'];
    expect((loaded!.data as Record<string, unknown>).mpMode).toBe('should-stay');
  });
});

// ---------------- circles → outlines legacy-type alias ----------------
//
// The video module formerly named CIRCLES was renamed OUTLINES (#699) when the
// SHAPE/ROTATION rework landed. Unlike the ruttetra case, the id was NOT reused
// for a different module — it's a pure rename. A node saved before the rename
// (localStorage / a live collab Y.Doc / a hand-exported .json) still carries
// `type: 'circles'`. The loader's canonicalizeVideoType() rewrites it to
// `outlines` so (a) getAnyDomainDef resolves a def — the node isn't dropped to a
// placeholder — AND (b) the node lands in the live store with the CURRENT type
// so SvelteFlow's type-keyed nodeTypes map renders OutlinesCard (not the default
// placeholder card) and a re-save persists the canonical id. This pins that the
// rename never silently drops a user's existing CIRCLES node.

describe('persistence: circles → outlines legacy-type rename', () => {
  // Stub the real OUTLINES def (factory never called — only type/schemaVersion
  // are read). We don't import the video modules barrel (it pulls shader ?url
  // imports that only resolve under the SvelteKit vite plugin).
  const outlinesStub: VideoModuleDef = {
    type: 'outlines',
    domain: 'video',
    label: 'outlines',
    category: 'sources',
    schemaVersion: 1,
    inputs: [],
    outputs: [{ id: 'combine', type: 'video' }],
    params: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    factory: throwingFactory as any,
  };

  beforeAll(() => {
    registerVideoModule(outlinesStub);
  });

  /** Hand-build an envelope carrying a single legacy `circles` node. */
  function circlesEnvelope() {
    const src = freshPatch();
    src.ydoc.transact(() => {
      src.store.nodes['cn'] = {
        id: 'cn',
        type: 'circles',
        domain: 'video',
        position: { x: 10, y: 20 },
        params: { d: 0.4, rate: 0.5 },
      };
    });
    return makeEnvelope(src.ydoc);
  }

  it('loads a saved CIRCLES node as OUTLINES (not dropped to a placeholder)', () => {
    const env = circlesEnvelope();
    const dest = freshPatch();
    const result = loadEnvelopeIntoStore(env, dest.ydoc, dest.store);
    // The node survives — NOT in diagnostics as an unknown type.
    expect(result.nodesLoaded).toBe(1);
    expect(result.diagnostics).toEqual([]);
    // And it's stored with the CURRENT type so the type-keyed card map renders it.
    expect(dest.store.nodes['cn']).toBeDefined();
    expect(dest.store.nodes['cn']!.type).toBe('outlines');
    // Params ride along unchanged (pure rename — no param migration).
    expect(dest.store.nodes['cn']!.params).toMatchObject({ d: 0.4, rate: 0.5 });
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

  it('preserves VIDEOBOX fileMeta (name/size/duration/handleId) through save → JSON → load', () => {
    // VIDEOBOX persists the loaded-video metadata on node.data.fileMeta so a
    // reopened patch can reload the file: name/size/duration drive the
    // cross-browser re-link prompt; handleId is the IndexedDB key for the
    // one-click remembered-handle reload (the handle itself is per-browser +
    // NOT in the patch — only the id travels). This pins that the new fields
    // survive the Yjs + JSON encode unchanged.
    registerVideoModule({
      type: 'videobox',
      domain: 'video',
      label: 'VIDEOBOX',
      category: 'sources',
      schemaVersion: 1,
      inputs: [],
      outputs: [],
      params: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      factory: throwingFactory as any,
    } satisfies VideoModuleDef);

    const fileMeta = {
      name: 'clip with spaces.mp4',
      duration: 123.456,
      size: 13_001_000,
      handleId: '6f9619ff-8b86-d011-b42d-00cf4fc964ff',
      contentHash: 'sha256-abc',
      loaderUserId: 'user_42',
    };

    const src = freshPatch();
    src.ydoc.transact(() => {
      src.store.nodes['vb'] = {
        id: 'vb',
        type: 'videobox',
        domain: 'video',
        position: { x: 10, y: 20 },
        params: {},
        data: {
          isPlaying: true,
          lastSyncTime: 1_700_000_000_000,
          lastSyncPosition: 42.5,
          fileMeta,
        },
      };
    });

    const reparsed = parseEnvelope(serializeEnvelope(makeEnvelope(src.ydoc)));
    const dest = freshPatch();
    const result = loadEnvelopeIntoStore(reparsed, dest.ydoc, dest.store);
    expect(result.nodesLoaded).toBe(1);
    expect(result.diagnostics).toEqual([]);

    const loaded = dest.store.nodes['vb'];
    expect(loaded).toBeDefined();
    const data = loaded!.data as {
      isPlaying: boolean;
      lastSyncPosition: number;
      fileMeta: typeof fileMeta;
    };
    expect(data.isPlaying).toBe(true);
    expect(data.lastSyncPosition).toBe(42.5);
    // The whole fileMeta — including the new size/handleId/contentHash —
    // round-trips byte-for-byte.
    expect(data.fileMeta).toEqual(fileMeta);
  });

  it('round-trips a VIDEOBOX fileMeta WITHOUT a handleId (re-link-only / pre-persistence patches)', () => {
    // A patch saved from Firefox/Safari (no File System Access) — or any
    // pre-persistence VIDEOBOX patch — carries fileMeta with no handleId.
    // It must still load cleanly; on reload the card shows the re-link
    // prompt (driven by name/size/duration alone).
    registerVideoModule({
      type: 'videobox',
      domain: 'video',
      label: 'VIDEOBOX',
      category: 'sources',
      schemaVersion: 1,
      inputs: [],
      outputs: [],
      params: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      factory: throwingFactory as any,
    } satisfies VideoModuleDef);

    const src = freshPatch();
    src.ydoc.transact(() => {
      src.store.nodes['vb2'] = {
        id: 'vb2',
        type: 'videobox',
        domain: 'video',
        position: { x: 0, y: 0 },
        params: {},
        data: {
          isPlaying: false,
          lastSyncTime: 0,
          lastSyncPosition: 0,
          fileMeta: { name: 'legacy.webm', duration: 60 },
        },
      };
    });

    const reparsed = parseEnvelope(serializeEnvelope(makeEnvelope(src.ydoc)));
    const dest = freshPatch();
    const result = loadEnvelopeIntoStore(reparsed, dest.ydoc, dest.store);
    expect(result.nodesLoaded).toBe(1);
    const fm = (dest.store.nodes['vb2']!.data as { fileMeta: Record<string, unknown> }).fileMeta;
    expect(fm.name).toBe('legacy.webm');
    expect(fm.duration).toBe(60);
    expect(fm.handleId).toBeUndefined();
    expect(fm.size).toBeUndefined();
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

// ---------------- sanitizeFilename ----------------

describe('persistence: sanitizeFilename', () => {
  it('appends .imp.json when missing', () => {
    expect(sanitizeFilename('mypatch')).toBe('mypatch.imp.json');
  });

  it('preserves a name that already ends in .imp.json (case-insensitive)', () => {
    expect(sanitizeFilename('mypatch.imp.json')).toBe('mypatch.imp.json');
    expect(sanitizeFilename('MyPatch.IMP.JSON')).toBe('MyPatch.IMP.JSON');
  });

  it('falls back to DEFAULT_FILENAME on empty or whitespace-only input', () => {
    expect(sanitizeFilename('')).toBe(DEFAULT_FILENAME);
    expect(sanitizeFilename('   ')).toBe(DEFAULT_FILENAME);
    expect(sanitizeFilename(null)).toBe(DEFAULT_FILENAME);
    expect(sanitizeFilename(undefined)).toBe(DEFAULT_FILENAME);
  });

  it('strips filesystem-invalid characters', () => {
    expect(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe('abcdefghij.imp.json');
  });

  it('falls back when input sanitizes to empty', () => {
    expect(sanitizeFilename('///***')).toBe(DEFAULT_FILENAME);
  });

  it('honors a custom fallback', () => {
    expect(sanitizeFilename('', 'rack-1.imp.json')).toBe('rack-1.imp.json');
  });

  it('preserves spaces and unicode in the middle of the name', () => {
    expect(sanitizeFilename('my cool patch')).toBe('my cool patch.imp.json');
    expect(sanitizeFilename('café')).toBe('café.imp.json');
  });
});

// ---------------- Edge-port migration (#353 DOOM per-slot ports) ----------------
//
// loadEnvelopeIntoStore rewrites edge endpoint portIds via the endpoint node's
// module-def `migrateEdgePortId` hook when the saved version is behind the def.
// DOOM uses this to rewrite legacy bare cv-gate ports (`up`/…) to the p1 group
// (`p1_up`/…) when the single shared input set became four per-slot groups.

/** A video def that renames bare cv-gate ports → p1_<id> for saves below v2. */
const doomLikeDefV2: VideoModuleDef = {
  type: 'doomLike',
  domain: 'video',
  label: 'DoomLike',
  category: 'sources',
  schemaVersion: 2,
  inputs: [{ id: 'p1_up', type: 'cv', paramTarget: 'cv_p1_up' }],
  outputs: [{ id: 'out', type: 'video' }],
  params: [],
  migrateEdgePortId(portId) {
    return portId === 'up' ? 'p1_up' : null;
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  factory: throwingFactory as any,
};

/** A CV source (LFO-like) feeding DOOM's `cv` gate inputs. The real cable into a
 * DOOM cv input is cv→cv (canConnect rejects audio→cv), so the source port is
 * declared `cv` — otherwise the Phase-4d import validator would (correctly) drop
 * the edge as an incompatible cable type. */
const cvLfoDef: AudioModuleDef = {
  type: 'cvLfo',
  domain: 'audio',
  label: 'CV LFO',
  category: 'sources',
  schemaVersion: 1,
  inputs: [],
  outputs: [{ id: 'sine', type: 'cv' }],
  params: [],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  factory: throwingFactory as any,
};

describe('migrateEdgeEndpoints — DOOM per-slot port migration (#353)', () => {
  beforeAll(() => {
    registerVideoModule(doomLikeDefV2);
    registerModule(cvLfoDef);
  });

  const nodes: Record<string, ModuleNode> = {
    doom: { id: 'doom', type: 'doomLike', position: { x: 0, y: 0 }, params: {} } as ModuleNode,
    lfo: { id: 'lfo', type: 'cvLfo', position: { x: 0, y: 0 }, params: {} } as ModuleNode,
  };
  const baseEdge: Edge = {
    id: 'e1',
    source: { nodeId: 'lfo', portId: 'sine' },
    target: { nodeId: 'doom', portId: 'up' },
    sourceType: 'cv',
    targetType: 'cv',
  };

  it('rewrites a legacy bare cv-gate target → p1_<id> when saved below v2', () => {
    const migrated = migrateEdgeEndpoints(baseEdge, nodes, { doomLike: 1 });
    expect(migrated.target.portId).toBe('p1_up');
    expect(migrated.source.portId).toBe('sine'); // source (lfo) untouched
    expect(migrated.id).toBe('e1');
  });

  it('leaves the edge unchanged when the saved version is already current', () => {
    const migrated = migrateEdgeEndpoints(baseEdge, nodes, { doomLike: 2 });
    expect(migrated).toBe(baseEdge); // same reference (no rewrite)
  });

  it('leaves non-migrating ports untouched (out/audio)', () => {
    const e: Edge = { ...baseEdge, target: { nodeId: 'doom', portId: 'out' } };
    const migrated = migrateEdgeEndpoints(e, nodes, { doomLike: 1 });
    expect(migrated.target.portId).toBe('out');
  });

  it('end-to-end: a saved v1 patch with an LFO→DOOM `up` edge loads onto p1_up', () => {
    // Build a v1 save: a doomLike node + an analogVco + an edge into bare `up`.
    const src = freshPatch();
    src.ydoc.transact(() => {
      src.store.nodes['doom'] = { id: 'doom', type: 'doomLike', position: { x: 0, y: 0 }, params: {} } as ModuleNode;
      src.store.nodes['lfo'] = { id: 'lfo', type: 'cvLfo', position: { x: 0, y: 0 }, params: {} } as ModuleNode;
      src.store.edges['e1'] = {
        id: 'e1',
        source: { nodeId: 'lfo', portId: 'sine' },
        target: { nodeId: 'doom', portId: 'up' },
        sourceType: 'cv',
        targetType: 'cv',
      } as Edge;
    });
    const env = makeEnvelope(src.ydoc);
    // Force the recorded doomLike schema to the OLD version (a real v1 save).
    env.moduleSchemas['doomLike'] = 1;

    const dest = freshPatch();
    const result = loadEnvelopeIntoStore(parseEnvelope(serializeEnvelope(env)), dest.ydoc, dest.store);
    expect(result.edgesLoaded).toBe(1);
    expect(dest.store.edges['e1']!.target.portId).toBe('p1_up');
  });
});

describe('persistence: portable performance snapshot (per-user layout baking)', () => {
  const USER = 'user-alice';

  it('bakes the saving user\'s layout override into node.position and clears layouts', () => {
    const { ydoc, store } = freshPatch();
    ydoc.transact(() => {
      store.nodes['vco'] = {
        id: 'vco',
        type: 'analogVco',
        domain: 'audio',
        position: { x: 100, y: 200 }, // stale spawn position
        params: { tune: 5, fine: 0 },
      };
      store.nodes['out'] = {
        id: 'out',
        type: 'audioOut',
        domain: 'audio',
        position: { x: 600, y: 200 }, // stale spawn position
        params: { master: 0.5 },
      };
    });
    // Multiplayer drag-stop: the user moved both cards. These writes go to the
    // per-user layouts map, NOT node.position (the bug's root cause).
    setNodePosition(ydoc, USER, 'vco', { x: 333, y: 444 });
    setNodePosition(ydoc, USER, 'out', { x: 999, y: 111 });
    // Sanity: node.position is still the stale spawn position.
    expect(ydoc.getMap('nodes').get('vco')).toBeDefined();
    expect((ydoc.getMap('layouts').get(USER) as Y.Map<unknown> | undefined)?.size).toBe(2);

    // Produce the portable envelope as the saving user.
    const env = makePortableEnvelope(ydoc, USER);

    // Load into a brand-new doc as a DIFFERENT (or absent) user — this is where
    // the old non-portable snapshot lost placement.
    const dest = freshPatch();
    loadEnvelopeIntoStore(parseEnvelope(serializeEnvelope(env)), dest.ydoc, dest.store);

    // Positions are now baked into node.position so any loader sees them.
    expect(dest.store.nodes['vco']!.position).toEqual({ x: 333, y: 444 });
    expect(dest.store.nodes['out']!.position).toEqual({ x: 999, y: 111 });
    // The per-user layouts map is dropped from the portable snapshot.
    expect(dest.ydoc.getMap('layouts').size).toBe(0);
  });

  it('does not mutate the live ydoc (temp-doc approach, no peer broadcast)', () => {
    const { ydoc, store } = freshPatch();
    ydoc.transact(() => {
      store.nodes['vco'] = {
        id: 'vco',
        type: 'analogVco',
        domain: 'audio',
        position: { x: 100, y: 200 },
        params: { tune: 5, fine: 0 },
      };
    });
    setNodePosition(ydoc, USER, 'vco', { x: 333, y: 444 });

    makePortableEnvelope(ydoc, USER);

    // Live doc is untouched: node.position is still the spawn value and the
    // user's layout override is still present.
    expect(store.nodes['vco']!.position).toEqual({ x: 100, y: 200 });
    const mine = ydoc.getMap('layouts').get(USER) as Y.Map<{ x: number; y: number }> | undefined;
    expect(mine?.get('vco')).toEqual({ x: 333, y: 444 });
  });

  it('keeps a node with no layout override at its canonical node.position', () => {
    const { ydoc, store } = freshPatch();
    ydoc.transact(() => {
      store.nodes['vco'] = {
        id: 'vco',
        type: 'analogVco',
        domain: 'audio',
        position: { x: 100, y: 200 },
        params: { tune: 5, fine: 0 },
      };
      store.nodes['out'] = {
        id: 'out',
        type: 'audioOut',
        domain: 'audio',
        position: { x: 600, y: 200 },
        params: { master: 0.5 },
      };
    });
    // Only 'vco' was dragged; 'out' keeps its canonical position.
    setNodePosition(ydoc, USER, 'vco', { x: 333, y: 444 });

    const env = makePortableEnvelope(ydoc, USER);
    const dest = freshPatch();
    loadEnvelopeIntoStore(parseEnvelope(serializeEnvelope(env)), dest.ydoc, dest.store);

    expect(dest.store.nodes['vco']!.position).toEqual({ x: 333, y: 444 });
    expect(dest.store.nodes['out']!.position).toEqual({ x: 600, y: 200 });
  });

  it('single-user mode (no userId): node.position is canonical, snapshot round-trips unchanged', () => {
    const { ydoc, store } = freshPatch();
    ydoc.transact(() => {
      store.nodes['vco'] = {
        id: 'vco',
        type: 'analogVco',
        domain: 'audio',
        position: { x: 100, y: 200 },
        params: { tune: 5, fine: 0 },
      };
    });
    // Single-user: setNodePosition is a no-op when userId is undefined; drags
    // mutate node.position directly. Simulate a moved card:
    ydoc.transact(() => {
      (ydoc.getMap('nodes').get('vco') as Y.Map<unknown>).set('position', (() => {
        const p = new Y.Map<number>();
        p.set('x', 50);
        p.set('y', 60);
        return p;
      })());
    });

    const env = makePortableEnvelope(ydoc, undefined);
    const dest = freshPatch();
    loadEnvelopeIntoStore(parseEnvelope(serializeEnvelope(env)), dest.ydoc, dest.store);

    expect(dest.store.nodes['vco']!.position).toEqual({ x: 50, y: 60 });
    expect(dest.ydoc.getMap('layouts').size).toBe(0);
  });
});

describe('persistence: OUTPUT aspect (videoAspect settings entry)', () => {
  it('read/write round-trips through the settings map', () => {
    const { ydoc } = freshPatch();
    expect(readVideoAspectFromDoc(ydoc)).toBeUndefined();
    writeVideoAspectToDoc(ydoc, '16:9');
    expect(readVideoAspectFromDoc(ydoc)).toBe('16:9');
    expect(ydoc.getMap(SETTINGS_MAP_KEY).get(SETTINGS_VIDEO_ASPECT)).toBe('16:9');
    writeVideoAspectToDoc(ydoc, '4:3');
    expect(readVideoAspectFromDoc(ydoc)).toBe('4:3');
  });

  it('coerces garbage / missing values to undefined (caller defaults 4:3)', () => {
    const { ydoc } = freshPatch();
    ydoc.getMap(SETTINGS_MAP_KEY).set(SETTINGS_VIDEO_ASPECT, 'banana');
    expect(readVideoAspectFromDoc(ydoc)).toBeUndefined();
  });

  it('save@16:9 → reload restores videoAspect into the loaded doc + result', () => {
    const src = freshPatch();
    src.ydoc.transact(() => {
      src.store.nodes['out'] = {
        id: 'out', type: 'analogVco', domain: 'audio',
        position: { x: 0, y: 0 }, params: { tune: 0 },
      };
    });
    writeVideoAspectToDoc(src.ydoc, '16:9');

    const env = makeEnvelope(src.ydoc);
    const dest = freshPatch();
    const result = loadEnvelopeIntoStore(parseEnvelope(serializeEnvelope(env)), dest.ydoc, dest.store);

    // The load result surfaces the aspect for the caller (Canvas → store/engine).
    expect(result.videoAspect).toBe('16:9');
    // …and it's restored into the live doc (re-syncs + persists on next save).
    expect(readVideoAspectFromDoc(dest.ydoc)).toBe('16:9');
  });

  it('legacy patch (no settings) → result.videoAspect undefined (load → 4:3)', () => {
    const src = freshPatch();
    src.ydoc.transact(() => {
      src.store.nodes['out'] = {
        id: 'out', type: 'analogVco', domain: 'audio',
        position: { x: 0, y: 0 }, params: { tune: 0 },
      };
    });
    // No writeVideoAspectToDoc — a pre-aspect-switch patch.
    const env = makeEnvelope(src.ydoc);
    const dest = freshPatch();
    const result = loadEnvelopeIntoStore(parseEnvelope(serializeEnvelope(env)), dest.ydoc, dest.store);
    expect(result.videoAspect).toBeUndefined();
    expect(readVideoAspectFromDoc(dest.ydoc)).toBeUndefined();
  });
});
