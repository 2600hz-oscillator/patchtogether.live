// packages/web/src/lib/media/asset-spawn.test.ts
//
// WORKFLOW MODE P3 — the asset↔module lifecycle against the REAL
// syncedStore + Y.Doc (graph/store.ts — never a mock,
// [[yjs-save-load-real-ydoc]]) and the real library/link singletons:
//
//   * unloadAsset deletes EVERY linked module (removePatchNode — edges
//     drop with the node) + the library item;
//   * ensureAssetModule reuses the PRIMARY linked module
//     (drag-from-existing never spawns a second one);
//   * createAssetModule rolls the node back when the media can't load
//     (no empty husk) and surfaces the reason;
//   * planAssetRebinds (pure) + runAssetRebindSweep re-link nodes whose
//     persisted descriptor dupe-key-matches a loaded library item.
//
// The media-load drivers themselves (samsloop decode, picturebox encode,
// varispeed IDB blob) are browser-API paths — covered by the
// workflow-media e2e in a real browser.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
import type { ModuleNode } from '$lib/graph/types';
import { mediaLibrary, type MediaItem } from './library.svelte.js';
import { assetLinks } from './asset-links.svelte.js';
import {
  createAssetModule,
  ensureAssetModule,
  unloadAsset,
  planAssetRebinds,
  runAssetRebindSweep,
} from './asset-spawn';
import { mediaDescriptorOf } from './asset-modules';

function makeFile(name: string, type = 'audio/wav', bytes = 8, lastModified = 42): File {
  return new File([new Uint8Array(bytes)], name, { type, lastModified });
}

/** Add one real item to the singleton library (the probe fails harmlessly
 *  in node — status flips to 'failed'; items stay fully usable). */
function addItem(name: string, kind: 'audio' | 'image' | 'video' = 'audio'): MediaItem {
  const mime = kind === 'audio' ? 'audio/wav' : kind === 'image' ? 'image/png' : 'video/mp4';
  const res = mediaLibrary.add([{ file: makeFile(name, mime), kind, relativePath: name }]);
  return res.added[0];
}

function seedNode(id: string, type: string, data: Record<string, unknown> = {}): void {
  ydoc.transact(() => {
    patch.nodes[id] = {
      id,
      type,
      domain: type === 'samsloop' ? 'audio' : 'video',
      position: { x: 0, y: 0 },
      params: {},
      data,
    } as ModuleNode;
  }, LOCAL_ORIGIN);
}

function reset(): void {
  ydoc.transact(() => {
    for (const id of Object.keys(patch.edges)) delete patch.edges[id];
    for (const id of Object.keys(patch.nodes)) delete patch.nodes[id];
  }, LOCAL_ORIGIN);
  assetLinks.clear();
  mediaLibrary.clear();
}

beforeEach(reset);
afterEach(reset);

describe('unloadAsset', () => {
  it('deletes every linked module (edges included) + the library item + the links', () => {
    const item = addItem('kick.wav');
    seedNode('asset-a', 'samsloop', { mediaDesc: mediaDescriptorOf(item) });
    seedNode('asset-b', 'samsloop', { mediaDesc: mediaDescriptorOf(item) });
    seedNode('dest', 'adsr');
    ydoc.transact(() => {
      patch.edges['e-1'] = {
        id: 'e-1',
        source: { nodeId: 'asset-a', portId: 'out' },
        target: { nodeId: 'dest', portId: 'gate' },
        sourceType: 'audio',
        targetType: 'gate',
      };
    }, LOCAL_ORIGIN);
    assetLinks.register(item.id, 'asset-a');
    assetLinks.register(item.id, 'asset-b');

    unloadAsset(item.id);

    expect(patch.nodes['asset-a']).toBeUndefined();
    expect(patch.nodes['asset-b']).toBeUndefined();
    expect(patch.nodes['dest']).toBeDefined(); // the wire's target survives
    expect(patch.edges['e-1']).toBeUndefined(); // edge died with its node
    expect(assetLinks.isLinked(item.id)).toBe(false);
    expect(mediaLibrary.get(item.id)).toBeUndefined();
  });
});

