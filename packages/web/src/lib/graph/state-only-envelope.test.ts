// packages/web/src/lib/graph/state-only-envelope.test.ts
//
// makeStateOnlyEnvelope: the history-free export. Three contracts:
//   1. It round-trips through loadEnvelopeIntoStore exactly like the portable
//      envelope — same nodes/edges/settings, positions baked, layouts dropped.
//   2. Its size scales with STATE, not SESSION LENGTH: aging the source doc
//      with thousands of net-zero edit transactions must not grow it, while
//      the same aging demonstrably grows the portable envelope (the negative
//      control proving the aging really produced history).
//   3. Session-scoped shares no loader reads (meta, layouts) don't ride along.

import { describe, it, expect, beforeAll } from 'vitest';
import * as Y from 'yjs';
import { syncedStore, getYjsDoc } from '@syncedstore/core';
import {
  makePortableEnvelope,
  makeStateOnlyEnvelope,
  parseEnvelope,
  serializeEnvelope,
  loadEnvelopeIntoStore,
  ENVELOPE_VERSION,
  SETTINGS_MAP_KEY,
  SETTINGS_VIDEO_ASPECT,
  type LivePatch,
} from './persistence';
import { setNodePosition } from '$lib/multiplayer/layouts';
import {
  readPresentBindingsFromUpdate,
  SETTINGS_PRESENT_BINDINGS,
  type PresentBinding,
} from '$lib/ui/modules/present-bindings';
import type { ModuleNode, Edge } from './types';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { registerModule } from '$lib/audio/module-registry';

const throwingFactory = (): never => {
  throw new Error('factory should not be called from persistence tests');
};

const testVcoDef: AudioModuleDef = {
  type: 'analogVco',
  domain: 'audio',
  label: 'Analog VCO',
  category: 'sources',
  inputs: [{ id: 'pitch', type: 'pitch' }],
  outputs: [{ id: 'sine', type: 'audio' }],
  params: [
    { id: 'tune', label: 'Tune', defaultValue: 0, min: -36, max: 36, curve: 'linear' },
  ],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  factory: throwingFactory as any,
};

const testOutDef: AudioModuleDef = {
  type: 'audioOut',
  domain: 'audio',
  label: 'Audio Out',
  category: 'output',
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

function freshPatch() {
  const store = syncedStore<{ nodes: Record<string, ModuleNode>; edges: Record<string, Edge> }>({
    nodes: {},
    edges: {},
  });
  const ydoc = getYjsDoc(store);
  return { store: store as unknown as LivePatch, ydoc };
}

const PRESENT_BINDING: PresentBinding = {
  nodeId: 'vco',
  screen: { label: 'DELL U2720Q', isInternal: false, width: 3840, height: 2160, dpr: 2, left: 0, top: 0 },
};

/** Seed the canonical two-node patch (nested data included) + settings. */
function seedPatch(p: ReturnType<typeof freshPatch>) {
  p.ydoc.transact(() => {
    p.store.nodes['vco'] = {
      id: 'vco',
      type: 'analogVco',
      domain: 'audio',
      position: { x: 100, y: 200 },
      params: { tune: 7 },
      data: {
        customName: 'lead',
        // clip-pattern-shaped nested content (arrays of objects)
        steps: [{ on: true, midi: 60 }, { on: false, midi: null }, { on: true, midi: 72 }],
      },
    };
    p.store.nodes['out'] = {
      id: 'out',
      type: 'audioOut',
      domain: 'audio',
      position: { x: 600, y: 200 },
      params: { master: 0.42 },
    };
    p.store.edges['e1'] = {
      id: 'e1',
      source: { nodeId: 'vco', portId: 'sine' },
      target: { nodeId: 'out', portId: 'L' },
      sourceType: 'audio',
      targetType: 'audio',
    };
    p.ydoc.getMap(SETTINGS_MAP_KEY).set(SETTINGS_VIDEO_ASPECT, '16:9');
    p.ydoc.getMap(SETTINGS_MAP_KEY).set(SETTINGS_PRESENT_BINDINGS, [PRESENT_BINDING]);
  });
}

/** Age the doc with `n` NET-ZERO edit transactions: every param write is
 *  reverted and every scratch node deleted, so the materialized state after
 *  aging is byte-for-byte the state before it — only CRDT history grows. */
function ageNetZero(p: ReturnType<typeof freshPatch>, n: number) {
  const nodes = p.store.nodes as Record<string, ModuleNode | undefined>;
  for (let t = 0; t < n; t++) {
    p.ydoc.transact(() => {
      if (t % 3 === 0) {
        const id = `scratch-${t}`;
        nodes[id] = {
          id,
          type: 'analogVco',
          domain: 'audio',
          position: { x: t, y: t },
          params: { tune: t % 36 },
        };
        delete nodes[id];
      } else {
        (nodes['vco']!.params as Record<string, unknown>).tune = t % 36;
        (nodes['vco']!.params as Record<string, unknown>).tune = 7;
      }
    });
  }
}

function decode(update: string): Y.Doc {
  const binary = atob(update);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bytes);
  return doc;
}

