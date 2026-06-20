// e2e/tests/collab.spec.ts
//
// Multi-context Stage B tests, tagged @collab. Each test spawns 2 browser
// contexts (separate cookie jars, localStorage, ydocs) and attaches both
// to the same Hocuspocus rackspace via the dev-only __attachProvider
// global. The Hocuspocus server is stub-accept (PR A scope) so no Clerk
// flow is exercised here — that's covered by auth-routes.spec.ts.
//
// Tests cover:
//   - sync: a node added in A appears in B
//   - layouts: A drag does NOT move it on B (per-user layout split)
//   - layouts: A and B can independently drag; each sees own override
//
// To run only collab specs:  npx playwright test --grep @collab

import { test, expect } from '@playwright/test';
import { SYNC_BUDGET_MS, SYNC_POLL_INTERVALS } from './_collab-helpers';

interface CollabContexts {
  pageA: import('@playwright/test').Page;
  pageB: import('@playwright/test').Page;
  ctxA: import('@playwright/test').BrowserContext;
  ctxB: import('@playwright/test').BrowserContext;
  rackspaceId: string;
  close: () => Promise<void>;
}

async function openTwoContexts(
  browser: import('@playwright/test').Browser,
): Promise<CollabContexts> {
  const rackspaceId = `collab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  // Public canvas at `/` keeps Clerk out of the picture. The dev global
  // __attachProvider is exposed in +layout.svelte for both authed and
  // unauthed routes (the layout always runs).
  for (const p of [pageA, pageB]) {
    await p.goto('/');
    await p.waitForLoadState('networkidle');
    await p.waitForFunction(
      () =>
        typeof (window as unknown as { __attachProvider?: unknown }).__attachProvider === 'function',
    );
  }

  // Both contexts attach to the same rackspace doc and await the
  // provider's `synced` event before proceeding. __attachProvider is
  // async and resolves once the initial sync completes (or rejects on a
  // 5s timeout) — see +layout.svelte.
  await Promise.all(
    [pageA, pageB].map((p) =>
      p.evaluate(async (id) => {
        const w = window as unknown as { __attachProvider: (id: string) => Promise<unknown> };
        await w.__attachProvider(id);
      }, rackspaceId),
    ),
  );

  return {
    pageA,
    pageB,
    ctxA,
    ctxB,
    rackspaceId,
    async close() {
      await Promise.all([ctxA.close(), ctxB.close()]);
    },
  };
}

test.describe('@collab', () => {
  test('sync: node added in A appears in B', async ({ browser }) => {
    const s = await openTwoContexts(browser);
    try {
      await s.pageA.evaluate(() => {
        const w = window as unknown as {
          __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => {
          w.__patch.nodes['shared-1'] = {
            id: 'shared-1',
            type: 'analogVco',
            domain: 'audio',
            position: { x: 100, y: 100 },
            params: {},
          };
        });
      });

      await expect
        .poll(
          async () =>
            await s.pageB.evaluate(() => {
              const w = window as unknown as { __patch: { nodes: Record<string, unknown> } };
              return Object.keys(w.__patch.nodes).includes('shared-1');
            }),
          { timeout: SYNC_BUDGET_MS, intervals: SYNC_POLL_INTERVALS },
        )
        .toBe(true);
    } finally {
      await s.close();
    }
  });

  test('layouts: A drags node, B does not see it move (per-user layout split)', async ({ browser }) => {
    const s = await openTwoContexts(browser);
    try {
      await s.pageA.evaluate(() => {
        const w = window as unknown as {
          __patch: { nodes: Record<string, unknown> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => {
          w.__patch.nodes['layout-test'] = {
            id: 'layout-test',
            type: 'analogVco',
            domain: 'audio',
            position: { x: 100, y: 100 },
            params: {},
          };
        });
      });

      await expect
        .poll(
          async () =>
            await s.pageB.evaluate(() =>
              Object.keys(
                (window as unknown as { __patch: { nodes: Record<string, unknown> } }).__patch.nodes,
              ),
            ),
          { timeout: SYNC_BUDGET_MS, intervals: SYNC_POLL_INTERVALS },
        )
        .toContain('layout-test');

      // A drags 'layout-test' to (500, 500) using its OWN userId 'user-a'.
      await s.pageA.evaluate(() => {
        const w = window as unknown as {
          __setNodePosition: (uid: string, nid: string, p: { x: number; y: number }) => void;
        };
        w.__setNodePosition('user-a', 'layout-test', { x: 500, y: 500 });
      });
      await s.pageB.waitForTimeout(500);

      // B reads the same node with userId 'user-b' — should see the
      // fallback, NOT A's override.
      const bSeesPosition = await s.pageB.evaluate(() =>
        (window as unknown as {
          __getNodePosition: (
            uid: string,
            nid: string,
            fb: { x: number; y: number },
          ) => { x: number; y: number };
        }).__getNodePosition('user-b', 'layout-test', { x: 100, y: 100 }),
      );
      expect(bSeesPosition).toEqual({ x: 100, y: 100 });

      const aSeesPosition = await s.pageA.evaluate(() =>
        (window as unknown as {
          __getNodePosition: (
            uid: string,
            nid: string,
            fb: { x: number; y: number },
          ) => { x: number; y: number };
        }).__getNodePosition('user-a', 'layout-test', { x: 100, y: 100 }),
      );
      expect(aSeesPosition).toEqual({ x: 500, y: 500 });
    } finally {
      await s.close();
    }
  });

  test('layouts: A and B independently drag; each sees own override', async ({ browser }) => {
    const s = await openTwoContexts(browser);
    try {
      await s.pageA.evaluate(() => {
        const w = window as unknown as {
          __patch: { nodes: Record<string, unknown> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => {
          w.__patch.nodes['both-drag'] = {
            id: 'both-drag',
            type: 'vca',
            domain: 'audio',
            position: { x: 200, y: 200 },
            params: {},
          };
        });
      });

      await expect
        .poll(
          async () =>
            await s.pageB.evaluate(
              () =>
                Object.keys(
                  (window as unknown as { __patch: { nodes: Record<string, unknown> } }).__patch.nodes,
                ).length,
            ),
          { timeout: SYNC_BUDGET_MS, intervals: SYNC_POLL_INTERVALS },
        )
        .toBeGreaterThan(0);

      await s.pageA.evaluate(() =>
        (window as unknown as {
          __setNodePosition: (uid: string, nid: string, p: unknown) => void;
        }).__setNodePosition('user-a', 'both-drag', { x: 700, y: 100 }),
      );
      await s.pageB.evaluate(() =>
        (window as unknown as {
          __setNodePosition: (uid: string, nid: string, p: unknown) => void;
        }).__setNodePosition('user-b', 'both-drag', { x: 100, y: 700 }),
      );

      await s.pageA.waitForTimeout(500);
      await s.pageB.waitForTimeout(500);

      const aPos = await s.pageA.evaluate(() =>
        (window as unknown as {
          __getNodePosition: (uid: string, nid: string, fb: unknown) => { x: number; y: number };
        }).__getNodePosition('user-a', 'both-drag', { x: 0, y: 0 }),
      );
      const bPos = await s.pageB.evaluate(() =>
        (window as unknown as {
          __getNodePosition: (uid: string, nid: string, fb: unknown) => { x: number; y: number };
        }).__getNodePosition('user-b', 'both-drag', { x: 0, y: 0 }),
      );
      expect(aPos).toEqual({ x: 700, y: 100 });
      expect(bPos).toEqual({ x: 100, y: 700 });

      // Each can introspect the other's override (useful for PR E
      // awareness/cursor rendering).
      const aSeesB = await s.pageA.evaluate(() =>
        (window as unknown as {
          __getNodePosition: (uid: string, nid: string, fb: unknown) => { x: number; y: number };
        }).__getNodePosition('user-b', 'both-drag', { x: 0, y: 0 }),
      );
      expect(aSeesB).toEqual({ x: 100, y: 700 });
    } finally {
      await s.close();
    }
  });
});
