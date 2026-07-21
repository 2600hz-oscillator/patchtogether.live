// e2e/tests/scratch-persist-video-live.spec.ts
//
// REGRESSION (fix/video-engine-persist-reconcile) — the owner-reported bug:
// returning to a persisted rack (e.g. a PR-preview rack loaded from the /rack
// scratch IndexedDB replica) restores the module GRAPH, but the VIDEO CONTENT
// is DEAD (black/frozen); re-adding a source, or DELETING one, brings the video
// back. Root cause: the PatchEngine + auto-reconciler boot lazily via Canvas's
// ensureEngine(), which only runs on a user graph-mutation (spawn / duplicate /
// load) — NOT on a persisted-graph load. So a restored rack never instantiates
// its video nodes and the VideoEngine rAF render loop never starts, until any
// add/delete forces ensureEngine() to boot + reconcile the whole (already
// seeded) graph.
//
// This spec drives the owner's exact repro through the REAL persistence path:
// seed TWO acidwarp -> videoOut chains on /rack, flush to IndexedDB, RELOAD (a
// full new JS context), then assert BOTH restored chains are LIVE (their video
// nodes advance frames) WITHOUT any manual add/delete. Two chains cover the
// second symptom directly: on a fresh load ALL restored video is live, so the
// "delete one to revive the others" workaround is no longer needed.
//
// Liveness is probed via the engine's per-node draw counter (framesDrawnFor) —
// a renderer-INDEPENDENT integer, so the assertion is stable on CI's SwiftShader
// software renderer (no pixel-precision dependency). The render window is a few
// frames (poll for +2), so this is light despite driving the REAL (un-paused)
// loop; acidwarp is a cheap 320x240 procedural plasma source.
//
// Runs on /rack (no DB / no relay — the scratch replica is pure client
// IndexedDB). Gated on IndexedDB availability so a hardened/private environment
// skips instead of failing.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

const REPLICA_DB_PREFIX = 'pt-rack-v1-';
const scratchStorageKey = (mode: 'dawless' | 'workflow') => `pt:local-scratch-id:${mode}`;

async function readScratchId(page: Page, mode: 'dawless' | 'workflow'): Promise<string | null> {
  return page.evaluate((key) => window.localStorage.getItem(key), scratchStorageKey(mode));
}

/** Poll until the page has minted a scratch id for the mode, then return it. */
async function waitForScratchId(page: Page, mode: 'dawless' | 'workflow'): Promise<string> {
  await expect
    .poll(() => readScratchId(page, mode), { timeout: 10_000 })
    .toMatch(new RegExp(`^local-scratch-${mode}-`));
  const id = await readScratchId(page, mode);
  if (!id) throw new Error(`scratch id for ${mode} never appeared`);
  return id;
}

/** Count the update rows in a replica DB WITHOUT creating it. A rising count
 *  proves the most recent doc edit flushed to IndexedDB before we reload. */
async function replicaRowCount(page: Page, scratchId: string): Promise<number> {
  const dbName = `${REPLICA_DB_PREFIX}${scratchId}`;
  return page.evaluate(async (name) => {
    const list = (await (indexedDB as unknown as { databases?: () => Promise<{ name?: string }[]> })
      .databases?.()) ?? [];
    if (!list.some((d) => d.name === name)) return 0;
    return new Promise<number>((resolve) => {
      const req = indexedDB.open(name);
      req.onerror = () => resolve(0);
      req.onupgradeneeded = () => {
        /* existing DB shouldn't upgrade; if it somehow does, don't seed a schema */
      };
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('updates')) {
          db.close();
          resolve(0);
          return;
        }
        const tx = db.transaction('updates', 'readonly');
        const keys = tx.objectStore('updates').getAllKeys();
        keys.onsuccess = () => {
          db.close();
          resolve((keys.result as unknown[]).length);
        };
        keys.onerror = () => {
          db.close();
          resolve(0);
        };
      };
    });
  }, dbName);
}

/** True once the PatchEngine has booted (the dev `__engine` global returns a
 *  non-null engine). On the BUGGED build this never flips after a plain reload
 *  — nothing calls ensureEngine() — so the wait below is exactly the regression. */
async function engineBooted(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const w = globalThis as unknown as { __engine?: () => unknown };
    try {
      return typeof w.__engine === 'function' && w.__engine() != null;
    } catch {
      return false;
    }
  });
}

