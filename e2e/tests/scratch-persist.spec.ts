// e2e/tests/scratch-persist.spec.ts
//
// SCRATCH PERSISTENCE (FIX A) — the `/rack` scratch canvas mirrors its Y.Doc
// into an IndexedDB local replica keyed by a stable per-device id
// (localStorage `pt:local-scratch-id:<mode>`), so a browser REFRESH rehydrates
// the patch instead of throwing it away. Before the fix the scratch doc lived
// only in a volatile in-memory Y.Doc — a reload = a new JS context = a fresh
// empty createPatch() = the whole rack gone (worst for logged-out users, whose
// ONLY canvas is `/rack`).
//
// This is data-durability coverage: add a node through the real graph path,
// prove it reached IndexedDB, reload, and assert it comes back — plus that the
// two modes (dawless | workflow) persist to SEPARATE replicas.
//
// Runs on `/rack` (no DB / no relay needed — the scratch replica is pure
// client IndexedDB). Gated on IndexedDB availability so a hardened/private
// environment skips instead of failing.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

// Contract strings mirrored from the source (lib/multiplayer/local-replica.ts
// REPLICA_DB_PREFIX + lib/multiplayer/local-scratch.ts key format). A change
// on either side should surface here — that's the point of pinning them.
const REPLICA_DB_PREFIX = 'pt-rack-v1-';
const scratchStorageKey = (mode: 'dawless' | 'workflow') => `pt:local-scratch-id:${mode}`;

/** Read the persisted scratch id for a mode (null until the page has minted
 *  it — the top-level bind does so synchronously on mount). */
async function readScratchId(page: Page, mode: 'dawless' | 'workflow'): Promise<string | null> {
  return page.evaluate((key) => window.localStorage.getItem(key), scratchStorageKey(mode));
}

/** Poll until the page has persisted a scratch id for the mode, then return
 *  it. */
async function waitForScratchId(page: Page, mode: 'dawless' | 'workflow'): Promise<string> {
  await expect
    .poll(() => readScratchId(page, mode), { timeout: 10_000 })
    .toMatch(new RegExp(`^local-scratch-${mode}-`));
  const id = await readScratchId(page, mode);
  if (!id) throw new Error(`scratch id for ${mode} never appeared`);
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
async function addNodeAndFlush(
  page: Page,
  mode: 'dawless' | 'workflow',
  nodeId: string,
): Promise<string> {
  const scratchId = await waitForScratchId(page, mode);
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

test.describe('scratch canvas persistence', () => {
  test('a node added on /rack survives a browser refresh', async ({ page }) => {
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    const idbOk = await page.evaluate(
      () => typeof indexedDB !== 'undefined' && indexedDB !== null,
    );
    test.skip(!idbOk, 'IndexedDB unavailable — scratch replica cannot persist');

    const scratchId = await addNodeAndFlush(page, 'dawless', 'scratch-persist-vco');

    // The refresh: a full document reload = new JS context = fresh empty doc.
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Same persisted id (localStorage survived the reload) → the replica
    // re-seeds the node WITHOUT re-adding it.
    await expect(page.locator('.svelte-flow__node[data-id="scratch-persist-vco"]')).toBeVisible({
      timeout: 15_000,
    });
    expect(await readScratchId(page, 'dawless')).toBe(scratchId);
  });

  test('dawless and workflow scratch persist to SEPARATE replicas (mode isolation)', async ({
    page,
  }) => {
    await page.goto('/rack?mode=workflow');
    await page.waitForLoadState('networkidle');

    const idbOk = await page.evaluate(
      () => typeof indexedDB !== 'undefined' && indexedDB !== null,
    );
    test.skip(!idbOk, 'IndexedDB unavailable — scratch replica cannot persist');

    // Add a marker on the WORKFLOW scratch and confirm it survives a workflow
    // refresh (independent persistence).
    const workflowId = await addNodeAndFlush(page, 'workflow', 'scratch-wf-marker');
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.locator('.svelte-flow__node[data-id="scratch-wf-marker"]')).toBeVisible({
      timeout: 15_000,
    });

    // Now open the DAWLESS scratch (same browser context → localStorage still
    // holds the workflow id, and mints a DISTINCT dawless id). The workflow
    // marker must NOT bleed in — it lives in a separate replica DB.
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    const dawlessId = await waitForScratchId(page, 'dawless');
    expect(dawlessId).not.toBe(workflowId); // distinct id → distinct replica DB
    await expect(page.locator('.svelte-flow__node[data-id="scratch-wf-marker"]')).toHaveCount(0);
  });
});
