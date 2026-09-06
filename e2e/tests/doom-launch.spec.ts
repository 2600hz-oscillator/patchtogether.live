// e2e/tests/doom-launch.spec.ts
//
// Slice 4 acceptance: the New Game dialog + Launch flow — the slice where a
// multiplayer game can finally be STARTED.
//
// The committed model is "one shared node, N per-peer runtimes". This
// 2-context test proves the full launch path:
//
//   1. A spawns DOOM (arbiter / rack host = player 0). B joins via the
//      request → arbiter-assign flow → B gets slot 1, NO clobber (A keeps 0).
//   2. A picks coop + E1M1 + skill 1 (ITYTD) and hits Launch.
//   3. Both peers' WASM ENTER the level (gamestate == GS_LEVEL, asserted via
//      the runtime gamestate hook).
//   4. Each peer moves its OWN marine (arrows on A move players[consoleplayer]
//      on A only) — asserted via getPlayerState().x/y (the console-player
//      position hook). The two peers end at DIFFERENT positions, proving
//      separate per-peer game instances in one configured netgame (not a
//      shared view).
//
// SKIPS: exactly ONE, and only before anything has been proven — the WASM/WAD
// asset gate (`checkAssets`), so a contributor without the artifacts gets a
// clean skip rather than a mystery. EVERYTHING past that point ASSERTS.
//
// ⚠ This header used to promise the opposite, and was stale for a year: it
// described the cross-context roster sync as "best-effort … if it never reaches
// B within the window we SKIP". #837+#841 converted that to a real
// SYNC_BUDGET_MS-bounded wait that FAILS, and 2026-08-13 (#1592) converted the
// last one — "DOOM runtime failed to load on A within 25s" — to an assertion
// too. Both had been readable as "this spec is allowed to prove nothing", which
// is precisely how `collab:attest` came to treat a dead DOOM 2-user gate as a
// benign asset skip and mint an attestation over it.

import { test, expect, type Page, type Browser } from '@playwright/test';
import { spawnPatch, type SpawnNode } from './_helpers';
import { SYNC_BUDGET_MS } from './_collab-helpers';

const GS_LEVEL = 0;

/** The DOOM game surface — `doom/DoomSurface.svelte`, mounted by the shell's
 *  dock full view. It owns the runtime, the `__doomCards` hook, the keyboard
 *  capture, the identity badges and the "Click to load DOOM" gesture, so EVERY
 *  peer opens its own faceplate before anything about it can be driven or read.
 *  The card mounted the same component with `variant="card"`, so every probe,
 *  overlay and testid below is byte-identical on both. */
const SURFACE = 'doom-face-surface';

/** THIS node's LANE tile — how a peer observes that the node has SYNCED to it,
 *  before its own faceplate exists. */
const laneTile = (nodeId: string): string =>
  `.svelte-flow__node[data-id="${nodeId}"] [data-testid="module-shell"]`;

/** Open a node's dock faceplate through the app's own hook. The dock boot is
 *  SEQUENTIAL — it does not overlap the page load — so this is a real wait. */
