// e2e/tests/new-rack-return-to-last.spec.ts
//
// FILE → NEW RACK + the landing "Return to last rack" card.
//
//   * New rack (File menu, LOGGED-OUT scratch path here): a FRESH empty rack of
//     a fresh empty rack — the shell's pinned singletons
//     re-spawn, and any prior user modules are gone. Driven on /rack?seed=none (no DB /
//     relay) with the scratch IndexedDB replica OPTED IN, so the test proves the
//     new rack genuinely discards the PERSISTED session (a new per-device
//     scratch id ⇒ a fresh empty replica DB), not just an in-memory reset.
//
//   * Return to last rack: the landing card appears ONLY when a prior scratch
//     rack is persisted in IndexedDB (the localStorage scratch id + the replica DB
//     present), reopens it, and is HIDDEN with no prior session.
//
// Signed-in create (POST /api/rackspaces → /r/{id}) reuses the dashboard's
// unit-tested path and needs Neon, which the shard runners don't have — the
// scratch path is the DB-free coverage; the persisted branch is exercised by
// the dashboard create tests + rackspaces.test.ts.

import { test, expect, type Page } from '@playwright/test';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

// ⚠ THE PER-TEST BUDGET IS A BOUND, AND IT WAS THE INVISIBLE 30 s DEFAULT.
//
// This file bounds its boot waits with `BOOT_MS` — 30 000 on CI, IDENTICAL to
// the 30 000 default budget they were running inside. 3 sites, 1.00x, and one
// test block declares BOOT_MS + 10 000 + 10 000 = 50 000 ms of tolerance in it.
//
// An inner bound at or above the budget that CONTAINS it can never come true:
// the outer clock kills the test first, so a legible `element not found` is
// converted into an illegible `Test timeout of 30000ms exceeded` — the class
// #2291 root-caused and #2293 repaired at its second call site. Nothing in this
// file said "30000"; `e2e/playwright.config.ts` never overrides Playwright's
// default, so there was nothing to grep for except the ABSENCE of a budget.
//
// The budget therefore comes from `boot-budget` (90 000 on CI/SwiftShader,
// 30 000 local) instead of the invisible default. A bound only costs wall-clock
// when it is EXCEEDED, so this adds exactly zero to a green run; lane cost stays
// gauged by `--global-timeout`, not by this.
//
// ⚠ BOUNDS ONLY. No assertion, subject or wait target changed here.
test.describe.configure({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

const SCRATCH_STORAGE_KEY = 'pt:local-scratch-id';
const REPLICA_DB_PREFIX = 'pt-rack-v1-';

async function readScratchId(page: Page): Promise<string | null> {
  return page.evaluate((key) => window.localStorage.getItem(key), SCRATCH_STORAGE_KEY);
}

/** Poll until the page has minted (and persisted) a scratch id. */
async function waitForScratchId(page: Page): Promise<string> {
  await expect
    .poll(() => readScratchId(page), { timeout: 10_000 })
    .toMatch(/^local-scratch-/);
  const id = await readScratchId(page);
  if (!id) throw new Error('scratch id never appeared');
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
    { timeout: BOOT_MS },
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

  test('New rack gives a fresh empty rack (singletons present, prior module gone)', async ({
    page,
  }) => {
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    const idbOk = await page.evaluate(
      () => typeof indexedDB !== 'undefined' && indexedDB !== null,
    );
    test.skip(!idbOk, 'IndexedDB unavailable — scratch replica cannot persist');

    await waitForPinnedTrio(page);
    const idBefore = await waitForScratchId(page);

    // Make the rack non-empty with a user module.
    await addMarker(page, 'newrack-wf-marker');

    // File.. → New rack.
    await page.getByTestId('workflow-file-trigger').click();
    await expect(page.getByTestId('workflow-file-menu')).toBeVisible();
    await page.getByTestId('workflow-file-new-rack').click();

    // New rack reloads the scratch route onto a fresh id. Wait for the reload,
    // then assert: the shell is up, pinned trio present, the marker gone,
    // and the scratch id was rotated (⇒ a distinct, empty replica DB).
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
    await waitForPinnedTrio(page);
    await expect(page.locator('.svelte-flow__node[data-id="newrack-wf-marker"]')).toHaveCount(0);

    const idAfter = await waitForScratchId(page);
    expect(idAfter).not.toBe(idBefore);
  });

  // The second New-rack test ("dawless: New rack gives a fresh empty DAWLESS
  // rack") was DELETED. It pressed `new-rack-btn` on the old topbar and
  // asserted the result was still the DAWLESS shell — both halves are gone.
  // File..→New rack on the one shell is covered by the test above.
});

test.describe('landing: Return to last rack', () => {
  test('HIDDEN when there is no rack in memory', async ({ page }) => {
    // Fresh context → no persisted scratch id → the card must not render.
    await page.goto('/');
    await expect(page.getByTestId('landing-tiles')).toBeVisible();
    await expect(page.getByTestId('return-to-last-rack')).toHaveCount(0);
  });

  test('APPEARS after a scratch session persists, and REOPENS it', async ({ page }) => {
    // Opt the replica in so /rack?seed=none actually persists a DB the landing tile can find.
    await page.addInitScript(() => {
      (window as unknown as { __ptScratchReplica?: boolean }).__ptScratchReplica = true;
    });

    await page.goto('/rack?seed=none');
    await page.waitForLoadState('networkidle');
    const idbOk = await page.evaluate(
      () => typeof indexedDB !== 'undefined' && indexedDB !== null,
    );
    test.skip(!idbOk, 'IndexedDB unavailable — scratch replica cannot persist');

    const scratchId = await waitForScratchId(page);
    // Add a module + wait for the replica DB to actually exist in IndexedDB
    // (the card's gate) before navigating to the landing.
    await page.waitForFunction(() => {
      const w = globalThis as unknown as { __patch?: unknown; __ydoc?: unknown };
      return !!w.__patch && !!w.__ydoc;
    });
    await addMarker(page, 'return-marker');
    await expect.poll(() => replicaDbExists(page, scratchId), { timeout: 10_000 }).toBe(true);

    // The landing now offers to resume the session. There is no
    // `data-rack-mode` any more — the card had one only to say WHICH of the
    // two shells to reopen, and there is one.
    await page.goto('/');
    const card = page.getByTestId('return-to-last-rack');
    await expect(card).toBeVisible({ timeout: 10_000 });
    // The card's href comes from local-scratch's readLastScratchRack() and is
    // the BARE route. ⚠ My URL sweep rewrote this literal too — it is an
    // EXPECTED VALUE, not a page to navigate to, and the sweep could not tell
    // the difference (same class as the `lib/ui/rack-sizes` import it also hit).
    await expect(card).toHaveAttribute('href', '/rack');

    // Clicking it reopens the scratch rack (same id → same replica).
    await card.click();
    await expect(page.locator('[data-testid="canvas-root"]')).toBeVisible({ timeout: BOOT_MS });
    expect(new URL(page.url()).pathname).toBe('/rack');
    expect(await readScratchId(page)).toBe(scratchId);
  });
});
