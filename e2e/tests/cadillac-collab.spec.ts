// e2e/tests/cadillac-collab.spec.ts
//
// @collab — CADILLAC across two contexts on one rackspace. User A
// spawns the car; the deletions land in A's Yjs doc and propagate to
// B via the Hocuspocus relay. B observes the same final state. The car
// publishes ZERO awareness traffic — the overlay derives its position
// from the node's spawnedAtMs/spawnerClientId, so B's awareness state
// for A should NOT carry per-frame car positions.

import { test, expect, type Page, type Browser } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });

interface PatchNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data?: Record<string, unknown>;
}

async function attach(
  browser: Browser,
  rackspaceId: string,
  identity: { id: string; displayName: string; color: string },
): Promise<{ page: Page; ctx: import('@playwright/test').BrowserContext }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => {
    const w = window as unknown as {
      __attachProvider?: unknown;
      __spawnFromPalette?: unknown;
      __ensureEngine?: unknown;
    };
    return (
      typeof w.__attachProvider === 'function' &&
      typeof w.__spawnFromPalette === 'function' &&
      typeof w.__ensureEngine === 'function'
    );
  });
  await page.evaluate(
    async ({ id, ident }) => {
      const w = window as unknown as {
        __attachProvider: (id: string) => Promise<unknown>;
        __setAwarenessUser: (u: typeof ident) => boolean;
        __ensureEngine: () => Promise<unknown>;
      };
      await w.__attachProvider(id);
      await w.__ensureEngine();
      w.__setAwarenessUser(ident);
    },
    { id: rackspaceId, ident: identity },
  );
  return { page, ctx };
}

async function readNodes(page: Page): Promise<PatchNode[]> {
  return await page.evaluate(() => {
    const w = window as unknown as {
      __patch: { nodes: Record<string, PatchNode> };
    };
    return Object.values(w.__patch.nodes).filter(Boolean) as PatchNode[];
  });
}

test.describe('@collab cadillac', () => {
  test('A spawns CADILLAC; B sees the deletions land via Yjs', async ({ browser }) => {
    const rackspaceId = `cadillac-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const a = await attach(browser, rackspaceId, {
      id: 'cad-a',
      displayName: 'Alice',
      color: '#ef4444',
    });
    const b = await attach(browser, rackspaceId, {
      id: 'cad-b',
      displayName: 'Bob',
      color: '#3b82f6',
    });
    try {
      // A places three VCOs in the car's path.
      await a.page.evaluate(() => {
        const w = window as unknown as {
          __patch: {
            nodes: Record<string, unknown>;
            edges: Record<string, unknown>;
          };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => {
          for (const id of Object.keys(w.__patch.edges)) delete w.__patch.edges[id];
          for (const id of Object.keys(w.__patch.nodes)) delete w.__patch.nodes[id];
          for (let i = 0; i < 3; i++) {
            const id = `vco-${i + 1}`;
            w.__patch.nodes[id] = {
              id,
              type: 'analogVco',
              domain: 'audio',
              position: { x: 100 + i * 160, y: 0 },
              params: {},
              data: {},
            };
          }
        });
      });

      // Wait for B to see the spawn (Yjs convergence).
      await expect
        .poll(async () => (await readNodes(b.page)).length, { timeout: 5000 })
        .toBe(3);

      // Wait for SvelteFlow on A to measure cards so the overlay can hit.
      await a.page.waitForFunction(
        () => document.querySelectorAll('.svelte-flow__node').length === 3,
        null,
        { timeout: 5000 },
      );

      // Snapshot B's awareness states so we can confirm no per-frame car
      // positions leak through it. Awareness keys we care about: not
      // 'cadillac', not 'carX', etc.
      const awarenessKeysBefore = await b.page.evaluate(() => {
        const w = window as unknown as {
          __getAwarenessStates: () => Array<Record<string, unknown>>;
        };
        const all = w.__getAwarenessStates();
        const keys = new Set<string>();
        for (const st of all) {
          for (const k of Object.keys(st)) keys.add(k);
        }
        return [...keys];
      });
      expect(
        awarenessKeysBefore.some((k) => /cadillac|car/i.test(k)),
        'awareness must not carry any cadillac-shaped keys',
      ).toBe(false);

      // A spawns the car.
      await a.page.evaluate(() => {
        (window as unknown as { __spawnFromPalette: (t: string) => void }).__spawnFromPalette(
          'cadillac',
        );
      });

      // Snap the three VCOs onto the car's y so they sit in the hit-band.
      await a.page.evaluate(() => {
        const w = window as unknown as {
          __patch: { nodes: Record<string, { type: string; position: { y: number } }> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        const cad = Object.values(w.__patch.nodes).find((n) => n?.type === 'cadillac');
        if (!cad) return;
        const carY = cad.position.y;
        w.__ydoc.transact(() => {
          for (const n of Object.values(w.__patch.nodes)) {
            if (n.type === 'analogVco') n.position.y = carY;
          }
        });
      });

      // B observes the eventual deletion of the three VCOs through Yjs.
      await expect
        .poll(
          async () => (await readNodes(b.page)).filter((n) => n.type === 'analogVco').length,
          { timeout: 15_000, intervals: [250] },
        )
        .toBe(0);

      // Eventually the cadillac itself disappears on B (self-destruct).
      await expect
        .poll(
          async () => (await readNodes(b.page)).filter((n) => n.type === 'cadillac').length,
          { timeout: 18_000, intervals: [250] },
        )
        .toBe(0);

      // After the drive, the awareness key surface must still not have
      // grown any cadillac-shaped entries — the car is purely deterministic
      // from node.data, no per-frame awareness packets.
      const awarenessKeysAfter = await b.page.evaluate(() => {
        const w = window as unknown as {
          __getAwarenessStates: () => Array<Record<string, unknown>>;
        };
        const all = w.__getAwarenessStates();
        const keys = new Set<string>();
        for (const st of all) {
          for (const k of Object.keys(st)) keys.add(k);
        }
        return [...keys];
      });
      expect(
        awarenessKeysAfter.some((k) => /cadillac|car/i.test(k)),
        'awareness must not carry any cadillac-shaped keys post-drive',
      ).toBe(false);
    } finally {
      await Promise.all([a.ctx.close().catch(() => {}), b.ctx.close().catch(() => {})]);
    }
  });
});
