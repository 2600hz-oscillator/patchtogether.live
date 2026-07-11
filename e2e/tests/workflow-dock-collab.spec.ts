// e2e/tests/workflow-dock-collab.spec.ts
//
// @collab — the TAGGED multi-user dock spec (workflow P2.5b; owner answer
// Q4: this spec JOINS the collab-attest basis by design, and the attest is
// paid at P2.5b review). It proves the Max-style DUAL-RECT invariants
// ACROSS PEERS: dock state is a LOCAL projection (never in the Y.Doc), so
// while user A docks a module,
//
//   * B keeps seeing the ORDINARY canvas card at its baked patch position
//     (no stub, no rails on B — peers see nothing different);
//   * B can PATCH to the docked node (edges keep their real endpoint ids);
//   * A sees B's cable land on the STUB (the node's one canvas presence);
//   * A's dock state survives A's RELOAD via the tombstone round-trip:
//     bind loads the persisted entry → the pre-sync empty snapshot RETIRES
//     it to a tombstone → the provider sync brings the node id back → the
//     entry REVIVES (rail card + stub return, no re-docking);
//   * B DELETING the node auto-evicts A's dock entry — rail card + stub
//     gone, eviction TOAST shown (P2.5b hardening: remote-transaction
//     deletes of a docked id notify; local slot switches stay silent),
//     entry retired to a tombstone (revive path if the peer undoes).
//
// Setup mirrors collab.spec.ts's canonical two-context pattern — separate
// cookie jars/localStorage/ydocs, both attached to one Hocuspocus room via
// the dev-only __attachProvider — but on /rack?mode=workflow (the mode is
// per-page shell chrome; the shared ydoc is mode-agnostic). Pure-sync: no
// DATABASE_URL-gated assertions, so the spec is real (not vacuous) on the
// dedicated collab lane AND under the local relay.

import { test, expect } from '@playwright/test';
import { SYNC_BUDGET_MS, SYNC_POLL_INTERVALS } from './_collab-helpers';

interface CollabContexts {
  pageA: import('@playwright/test').Page;
  pageB: import('@playwright/test').Page;
  rackspaceId: string;
  close: () => Promise<void>;
}

async function attachWorkflow(
  page: import('@playwright/test').Page,
  rackspaceId: string,
): Promise<void> {
  await page.goto('/rack?mode=workflow');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(
    () =>
      typeof (window as unknown as { __attachProvider?: unknown }).__attachProvider === 'function',
  );
  await page.evaluate(async (id) => {
    const w = window as unknown as { __attachProvider: (id: string) => Promise<unknown> };
    await w.__attachProvider(id);
  }, rackspaceId);
}

