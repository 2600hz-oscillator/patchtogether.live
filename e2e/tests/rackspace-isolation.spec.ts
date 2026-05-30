// e2e/tests/rackspace-isolation.spec.ts
//
// Regression for the "edits in one rackspace leak into all 4" bug.
//
// Root cause: `patch` / `ydoc` / `undoManager` were `export const` in
// graph/store.ts, so navigating /r/A → /r/B in the same JS context
// re-attached the new HocuspocusProvider to the SAME Y.Doc that still
// held A's nodes + edges. On sync the merged state was uploaded into
// B's room, corrupting it for every participant, and the same Y.Doc
// kept accumulating edits across every rackspace switch.
//
// This spec exercises the `__attachProvider` dev-hook path on `/` —
// which after the fix calls `bindRackspace(id)` before each provider
// attach, getting a fresh Y.Doc every rackspace. The same code path
// runs in production at /r/[id]/+page.svelte.
//
// Scenario:
//   1. Attach to rackspace A in ONE tab. Add a node ("nibbles-A").
//   2. In a SECOND tab (different context), attach to rackspace B.
//   3. Verify B's __patch.nodes is EMPTY — A's node didn't leak server-side.
//   4. Mutate B (add "nibbles-B").
//   5. In a THIRD tab, attach to rackspace A again. The server should still
//      hold only the original "nibbles-A" — B's edits did NOT cross over.
//
// The test is tagged @collab because it spins up multiple browser
// contexts against the in-memory Hocuspocus relay. It runs in the
// dedicated `task collab` runner.

import { test, expect } from '@playwright/test';

interface PatchSnapshot {
  nodes: string[];
  edges: string[];
}

async function bootTab(browser: import('@playwright/test').Browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(
    () =>
      typeof (window as unknown as { __attachProvider?: unknown })
        .__attachProvider === 'function' &&
      typeof (window as unknown as { __ensureEngine?: unknown })
        .__ensureEngine === 'function',
  );
  await page.evaluate(async () => {
    const w = window as unknown as { __ensureEngine: () => Promise<unknown> };
    await w.__ensureEngine();
  });
  return { ctx, page };
}

async function attach(page: import('@playwright/test').Page, rackspaceId: string) {
  await page.evaluate(async (id) => {
    const w = window as unknown as {
      __attachProvider: (id: string) => Promise<unknown>;
    };
    await w.__attachProvider(id);
  }, rackspaceId);
}

async function addNode(
  page: import('@playwright/test').Page,
  nodeId: string,
  type = 'analogVco',
) {
  await page.evaluate(
    ({ nodeId, type }) => {
      const w = window as unknown as {
        __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        w.__patch.nodes[nodeId] = {
          id: nodeId,
          type,
          domain: 'audio',
          position: { x: 0, y: 0 },
          params: {},
        };
      });
    },
    { nodeId, type },
  );
}

async function snapshot(page: import('@playwright/test').Page): Promise<PatchSnapshot> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
    };
    return {
      nodes: Object.keys(w.__patch.nodes).sort(),
      edges: Object.keys(w.__patch.edges).sort(),
    };
  });
}

test.describe('@collab rackspace isolation', () => {
  test('mutating rackspace B does NOT leak into rackspace A (separate Hocuspocus rooms)', async ({
    browser,
  }) => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const rackA = `iso-A-${suffix}`;
    const rackB = `iso-B-${suffix}`;

    // Three independent browser contexts — modelling three users / tabs
    // sitting on different rackspaces simultaneously. The bug under test
    // is server-side: a corrupted upload from a stale singleton Y.Doc in
    // ONE tab would write the wrong data into the Hocuspocus room and
    // every other participant in that room would see it.
    const a1 = await bootTab(browser);
    const b1 = await bootTab(browser);
    const a2 = await bootTab(browser);

    try {
      // Tab a1: enter rackspace A, plant a node only A should ever see.
      await attach(a1.page, rackA);
      await addNode(a1.page, 'sentinel-A', 'analogVco');

      // Tab b1: enter rackspace B (fresh room).
      await attach(b1.page, rackB);

      // B's view must be empty — sentinel-A must NOT have crossed rooms.
      // Pre-fix this failed: a1's singleton was the only Y.Doc in the
      // module, so when a SECOND attach (from the dev hook in a different
      // tab) hit the same Hocuspocus server it could observe the leak
      // server-side; harder to reproduce inline, but more reliably we
      // check the cleaner contract: after attaching to B in a fresh tab,
      // B is empty. (The within-one-tab leak is covered by store-bind.test.ts.)
      await expect
        .poll(async () => (await snapshot(b1.page)).nodes, { timeout: 4000 })
        .toEqual([]);

      // Mutate B: add a node only B should see.
      await addNode(b1.page, 'sentinel-B', 'analogVco');

      // Tab a2: enter rackspace A in a NEW tab. The server should sync
      // it the original A state ({sentinel-A} only) — B's sentinel-B
      // must NOT appear in A.
      await attach(a2.page, rackA);
      await expect
        .poll(async () => (await snapshot(a2.page)).nodes, { timeout: 4000 })
        .toEqual(['sentinel-A']);

      // Belt-and-suspenders: the original a1 tab still on rackspace A
      // also doesn't see sentinel-B (no cross-room leak in either
      // direction).
      const a1Snap = await snapshot(a1.page);
      expect(a1Snap.nodes).not.toContain('sentinel-B');
      expect(a1Snap.nodes).toContain('sentinel-A');
    } finally {
      await Promise.all([a1.ctx.close(), b1.ctx.close(), a2.ctx.close()]);
    }
  });

  test('same-tab navigation A → B → A starts B from empty and does NOT carry A edits server-side', async ({
    browser,
  }) => {
    // Models the user's likely flow: one tab, click a link to rack A,
    // do work, navigate to rack B, do work, navigate back. The bug
    // before the fix was that A's in-memory Y.Doc carried edits into B's
    // Hocuspocus room because the singleton was never reset.
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const rackA = `nav-A-${suffix}`;
    const rackB = `nav-B-${suffix}`;

    const tab = await bootTab(browser);
    // Verifier tab — connects to each rack after the navigating tab has
    // moved on, so we observe what the server actually holds for the
    // room (not just the navigating tab's in-memory state).
    const verifier = await bootTab(browser);

    try {
      // Visit A, plant a node.
      await attach(tab.page, rackA);
      await addNode(tab.page, 'A-only', 'analogVco');

      // Navigate the same tab to B (re-bind), plant a different node.
      await attach(tab.page, rackB);
      // Critical isolation check: B must start EMPTY. With the bug, A's
      // node would still be in the same Y.Doc and the listener would see
      // it in B too.
      await expect
        .poll(async () => (await snapshot(tab.page)).nodes, { timeout: 4000 })
        .toEqual([]);
      await addNode(tab.page, 'B-only', 'analogVco');

      // Verifier joins B fresh — server should report only B-only.
      await attach(verifier.page, rackB);
      await expect
        .poll(async () => (await snapshot(verifier.page)).nodes, { timeout: 4000 })
        .toEqual(['B-only']);

      // Now verifier joins A — server should report only A-only (B's
      // edits did NOT bleed back into A's room).
      await attach(verifier.page, rackA);
      await expect
        .poll(async () => (await snapshot(verifier.page)).nodes, { timeout: 4000 })
        .toEqual(['A-only']);
    } finally {
      await Promise.all([tab.ctx.close(), verifier.ctx.close()]);
    }
  });
});
