// e2e/tests/doom-mp-latejoin-freeze.spec.ts
//
// @collab — FAITHFUL reproduction of the owner-confirmed live DOOM-MP failure:
//   "P1 (host) FREEZES the moment P2 (a late joiner) is in and MOVING."
//
// Why the existing doom-mp-real.spec.ts MISSES it
// ───────────────────────────────────────────────
// That suite has the guest hot-join and then both players move for ~1-2s,
// asserting cross-peer visibility. The freeze is a DELAYED death: it is the C
// engine's netgame CONSISTENCY check (g_game.c G_Ticker) firing
// I_Error("consistency failure") → exit(-1) → the WASM runtime aborts. That
// check only runs once `gametic > BACKUPTICS` (= 128 tics ≈ 3.6s at 35 Hz)
// AFTER the hot-drop relaunch, for every IN-GAME slot. The injected remote
// ticcmd carries no consistancy byte in normal (non-scripted) live play, so the
// host's locally-computed consistancy for the remote slot (= players[slot].mo->x)
// never matches → abort. The old test simply never lets the relaunched netgame
// run past that ~3.6s boundary with both slots live, so the sim never reaches
// the check and the test passes on the broken engine.
//
// This scenario matches the live flow EXACTLY:
//   1. owner hosts + launches SOLO (numPlayers=1, netgame=false → no check),
//   2. owner MOVES for a moment so its position ≠ spawn,
//   3. an ANON guest hot-joins the RUNNING game → arbiter hot-drop RELAUNCHES
//      the current map at numPlayers=2 (now netgame=true on every peer),
//   4. BOTH players move CONTINUOUSLY for >4 seconds — long enough that
//      gametic crosses BACKUPTICS while both slots are in-game,
//   5. ASSERT the host's sim is STILL ALIVE: it is on GS_LEVEL and its OWN
//      marine STILL advances in response to its OWN held key.
//
// FAILS on current main (host WASM aborted on the consistency failure → its
// gamestate poll throws / its marine never advances again). PASSES once the
// overlay stamps the locally-expected consistancy onto remote slots in live
// play too (matching what scripted-lockstep mode already does).
//
// Run only this:  flox activate -- task e2e -- doom-mp-latejoin-freeze.spec.ts

import { test, expect, type Page, type Browser, type BrowserContext } from '@playwright/test';
import { spawnPatch, claimKeyboard, type SpawnNode } from './_helpers';
import { SYNC_BUDGET_MS } from './_collab-helpers';

const GS_LEVEL = 0;
const GS_DEMOSCREEN = 3;
const NODE_ID = 'doom-mp';

interface Peer {
  ctx: BrowserContext;
  page: Page;
  userId: string;
  name: string;
  isOwner: boolean;
}

interface CardState {
  mySlot: number | null;
  myPendingSlot: number | null;
  isHost: boolean;
  isNetArbiter: boolean;
  memberIds: string[];
  mpLive: boolean;
  launched: boolean;
  gamestate: number;
}

async function boot(
  browser: Browser,
  rackId: string,
  specs: ReadonlyArray<{ userId: string; name: string; isOwner: boolean }>,
): Promise<Peer[]> {
  const out: Peer[] = [];
  for (const s of specs) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    out.push({ ctx, page, ...s });
  }
  for (const p of out) {
    await p.page.goto('/');
    await p.page.waitForLoadState('networkidle');
    await p.page.waitForFunction(
      () => typeof (window as unknown as { __attachProvider?: unknown }).__attachProvider === 'function',
    );
  }
  for (const p of out) {
    await p.page.evaluate(
      async (args) => {
        const [id, userId, name, isOwner] = args as [string, string, string, boolean];
        const w = window as unknown as {
          __attachProvider: (id: string) => Promise<unknown>;
          __ensureEngine: () => Promise<unknown>;
          __setAwarenessUser: (u: {
            id: string;
            displayName: string;
            color: string;
            isRackOwner?: boolean;
          }) => boolean;
        };
        await w.__ensureEngine();
        await w.__attachProvider(id);
        w.__setAwarenessUser({ id: userId, displayName: name, color: '#0f0', isRackOwner: isOwner });
      },
      [rackId, p.userId, p.name, p.isOwner],
    );
  }
  return out;
}

async function assetsPresent(page: Page): Promise<boolean> {
  return await page.evaluate(async () => {
    try {
      const wasm = (await fetch('/doom/doom.js', { method: 'HEAD' })).ok;
      const wad = (await fetch('/doom/DOOM1.WAD', { method: 'HEAD' })).ok;
      return wasm && wad;
    } catch {
      return false;
    }
  });
}