async function openDoomFace(page: Page, nodeId: string): Promise<void> {
  await page.evaluate(
    (n) => (globalThis as unknown as { __openDockFullView(x: string): void }).__openDockFullView(n),
    nodeId,
  );
  await expect(page.getByTestId(SURFACE)).toBeVisible({ timeout: 20_000 });
}

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
  const rackspaceId = `doom-launch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  for (const p of [pageA, pageB]) {
    await p.goto('/rack?seed=none');
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

/** Read the video domain's own load state for a node. The surface's
 *  `loadStatus` is component-local; this is the engine-side truth the app
 *  writes. */
async function readLoadState(page: Page, nodeId: string): Promise<{ loaded: unknown; loadError: unknown }> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => { getDomain?: (d: string) => { read?: (id: string, k: string) => unknown } | null } | null;
    };
    const dom = w.__engine?.()?.getDomain?.('video');
    return { loaded: dom?.read?.(id, 'loaded') ?? null, loadError: dom?.read?.(id, 'loadError') ?? null };
  }, nodeId);
}

/**
 * Spawn DOOM on `page` and bring its runtime up. Returns the REASON it failed,
 * or null on success.
 *
 * ⚠ This used to be `Promise<boolean>` with a bare `catch { return false }`, and
 * the caller turned `false` into `test.skip(true, 'DOOM runtime failed to load
 * on A within 25s')`. Two things were wrong with that and both cost real time:
 *
 *  1. The `catch` ate the CAUSE. "Did the 25s wait expire, or did the runtime
 *     report a loadError?" are different bugs and the test could not tell you
 *     which, so a failure here carried no information at all.
 *  2. It SKIPPED. `checkAssets` has already proven the WASM + WAD are served two
 *     lines earlier. Past that point a runtime that does not come up is a
 *     DEFECT, not an environment. Skipping made it invisible — and worse than
 *     invisible while `collab:attest` existed, because that runner classified
 *     the reason as a benign "asset skip" and minted an attestation anyway. The
 *     attest is gone (deleted 2026-08-17); the reason not to skip is not.
 *
 * MEASURED on this machine 2026-08-13, three consecutive green runs: spawnPatch
 * 43 ms, the overlay click 23 ms, `loaded === true` a further 201 ms. The 25 s
 * budget is a ~100x margin — it bounds a hang, it does not gate a slow machine.
 */
async function spawnAndLoadDoom(page: Page, nodeId: string): Promise<string | null> {
  const nodes: SpawnNode[] = [
    { id: nodeId, type: 'doom', position: { x: 60, y: 60 }, domain: 'video' },
  ];
  await spawnPatch(page, nodes, []);
  await openDoomFace(page, nodeId);
  const card = page.locator(`[data-testid="${SURFACE}"]`);
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
  } catch {
    const st = await readLoadState(page, nodeId).catch(() => ({ loaded: '<unreadable>', loadError: '<unreadable>' }));
    return (
      `video domain never reported loaded===true for "${nodeId}" within 25000 ms ` +
      `(last read: loaded=${JSON.stringify(st.loaded)}, loadError=${JSON.stringify(st.loadError)}). ` +
      `The WASM + WAD were confirmed served by checkAssets, so this is a runtime/load defect.`
    );
  }
  const { loadError } = await readLoadState(page, nodeId);
  return loadError === null ? null : `DOOM runtime reported loadError: ${JSON.stringify(loadError)}`;
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

/**
 * Join the netgame on `page`.
 *
 * ⚠ THE ONE UNBOUNDED AWAIT IN THIS SPEC, AND IT AWAITS AN APP PROMISE.
 * `page.evaluate` takes no timeout, and the promise it awaits here —
 * `DoomSurface.joinGame()` — awaits `tryLoad()` → `extras.ensureLoaded()` →
 * `DoomRuntime.load()` (a dynamic `import()` of /doom/doom.js plus the
 * emscripten module factory) and `loadWad()` (a 4 MB fetch). Not one link in
 * that chain has a timeout, so a stall anywhere in it consumed the WHOLE 180 s
 * test budget and surfaced as a bare test timeout — the least informative
 * failure Playwright can emit, and the one that got #1592 filed against the
 * wrong step.
 *
 * It matters most for the GUEST: A's runtime load is watched by an explicit
 * 25 s `loaded === true` wait, but B never clicks anything, so B's entire
 * runtime load happens inside this evaluate, unobserved.
 *
 * So: race it against a labelled budget and, on expiry, report the page-side
 * state that says WHY. This is not a timeout bump — the budget is a ceiling on
 * a step MEASURED at 216/203/256 ms across three green runs, and its only job
 * is to turn a hang into a sentence.
 */
async function join(page: Page, nodeId: string, budgetMs = SYNC_BUDGET_MS): Promise<void> {
  await waitForCardHook(page, nodeId);
  const t0 = Date.now();
  const work = page.evaluate(async (id) => {
    const w = globalThis as unknown as { __doomCards: Record<string, { join: () => Promise<void> }> };
    await w.__doomCards[id]!.join();
  }, nodeId);
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<'expired'>((resolve) => {
    timer = setTimeout(() => resolve('expired'), budgetMs);
  });
  try {
    const outcome = await Promise.race([work.then(() => 'done' as const), expired]);
    if (outcome === 'expired') {
      const st = await readLoadState(page, nodeId).catch(() => ({ loaded: '<unreadable>', loadError: '<unreadable>' }));
      const card = await cardState(page, nodeId).catch(() => null);
      throw new Error(
        `__doomCards["${nodeId}"].join() did not settle within ${budgetMs} ms ` +
          `(elapsed ${Date.now() - t0} ms). joinGame() awaits the WASM+WAD load, so the ` +
          `stall is almost certainly there. video domain: loaded=${JSON.stringify(st.loaded)}, ` +
          `loadError=${JSON.stringify(st.loadError)}; session: ${JSON.stringify(card)}.`,
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

interface CardState {
  roster: Record<string, string>;
  mySlot: number | null;
  netStarted: boolean;
  isHost: boolean;
  launched: boolean;
  gamestate: number;
}

async function cardState(page: Page, nodeId: string): Promise<CardState | null> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as { __doomCards?: Record<string, { getState: () => unknown }> };
    const c = w.__doomCards?.[id];
    return c ? (c.getState() as never) : null;
  }, nodeId);
}

async function playerPos(page: Page, nodeId: string): Promise<{ x: number; y: number; slot: number } | null> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __doomCards?: Record<string, { getPlayerState: () => { x: number; y: number; slot: number } | null }>;
    };
    return w.__doomCards?.[id]?.getPlayerState() ?? null;
  }, nodeId);
}

