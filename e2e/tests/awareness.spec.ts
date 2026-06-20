// e2e/tests/awareness.spec.ts
//
// Multi-context Stage B PR B-c (@collab) tests for the Awareness layer.
// Two browser contexts attach to the same Hocuspocus rackspace, set their
// `user` + `cursor` local state, and verify each sees the other's cursor
// move within the latency budget — and that the cursor disappears when
// the peer closes their tab.

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
  // PRESENCE CONVERGENCE — the headline reliability assertion. The live bug
  // was that two browsers in one rack EACH showed "1/4 members" (each saw only
  // ITSELF in awareness). The Yjs doc synced fine but presence/awareness did
  // not propagate/backfill between peers. This test asserts BOTH contexts
  // converge to seeing the OTHER (memberCount == 2 from each side) within a
  // budget — the property every collaborative feature depends on. If this
  // fails reliably, presence backfill is broken; if it passes reliably, the
  // live desync was transient (a relay restart wiping in-memory awareness).
  test('both contexts converge to memberCount==2 (each sees the other)', async ({
    browser,
  }) => {
    const s = await openTwoContexts(browser);
    try {
      // Each peer publishes a distinct presence identity (as the rack page's
      // presence init does). Neither sets a cursor — pure presence.
      await s.pageA.evaluate(() => {
        (window as unknown as {
          __setAwarenessUser: (u: { id: string; displayName: string; color: string }) => boolean;
        }).__setAwarenessUser({ id: 'peer-a', displayName: 'A', color: '#ef4444' });
      });
      await s.pageB.evaluate(() => {
        (window as unknown as {
          __setAwarenessUser: (u: { id: string; displayName: string; color: string }) => boolean;
        }).__setAwarenessUser({ id: 'peer-b', displayName: 'B', color: '#3b82f6' });
      });

      // Count OTHER members (states carrying a real `user.id`, excluding self
      // and the server's heartbeat-only client). This mirrors how DoomCard /
      // the rack bar derive the member count.
      const otherMemberCount = (page: import('@playwright/test').Page) =>
        page.evaluate(() => {
          const w = window as unknown as {
            __getAwarenessStates: () => Array<{ clientId: number; user?: { id?: string } }>;
            __getLocalClientId: () => number | null;
          };
          const local = w.__getLocalClientId();
          return w
            .__getAwarenessStates()
            .filter((st) => st.clientId !== local && typeof st.user?.id === 'string').length;
        });

      // BOTH directions must converge — not just A→B. A one-sided pass would
      // hide exactly the split-brain (each peer alone in its own view).
      await expect
        .poll(() => otherMemberCount(s.pageA), { timeout: SYNC_BUDGET_MS, intervals: SYNC_POLL_INTERVALS })
        .toBe(1);
      await expect
        .poll(() => otherMemberCount(s.pageB), { timeout: SYNC_BUDGET_MS, intervals: SYNC_POLL_INTERVALS })
        .toBe(1);

      // And each names the OTHER peer specifically (not a stale/self echo).
      const seesPeer = (page: import('@playwright/test').Page, id: string) =>
        page.evaluate((wantId) => {
          const w = window as unknown as {
            __getAwarenessStates: () => Array<{ clientId: number; user?: { id?: string } }>;
            __getLocalClientId: () => number | null;
          };
          const local = w.__getLocalClientId();
          return w
            .__getAwarenessStates()
            .some((st) => st.clientId !== local && st.user?.id === wantId);
        }, id);
      expect(await seesPeer(s.pageA, 'peer-b'), 'A sees B').toBe(true);
      expect(await seesPeer(s.pageB, 'peer-a'), 'B sees A').toBe(true);
    } finally {
      await s.close();
    }
  });

  // Late-join backfill: A is already present + has published its identity, THEN
  // B connects. B must receive A's EXISTING awareness state (the server's
  // sendCurrentAwareness backfill on connect), not just A's future updates.
  // This is the reconnection / join-after-others path that the live desync hit.
  test('a peer joining AFTER another backfills the existing presence', async ({ browser }) => {
    const rackspaceId = `awareness-backfill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    try {
      // A connects + publishes identity FIRST.
      await pageA.goto('/');
      await pageA.waitForLoadState('networkidle');
      await pageA.waitForFunction(
        () => typeof (window as unknown as { __attachProvider?: unknown }).__attachProvider === 'function',
      );
      await pageA.evaluate(async (id) => {
        await (window as unknown as { __attachProvider: (id: string) => Promise<unknown> }).__attachProvider(id);
        (window as unknown as {
          __setAwarenessUser: (u: { id: string; displayName: string; color: string }) => boolean;
        }).__setAwarenessUser({ id: 'early-a', displayName: 'EarlyA', color: '#22c55e' });
      }, rackspaceId);

      // THEN B connects — it must backfill A's already-published presence.
      await pageB.goto('/');
      await pageB.waitForLoadState('networkidle');
      await pageB.waitForFunction(
        () => typeof (window as unknown as { __attachProvider?: unknown }).__attachProvider === 'function',
      );
      await pageB.evaluate(async (id) => {
        await (window as unknown as { __attachProvider: (id: string) => Promise<unknown> }).__attachProvider(id);
        (window as unknown as {
          __setAwarenessUser: (u: { id: string; displayName: string; color: string }) => boolean;
        }).__setAwarenessUser({ id: 'late-b', displayName: 'LateB', color: '#a855f7' });
      }, rackspaceId);

      // B must see A (backfill), and A must see B (incremental) — both within budget.
      const seesId = (page: import('@playwright/test').Page, id: string) =>
        page.evaluate((wantId) => {
          const w = window as unknown as {
            __getAwarenessStates: () => Array<{ clientId: number; user?: { id?: string } }>;
            __getLocalClientId: () => number | null;
          };
          const local = w.__getLocalClientId();
          return w.__getAwarenessStates().some((st) => st.clientId !== local && st.user?.id === wantId);
        }, id);
      await expect
        .poll(() => seesId(pageB, 'early-a'), { timeout: SYNC_BUDGET_MS, intervals: SYNC_POLL_INTERVALS })
        .toBe(true);
      await expect
        .poll(() => seesId(pageA, 'late-b'), { timeout: SYNC_BUDGET_MS, intervals: SYNC_POLL_INTERVALS })
        .toBe(true);
    } finally {
      await Promise.all([ctxA.close().catch(() => {}), ctxB.close().catch(() => {})]);
    }
  });

  // Cursor PROPAGATION correctness: A publishes a cursor position, B converges
  // to the exact coordinates. (This is the cursor-MOVE coverage too — the old
  // separate "within 200ms" SLA test was a pure-LATENCY assertion that flaked
  // under CI relay contention and proved nothing this doesn't; it was removed
  // in the @collab de-flake. Correctness, not speed, is the property we gate.)
  test('A sets a cursor; B converges to the same position', async ({ browser }) => {
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
          { timeout: SYNC_BUDGET_MS, intervals: SYNC_POLL_INTERVALS },
        )
        .toEqual({ x: 123, y: 456 });
    } finally {
      await s.close();
    }
  });

  test('peer closes tab; remaining context no longer sees their cursor', async ({
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
          { timeout: SYNC_BUDGET_MS, intervals: SYNC_POLL_INTERVALS },
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
          { timeout: SYNC_BUDGET_MS, intervals: SYNC_POLL_INTERVALS },
        )
        .toBe(false);
    } finally {
      // ctxA may already be closed; close() is idempotent in our wrapper.
      await s.close();
    }
  });
});