async function cardHookReady(page: Page, id: string, timeout = 15000): Promise<void> {
  await page.waitForFunction(
    (nid) => !!(globalThis as unknown as { __doomCards?: Record<string, unknown> }).__doomCards?.[nid],
    id,
    { timeout },
  );
}

async function getState(page: Page, id: string): Promise<CardState> {
  return await page.evaluate(
    (nid) =>
      (globalThis as unknown as { __doomCards: Record<string, { getState: () => CardState }> }).__doomCards[
        nid
      ]!.getState() as never,
    id,
  );
}

async function waitForSlot(page: Page, id: string, slot: number | null, timeout = 30000): Promise<boolean> {
  return page
    .waitForFunction(
      (args) => {
        const [nid, want] = args as [string, number | null];
        const w = globalThis as unknown as {
          __doomCards?: Record<string, { getState: () => { mySlot: number | null } }>;
        };
        return w.__doomCards?.[nid]?.getState().mySlot === want;
      },
      [id, slot],
      { timeout },
    )
    .then(() => true)
    .catch(() => false);
}

async function waitForLevel(page: Page, id: string, timeout = 45000): Promise<boolean> {
  return page
    .waitForFunction(
      (args) => {
        const [nid, lvl] = args as [string, number];
        const w = globalThis as unknown as {
          __doomCards?: Record<string, { getState: () => { launched: boolean; gamestate: number } }>;
        };
        const st = w.__doomCards?.[nid]?.getState();
        return !!st && st.launched === true && st.gamestate === lvl;
      },
      [id, GS_LEVEL],
      { timeout },
    )
    .then(() => true)
    .catch(() => false);
}

async function playerPos(
  page: Page,
  id: string,
): Promise<{ x: number; y: number; slot: number } | null> {
  // The getPlayerState ccall reaches into the WASM runtime; if the runtime has
  // ABORTED (the freeze bug — exit(-1) on consistency failure) the ccall throws.
  // We catch + return a sentinel so the test can DISTINGUISH "alive but not yet
  // moved" from "runtime is dead", rather than the whole evaluate rejecting.
  return await page.evaluate((nid) => {
    try {
      const w = globalThis as unknown as {
        __doomCards?: Record<string, { getPlayerState: () => { x: number; y: number; slot: number } | null }>;
      };
      return w.__doomCards?.[nid]?.getPlayerState() ?? null;
    } catch {
      return { x: NaN, y: NaN, slot: -999 }; // runtime aborted
    }
  }, id);
}

async function holdArrowUp(page: Page): Promise<void> {
  // Deterministic, focus-independent keyboard claim (NOT a racy `.focus()`):
  // either page can be backgrounded across the two contexts, so we latch the
  // claim via the forceClaimKeyboard() hook + poll shouldClaimKey before keys.
  await claimKeyboard(page, NODE_ID);
  await page.evaluate(() =>
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowUp', bubbles: true })),
  );
}
async function releaseArrowUp(page: Page): Promise<void> {
  await page.evaluate(() =>
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ArrowUp', bubbles: true })),
  );
}