beforeAll(() => {
  registerModule(testVcoDef);
  registerModule(testOutDef);
});

describe('makeStateOnlyEnvelope', () => {
  it('round-trips nodes, edges, and settings through loadEnvelopeIntoStore', () => {
    const src = freshPatch();
    seedPatch(src);
    ageNetZero(src, 200);

    const env = parseEnvelope(serializeEnvelope(makeStateOnlyEnvelope(src.ydoc, undefined)));
    expect(env.envelopeVersion).toBe(ENVELOPE_VERSION);

    const dst = freshPatch();
    const result = loadEnvelopeIntoStore(env, dst.ydoc, dst.store);

    expect(result.diagnostics).toEqual([]);
    expect(result.nodesLoaded).toBe(2);
    expect(result.edgesLoaded).toBe(1);
    expect(result.videoAspect).toBe('16:9');
    expect(JSON.parse(JSON.stringify(dst.store.nodes))).toEqual(
      JSON.parse(JSON.stringify(src.store.nodes)),
    );
    expect(JSON.parse(JSON.stringify(dst.store.edges))).toEqual(
      JSON.parse(JSON.stringify(src.store.edges)),
    );
    // The settings map rides whole — presentBindings must be readable off the
    // envelope exactly as the zip-load path reads them.
    expect(readPresentBindingsFromUpdate(env.update)).toEqual([PRESENT_BINDING]);
  });

  it('materializes the identical state the portable envelope materializes', () => {
    const src = freshPatch();
    seedPatch(src);
    // Per-user layout override: both envelopes must bake it into node.position.
    setNodePosition(src.ydoc, 'u1', 'vco', { x: 1234, y: 567 });
    ageNetZero(src, 200);

    const portable = decode(makePortableEnvelope(src.ydoc, 'u1').update);
    const stateOnly = decode(makeStateOnlyEnvelope(src.ydoc, 'u1').update);

    for (const key of ['nodes', 'edges', SETTINGS_MAP_KEY]) {
      expect(stateOnly.getMap(key).toJSON()).toEqual(portable.getMap(key).toJSON());
    }
    const vco = stateOnly.getMap('nodes').toJSON()['vco'] as ModuleNode;
    expect(vco.position).toEqual({ x: 1234, y: 567 });
  });

  it('size scales with state, not session length — and re-encodes byte-stably', () => {
    const src = freshPatch();
    seedPatch(src);
    const before = makeStateOnlyEnvelope(src.ydoc, undefined).update.length;

    ageNetZero(src, 3000);

    const after = makeStateOnlyEnvelope(src.ydoc, undefined).update.length;
    const portable = makePortableEnvelope(src.ydoc, undefined).update.length;

    // Negative control: the aging really did bloat the history-carrying
    // envelope (else the invariance below would be vacuous).
    expect(portable, `portable=${portable}B stateOnly=${after}B (base64 chars)`).toBeGreaterThan(
      after * 2,
    );
    // The state-only envelope is invariant to that history. The rebuild
    // writes keys in SORTED order (persistence.ts), so identical state means
    // identical struct layout — but each rebuild's Y.Doc draws a fresh random
    // uint32 clientID, and that id's VARINT WIDTH (4B below 2^28, 5B at or
    // above) is written once per struct reference. MEASURED: this doc has 52
    // struct references, so two rebuilds differ by exactly 0B or exactly 52B
    // depending on the two draws — ±16 flaked CI on the 52B draw (PR #2257's
    // unit lane). 64 covers the full width swing for this fixture with room
    // for a handful of added structs; the NEGATIVE CONTROL above (portable
    // > 2x state-only) is what carries the actual size claim.
    expect(Math.abs(after - before), `before=${before}B after=${after}B`).toBeLessThanOrEqual(64);

    // No hidden pending state: applying the update to a fresh doc and
    // re-encoding reproduces it byte for byte.
    const env = makeStateOnlyEnvelope(src.ydoc, undefined);
    const reencoded = Y.encodeStateAsUpdate(decode(env.update));
    const binary = atob(env.update);
    const original = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) original[i] = binary.charCodeAt(i);
    expect(Buffer.from(reencoded).equals(Buffer.from(original))).toBe(true);
  });

  it('drops session-scoped shares no loader reads (meta, layouts)', () => {
    const src = freshPatch();
    seedPatch(src);
    src.ydoc.getMap('meta').set('epoch_ms', 1_722_000_000_000);
    setNodePosition(src.ydoc, 'u1', 'vco', { x: 50, y: 60 });

    const doc = decode(makeStateOnlyEnvelope(src.ydoc, 'u1').update);
    expect(doc.getMap('meta').size).toBe(0);
    expect(doc.getMap('layouts').size).toBe(0);
    // ...while the shares the loaders DO read are present and populated.
    expect(doc.getMap('nodes').size).toBe(2);
    expect(doc.getMap('edges').size).toBe(1);
    expect(doc.getMap(SETTINGS_MAP_KEY).size).toBe(2);
  });
});
