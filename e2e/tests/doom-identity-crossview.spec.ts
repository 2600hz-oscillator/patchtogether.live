// e2e/tests/doom-identity-crossview.spec.ts
//
// Slice 5 acceptance: per-player identity (slot badge + DOOM color tint) +
// cross-peer marine visibility (peer A moving its marine changes peer B's
// own-POV framebuffer in the region where A walks).
//
// The committed model is "one shared node, N per-peer runtimes": A is the
// arbiter/host (player 0, GREEN), B joins as player 1 (INDIGO). After A
// launches coop E1M1, each peer renders its OWN WASM framebuffer (no
// host-mirror in steady state — that path is spectator-only). The slice-5
// ticcmd cross-feed broadcasts each peer's per-tic ticcmd over the netcode so
// every peer applies every player's input → A's forward motion moves A's
// marine in B's world, changing B's framebuffer.
//
// What's asserted:
//   1. Identity: A badge "P1" + green tint + "Player 1 — A (you)"; B badge
//      "P2" + indigo tint + "Player 2 — B (you)".
//   2. Per-peer POV: B is a joined player (mySlot=1) → it renders its OWN
//      runtime framebuffer (isHost=false but mySlot!=null means NO host
//      mirror; the card's onIncomingFrame early-returns for joined players).
//   3. Cross-peer visibility: snapshot B's canvas, hold ArrowUp on A for a
//      beat, snapshot B's canvas again → the two differ (B saw A's marine
//      move through B's own POV).
//
// QUARANTINE (task #97): the @collab 2-context Hocuspocus relay drops peer B
// under CI shard load. Skip on CI; runs locally. The identity mapping is
// unit-proven (doom-player-identity.test.ts); the ticcmd cross-feed is
// unit-proven (doom-netcode.test.ts) + deterministically proven in-process by
// start-netgame.acceptance.mjs (B sees A's marine travel). This spec is the
// browser-level integration check, run locally.

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
  const rackspaceId = `doom-id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  for (const p of [pageA, pageB]) {
    await p.goto('/');
    await p.waitForLoadState('networkidle');
    await p.waitForFunction(() =>
      typeof (window as unknown as { __attachProvider?: unknown }).__attachProvider === 'function',
    );
  }

  // A first + lex-smallest id → A wins arbiter/host (player 0). displayName
  // "Alice" / "Bob" so we can assert the identity label carries the username.
  await pageA.evaluate(async (id) => {
    const w = window as unknown as {
      __attachProvider: (id: string) => Promise<unknown>;
      __ensureEngine: () => Promise<unknown>;
      __setAwarenessUser: (u: { id: string; displayName: string; color: string }) => boolean;
    };
    await w.__ensureEngine();
    await w.__attachProvider(id);
    w.__setAwarenessUser({ id: 'aaa-userA', displayName: 'Alice', color: '#f00' });
  }, rackspaceId);
  await pageB.evaluate(async (id) => {
    const w = window as unknown as {
      __attachProvider: (id: string) => Promise<unknown>;
      __ensureEngine: () => Promise<unknown>;
      __setAwarenessUser: (u: { id: string; displayName: string; color: string }) => boolean;
    };
    await w.__ensureEngine();
    await w.__attachProvider(id);
    w.__setAwarenessUser({ id: 'bbb-userB', displayName: 'Bob', color: '#0f0' });
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
    const err = await page.evaluate((id) => {
      const w = globalThis as unknown as {
        __engine?: () => { getDomain?: (d: string) => { read?: (id: string, k: string) => unknown } | null } | null;
      };
      return w.__engine?.()?.getDomain?.('video')?.read?.(id, 'loadError') ?? null;
    }, nodeId);
    return err === null;
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
  mySlot: number | null;
  isHost: boolean;
  launched: boolean;
  gamestate: number;
  slotColor: string;
  badgeText: string;
  identityLabel: string;
  username: string | null;
}

async function cardState(page: Page, nodeId: string): Promise<CardState | null> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as { __doomCards?: Record<string, { getState: () => unknown }> };
    const c = w.__doomCards?.[id];
    return c ? (c.getState() as never) : null;
  }, nodeId);
}

/** Hash the visible DOOM canvas pixels (the per-card 2D blit of this peer's
 *  OWN framebuffer). Returns a cheap rolling checksum so we can detect that
 *  B's POV changed when A moved. */
async function canvasHash(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const cv = document.querySelector('[data-testid="doom-canvas"]') as HTMLCanvasElement | null;
    if (!cv) return -1;
    const ctx = cv.getContext('2d');
    if (!ctx) return -1;
    const { data } = ctx.getImageData(0, 0, cv.width, cv.height);
    let h = 2166136261;
    // Sample every 64th byte (1/16th of the pixels) — enough to detect a
    // viewport change, cheap enough to run twice.
    for (let i = 0; i < data.length; i += 64) {
      h ^= data[i]!;
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  });
}

test.describe('@collab DOOM identity + cross-peer visibility (slice 5)', () => {
  // Runs on the dedicated @collab lane (COLLAB_JOB=1 — relay + Postgres), and
  // is skipped only in the sharded matrix where the relay/DB aren't available.
  // De-flaked (consolidated #837+#841): the former relay-flake vacuity skips
  // inside the body are now real SYNC_BUDGET_MS-bounded waits that FAIL if the
  // cross-context sync never delivers, instead of silently skipping green.
  test.skip(!!process.env.CI && !process.env.COLLAB_JOB, '@collab — runs on the dedicated COLLAB_JOB lane, not the sharded matrix');
  test.setTimeout(180_000);

  test('peers show slot badge + DOOM color; A moving changes B\'s POV (cross-peer)', async ({ browser }) => {
    const pair = await openPair(browser);
    try {
      const assets = await checkAssets(pair.pageA);
      if (!assets.ok) { test.skip(true, assets.reason); return; }

      const NODE = 'sut';

      // ─── A (arbiter/host) spawns + loads DOOM ───
      const aLoaded = await spawnAndLoadDoom(pair.pageA, NODE);
      if (!aLoaded) { test.skip(true, 'DOOM runtime failed to load on A within 25s'); return; }

      // ─── B sees the SAME node via Yjs sync; load its hook + WASM ───
      await pair.pageB.locator('[data-testid="doom-card"]').waitFor({ timeout: 10000 });
      await waitForCardHook(pair.pageB, NODE);

      // ─── A joins (auto player 0) ───
      await join(pair.pageA, NODE);
      await pair.pageA.waitForFunction(
        (id) => {
          const w = globalThis as unknown as { __doomCards?: Record<string, { getState: () => { mySlot: number | null } }> };
          return w.__doomCards?.[id]?.getState().mySlot === 0;
        },
        NODE,
        { timeout: 15000 },
      );

      // ─── Round 5: A (arbiter) picks coop + E1M1, LAUNCHES → MP goes live ───
      // The new model gates a guest's Join on the host running a live MP game,
      // so A launches FIRST; B then one-click hot-joins the running level.
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
        (id) => {
          const w = globalThis as unknown as { __doomCards?: Record<string, { getState: () => { mpLive: boolean } }> };
          return w.__doomCards?.[id]?.getState().mpLive === true;
        },
        NODE,
        { timeout: 30000 },
      );

      // ─── B hot-joins the RUNNING game → arbiter assigns slot 1 + relaunches ─
      // De-flake (consolidated #837+#841): these were vacuity skips ("relay
      // flake" → green-while-asserting-nothing). They are now REAL waits with a
      // deterministic SYNC_BUDGET_MS budget — a correct slow cross-context sync
      // passes; a relay that NEVER delivers throws → the test FAILS (no more
      // silent skip). Proves B actually observes A's live MP game and is seated
      // at slot 1 via real Yjs/roster sync.
      await pair.pageB.waitForFunction(
        (id) => {
          const w = globalThis as unknown as { __doomCards?: Record<string, { getState: () => { mpLive: boolean } }> };
          return w.__doomCards?.[id]?.getState().mpLive === true;
        },
        NODE,
        { timeout: SYNC_BUDGET_MS },
      );
      await join(pair.pageB, NODE);
      await pair.pageB.waitForFunction(
        (id) => {
          const w = globalThis as unknown as { __doomCards?: Record<string, { getState: () => { mySlot: number | null } }> };
          return w.__doomCards?.[id]?.getState().mySlot === 1;
        },
        NODE,
        { timeout: SYNC_BUDGET_MS },
      );

      // ─── Both peers are in the level (B hot-joined into the running map) ───
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

      // ─── Identity: badge + DOOM color tint + label (slice 5) ───
      const aState = await cardState(pair.pageA, NODE);
      const bState = await cardState(pair.pageB, NODE);
      // A = player 0 = GREEN, B = player 1 = INDIGO (vanilla DOOM order).
      expect(aState!.badgeText, 'A badge P1').toBe('P1');
      expect(aState!.slotColor, 'A tint = DOOM green').toBe('#3fa34d');
      expect(aState!.identityLabel, 'A label carries username + (you)').toBe('Player 1 — Alice (you)');
      expect(bState!.badgeText, 'B badge P2').toBe('P2');
      expect(bState!.slotColor, 'B tint = DOOM indigo').toBe('#5b5bd6');
      expect(bState!.identityLabel, 'B label carries username + (you)').toBe('Player 2 — Bob (you)');

      // Per-peer POV: B is a joined player (not a spectator), so it renders its
      // OWN WASM — no host-mirror. (isHost false + mySlot set is exactly the
      // condition the card uses to skip onIncomingFrame.)
      expect(bState!.isHost, 'B is not the host').toBe(false);
      expect(bState!.mySlot, 'B is a joined player → renders own POV').toBe(1);

      // Let both render a few frames so B's canvas holds a stable POV.
      await pair.pageB.waitForTimeout(800);

      // ─── Cross-peer visibility: snapshot B's POV, move A, snapshot again ───
      const bHashBefore = await canvasHash(pair.pageB);

      await pair.pageA.evaluate(() => {
        const c = document.querySelector('[data-testid="doom-card"]') as HTMLElement | null;
        c?.focus();
      });
      await pair.pageA.evaluate(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowUp', bubbles: true }));
      });
      // A walks forward for ~2 s; its per-tic ticcmd broadcasts to B, whose
      // sim moves A's marine → B's framebuffer changes.
      await pair.pageA.waitForTimeout(2000);
      await pair.pageA.evaluate(() => {
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ArrowUp', bubbles: true }));
      });
      await pair.pageB.waitForTimeout(600);

      const bHashAfter = await canvasHash(pair.pageB);
      expect(bHashBefore, 'B canvas had pixels before').not.toBe(-1);
      expect(bHashAfter, 'B canvas had pixels after').not.toBe(-1);
      expect(
        bHashAfter,
        "B's own-POV framebuffer changed after A moved (cross-peer marine visibility)",
      ).not.toBe(bHashBefore);
    } finally {
      await pair.close();
    }
  });
});