async function openWorkflowPair(
  browser: import('@playwright/test').Browser,
): Promise<CollabContexts> {
  const rackspaceId = `dockcollab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  await Promise.all([attachWorkflow(pageA, rackspaceId), attachWorkflow(pageB, rackspaceId)]);
  return {
    pageA,
    pageB,
    rackspaceId,
    async close() {
      await Promise.all([ctxA.close(), ctxB.close()]);
    },
  };
}

/** Spawn the noise → (unpatched) mixer pair on page A and wait until the
 *  peer page sees the mixer's card in its DOM (graph synced + rendered). */
async function seedAndSync(s: CollabContexts): Promise<void> {
  await s.pageA.evaluate(() => {
    const w = window as unknown as {
      __patch: { nodes: Record<string, unknown> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      w.__patch.nodes['nz'] = {
        id: 'nz', type: 'noise', domain: 'audio', position: { x: 120, y: 140 }, params: {},
      };
      w.__patch.nodes['mx'] = {
        id: 'mx', type: 'mixer', domain: 'audio', position: { x: 420, y: 180 }, params: {},
      };
    });
  });
  for (const p of [s.pageA, s.pageB]) {
    await expect(p.locator('.svelte-flow__node[data-id="mx"]')).toBeVisible({
      timeout: SYNC_BUDGET_MS,
    });
  }
}

test.describe('@collab workflow dock — dual-rect invariants for peers', () => {
  // The @collab-standard 120s ceiling: cross-context waits budget 20s each
  // (SYNC_BUDGET_MS) and there are several in sequence. A ceiling, not a
  // sleep — green runs pay nothing extra.
  test.setTimeout(120_000);

  test('A docks → B keeps the ordinary card + can patch to it; the cable lands on A\'s stub; A\'s dock survives reload (tombstone revive)', async ({ browser }) => {
    const s = await openWorkflowPair(browser);
    try {
      await seedAndSync(s);

      // A docks the mixer to the TOP rail (bakes the canvas position).
      await s.pageA.evaluate(() => {
        (globalThis as unknown as { __dock: { dock: (id: string, z: string) => void } }).__dock.dock('mx', 'top');
      });
      await expect(s.pageA.getByTestId('dock-rail-top').locator('[data-dock-card="mx"]')).toBeVisible();
      await expect(
        s.pageA.locator('.svelte-flow__node[data-id="mx"] [data-testid="dock-stub"]'),
      ).toBeVisible();

      // B SEES NOTHING DIFFERENT: the ordinary card (no stub, no rail
      // entry) at the baked patch position — dock state never syncs.
      await expect(s.pageB.locator('[data-dock-card="mx"]')).toHaveCount(0);
      await expect(
        s.pageB.locator('.svelte-flow__node[data-id="mx"] [data-testid="dock-stub"]'),
      ).toHaveCount(0);
      await expect(
        s.pageB.locator('.svelte-flow__node[data-id="mx"] .mod-card').first(),
      ).toBeVisible();
      const posOnB = await s.pageB.evaluate(() => {
        const w = window as unknown as {
          __patch: { nodes: Record<string, { position: { x: number; y: number } }> };
        };
        return w.__patch.nodes['mx']?.position;
      });
      expect(posOnB).toEqual({ x: 420, y: 180 }); // the dock-time baked position

      // B PATCHES to the docked node — the edge keeps the real endpoint id.
      await s.pageB.evaluate(() => {
        const w = window as unknown as {
          __patch: { edges: Record<string, unknown> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => {
          w.__patch.edges['e-b1'] = {
            id: 'e-b1',
            source: { nodeId: 'nz', portId: 'white' },
            target: { nodeId: 'mx', portId: 'in1' },
            sourceType: 'audio',
            targetType: 'audio',
          };
        });
      });
      await expect(s.pageB.locator('.svelte-flow__edge')).toHaveCount(1, {
        timeout: SYNC_BUDGET_MS,
      });

      // A sees B's cable LAND ON THE STUB: the edge materializes while the
      // node's only canvas presence is still the DockStubCard (same id).
      await expect(s.pageA.locator('.svelte-flow__edge')).toHaveCount(1, {
        timeout: SYNC_BUDGET_MS,
      });
      await expect(
        s.pageA.locator('.svelte-flow__node[data-id="mx"] [data-testid="dock-stub"]'),
      ).toBeVisible();
      await expect(s.pageA.getByTestId('dock-rail-top').locator('[data-dock-card="mx"]')).toBeVisible();

      // A RELOADS: the persisted dock entry retires against the pre-sync
      // empty snapshot, then REVIVES when the provider sync returns the
      // node id — rail card + stub reappear with no user re-docking.
      await attachWorkflow(s.pageA, s.rackspaceId);
      await expect(
        s.pageA.getByTestId('dock-rail-top').locator('[data-dock-card="mx"]'),
      ).toBeVisible({ timeout: SYNC_BUDGET_MS });
      await expect(
        s.pageA.locator('.svelte-flow__node[data-id="mx"] [data-testid="dock-stub"]'),
      ).toBeVisible();
      // …and B's cable still lands on the revived stub.
      await expect(s.pageA.locator('.svelte-flow__edge')).toHaveCount(1, {
        timeout: SYNC_BUDGET_MS,
      });
    } finally {
      await s.close();
    }
  });

  test('B deletes the docked node → A auto-evicts the rail card + stub, shows the eviction toast, and retires the entry to a tombstone', async ({ browser }) => {
    const s = await openWorkflowPair(browser);
    try {
      await seedAndSync(s);
      await s.pageA.evaluate(() => {
        (globalThis as unknown as { __dock: { dock: (id: string, z: string) => void } }).__dock.dock('mx', 'top');
      });
      await expect(s.pageA.getByTestId('dock-rail-top').locator('[data-dock-card="mx"]')).toBeVisible();

      // B deletes the node (a remote transaction from A's perspective).
      await s.pageB.evaluate(() => {
        const w = window as unknown as {
          __patch: { nodes: Record<string, unknown> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => {
          delete w.__patch.nodes['mx'];
        });
      });

      // A: eviction toast (P2.5b hardening — remote deletes of a docked id
      // notify; the 4s toast window is far wider than the sync poll).
      await expect(s.pageA.getByTestId('dock-toast')).toBeVisible({ timeout: SYNC_BUDGET_MS });
      await expect(s.pageA.getByTestId('dock-toast')).toContainText('deleted by a rack-mate');

      // A: rail card + stub are gone; the entry retired to a TOMBSTONE
      // (not hard-dropped — the revive path stays if the peer undoes).
      await expect(s.pageA.locator('[data-dock-card="mx"]')).toHaveCount(0);
      await expect(s.pageA.locator('.svelte-flow__node[data-id="mx"]')).toHaveCount(0);
      await expect
        .poll(
          async () =>
            await s.pageA.evaluate(() => {
              const w = globalThis as unknown as {
                __dock: { entryFor: (id: string) => unknown; tombstoneCount: () => number };
              };
              return { entry: w.__dock.entryFor('mx'), tombstones: w.__dock.tombstoneCount() };
            }),
          { timeout: SYNC_BUDGET_MS, intervals: SYNC_POLL_INTERVALS },
        )
        .toEqual({ entry: null, tombstones: 1 });
    } finally {
      await s.close();
    }
  });
});