describe('ensureAssetModule — drag-from-existing', () => {
  it('returns the PRIMARY linked module without creating a second one', async () => {
    const item = addItem('kick.wav');
    seedNode('asset-first', 'samsloop', { mediaDesc: mediaDescriptorOf(item) });
    seedNode('asset-extra', 'samsloop', { mediaDesc: mediaDescriptorOf(item) });
    assetLinks.register(item.id, 'asset-first');
    assetLinks.register(item.id, 'asset-extra');

    const before = Object.keys(patch.nodes).length;
    const res = await ensureAssetModule(item, { currentUserId: null });
    expect(res).toEqual({ nodeId: 'asset-first', portId: 'out' });
    expect(Object.keys(patch.nodes)).toHaveLength(before); // nothing spawned
  });

  it('a dead primary link does not resolve (falls through to creation path)', async () => {
    const item = addItem('kick.wav');
    assetLinks.register(item.id, 'ghost-node'); // node never existed
    // Creation then runs — and rolls back (no audio engine in unit tests),
    // which is exactly the "no empty husk" contract below.
    const errors: string[] = [];
    const res = await ensureAssetModule(item, {
      currentUserId: null,
      onError: (m) => errors.push(m),
    });
    expect(res).toBeNull();
    expect(errors).toHaveLength(1);
  });
});

describe('createAssetModule — rollback on media-load failure', () => {
  it('removes the just-created node and surfaces the reason when the sample cannot load', async () => {
    const item = addItem('kick.wav'); // audio → samsloop → needs an AudioContext
    const errors: string[] = [];
    const res = await createAssetModule(item, {
      currentUserId: null,
      onError: (m) => errors.push(m),
    });
    expect(res).toBeNull();
    expect(Object.keys(patch.nodes)).toHaveLength(0); // rolled back
    expect(assetLinks.isLinked(item.id)).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/audio engine/i);
  });
});

describe('planAssetRebinds (pure)', () => {
  const item = {
    id: 'media-7',
    name: 'kick.wav',
    size: 8,
    lastModified: 42,
    kind: 'audio' as const,
  };
  const desc = mediaDescriptorOf(item);

  it('matches unlinked descriptor-carrying nodes by dupe-key', () => {
    const plan = planAssetRebinds(
      [
        { id: 'n1', data: { mediaDesc: desc } },
        { id: 'n2', data: { mediaDesc: { ...desc, size: 9 } } }, // no match
        { id: 'n3', data: {} }, // no descriptor
      ],
      [item],
      new Set(),
    );
    expect(plan).toEqual([{ nodeId: 'n1', item }]);
  });

  it('skips nodes already linked this session', () => {
    const plan = planAssetRebinds([{ id: 'n1', data: { mediaDesc: desc } }], [item], new Set(['n1']));
    expect(plan).toEqual([]);
  });
});

describe('runAssetRebindSweep', () => {
  it('re-links a matching node whose media is already in the doc (link-only rebind)', async () => {
    const item = addItem('kick.wav');
    seedNode('restored', 'samsloop', {
      mediaDesc: mediaDescriptorOf(item),
      fileBytesB64: 'QUJD', // bytes present in-doc → no load-path re-drive
    });

    await runAssetRebindSweep({ currentUserId: null });

    expect(assetLinks.nodesFor(item.id)).toEqual(['restored']);
    // Untouched data — the sweep only linked.
    expect((patch.nodes['restored']!.data as Record<string, unknown>).fileBytesB64).toBe('QUJD');
  });

  it('leaves unrelated nodes and non-matching items alone; sweep is idempotent', async () => {
    const item = addItem('kick.wav');
    seedNode('other', 'adsr');
    seedNode('mismatch', 'samsloop', {
      mediaDesc: { name: 'other.wav', size: 1, lastModified: 2, kind: 'audio' },
      fileBytesB64: 'QUJD',
    });

    await runAssetRebindSweep({ currentUserId: null });
    expect(assetLinks.isLinked(item.id)).toBe(false);

    await runAssetRebindSweep({ currentUserId: null }); // second run: no throw, no change
    expect(assetLinks.isLinked(item.id)).toBe(false);
  });
});
