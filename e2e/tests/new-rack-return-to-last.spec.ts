// e2e/tests/new-rack-return-to-last.spec.ts
//
// FILE → NEW RACK + the landing "Return to last rack" card.
//
//   * New rack (File menu, LOGGED-OUT scratch path here): a FRESH empty rack of
//     the CURRENT kind — mode preserved, the workflow shell's pinned singletons
//     re-spawn, and any prior user modules are gone. Driven on /rack (no DB /
//     relay) with the scratch IndexedDB replica OPTED IN, so the test proves the
//     new rack genuinely discards the PERSISTED session (a new per-device
//     scratch id ⇒ a fresh empty replica DB), not just an in-memory reset.
//
//   * Return to last rack: the landing card appears ONLY when a prior scratch
//     rack is persisted in IndexedDB (localStorage last-mode + the replica DB
//     present), reopens it, and is HIDDEN with no prior session.
//
// Signed-in create (POST /api/rackspaces → /r/{id}) reuses the dashboard's
// unit-tested path and needs Neon, which the shard runners don't have — the
// scratch path is the DB-free coverage; the persisted branch is exercised by
// the dashboard create tests + rackspaces.test.ts.

import { test, expect, type Page } from '@playwright/test';

const scratchStorageKey = (mode: 'dawless' | 'workflow') => `pt:local-scratch-id:${mode}`;
const REPLICA_DB_PREFIX = 'pt-rack-v1-';

async function readScratchId(page: Page, mode: 'dawless' | 'workflow'): Promise<string | null> {
  return page.evaluate((key) => window.localStorage.getItem(key), scratchStorageKey(mode));
}

/** Poll until the page has minted (and persisted) a scratch id for the mode. */
async function waitForScratchId(page: Page, mode: 'dawless' | 'workflow'): Promise<string> {
  await expect
    .poll(() => readScratchId(page, mode), { timeout: 10_000 })
    .toMatch(new RegExp(`^local-scratch-${mode}-`));
  const id = await readScratchId(page, mode);
  if (!id) throw new Error(`scratch id for ${mode} never appeared`);
  return id;
}

/** True once the replica DB for `scratchId` exists in IndexedDB (the "rack in
 *  memory" signal the landing card gates on). */
async function replicaDbExists(page: Page, scratchId: string): Promise<boolean> {
  return page.evaluate(async (name) => {
    const list =
      (await (indexedDB as unknown as { databases?: () => Promise<{ name?: string }[]> })
        .databases?.()) ?? [];
    return list.some((d) => d.name === name);
  }, `${REPLICA_DB_PREFIX}${scratchId}`);
}

/** Add a marker node to the live graph (no engine needed — the same __ydoc seam
 *  the add menu drives), and wait for its SvelteFlow node to render. */
async function addMarker(page: Page, id: string): Promise<void> {
  await page.evaluate((nodeId) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, Record<string, unknown>> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      w.__patch.nodes[nodeId] = {
        id: nodeId,
        type: 'analogVco',
        domain: 'audio',
        position: { x: 220, y: 200 },
        params: {},
        data: {},
      };
    });
  }, id);
  await expect(page.locator(`.svelte-flow__node[data-id="${id}"]`)).toBeVisible();
}

/** Wait for the workflow pinned trio (deterministic ids from workflow-pins.ts). */
async function waitForPinnedTrio(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as {
        __patch?: { nodes: Record<string, { data?: { pinned?: boolean } } | undefined> };
      };
      if (!w.__patch) return false;
      return ['pinned-mixmstrs', 'pinned-electraControl', 'pinned-clipplayer'].every(
        (id) => w.__patch!.nodes[id]?.data?.pinned === true,
      );
    },
    undefined,
    { timeout: 15_000 },
  );
}

