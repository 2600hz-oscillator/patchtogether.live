// e2e/tests/doom-late-join.spec.ts
//
// Late-join acceptance: HOT-DROP into the running map.
//
// The late-join design (operator-revised — supersedes the slice-6 "seat at the
// next map" reservation): a peer that joins an IN-PROGRESS game spawns into the
// CURRENT map within seconds, not at the next map. DOOM has no true mid-level
// join (the player set is fixed at G_InitNew + the lockstep tic stream assumes a
// constant playeringame[]), so the pragmatic mechanism is: the arbiter seats the
// joiner as an ACTIVE player and immediately RE-LAUNCHES the current map (same
// skill/episode/map, larger numPlayers). Every peer reloads the level via
// G_InitNew and the joiner spawns at its coop start — a fast ~1-2s reload.
//
// This 2-context test proves the path end-to-end in the browser:
//   1. A (arbiter / host = player 0) spawns + loads DOOM, joins, launches coop
//      E1M1. A is in the level (gamestate == GS_LEVEL).
//   2. B joins WHILE A's level is running → B is seated ACTIVE at slot 1 (NOT
//      pending) and the arbiter hot-drop-relaunches the current map, so B
//      reaches GS_LEVEL with a live marine at slot 1 within seconds.
//
// QUARANTINE (task #97): the @collab 2-context Hocuspocus relay drops peer B
// under CI shard load → flaky. Skip on CI; runs locally. The pending↔active
// roster model + promotion is unit-proven (doom-roster.test.ts); the
// spectator/pending label states are unit-proven (doom-player-identity.test.ts);
// and the C-side start-netgame.acceptance.mjs harness deterministically proves
// a late joiner spawns at the NEXT map (and NOT during the running one). This
// spec is the browser-level integration check, run locally.

import { test, expect, type Page, type Browser } from '@playwright/test';
import { spawnPatch, type SpawnNode } from './_helpers';
import { SYNC_BUDGET_MS } from './_collab-helpers';

const GS_LEVEL = 0;

interface DoomPair {
  pageA: Page;
  pageB: Page;
  close: () => Promise<void>;
}

async function checkAssets(page: Page): Promise<{ ok: boolean; reason?: string }> {
  const wasmOk = await page.evaluate(async () => {
    try { return (await fetch('/doom/doom.js', { method: 'HEAD' })).ok; } catch { return false; }
  });
  if (!wasmOk) {
    return { ok: false, reason: 'DOOM WASM not built — run `bash packages/web/native/build-doom-wasm.sh`' };
  }
  const wadOk = await page.evaluate(async () => {
    try { return (await fetch('/doom/DOOM1.WAD', { method: 'HEAD' })).ok; } catch { return false; }
  });
  if (!wadOk) {
    return { ok: false, reason: 'DOOM1.WAD missing — see static/doom/DOWNLOAD_INSTRUCTIONS.md' };
  }
  return { ok: true };
}

