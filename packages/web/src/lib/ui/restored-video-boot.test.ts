// packages/web/src/lib/ui/restored-video-boot.test.ts
//
// Unit gate on the persisted-rack VIDEO boot predicate. This is the extractable
// core of the Canvas.svelte `$effect` that fixes "restored video is dead until
// you add/delete a node" (fix/video-engine-persist-reconcile).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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

describe('the Canvas wiring re-checks at CALL TIME (#1623) — anchored to the source', () => {
  // The pure guard above is evaluated when the $effect FIRES; the async body
  // it gates runs later, and `ensureEngine()` resumes a suspended
  // AudioContext on every call. Without a call-time re-check, a boot queued
  // pre-suspend lands post-suspend — measured: vrt-strict's face capture
  // re-froze the graph SIX times and this queued call still resumed it after
  // the last retry. The pure test cannot see the wiring, so this leg reads
  // the artifact itself: the async body must bail on a live engine BEFORE
  // calling ensureEngine().
  it('the restored-video async body bails on a live engine before ensureEngine()', () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'Canvas.svelte'),
      'utf8',
    );
    const effectStart = src.indexOf('shouldBootEngineForRestoredVideo({');
    expect(effectStart, 'the restored-video boot effect must exist in Canvas').toBeGreaterThan(-1);
    // Bounded window rather than brace-matching: wide enough to hold the
    // whole async body, narrow enough that a re-check ANYWHERE else in the
    // 8k-line file cannot satisfy this leg.
    const asyncBody = src.slice(effectStart, effectStart + 2500);
    const recheck = asyncBody.indexOf('if (engine != null) return;');
    const boot = asyncBody.indexOf('await ensureEngine()');
    expect(recheck, 'the call-time re-check is missing — the #1623 TOCTOU is open').toBeGreaterThan(-1);
    expect(boot).toBeGreaterThan(-1);
    expect(recheck, 're-check must run BEFORE the boot, not after').toBeLessThan(boot);
  });
});
