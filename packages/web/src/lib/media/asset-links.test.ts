// packages/web/src/lib/media/asset-links.test.ts
//
// WORKFLOW MODE P3 — the local assetId↔nodeId link map's lifecycle:
// ordered registration (nodesFor()[0] = the PRIMARY module subsequent
// drags reuse), additional-module bookkeeping, per-node/per-asset
// unregistration, the delete-by-any-path prune, and the per-rackspace
// clear. (Placement rationale — local, never synced — is documented in
// asset-links.svelte.ts.)

import { describe, expect, it } from 'vitest';
import { createAssetLinks } from './asset-links.svelte.js';

describe('asset-links', () => {
  it('register keeps creation order: first module stays PRIMARY, extras append', () => {
    const links = createAssetLinks();
    links.register('media-1', 'node-a');
    links.register('media-1', 'node-b'); // "add additional output module"
    expect(links.nodesFor('media-1')).toEqual(['node-a', 'node-b']);
    expect(links.primaryFor('media-1')).toBe('node-a');
    expect(links.isLinked('media-1')).toBe(true);
    // Duplicate registration is a no-op (idempotent rebind sweep).
    links.register('media-1', 'node-a');
    expect(links.nodesFor('media-1')).toEqual(['node-a', 'node-b']);
  });

  it('unlinked assets read empty', () => {
    const links = createAssetLinks();
    expect(links.nodesFor('media-9')).toEqual([]);
    expect(links.primaryFor('media-9')).toBeNull();
    expect(links.isLinked('media-9')).toBe(false);
    expect(links.assetForNode('node-x')).toBeNull();
  });

  it('assetForNode resolves the owning asset', () => {
    const links = createAssetLinks();
    links.register('media-1', 'node-a');
    links.register('media-2', 'node-b');
    expect(links.assetForNode('node-a')).toBe('media-1');
    expect(links.assetForNode('node-b')).toBe('media-2');
  });

  it('unregisterNode removes just that module; the second becomes primary; last removal drops the asset', () => {
    const links = createAssetLinks();
    links.register('media-1', 'node-a');
    links.register('media-1', 'node-b');
    links.unregisterNode('node-a');
    expect(links.nodesFor('media-1')).toEqual(['node-b']);
    expect(links.primaryFor('media-1')).toBe('node-b');
    links.unregisterNode('node-b');
    expect(links.isLinked('media-1')).toBe(false);
  });

  it('unregisterAsset drops every module link for the asset (unload path)', () => {
    const links = createAssetLinks();
    links.register('media-1', 'node-a');
    links.register('media-1', 'node-b');
    links.register('media-2', 'node-c');
    links.unregisterAsset('media-1');
    expect(links.isLinked('media-1')).toBe(false);
    expect(links.nodesFor('media-2')).toEqual(['node-c']); // untouched
  });

  it('pruneMissing drops dead nodeIds (deleted by any path) and empty assets', () => {
    const links = createAssetLinks();
    links.register('media-1', 'node-a');
    links.register('media-1', 'node-b');
    links.register('media-2', 'node-c');
    links.pruneMissing(new Set(['node-b']));
    expect(links.nodesFor('media-1')).toEqual(['node-b']);
    expect(links.isLinked('media-2')).toBe(false);
  });

  it('clear wipes everything (per-rackspace hygiene)', () => {
    const links = createAssetLinks();
    links.register('media-1', 'node-a');
    links.clear();
    expect(links.isLinked('media-1')).toBe(false);
    expect(links.nodesFor('media-1')).toEqual([]);
  });
});
