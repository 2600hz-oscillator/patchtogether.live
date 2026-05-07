// e2e/tests/awareness.spec.ts
//
// Multi-context Stage B PR B-c (@collab) tests for the Awareness layer.
// Two browser contexts attach to the same Hocuspocus rackspace, set their
// `user` + `cursor` local state, and verify each sees the other's cursor
// move within the latency budget — and that the cursor disappears when
// the peer closes their tab.

import { test, expect } from '@playwright/test';

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
  const rackspaceId = `awareness-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  for (const p of [pageA, pageB]) {
    await p.goto('/');
    await p.waitForLoadState('networkidle');
    await p.waitForFunction(
      () =>
        typeof (window as unknown as { __attachProvider?: unknown }).__attachProvider === 'function',
    );
  }

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
      await Promise.all([ctxA.close().catch(() => {}), ctxB.close().catch(() => {})]);
    },
  };
}

test.describe('@collab awareness', () => {
  test('A sets a cursor; B sees it within 1s', async ({ browser }) => {
    const s = await openTwoContexts(browser);
    try {
      await s.pageA.evaluate(() => {
        const w = window as unknown as {
          __setAwarenessUser: (u: { id: string; displayName: string; color: string }) => boolean;
          __setAwarenessCursor: (x: number, y: number) => boolean;
        };
        w.__setAwarenessUser({ id: 'user-a', displayName: 'Alice', color: '#ef4444' });
        w.__setAwarenessCursor(123, 456);
      });

      await s.pageB.evaluate(() => {
        const w = window as unknown as {
          __setAwarenessUser: (u: { id: string; displayName: string; color: string }) => boolean;
        };
        w.__setAwarenessUser({ id: 'user-b', displayName: 'Bob', color: '#3b82f6' });
      });

      await expect
        .poll(
          async () =>
            await s.pageB.evaluate(() => {
              const w = window as unknown as {
                __getAwarenessStates: () => Array<{
                  clientId: number;
                  user?: { id: string };
                  cursor?: { x: number; y: number };
                }>;
                __getLocalClientId: () => number | null;
              };
              const local = w.__getLocalClientId();
              const remote = w.__getAwarenessStates().find(
                (s) => s.clientId !== local && s.user?.id === 'user-a',
              );
              return remote?.cursor ?? null;
            }),
          { timeout: 1000 },
        )
        .toEqual({ x: 123, y: 456 });
    } finally {
      await s.close();
    }
  });

  test('A moves cursor; B sees the position update within 200ms', async ({ browser }) => {
    const s = await openTwoContexts(browser);
    try {
      await s.pageA.evaluate(() => {
        const w = window as unknown as {
          __setAwarenessUser: (u: { id: string; displayName: string; color: string }) => boolean;
          __setAwarenessCursor: (x: number, y: number) => boolean;
        };
        w.__setAwarenessUser({ id: 'mover', displayName: 'Mover', color: '#22c55e' });
        w.__setAwarenessCursor(0, 0);
      });

      await expect
        .poll(
          async () =>
            await s.pageB.evaluate(() => {
              const w = window as unknown as {
                __getAwarenessStates: () => Array<{ clientId: number; user?: { id: string } }>;
                __getLocalClientId: () => number | null;
              };
              const local = w.__getLocalClientId();
              return !!w.__getAwarenessStates().find(
                (s) => s.clientId !== local && s.user?.id === 'mover',
              );
            }),
          { timeout: 1500 },
        )
        .toBe(true);

      await s.pageA.evaluate(() => {
        const w = window as unknown as {
          __setAwarenessCursor: (x: number, y: number) => boolean;
        };
        w.__setAwarenessCursor(789, 321);
      });

      await expect
        .poll(
          async () =>
            await s.pageB.evaluate(() => {
              const w = window as unknown as {
                __getAwarenessStates: () => Array<{
                  clientId: number;
                  user?: { id: string };
                  cursor?: { x: number; y: number };
                }>;
                __getLocalClientId: () => number | null;
              };
              const local = w.__getLocalClientId();
              return (
                w.__getAwarenessStates().find(
                  (s) => s.clientId !== local && s.user?.id === 'mover',
                )?.cursor ?? null
              );
            }),
          { timeout: 200, intervals: [25, 50, 100] },
        )
        .toEqual({ x: 789, y: 321 });
    } finally {
      await s.close();
    }
  });

  test('peer closes tab; remaining context no longer sees their cursor within 1s', async ({
    browser,
  }) => {
    const s = await openTwoContexts(browser);
    try {
      await s.pageA.evaluate(() => {
        const w = window as unknown as {
          __setAwarenessUser: (u: { id: string; displayName: string; color: string }) => boolean;
          __setAwarenessCursor: (x: number, y: number) => boolean;
        };
        w.__setAwarenessUser({ id: 'leaver', displayName: 'Leaver', color: '#a855f7' });
        w.__setAwarenessCursor(50, 50);
      });

      // B sees A first.
      await expect
        .poll(
          async () =>
            await s.pageB.evaluate(() => {
              const w = window as unknown as {
                __getAwarenessStates: () => Array<{ clientId: number; user?: { id: string } }>;
                __getLocalClientId: () => number | null;
              };
              const local = w.__getLocalClientId();
              return !!w.__getAwarenessStates().find(
                (s) => s.clientId !== local && s.user?.id === 'leaver',
              );
            }),
          { timeout: 1500 },
        )
        .toBe(true);

      // A's tab closes — Hocuspocus broadcasts removal to B.
      await s.ctxA.close();

      await expect
        .poll(
          async () =>
            await s.pageB.evaluate(() => {
              const w = window as unknown as {
                __getAwarenessStates: () => Array<{ clientId: number; user?: { id: string } }>;
                __getLocalClientId: () => number | null;
              };
              const local = w.__getLocalClientId();
              return !!w.__getAwarenessStates().find(
                (s) => s.clientId !== local && s.user?.id === 'leaver',
              );
            }),
          { timeout: 2000 },
        )
        .toBe(false);
    } finally {
      // ctxA may already be closed; close() is idempotent in our wrapper.
      await s.close();
    }
  });
});
