// e2e/tests/scratch-persist.spec.ts
//
// SCRATCH PERSISTENCE (FIX A) — the `/rack` scratch canvas mirrors its Y.Doc
// into an IndexedDB local replica keyed by a stable per-device id
// (localStorage `pt:local-scratch-id`), so a browser REFRESH rehydrates
// the patch instead of throwing it away. Before the fix the scratch doc lived
// only in a volatile in-memory Y.Doc — a reload = a new JS context = a fresh
// empty createPatch() = the whole rack gone (worst for logged-out users, whose
// ONLY canvas is `/rack`).
//
// This is data-durability coverage: add a node through the real graph path,
// prove it reached IndexedDB, reload, and assert it comes back — plus that the
// ONE scratch doc: there is one rack shell, so there is one replica.
//
// Runs on `/rack` (no DB / no relay needed — the scratch replica is pure
// client IndexedDB). Gated on IndexedDB availability so a hardened/private
// environment skips instead of failing.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

// The pinned-param test is FOUR full app boots (1 goto + a 3-reload guard
// loop, each reload a fresh JS context), so its cost is boot-count-driven and
// the default 30 s whole-test budget is a lottery ticket on a hot shard —
// measured losing one: timedOut → passed on the same SHA (run 33279114856,
// e2e shard 4/12, #1903 flake-gate red). Per-spec budget per boot-budget.ts;
// never in playwright.config.ts (WebGL attest basis).
test.describe.configure({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

// Contract strings mirrored from the source (lib/multiplayer/local-replica.ts
// REPLICA_DB_PREFIX + lib/multiplayer/local-scratch.ts key format). A change
// on either side should surface here — that's the point of pinning them.
const REPLICA_DB_PREFIX = 'pt-rack-v1-';
const SCRATCH_STORAGE_KEY = 'pt:local-scratch-id';

/** Read the persisted scratch id (null until the page has minted it — the
 *  top-level bind does so synchronously on mount). */
async function readScratchId(page: Page): Promise<string | null> {
  return page.evaluate((key) => window.localStorage.getItem(key), SCRATCH_STORAGE_KEY);
}

/** Poll until the page has persisted a scratch id, then return it. */
async function waitForScratchId(page: Page): Promise<string> {
  await expect
    .poll(() => readScratchId(page), { timeout: 10_000 })
    .toMatch(/^local-scratch-/);
  const id = await readScratchId(page);
  if (!id) throw new Error('scratch id never appeared');
  return id;
}

/** Count the update rows in a replica DB WITHOUT creating it (open only when
 *  indexedDB.databases() confirms it exists — an unconditional open would
 *  create an empty shell and race the replica). A rising count proves the
 *  most recent doc edit flushed to IndexedDB before we reload — a
 *  deterministic flush signal, no fixed sleep. */
async function replicaRowCount(page: Page, scratchId: string): Promise<number> {
  const dbName = `${REPLICA_DB_PREFIX}${scratchId}`;
  return page.evaluate(async (name) => {
    const list = (await (indexedDB as unknown as { databases?: () => Promise<{ name?: string }[]> })
      .databases?.()) ?? [];
    if (!list.some((d) => d.name === name)) return 0;
    return new Promise<number>((resolve) => {
      const req = indexedDB.open(name); // no version → open current, no upgrade
      req.onerror = () => resolve(0);
      req.onupgradeneeded = () => {
        /* existing DB shouldn't upgrade; if it somehow does, don't seed a
           schema — the transaction resolves 0 below */
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

/** Add a node to the live graph (spawnPatch drives the real Y.Doc the replica
 *  mirrors), then BLOCK until that write has flushed to IndexedDB. */
async function addNodeAndFlush(page: Page, nodeId: string): Promise<string> {
  const scratchId = await waitForScratchId(page);
  const before = await replicaRowCount(page, scratchId);
  await spawnPatch(page, [{ id: nodeId, type: 'analogVco', position: { x: 180, y: 160 } }]);
  await expect(page.locator(`.svelte-flow__node[data-id="${nodeId}"]`)).toBeVisible();
  // Deterministic flush: the replica has written at least one more update row
  // than it had before the add.
  await expect
    .poll(() => replicaRowCount(page, scratchId), { timeout: 10_000 })
    .toBeGreaterThan(before);
  return scratchId;
}

/** Wait until the workflow ensure effect has spawned the given pinned nodes
 *  (deterministic ids from graph/workflow-pins.ts, `data.pinned === true`). */
async function waitForPinned(page: Page, ids: readonly string[]): Promise<void> {
  await page.waitForFunction(
    (wanted) => {
      const w = globalThis as unknown as {
        __patch?: { nodes: Record<string, { data?: { pinned?: boolean } } | undefined> };
      };
      if (!w.__patch) return false;
      return wanted.every((id) => w.__patch!.nodes[id]?.data?.pinned === true);
    },
    ids as string[],
    // BOOT bound, not an assertion — this waits on a boot subject after a
    // goto/reload, so it takes the export site's number (the hand-typed 15 s
    // was the same flat-bound class the #1906 sweep ended for toBeVisible
    // sites).
    { timeout: BOOT_MS },
  );
}

test.describe('scratch canvas persistence', () => {
  // OPT IN to the scratch replica. `/rack` disables the IndexedDB replica under
  // the e2e harness by default (so the general module-correctness suite stays
  // ephemeral + isolated from persistence); this dedicated spec is the coverage
  // for the real feature, so it flips `window.__ptScratchReplica` on for every
  // navigation (addInitScript runs before each document, incl. reloads + gotos).
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __ptScratchReplica?: boolean }).__ptScratchReplica = true;
    });
  });

  test('a node added on /rack survives a browser refresh', async ({ page }) => {
    await page.goto('/rack?shell=legacy&seed=none');
    await page.waitForLoadState('networkidle');

    const idbOk = await page.evaluate(
      () => typeof indexedDB !== 'undefined' && indexedDB !== null,
    );
    test.skip(!idbOk, 'IndexedDB unavailable — scratch replica cannot persist');

    const scratchId = await addNodeAndFlush(page, 'scratch-persist-vco');

    // The refresh: a full document reload = new JS context = fresh empty doc.
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Same persisted id (localStorage survived the reload) → the replica
    // re-seeds the node WITHOUT re-adding it.
    await expect(page.locator('.svelte-flow__node[data-id="scratch-persist-vco"]')).toBeVisible({
      timeout: 15_000,
    });
    expect(await readScratchId(page)).toBe(scratchId);
  });

  // The "dawless and workflow scratch persist to SEPARATE replicas" test was
  // DELETED, not re-pointed: mode isolation was the whole assertion and there
  // is now exactly ONE scratch doc. The client-side migration that replaces it
  // (the two mode-suffixed localStorage keys are PRUNED rather than adopted) is
  // unit-covered in lib/storage/local-scratch.test.ts, which feeds the real old
  // key shape in.

  // REGRESSION (workflow mount-race): on /rack Canvas's "ensure"
  // effects re-create the pinned modules at DETERMINISTIC keys on mount, with no
  // provider to gate them. If they ran before the IndexedDB seed, the empty
  // defaults raced the stored pinned state at the same Yjs key (clientID
  // tiebreak) and ~half the refreshes discarded the user's saved pinned
  // settings. The fix defers the Canvas mount until the replica seeds, so the
  // ensures skip the already-restored nodes. (The deleted mode-isolation test
  // only checks a UNIQUE-id marker node, which seeds fine either way and cannot
  // catch this — pinned nodes are the only at-risk keys.)
  const PINNED_TIMELORDE = 'pinned-timelorde';
  const PINNED_MIXMSTRS = 'pinned-mixmstrs';

  test('a pinned-module param on /rack survives refresh', async ({ page }) => {
    await page.goto('/rack?shell=legacy');
    await page.waitForLoadState('networkidle');

    const idbOk = await page.evaluate(
      () => typeof indexedDB !== 'undefined' && indexedDB !== null,
    );
    test.skip(!idbOk, 'IndexedDB unavailable — scratch replica cannot persist');

    // The ensure has spawned the pinned modules with default (empty-params) state.
    await waitForPinned(page, [PINNED_TIMELORDE, PINNED_MIXMSTRS]);
    const scratchId = await waitForScratchId(page);

    // Adjust NON-DEFAULT settings on pinned modules through the REAL doc (the
    // same Y.Doc the replica mirrors) — a mixer level + the clock BPM.
    const before = await replicaRowCount(page, scratchId);
    await page.evaluate(
      ({ clockId, mixerId }) => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { params?: Record<string, unknown> }> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => {
          const clock = w.__patch.nodes[clockId];
          const mixer = w.__patch.nodes[mixerId];
          if (!clock.params) clock.params = {};
          if (!mixer.params) mixer.params = {};
          clock.params.bpm = 142;
          mixer.params.ch1Level = 0.33;
        });
      },
      { clockId: PINNED_TIMELORDE, mixerId: PINNED_MIXMSTRS },
    );
    await expect
      .poll(() => replicaRowCount(page, scratchId), { timeout: 10_000 })
      .toBeGreaterThan(before);

    // Reload repeatedly: the params must persist EVERY time. A single reload
    // only exposes the race ~50% of the time (the clientID tiebreak is
    // symmetric) and a lost reload permanently overwrites the stored state with
    // empty defaults — so loop to make the guard robust.
    for (let i = 1; i <= 3; i++) {
      await page.reload();
      await page.waitForLoadState('networkidle');
      await waitForPinned(page, [PINNED_TIMELORDE, PINNED_MIXMSTRS]);
      const vals = await page.evaluate(
        ({ clockId, mixerId }) => {
          const w = globalThis as unknown as {
            __patch: { nodes: Record<string, { params?: Record<string, unknown> } | undefined> };
          };
          return {
            bpm: w.__patch.nodes[clockId]?.params?.bpm,
            ch1Level: w.__patch.nodes[mixerId]?.params?.ch1Level,
          };
        },
        { clockId: PINNED_TIMELORDE, mixerId: PINNED_MIXMSTRS },
      );
      expect(vals.bpm, `pinned-timelorde bpm after reload ${i}`).toBe(142);
      expect(vals.ch1Level, `pinned-mixmstrs ch1Level after reload ${i}`).toBe(0.33);
    }
  });

  // OWNER-REPORTED BUG (the reason for the gate fix): "new workflow rack, add a
  // module, refresh → I lose my rack." The prior tests seeded a pre-built patch
  // (a unique marker) or drove pinned params; NEITHER exercised the owner's
  // flow of ADDING A FRESH MODULE after the workflow shell has loaded, then
  // reloading. This asserts the user-added node id is still in the LIVE graph
  // (`window.__patch.nodes`) after a refresh, and that the DAWLESS canvas remains
  // a blank sandbox on its OWN id (the workflow add does not cross-load).
  //
  // (This bug shipped LIVE despite the earlier tests because Fix A gated the
  // whole replica on the VITE_E2E_HOOKS *build* flag — TRUE on the dev/autotest
  // deploys + local `npm run dev` where the owner works — so persistence was off
  // for real users while these e2e ran. The gate now keys on `navigator.webdriver`
  // (a real automated run) instead, so real users get persistence and this spec
  // still opts in.)
  const WF_USER_ADD = 'scratch-wf-useradd';

  test('a user-added module on /rack survives refresh (owner bug)', async ({
    page,
  }) => {
    await page.goto('/rack?shell=legacy');
    await page.waitForLoadState('networkidle');

    const idbOk = await page.evaluate(
      () => typeof indexedDB !== 'undefined' && indexedDB !== null,
    );
    test.skip(!idbOk, 'IndexedDB unavailable — scratch replica cannot persist');

    // Let the workflow shell finish loading BEFORE the add — the owner's flow is
    // "open the workflow rack, then add a module", not "seed a patch pre-mount".
    await waitForPinned(page, [PINNED_TIMELORDE, PINNED_MIXMSTRS]);

    // Add a module AFTER load through the real live-doc path (__patch/__ydoc, the
    // same seam the add menu drives) and block until it flushes to IndexedDB.
    const workflowId = await addNodeAndFlush(page, WF_USER_ADD);

    // The refresh: full document reload = new JS context = fresh empty doc that
    // must be rehydrated from the IndexedDB replica.
    await page.reload();
    await page.waitForLoadState('networkidle');

    // The owner's assertion: the user-added node is STILL in the live graph.
    await page.waitForFunction(
      (id) => {
        const w = globalThis as unknown as { __patch?: { nodes: Record<string, unknown> } };
        return !!w.__patch && Object.prototype.hasOwnProperty.call(w.__patch.nodes, id);
      },
      WF_USER_ADD,
      { timeout: 15_000 },
    );
    expect(await readScratchId(page)).toBe(workflowId);

    // The old tail of this test opened the DAWLESS scratch and asserted the
    // workflow add did NOT cross-load. There is one scratch doc now, so the
    // inverse is the contract: revisiting /rack keeps the SAME id and the SAME
    // node. Asserting that here rather than deleting the leg keeps a positive
    // control on the id being stable across a navigation (not just a reload).
    await page.goto('/rack?shell=legacy');
    await page.waitForLoadState('networkidle');
    expect(await waitForScratchId(page)).toBe(workflowId);
    await page.waitForFunction(
      (id) => {
        const w = globalThis as unknown as { __patch?: { nodes: Record<string, unknown> } };
        return !!w.__patch && Object.prototype.hasOwnProperty.call(w.__patch.nodes, id);
      },
      WF_USER_ADD,
      { timeout: 15_000 },
    );
  });
});
