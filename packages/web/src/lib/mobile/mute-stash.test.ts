// Mute-stash — tested against the REAL singleton Y.Doc store (the
// yjs-save-load rule: never mock Y flows; mutateNode writes through the live
// SyncedStore proxy and the "Type already integrated" class only reproduces
// on real Yjs types).

import { beforeEach, describe, expect, it } from 'vitest';
import { patch, ydoc, undoManager, LOCAL_ORIGIN } from '$lib/graph/store';
import type { ModuleNode } from '$lib/graph/types';
import {
  CH_VOLUME_DEFAULT,
  isChannelMuted,
  muteStashKey,
  toggleChannelMute,
} from './mute-stash';

const MIX_ID = 'mixmstrs-mutetest';

function seedMixNode(params: Record<string, number> = {}): void {
  ydoc.transact(() => {
    // Clear leftovers from previous tests (the store is a module singleton).
    for (const id of Object.keys(patch.nodes)) delete patch.nodes[id];
    for (const id of Object.keys(patch.edges)) delete patch.edges[id];
    patch.nodes[MIX_ID] = {
      id: MIX_ID,
      type: 'mixmstrs',
      domain: 'audio',
      position: { x: 0, y: 0 },
      params: { ...params },
      data: { name: 'MIXMSTRS' },
    };
  }, LOCAL_ORIGIN);
}

function liveNode(): ModuleNode {
  return patch.nodes[MIX_ID] as ModuleNode;
}

describe('toggleChannelMute (real Y.Doc)', () => {
  beforeEach(() => {
    seedMixNode({ ch1_volume: 0.62 });
    undoManager.clear();
  });

  it('mute stashes the live volume and zeroes the fader', () => {
    toggleChannelMute(MIX_ID, 1);
    const n = liveNode();
    expect(n.params.ch1_volume).toBe(0);
    expect((n.data as Record<string, unknown>)[muteStashKey(1)]).toBe(0.62);
    expect(isChannelMuted(n, 1)).toBe(true);
  });

  it('unmute restores the stashed volume and clears the stash key', () => {
    toggleChannelMute(MIX_ID, 1);
    toggleChannelMute(MIX_ID, 1);
    const n = liveNode();
    expect(n.params.ch1_volume).toBe(0.62);
    expect((n.data as Record<string, unknown>)[muteStashKey(1)]).toBeUndefined();
    expect(isChannelMuted(n, 1)).toBe(false);
  });

  it('an untouched fader (no param yet) stashes the 0.8 default', () => {
    toggleChannelMute(MIX_ID, 2);
    const n = liveNode();
    expect(n.params.ch2_volume).toBe(0);
    expect((n.data as Record<string, unknown>)[muteStashKey(2)]).toBe(CH_VOLUME_DEFAULT);
    toggleChannelMute(MIX_ID, 2);
    expect(liveNode().params.ch2_volume).toBe(CH_VOLUME_DEFAULT);
  });

  it('per-channel independence: muting ch1 leaves ch3 untouched', () => {
    toggleChannelMute(MIX_ID, 1);
    const n = liveNode();
    expect(isChannelMuted(n, 3)).toBe(false);
    expect(n.params.ch3_volume).toBeUndefined();
  });

  it('is UNDOABLE: undo after mute restores the volume and drops the stash', async () => {
    toggleChannelMute(MIX_ID, 1);
    expect(liveNode().params.ch1_volume).toBe(0);
    // captureTimeout batches within 500ms — stopCapturing splits the units.
    undoManager.stopCapturing();
    undoManager.undo();
    const n = liveNode();
    expect(n.params.ch1_volume).toBe(0.62);
    expect(isChannelMuted(n, 1)).toBe(false);
  });

  it('no-op on a missing node (mutateNode safe no-op path)', () => {
    expect(() => toggleChannelMute('mixmstrs-gone', 1)).not.toThrow();
  });
});