test.describe('@collab DOOM New Game + Launch (slice 4)', () => {
  // Runs on the dedicated @collab lane (COLLAB_JOB=1 — relay + Postgres), and
  // is skipped only in the sharded matrix where the relay/DB aren't available.
  // De-flaked (consolidated #837+#841): the former relay-flake vacuity skip in
  // the body (B's slot-1 round-trip) is now a real SYNC_BUDGET_MS-bounded wait
  // that FAILS if cross-context roster sync never lands. The Launch + per-peer
  // marine path stays proven by start-netgame.acceptance.mjs + unit suites.
  test.skip(!!process.env.CI && !process.env.COLLAB_JOB, '@collab — runs on the dedicated COLLAB_JOB lane, not the sharded matrix');
  // Cold WASM + 4 MB WAD on TWO contexts + cross-context sync + netgame
  // launch + several seconds of ticks → the same 20-90 s window as the other
  // doom @collab specs. Generous ceiling.
  test.setTimeout(180_000);

  test('arbiter launches coop E1M1; both peers enter the level + move their own marine', async ({ browser }) => {
    const pair = await openPair(browser);
    try {
      const assets = await checkAssets(pair.pageA);
      if (!assets.ok) { test.skip(true, assets.reason); return; }

      const NODE = 'sut';

      // ─── A (arbiter / host) spawns + loads DOOM ───
      // A FAILURE, never a skip: checkAssets just proved the WASM + WAD are
      // served, so anything past this point is a defect in the load path. The
      // former `test.skip` here was invisible to `collab:attest` — it filed the
      // reason as a benign asset skip and minted the attestation regardless.
      const aLoadError = await spawnAndLoadDoom(pair.pageA, NODE);
      expect(aLoadError, "A's DOOM runtime must come up").toBeNull();

      // ─── B sees the SAME node via Yjs sync; open its faceplate + hook ───
      await pair.pageB.locator(laneTile(NODE)).waitFor({ timeout: 10000 });
      await openDoomFace(pair.pageB, NODE);
      await waitForCardHook(pair.pageB, NODE);

      // ─── A joins (auto player 0 as host) ───
      await join(pair.pageA, NODE);
      await pair.pageA.waitForFunction(
        (id) => {
          const w = globalThis as unknown as { __doomCards?: Record<string, { getState: () => { mySlot: number | null } }> };
          return w.__doomCards?.[id]?.getState().mySlot === 0;
        },
        NODE,
        { timeout: 15000 },
      );

      // ─── Round 5 NEW FLOW: A (host) LAUNCHES first → MP goes live ───
      // The old flow had B join the pre-launch lobby then A launch. The new
      // model gates a guest's Join on the host running a live MP game, so the
      // host launches FIRST; B then one-click hot-joins the running level.
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

      // ─── B hot-joins the RUNNING game → arbiter assigns slot 1 + relaunches ─
      await join(pair.pageB, NODE);

      // Wait for B's slot-1 assignment to round-trip back to B.
      // De-flake (consolidated #837+#841): formerly a "relay flake" vacuity skip
      // (green-while-asserting-nothing). Now a real SYNC_BUDGET_MS-bounded wait —
      // a correct slow roster sync passes; a relay that never assigns B slot 1
      // throws → the test FAILS. Proves the arbiter actually seats B at slot 1
      // via real cross-context node-data sync.
      await pair.pageB.waitForFunction(
        (id) => {
          const w = globalThis as unknown as { __doomCards?: Record<string, { getState: () => { mySlot: number | null } }> };
          return w.__doomCards?.[id]?.getState().mySlot === 1;
        },
        NODE,
        { timeout: SYNC_BUDGET_MS },
      );

      // Arbiter-authoritative: A=slot0, B=slot1, distinct (the slice-3 clobber
      // would have collided both on slot 0).
      const aState = await cardState(pair.pageA, NODE);
      const bState = await cardState(pair.pageB, NODE);
      expect(aState!.mySlot, 'A slot 0').toBe(0);
      expect(bState!.mySlot, 'B slot 1 (arbiter-assigned, no clobber)').toBe(1);
      expect(aState!.roster, 'roster has both in distinct slots').toMatchObject({
        '0': 'aaa-userA',
        '1': 'bbb-userB',
      });

      // ─── B hot-dropped into the running level via the auto-relaunch ───
      for (const p of [pair.pageA, pair.pageB]) {
        await p.waitForFunction(
          (args) => {
            const [id, level] = args as [string, number];
            const w = globalThis as unknown as { __doomCards?: Record<string, { getState: () => { launched: boolean; gamestate: number } }> };
            const st = w.__doomCards?.[id]?.getState();
            return !!st && st.launched === true && st.gamestate === level;
          },
          [NODE, GS_LEVEL],
          { timeout: SYNC_BUDGET_MS },
        );
      }

      // ─── Each peer's console player has spawned ───
      const aStart = await playerPos(pair.pageA, NODE);
      const bStart = await playerPos(pair.pageB, NODE);
      expect(aStart, 'A console player spawned').not.toBeNull();
      expect(bStart, 'B console player spawned').not.toBeNull();
      expect(aStart!.slot, 'A controls slot 0').toBe(0);
      expect(bStart!.slot, 'B controls slot 1').toBe(1);

      // ─── A moves its OWN marine (ArrowUp held) — B does NOT press a key ───
      await pair.pageA.evaluate(() => {
        const c = document.querySelector('[data-testid="doom-face-surface"]') as HTMLElement | null;
        c?.focus();
      });
      await pair.pageA.evaluate(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowUp', bubbles: true }));
      });
      // Let A run ~1.5 s of forward motion.
      await pair.pageA.waitForTimeout(1500);
      await pair.pageA.evaluate(() => {
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ArrowUp', bubbles: true }));
      });
      await pair.pageA.waitForTimeout(300);

      const aEnd = await playerPos(pair.pageA, NODE);
      const bEnd = await playerPos(pair.pageB, NODE);
      expect(aEnd, 'A pos after move').not.toBeNull();
      expect(bEnd, 'B pos after move').not.toBeNull();

      // A's OWN marine moved (arrows on A move players[consoleplayer] on A).
      const aMoved = aEnd!.x !== aStart!.x || aEnd!.y !== aStart!.y;
      expect(aMoved, "A's marine moved after holding ArrowUp on A").toBe(true);

      // The two peers see DIFFERENT positions for their own marine — proves
      // separate per-peer game instances in one netgame (not a shared view):
      // they spawned at distinct coop starts AND only A moved.
      const distinct = aEnd!.x !== bEnd!.x || aEnd!.y !== bEnd!.y;
      expect(distinct, 'A and B occupy DIFFERENT positions (per-peer instances)').toBe(true);
    } finally {
      await pair.close();
    }
  });
});