test.describe('File → New rack (scratch / logged-out)', () => {
  // Opt the scratch replica IN so New rack proves it discards the PERSISTED
  // rack (a fresh id ⇒ a fresh empty replica DB), not merely an ephemeral one.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __ptScratchReplica?: boolean }).__ptScratchReplica = true;
    });
  });

  test('workflow: New rack gives a fresh empty WORKFLOW rack (mode preserved, singletons present, prior module gone)', async ({
    page,
  }) => {
    await page.goto('/rack?mode=workflow');
    await page.waitForLoadState('networkidle');

    const idbOk = await page.evaluate(
      () => typeof indexedDB !== 'undefined' && indexedDB !== null,
    );
    test.skip(!idbOk, 'IndexedDB unavailable — scratch replica cannot persist');

    await waitForPinnedTrio(page);
    const idBefore = await waitForScratchId(page, 'workflow');

    // Make the rack non-empty with a user module.
    await addMarker(page, 'newrack-wf-marker');

    // File.. → New rack.
    await page.getByTestId('workflow-file-trigger').click();
    await expect(page.getByTestId('workflow-file-menu')).toBeVisible();
    await page.getByTestId('workflow-file-new-rack').click();

    // New rack reloads the scratch route onto a fresh id. Wait for the reload,
    // then assert: still WORKFLOW mode, pinned trio present, the marker gone,
    // and the scratch id was rotated (⇒ a distinct, empty replica DB).
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('workflow-topbar')).toBeVisible();
    await waitForPinnedTrio(page);
    await expect(page.locator('.svelte-flow__node[data-id="newrack-wf-marker"]')).toHaveCount(0);

    const idAfter = await waitForScratchId(page, 'workflow');
    expect(idAfter).not.toBe(idBefore);
  });

  test('dawless: New rack gives a fresh empty DAWLESS rack (mode preserved, prior module gone)', async ({
    page,
  }) => {
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    const idbOk = await page.evaluate(
      () => typeof indexedDB !== 'undefined' && indexedDB !== null,
    );
    test.skip(!idbOk, 'IndexedDB unavailable — scratch replica cannot persist');

    await expect(page.locator('header.topbar')).toBeVisible();
    const idBefore = await waitForScratchId(page, 'dawless');

    // Boot the engine + add a module through the real seam.
    await page.waitForFunction(() => {
      const w = globalThis as unknown as { __patch?: unknown; __ydoc?: unknown };
      return !!w.__patch && !!w.__ydoc;
    });
    await addMarker(page, 'newrack-dawless-marker');

    // The dawless topbar's New rack button.
    await page.getByTestId('new-rack-btn').click();

    await page.waitForLoadState('networkidle');
    // Still the DAWLESS shell (no workflow chrome), marker gone, id rotated.
    await expect(page.locator('header.topbar')).toBeVisible();
    await expect(page.getByTestId('workflow-topbar')).toHaveCount(0);
    await expect(
      page.locator('.svelte-flow__node[data-id="newrack-dawless-marker"]'),
    ).toHaveCount(0);

    const idAfter = await waitForScratchId(page, 'dawless');
    expect(idAfter).not.toBe(idBefore);
  });
});

test.describe('landing: Return to last rack', () => {
  test('HIDDEN when there is no rack in memory', async ({ page }) => {
    // Fresh context → no localStorage last-mode → the card must not render.
    await page.goto('/');
    await expect(page.getByTestId('landing-tiles')).toBeVisible();
    await expect(page.getByTestId('return-to-last-rack')).toHaveCount(0);
  });

  test('APPEARS after a scratch session persists, and REOPENS it', async ({ page }) => {
    // Opt the replica in so /rack actually persists a DB the card can find.
    await page.addInitScript(() => {
      (window as unknown as { __ptScratchReplica?: boolean }).__ptScratchReplica = true;
    });

    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    const idbOk = await page.evaluate(
      () => typeof indexedDB !== 'undefined' && indexedDB !== null,
    );
    test.skip(!idbOk, 'IndexedDB unavailable — scratch replica cannot persist');

    const scratchId = await waitForScratchId(page, 'dawless');
    // Add a module + wait for the replica DB to actually exist in IndexedDB
    // (the card's gate) before navigating to the landing.
    await page.waitForFunction(() => {
      const w = globalThis as unknown as { __patch?: unknown; __ydoc?: unknown };
      return !!w.__patch && !!w.__ydoc;
    });
    await addMarker(page, 'return-marker');
    await expect.poll(() => replicaDbExists(page, scratchId), { timeout: 10_000 }).toBe(true);

    // The landing now offers to resume the dawless session.
    await page.goto('/');
    const card = page.getByTestId('return-to-last-rack');
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toHaveAttribute('data-rack-mode', 'dawless');

    // Clicking it reopens the scratch rack (same id → same replica).
    await card.click();
    await expect(page.locator('[data-testid="canvas-root"]')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/rack');
    expect(await readScratchId(page, 'dawless')).toBe(scratchId);
  });
});