test.describe('@collab DOOM multiplayer — late-join host freeze', () => {
  // Cold WASM + 4 MB WAD on two contexts + relaunch + a SUSTAINED multi-second
  // movement window (must outlast BACKUPTICS ≈ 3.6s post-relaunch).
  test.setTimeout(150_000);

  test('host keeps playing after an anon late-joiner relaunches + moves past the consistency-check boundary', async ({
    browser,
  }) => {
    const rackId = `doom-freeze-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const peers = await boot(browser, rackId, [
      { userId: 'zzz-rack-owner', name: 'Owner', isOwner: true },
      // Anon/invite guest — the exact identity an invite-link viewer carries.
      { userId: 'anon-guest-abc', name: 'guest 0001', isOwner: false },
    ]);
    const owner = peers[0]!;
    const anon = peers[1]!;
    // Capture the host's C-side abort message. I_Error("consistency failure …")
    // prints to stderr → Emscripten routes it to console.error before exit(-1).
    // Seeing it is direct evidence of the root cause (not just a frozen pixel).
    const ownerConsole: string[] = [];
    owner.page.on('console', (m) => ownerConsole.push(m.text()));
    owner.page.on('pageerror', (e) => ownerConsole.push(`pageerror: ${e.message}`));
    try {
      if (!(await assetsPresent(owner.page))) {
        test.skip(true, 'DOOM WASM / WAD missing — run build-doom-wasm.sh + fetch DOOM1.WAD');
        return;
      }

      // Owner adds the single shared DOOM node; anon sees it via Yjs node sync.
      const nodes: SpawnNode[] = [
        { id: NODE_ID, type: 'doom', position: { x: 120, y: 120 }, domain: 'video' },
      ];
      await spawnPatch(owner.page, nodes, []);
      // De-flake (consolidated #837+#841): formerly a "cross-context node sync
      // flake" vacuity skip (green-while-asserting-nothing). Now a real
      // SYNC_BUDGET_MS-bounded wait — a correct slow node sync passes; a relay
      // that never delivers the shared DOOM node to the anon throws → FAILS.
      await anon.page.waitForFunction(
        (nid) =>
          Object.keys(
            (window as unknown as { __patch: { nodes: Record<string, unknown> } }).__patch.nodes,
          ).includes(nid),
        NODE_ID,
        { timeout: SYNC_BUDGET_MS },
      );
      await cardHookReady(owner.page, NODE_ID);
      await cardHookReady(anon.page, NODE_ID);
      await expect
        .poll(async () => (await getState(owner.page, NODE_ID)).memberIds.length, { timeout: 10000 })
        .toBe(2);

      // ── 1. Owner hosts + launches SOLO (numPlayers=1, netgame=false) ───────
      await owner.page.evaluate(
        (nid) =>
          (
            globalThis as unknown as {
              __doomCards: Record<string, { hostMultiplayer: () => Promise<void> }>;
            }
          ).__doomCards[nid]!.hostMultiplayer(),
        NODE_ID,
      );
      expect(await waitForSlot(owner.page, NODE_ID, 0, 25000)).toBe(true);
      await owner.page.evaluate(
        (nid) => {
          const w = globalThis as unknown as {
            __doomCards: Record<string, { setOptions: (o: object) => void; launch: () => void }>;
          };
          w.__doomCards[nid]!.setOptions({ mode: 'coop', skill: 0, episode: 1, map: 1 });
          w.__doomCards[nid]!.launch();
        },
        NODE_ID,
      );
      expect(await waitForLevel(owner.page, NODE_ID), 'owner reaches a running level solo').toBe(true);

      // ── 2. Owner MOVES so its position ≠ spawn (matches the live flow) ─────
      const spawnPos = await playerPos(owner.page, NODE_ID);
      expect(spawnPos, 'owner spawned').not.toBeNull();
      await holdArrowUp(owner.page);
      const ownerMovedSolo = await owner.page
        .waitForFunction(
          (args) => {
            const [nid, sx, sy] = args as [string, number, number];
            const w = globalThis as unknown as {
              __doomCards?: Record<string, { getPlayerState: () => { x: number; y: number } | null }>;
            };
            const p = w.__doomCards?.[nid]?.getPlayerState();
            return !!p && (p.x !== sx || p.y !== sy);
          },
          [NODE_ID, spawnPos!.x, spawnPos!.y],
          { timeout: 10000 },
        )
        .then(() => true)
        .catch(() => false);
      await releaseArrowUp(owner.page);
      expect(ownerMovedSolo, 'owner moves freely before the guest joins (single-player)').toBe(true);

      // ── 3. Anon hot-joins the RUNNING game → arbiter relaunches at np=2 ────
      const joinBtn = anon.page.locator('[data-testid="doom-join-btn"]');
      await expect(joinBtn, 'anon Join enables once MP is live').toBeEnabled({ timeout: 20000 });
      // force:true — the Join is gated visible+enabled above; the only blocker is
      // the auto-spawned TIMELORDE display canvas overlapping the DOOM card in
      // screen space (SvelteFlow fitView re-centers both nodes, so relocating
      // doesn't help). The canonical Playwright remedy for an unrelated overlay
      // intercept on a confirmed-actionable target.
      await joinBtn.click({ force: true });
      // De-flake (consolidated #837+#841): formerly a "relay flake" vacuity skip.
      // Now a real bounded assert — a relay that never seats the anon at slot 1
      // FAILS the test instead of silently skipping green.
      expect(
        await waitForSlot(anon.page, NODE_ID, 1, SYNC_BUDGET_MS),
        'anon is seated at slot 1 via cross-context roster sync',
      ).toBe(true);
      // Both peers reload the level via the hot-drop relaunch (G_InitNew at np=2).
      expect(await waitForLevel(anon.page, NODE_ID), 'anon hot-drops into the running map').toBe(true);
      expect(await waitForLevel(owner.page, NODE_ID), 'owner re-enters the level after relaunch').toBe(
        true,
      );
      {
        const o = await getState(owner.page, NODE_ID);
        const a = await getState(anon.page, NODE_ID);
        expect(o.mySlot, 'owner stays P1 (slot 0) across the relaunch').toBe(0);
        expect(a.mySlot, 'anon is P2 (slot 1)').toBe(1);
      }

      // ── 4. BOTH move CONTINUOUSLY past the consistency-check boundary ──────
      // The C check fires once gametic > BACKUPTICS (128 tics ≈ 3.6s) for every
      // in-game slot. Hold both keys for a sustained window WELL past that so the
      // relaunched netgame definitely reaches + runs the check with both slots
      // live. On broken main, the host's WASM aborts mid-window.
      //
      // Each periodic poll is BOUNDED + try/caught: once the host's WASM aborts
      // (exit(-1) on the consistency failure), its ccalls throw — we record that
      // as the freeze rather than letting the page wedge the whole test.
      await holdArrowUp(owner.page);
      await holdArrowUp(anon.page);

      let hostDead = false;
      let lastHostGs = GS_LEVEL;
      let lastHostPos = await playerPos(owner.page, NODE_ID);
      for (let i = 0; i < 8 && !hostDead; i++) {
        await owner.page.waitForTimeout(800);
        await holdArrowUp(owner.page).catch(() => {});
        await holdArrowUp(anon.page).catch(() => {});
        // Read the host's gamestate + position; a thrown ccall / dead runtime is
        // the freeze signature.
        const probe = await owner.page
          .evaluate((nid) => {
            try {
              const w = globalThis as unknown as {
                __doomCards?: Record<
                  string,
                  { getState: () => { gamestate: number }; getPlayerState: () => { x: number; y: number; slot: number } | null }
                >;
              };
              const c = w.__doomCards?.[nid];
              if (!c) return { dead: true as const };
              const gs = c.getState().gamestate;
              const p = c.getPlayerState();
              return { dead: false as const, gs, p };
            } catch {
              return { dead: true as const };
            }
          }, NODE_ID)
          .catch(() => ({ dead: true as const }));
        if (probe.dead) {
          hostDead = true;
          break;
        }
        lastHostGs = probe.gs;
        if (probe.p) lastHostPos = probe.p;
        // GS_LEVEL → GS_DEMOSCREEN (or any non-level) mid-play is the soft form
        // of the freeze (the demo loop resumes after the sim tore down).
        if (probe.gs !== GS_LEVEL) {
          hostDead = true;
          break;
        }
      }

      // ── 5. ASSERT the host's sim is STILL ALIVE + responsive to its OWN key ─
      const consistencyFailure = ownerConsole.some((l) => /consistency failure/i.test(l));
      // Surface the evidence in the failure message for the diagnose-first writeup.
      expect(
        hostDead,
        `host sim must NOT die after a late joiner moves past the consistency-check boundary. ` +
          `lastGamestate=${lastHostGs} consistencyFailureLogged=${consistencyFailure} ` +
          `consoleTail=${JSON.stringify(ownerConsole.slice(-6))}`,
      ).toBe(false);
      expect(lastHostGs, 'host is STILL in the level (NOT a dead/aborted sim)').toBe(GS_LEVEL);
      expect(lastHostGs, 'host did not fall back to the title/attract screen').not.toBe(GS_DEMOSCREEN);

      // (b) the host's OWN marine STILL advances from the host's OWN held key —
      // the definitive "not frozen" signal. Bounded poll; a dead runtime never
      // satisfies it (and was already caught above).
      const hostBaseline = lastHostPos;
      expect(hostBaseline, 'host marine readable (runtime alive)').not.toBeNull();
      expect(hostBaseline!.slot, 'host still controls slot 0').toBe(0);
      await holdArrowUp(owner.page);
      const hostStillMoves = await owner.page
        .waitForFunction(
          (args) => {
            const [nid, bx, by] = args as [string, number, number];
            try {
              const w = globalThis as unknown as {
                __doomCards?: Record<string, { getPlayerState: () => { x: number; y: number } | null }>;
              };
              const p = w.__doomCards?.[nid]?.getPlayerState();
              return !!p && (p.x !== bx || p.y !== by);
            } catch {
              return false; // runtime aborted → never satisfies
            }
          },
          [NODE_ID, hostBaseline!.x, hostBaseline!.y],
          { timeout: 8000 },
        )
        .then(() => true)
        .catch(() => false);
      await releaseArrowUp(owner.page).catch(() => {});
      await releaseArrowUp(anon.page).catch(() => {});
      expect(
        hostStillMoves,
        "host's OWN marine STILL responds to the host's OWN input after a late joiner moved (no freeze)",
      ).toBe(true);
    } finally {
      await Promise.all(peers.map((p) => p.ctx.close().catch(() => {})));
    }
  });
});