/** Read the VideoEngine per-node cumulative draw counter for each id. Returns
 *  -1 for a node when the engine/domain isn't available yet. */
async function framesDrawn(page: Page, ids: string[]): Promise<Record<string, number>> {
  return page.evaluate((nodeIds) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        getDomain: (d: string) => { framesDrawnFor: (id: string) => number };
      } | null;
    };
    const out: Record<string, number> = {};
    let vid: { framesDrawnFor: (id: string) => number } | null = null;
    try {
      vid = w.__engine?.()?.getDomain('video') ?? null;
    } catch {
      vid = null;
    }
    for (const id of nodeIds) out[id] = vid ? vid.framesDrawnFor(id) : -1;
    return out;
  }, ids);
}

test.describe('persisted rack — restored video is live without a manual add/delete', () => {
  // OPT IN to the scratch replica (default OFF under webdriver). addInitScript
  // runs before every document, including the reload.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __ptScratchReplica?: boolean }).__ptScratchReplica = true;
    });
  });

  test('two acidwarp -> videoOut chains keep rendering after a reload (owner bug)', async ({
    page,
  }) => {
    test.setTimeout(90_000);

    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    const idbOk = await page.evaluate(
      () => typeof indexedDB !== 'undefined' && indexedDB !== null,
    );
    test.skip(!idbOk, 'IndexedDB unavailable — scratch replica cannot persist');

    const scratchId = await waitForScratchId(page, 'dawless');
    const before = await replicaRowCount(page, scratchId);

    // Seed TWO independent video chains through the REAL graph path (spawnPatch
    // drives the same Y.Doc the replica mirrors). acidwarp = a cheap procedural
    // source; videoOut = the visible sink.
    await spawnPatch(
      page,
      [
        { id: 'aw1', type: 'acidwarp', position: { x: 80, y: 80 }, domain: 'video' },
        { id: 'out1', type: 'videoOut', position: { x: 480, y: 80 }, domain: 'video' },
        { id: 'aw2', type: 'acidwarp', position: { x: 80, y: 420 }, domain: 'video' },
        { id: 'out2', type: 'videoOut', position: { x: 480, y: 420 }, domain: 'video' },
      ],
      [
        { id: 'e1', from: { nodeId: 'aw1', portId: 'out' }, to: { nodeId: 'out1', portId: 'in' }, sourceType: 'video', targetType: 'video' },
        { id: 'e2', from: { nodeId: 'aw2', portId: 'out' }, to: { nodeId: 'out2', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      ],
    );

    // Deterministic flush: the replica wrote at least one more update row.
    await expect
      .poll(() => replicaRowCount(page, scratchId), { timeout: 10_000 })
      .toBeGreaterThan(before);

    // THE RELOAD — a full document reload = new JS context = fresh empty doc that
    // must be rehydrated from the IndexedDB replica. This is the owner's "return
    // to the rack" moment.
    await page.reload();
    await page.waitForLoadState('networkidle');

    // The GRAPH is restored (the cards mount straight off the seeded snapshot).
    for (const id of ['aw1', 'out1', 'aw2', 'out2']) {
      await expect(page.locator(`.svelte-flow__node[data-id="${id}"]`)).toBeVisible({
        timeout: 15_000,
      });
    }
    expect(await readScratchId(page, 'dawless')).toBe(scratchId);

    // THE REGRESSION: WITHOUT any add/delete, the engine boots on its own and the
    // restored video renders. On the bugged build __engine() stays null forever
    // here (nothing calls ensureEngine on a plain load) → this poll times out.
    await expect.poll(() => engineBooted(page), { timeout: 20_000 }).toBe(true);

    // BOTH restored chains are LIVE: each source's draw counter ADVANCES (the
    // rAF loop runs AND the node is in the active render set). A dead/black
    // chain would leave its counter flat. Two chains cover the second symptom
    // (a fresh load is fully live → no "delete one to revive the others").
    const base = await framesDrawn(page, ['aw1', 'aw2']);
    await expect
      .poll(async () => (await framesDrawn(page, ['aw1', 'aw2'])).aw1, { timeout: 15_000 })
      .toBeGreaterThan(base.aw1 + 1);
    await expect
      .poll(async () => (await framesDrawn(page, ['aw1', 'aw2'])).aw2, { timeout: 15_000 })
      .toBeGreaterThan(base.aw2 + 1);
  });
});
