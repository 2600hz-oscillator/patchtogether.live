// packages/web/src/lib/ui/restored-video-boot.test.ts
//
// Unit gate on the persisted-rack VIDEO boot predicate. This is the extractable
// core of the Canvas.svelte `$effect` that fixes "restored video is dead until
// you add/delete a node" (fix/video-engine-persist-reconcile).

import { describe, it, expect } from 'vitest';
import { shouldBootEngineForRestoredVideo } from './restored-video-boot';

const vid = { domain: 'video' as const };
const aud = { domain: 'audio' as const };
const meta = { domain: 'meta' as const };

describe('shouldBootEngineForRestoredVideo', () => {
  it('boots once a LOADED restored graph contains a video node (the fix)', () => {
    expect(
      shouldBootEngineForRestoredVideo({ loaded: true, engineBooted: false, nodes: [vid] }),
    ).toBe(true);
    // Mixed graph: a single video node is enough.
    expect(
      shouldBootEngineForRestoredVideo({
        loaded: true,
        engineBooted: false,
        nodes: [aud, meta, vid],
      }),
    ).toBe(true);
  });

  it('does NOT boot before the persisted graph has loaded (avoids a partial-graph boot)', () => {
    // The video node is present but the seed/sync has not resolved yet — hold
    // off; the bus-driven reconciler catches it once a later state boots.
    expect(
      shouldBootEngineForRestoredVideo({ loaded: false, engineBooted: false, nodes: [vid] }),
    ).toBe(false);
  });

  it('does NOT boot when the engine is already up (reconciler keeps it live via the bus)', () => {
    expect(
      shouldBootEngineForRestoredVideo({ loaded: true, engineBooted: true, nodes: [vid] }),
    ).toBe(false);
  });

  it('does NOT boot an audio-only / empty restored rack (keeps the lazy gesture boot)', () => {
    expect(
      shouldBootEngineForRestoredVideo({ loaded: true, engineBooted: false, nodes: [aud, meta] }),
    ).toBe(false);
    expect(
      shouldBootEngineForRestoredVideo({ loaded: true, engineBooted: false, nodes: [] }),
    ).toBe(false);
  });
});