async function openPair(browser: Browser): Promise<DoomPair> {
  const rackspaceId = `doom-late-join-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  for (const p of [pageA, pageB]) {
    await p.goto('/rack');
    await p.waitForLoadState('networkidle');
    await p.waitForFunction(() =>
      typeof (window as unknown as { __attachProvider?: unknown }).__attachProvider === 'function',
    );
  }

  // A first + lex-smallest id → A wins the arbiter/host tiebreak (player 0).
  await pageA.evaluate(async (id) => {
    const w = window as unknown as {
      __attachProvider: (id: string) => Promise<unknown>;
      __ensureEngine: () => Promise<unknown>;
      __setAwarenessUser: (u: { id: string; displayName: string; color: string }) => boolean;
    };
    await w.__ensureEngine();
    await w.__attachProvider(id);
    w.__setAwarenessUser({ id: 'aaa-userA', displayName: 'A', color: '#f00' });
  }, rackspaceId);
  await pageB.evaluate(async (id) => {
    const w = window as unknown as {
      __attachProvider: (id: string) => Promise<unknown>;
      __ensureEngine: () => Promise<unknown>;
      __setAwarenessUser: (u: { id: string; displayName: string; color: string }) => boolean;
    };
    await w.__ensureEngine();
    await w.__attachProvider(id);
    w.__setAwarenessUser({ id: 'bbb-userB', displayName: 'B', color: '#0f0' });
  }, rackspaceId);

  return {
    pageA,
    pageB,
    async close() {
      await Promise.all([ctxA.close().catch(() => {}), ctxB.close().catch(() => {})]);
    },
  };
}

async function spawnAndLoadDoom(page: Page, nodeId: string): Promise<boolean> {
  const nodes: SpawnNode[] = [
    { id: nodeId, type: 'doom', position: { x: 60, y: 60 }, domain: 'video' },
  ];
  await spawnPatch(page, nodes, []);
  const card = page.locator('[data-testid="doom-card"]');
  await card.locator('button.overlay', { hasText: /Click to load DOOM/i }).click();
  try {
    await page.waitForFunction(
      (id) => {
        const w = globalThis as unknown as {
          __engine?: () => { getDomain?: (d: string) => { read?: (id: string, k: string) => unknown } | null } | null;
        };
        return w.__engine?.()?.getDomain?.('video')?.read?.(id, 'loaded') === true;
      },
      nodeId,
      { timeout: 25000 },
    );
    return true;
  } catch {
    return false;
  }
}

async function waitForCardHook(page: Page, nodeId: string, timeout = 10000): Promise<void> {
  await page.waitForFunction(
    (id) => {
      const w = globalThis as unknown as { __doomCards?: Record<string, unknown> };
      return !!w.__doomCards && !!w.__doomCards[id];
    },
    nodeId,
    { timeout },
  );
}

async function join(page: Page, nodeId: string): Promise<void> {
  await waitForCardHook(page, nodeId);
  await page.evaluate(async (id) => {
    const w = globalThis as unknown as { __doomCards: Record<string, { join: () => Promise<void> }> };
    await w.__doomCards[id]!.join();
  }, nodeId);
}

interface CardState {
  roster: Record<string, string>;
  pending: Record<string, string>;
  mySlot: number | null;
  myPendingSlot: number | null;
  viewerStatus: 'player' | 'pending' | 'spectator';
  netStarted: boolean;
  isHost: boolean;
  launched: boolean;
  gamestate: number;
  specLabel: string;
  specBadge: string;
}

async function cardState(page: Page, nodeId: string): Promise<CardState | null> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as { __doomCards?: Record<string, { getState: () => unknown }> };
    const c = w.__doomCards?.[id];
    return c ? (c.getState() as never) : null;
  }, nodeId);
}

async function slotPos(
  page: Page,
  nodeId: string,
  slot: number,
): Promise<{ x: number; y: number } | null> {
  return await page.evaluate(
    (args) => {
      const [id, s] = args as [string, number];
      const w = globalThis as unknown as {
        __doomCards?: Record<string, { getSlotState: (slot: number) => { x: number; y: number } | null }>;
      };
      return w.__doomCards?.[id]?.getSlotState(s) ?? null;
    },
    [nodeId, slot],
  );
}

test.describe('@collab DOOM late-join — hot-drop into the running map', () => {
  // Runs on the dedicated @collab lane (COLLAB_JOB=1 — relay + Postgres), and
  // is skipped only in the sharded matrix where the relay/DB aren't available.
  // De-flaked (consolidated #837+#841): the former relay-flake vacuity skips in
  // the body are now real SYNC_BUDGET_MS-bounded waits that FAIL if cross-context
  // sync never lands. The pending↔active model + promotion stays unit-proven
  // (doom-roster.test.ts); this is the browser-level integration check.
  test.skip(!!process.env.CI && !process.env.COLLAB_JOB, '@collab — runs on the dedicated COLLAB_JOB lane, not the sharded matrix');
  // Cold WASM + 4 MB WAD on TWO contexts + cross-context sync + a launch + an
  // intermission round-trip + a second launch → a long window. Generous ceiling.
  test.setTimeout(180_000);

  test('B joins mid-level → hot-drops into the current map as active player 1', async ({ browser }) => {
    const pair = await openPair(browser);
    try {
      const assets = await checkAssets(pair.pageA);
      if (!assets.ok) { test.skip(true, assets.reason); return; }

      const NODE = 'sut';

      // ─── A (arbiter / host) spawns + loads DOOM, joins as player 0 ───
      const aLoaded = await spawnAndLoadDoom(pair.pageA, NODE);
      if (!aLoaded) { test.skip(true, 'DOOM runtime failed to load on A within 25s'); return; }
      await pair.pageB.locator('[data-testid="doom-card"]').waitFor({ timeout: 10000 });
      await waitForCardHook(pair.pageB, NODE);

      await join(pair.pageA, NODE);
      await pair.pageA.waitForFunction(
        (id) => {
          const w = globalThis as unknown as { __doomCards?: Record<string, { getState: () => { mySlot: number | null } }> };
          return w.__doomCards?.[id]?.getState().mySlot === 0;
        },
        NODE,
        { timeout: 15000 },
      );

      // ─── A launches coop E1M1 — A is now in a RUNNING level ───
      await pair.pageA.evaluate((id) => {
        const w = globalThis as unknown as {
          __doomCards: Record<string, {
            setOptions: (o: { mode?: string; skill?: number; episode?: number; map?: number }) => void;
            launch: () => void;
          }>;
        };
        w.__doomCards[id]!.setOptions({ mode: 'coop', skill: 0, episode: 1, map: 1 });
        w.__doomCards[id]!.launch();
      }, NODE);
      await pair.pageA.waitForFunction(
        (args) => {
          const [id, level] = args as [string, number];
          const w = globalThis as unknown as { __doomCards?: Record<string, { getState: () => { launched: boolean; gamestate: number } }> };
          const st = w.__doomCards?.[id]?.getState();
          return !!st && st.launched === true && st.gamestate === level;
        },
        [NODE, GS_LEVEL],
        { timeout: SYNC_BUDGET_MS },
      );

      // ─── B joins WHILE A's level is running → HOT-DROP into the CURRENT map ─
      // Round 5: B's Join is gated on the host's live-MP signal — wait for it to
      // sync to B before joining (the signal is what enables the Join button).
      // De-flake (consolidated #837+#841): formerly vacuity skips ("relay flake"
      // → green-while-asserting-nothing). Now real SYNC_BUDGET_MS-bounded waits:
      // a correct slow cross-context sync passes; a relay that never delivers
      // throws → the test FAILS. Proves B sees A's live game and hot-drops as
      // active player 1 into the SAME running map via real roster sync.
      await pair.pageB.waitForFunction(
        (id) => {
          const w = globalThis as unknown as { __doomCards?: Record<string, { getState: () => { mpLive: boolean } }> };
          return w.__doomCards?.[id]?.getState().mpLive === true;
        },
        NODE,
        { timeout: SYNC_BUDGET_MS },
      );
      await join(pair.pageB, NODE);

      // B is seated ACTIVE at slot 1 (NOT pending) and the arbiter hot-drop-
      // relaunches the current map, so B reaches GS_LEVEL with a live marine.
      await pair.pageB.waitForFunction(
        (args) => {
          const [id, level] = args as [string, number];
          const w = globalThis as unknown as {
            __doomCards?: Record<string, { getState: () => { mySlot: number | null; launched: boolean; gamestate: number } }>;
          };
          const st = w.__doomCards?.[id]?.getState();
          return !!st && st.mySlot === 1 && st.launched === true && st.gamestate === level;
        },
        [NODE, GS_LEVEL],
        { timeout: SYNC_BUDGET_MS },
      );

      // ─── B is an ACTIVE player at slot 1 in the SAME map (not pending) ───
      const bFinal = await cardState(pair.pageB, NODE);
      expect(bFinal!.mySlot, 'B hot-dropped as active player 1').toBe(1);
      expect(bFinal!.myPendingSlot, 'B has NO pending reservation (active hot-drop)').toBeNull();
      expect(bFinal!.viewerStatus, 'B is a player, not a pending spectator').toBe('player');
      // The arbiter's ACTIVE roster now holds both players; pending stays empty.
      const aMid = await cardState(pair.pageA, NODE);
      expect(aMid!.roster, 'A active roster holds both players after hot-drop').toMatchObject({
        '0': 'aaa-userA',
        '1': 'bbb-userB',
      });
      expect(Object.keys(aMid!.pending), 'no pending reservations — hot-drop is immediate').toHaveLength(0);
      // B has a LIVE marine in the current map (slot 1 spawned via the relaunch).
      const bMarine = await slotPos(pair.pageB, NODE, 1);
      expect(bMarine, 'B spawned a live marine into the current map (hot-drop)').not.toBeNull();
    } finally {
      await pair.close();
    }
  });
});
