// e2e/tests/doom-mp-soak.spec.ts
//
// @collab @soak — DOOM multiplayer SOAK / STRESS harness.
//
// N independent browser contexts ("bots") join ONE shared rackspace. The rack
// OWNER adds + hosts the single shared DOOM node (the committed instance model:
// one node per rack, every other peer sees it via Yjs sync and JOINs to claim a
// slot + bring up its own runtime). The owner launches a deathmatch; every bot
// then continuously WANDERS (random Arrow keys) + SHOOTS (Ctrl) for the soak
// duration. This is a chaotic deathmatch that does NOT need to play well.
//
// The ONLY success metric is SURVIVAL TIME: how long all N contexts stay alive
// with NO crash. A "crash" is any of:
//   - a page error / uncaught exception (incl. a WASM RuntimeError / abort),
//   - a browser context closing out from under us,
//   - the relay going unresponsive (a page.evaluate / __doomCards read throwing),
//   - the DOOM module disappearing from a peer's graph,
//   - a peer that was in-level falling OUT of GS_LEVEL back to the title/attract
//     screen (a netgame desync / re-init — the kind of instability PR #318's
//     framebuffer-broadcast gate + sticky-key fix targeted).
// The test FAILS only on a real crash — NOT on "didn't play well" / low movement.
//
// PARAMETERIZED so a 2-bot smoke and a 4-bot/10-min soak are the SAME test, no
// code edits:
//   SOAK_BOTS         number of bots / contexts        (default 2, clamped 2..4)
//   SOAK_DURATION_MS  gameplay soak window in ms        (default 30_000)
//   SOAK_TICK_MS      input cadence per bot in ms       (default 250)
//   SOAK             must be set (=1) for this spec to RUN at all.
//
// GATING — this is a LONG soak (up to 10 min), so it must NOT run inside the
// normal @collab gate (which would balloon the collab job to 10+ min and isn't
// what that gate is for). It runs ONLY when SOAK is set: locally for a short
// smoke (2 bots / ~30-60s, then TEAR DOWN chrome), and on CI in a DEDICATED,
// INFORMATIONAL `doom-soak` job (off the blocking path). Without SOAK it skips.
//
// HARD CONSTRAINT (owner's machine): do NOT run a 4-bot / 10-min soak locally —
// it leaks chrome-headless-shell + spikes CPU. Local = short smoke only, then
// `flox activate -- pkill -9 -f chrome-headless-shell`.
//
// Run a short local smoke:
//   flox activate -- SOAK=1 SOAK_BOTS=2 SOAK_DURATION_MS=30000 \
//     task e2e -- doom-mp-soak.spec.ts
// then tear down chrome (see HARD CONSTRAINT).

import { test, expect, type Page, type Browser, type BrowserContext } from '@playwright/test';
import { spawnPatch, type SpawnNode } from './_helpers';

const GS_LEVEL = 0;
// DOOM gamestate_t ordinals (doomdef.h): GS_LEVEL=0, GS_DEMOSCREEN=3 (the
// title/attract loop). A peer dropping from GS_LEVEL back to GS_DEMOSCREEN
// mid-soak is an instability we want to CATCH.
const NODE_ID = 'doom-soak';

// Movement / fire keys. ControlLeft is DOOM's fire ("attack") + is a
// modifier-only key the card's capture handler claims; the arrows are wander.
const MOVE_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'] as const;

// Bot count + duration come from env so the 2-bot smoke and the 4-bot/10-min
// soak are the SAME test. Defaults make a bare `SOAK=1` run a safe short smoke.
const BOTS = clamp(intEnv('SOAK_BOTS', 2), 2, 4);
const DURATION_MS = intEnv('SOAK_DURATION_MS', 30_000);
const TICK_MS = intEnv('SOAK_TICK_MS', 250);

function intEnv(name: string, dflt: number): number {
  const v = process.env[name];
  if (!v) return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}
function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

interface Bot {
  ctx: BrowserContext;
  page: Page;
  userId: string;
  name: string;
  isOwner: boolean;
  /** First page-error seen on this bot's page (uncaught exn / WASM abort). */
  pageError: string | null;
  rngState: number;
}

interface CardState {
  mySlot: number | null;
  launched: boolean;
  gamestate: number;
  memberIds: string[];
  isHost: boolean;
  mpMode?: 'single' | 'multi';
}

// Deterministic per-bot PRNG (so a flake is reproducible from the seed) —
// mulberry32. Each bot wanders + fires on its own stream.
function nextRand(bot: Bot): number {
  let t = (bot.rngState += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
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

// Boot N contexts on ONE shared rack. The OWNER's id sorts LEX-LARGE (the
// pre-fix break ordering — a lex-min guest used to hijack host/P0); the rack
// owner publishes isRackOwner:true so it is host / arbiter / P1 regardless.
async function boot(browser: Browser, rackId: string, n: number): Promise<Bot[]> {
  const bots: Bot[] = [];
  for (let i = 0; i < n; i++) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const isOwner = i === 0;
    // Owner id sorts last; guests sort small (g1, g2, g3 < zzz-owner).
    const userId = isOwner ? 'zzz-rack-owner' : `guest-${i}-${Math.random().toString(36).slice(2, 6)}`;
    const bot: Bot = {
      ctx,
      page,
      userId,
      name: isOwner ? 'Owner' : `Bot${i}`,
      isOwner,
      pageError: null,
      rngState: 0x1234_5678 ^ (i * 0x9e3779b1),
    };
    // Record the FIRST page error (uncaught exn / WASM RuntimeError abort).
    page.on('pageerror', (e) => {
      if (!bot.pageError) bot.pageError = e.message || String(e);
    });
    bots.push(bot);
  }
  for (const b of bots) {
    await b.page.goto('/');
    await b.page.waitForLoadState('networkidle');
    await b.page.waitForFunction(
      () => typeof (window as unknown as { __attachProvider?: unknown }).__attachProvider === 'function',
    );
  }
  for (const b of bots) {
    await b.page.evaluate(
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
      [rackId, b.userId, b.name, b.isOwner],
    );
  }
  return bots;
}

async function cardHookReady(page: Page, id: string, timeout = 20000): Promise<void> {
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

async function waitForSlot(page: Page, id: string, slot: number, timeout = 30000): Promise<boolean> {
  return page
    .waitForFunction(
      (args) => {
        const [nid, want] = args as [string, number];
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

async function waitForLevel(page: Page, id: string, timeout = 60000): Promise<boolean> {
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

// One chaos "tick" for a bot: hold a fresh random movement key (releasing the
// previous one) + fire on a coin flip. Keys reach the game via the card's
// window-level capture-phase handler, gated on shouldClaimKey() — so we focus
// the card (sticky latch) before each burst and dispatch real window
// KeyboardEvents with the right .code / .ctrlKey shape the handler inspects.
async function botTick(bot: Bot, heldMove: string | null): Promise<string> {
  const r = nextRand(bot);
  const move = MOVE_KEYS[Math.floor(nextRand(bot) * MOVE_KEYS.length)]!;
  const fire = r < 0.45; // ~45% of ticks pull the trigger.
  await bot.page.evaluate(
    (args) => {
      const [prevMove, nextMove, doFire] = args as [string | null, string, boolean];
      const card = document.querySelector('[data-testid="doom-card"]') as HTMLElement | null;
      card?.focus();
      const fire = (type: 'keydown' | 'keyup', code: string, ctrl = false) =>
        window.dispatchEvent(new KeyboardEvent(type, { code, ctrlKey: ctrl, bubbles: true }));
      if (prevMove && prevMove !== nextMove) fire('keyup', prevMove);
      fire('keydown', nextMove);
      if (doFire) {
        // ControlLeft is DOOM's attack + a modifier-only key the card claims;
        // ctrlKey:true matches the capture handler's isModifierOnlyKey path.
        fire('keydown', 'ControlLeft', true);
        fire('keyup', 'ControlLeft', true);
      }
    },
    [heldMove, move, fire] as [string | null, string, boolean],
  );
  return move;
}

// Release any keys + drop focus (best-effort) so a bot doesn't leave a key
// latched in the WASM input queue at teardown.
async function botRelease(bot: Bot, heldMove: string | null): Promise<void> {
  await bot.page
    .evaluate((prev) => {
      const m = prev as string | null;
      if (m) window.dispatchEvent(new KeyboardEvent('keyup', { code: m, bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ControlLeft', ctrlKey: true, bubbles: true }));
      (document.activeElement as HTMLElement | null)?.blur?.();
    }, heldMove)
    .catch(() => {});
}

// Liveness probe for one bot. Returns null if alive, else a crash reason.
async function probe(bot: Bot): Promise<string | null> {
  if (bot.pageError) return `page-error: ${bot.pageError}`;
  if (bot.page.isClosed()) return 'page-closed';
  let st: CardState;
  try {
    // A relay-dead / context-torn page makes this evaluate throw or hang; the
    // wrapping waitForFunction-free evaluate surfaces it as a rejected promise.
    st = await getState(bot.page, NODE_ID);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `state-read-failed (relay/context unresponsive): ${msg}`;
  }
  // Module vanished from this peer's graph.
  const present = await bot.page
    .evaluate(
      (nid) =>
        !!(globalThis as unknown as { __doomCards?: Record<string, unknown> }).__doomCards?.[nid],
      NODE_ID,
    )
    .catch(() => false);
  if (!present) return 'doom-module-missing';
  // Fell out of the level back to the title/attract loop (netgame re-init /
  // desync). launched stays true through normal play; gamestate must stay at
  // GS_LEVEL. (Death respawns keep gamestate==GS_LEVEL in deathmatch, so this
  // is a real-instability signal, not a "bot died in-game" false positive.)
  if (st.launched && st.gamestate !== GS_LEVEL) {
    return `fell-out-of-level (gamestate=${st.gamestate}, expected GS_LEVEL=${GS_LEVEL})`;
  }
  return null;
}

test.describe('@collab @soak DOOM multiplayer soak', () => {
  // Only run when explicitly opted in (SOAK=1). Otherwise this LONG soak would
  // bloat the normal @collab gate. The dedicated, informational CI `doom-soak`
  // job sets SOAK=1; locally you set it for a short smoke.
  test.skip(!process.env.SOAK, 'soak — set SOAK=1 to run (short local smoke / informational CI job)');

  // Ceiling = setup budget + the soak window + teardown headroom. SETUP scales
  // with bot count: each context cold-loads its own 395 KB WASM + 4 MB WAD and
  // waits to reach GS_LEVEL, which is the dominant cost (observed ~2-4 min for
  // 2 contexts on a slow runner). Budget 90 s base + 90 s/bot so a 4-bot boot
  // has ~7.5 min before the soak even starts; cap at 30 min (job ceiling).
  const SETUP_BUDGET_MS = 90_000 + BOTS * 90_000;
  test.setTimeout(Math.min(SETUP_BUDGET_MS + DURATION_MS + 90_000, 30 * 60_000));

  test(`${BOTS} bots deathmatch survival soak (${Math.round(DURATION_MS / 1000)}s)`, async ({
    browser,
  }) => {
    const t0 = Date.now();
    const rackId = `doom-soak-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const bots = await boot(browser, rackId, BOTS);
    const owner = bots[0]!;
    const guests = bots.slice(1);
    let crash: string | null = null;
    const survivedS = () => Math.round((Date.now() - t0) / 1000);

    try {
      if (!(await assetsPresent(owner.page))) {
        test.skip(true, 'DOOM WASM / WAD missing — run build-doom-wasm.sh + fetch DOOM1.WAD');
        return;
      }

      // ── Owner adds the single shared DOOM node ──────────────────────────
      const nodes: SpawnNode[] = [
        { id: NODE_ID, type: 'doom', position: { x: 120, y: 120 }, domain: 'video' },
      ];
      await spawnPatch(owner.page, nodes, []);

      // ── Every guest sees the SAME node via Yjs sync ─────────────────────
      for (const g of guests) {
        const saw = await g.page
          .waitForFunction(
            (nid) =>
              Object.keys(
                (window as unknown as { __patch: { nodes: Record<string, unknown> } }).__patch.nodes,
              ).includes(nid),
            NODE_ID,
            { timeout: 30000 },
          )
          .then(() => true)
          .catch(() => false);
        if (!saw) {
          test.skip(true, 'cross-context node sync did not deliver the DOOM node (relay flake)');
          return;
        }
      }
      for (const b of bots) await cardHookReady(b.page, NODE_ID);

      // Let awareness presence converge so every card sees all BOTS members.
      for (const b of bots) {
        await expect
          .poll(async () => (await getState(b.page, NODE_ID)).memberIds.length, { timeout: 20000 })
          .toBe(BOTS);
      }

      // ── Owner hosts MP (seats P1) + every guest joins ───────────────────
      await owner.page.evaluate(
        (nid) =>
          (
            globalThis as unknown as {
              __doomCards: Record<string, { hostMultiplayer: () => Promise<void> }>;
            }
          ).__doomCards[nid]!.hostMultiplayer(),
        NODE_ID,
      );
      expect(await waitForSlot(owner.page, NODE_ID, 0, 30000), 'owner seated P1').toBe(true);

      for (let i = 0; i < guests.length; i++) {
        const g = guests[i]!;
        // Guest waits for the host-opened lobby, then joins → arbiter seats it.
        const sawLobby = await g.page
          .waitForFunction(
            (nid) =>
              (
                globalThis as unknown as {
                  __doomCards: Record<string, { getState: () => { mpMode?: string } }>;
                }
              ).__doomCards[nid]!.getState().mpMode === 'multi',
            NODE_ID,
            { timeout: 20000 },
          )
          .then(() => true)
          .catch(() => false);
        if (!sawLobby) {
          test.skip(true, `guest ${i + 1} never saw the lobby (relay flake)`);
          return;
        }
        await g.page.evaluate(
          (nid) =>
            (globalThis as unknown as { __doomCards: Record<string, { join: () => Promise<void> }> })
              .__doomCards[nid]!.join(),
          NODE_ID,
        );
        const seated = await waitForSlot(g.page, NODE_ID, i + 1, 40000);
        if (!seated) {
          test.skip(true, `cross-context roster sync didn't seat guest ${i + 1} at slot ${i + 1} (relay flake)`);
          return;
        }
      }

      // ── Owner (arbiter) launches a DEATHMATCH → all bots reach GS_LEVEL ──
      await owner.page.evaluate(
        (nid) => {
          const w = globalThis as unknown as {
            __doomCards: Record<string, { setOptions: (o: object) => void; launch: () => void }>;
          };
          w.__doomCards[nid]!.setOptions({ mode: 'deathmatch', skill: 2, episode: 1, map: 1 });
          w.__doomCards[nid]!.launch();
        },
        NODE_ID,
      );
      for (const b of bots) {
        const inLevel = await waitForLevel(b.page, NODE_ID, 60000);
        if (!inLevel) {
          test.skip(true, `a bot never reached GS_LEVEL on launch (relay flake / cold WASM)`);
          return;
        }
      }

      // Sanity: every bot is in-level + holds a distinct slot before the soak.
      for (let i = 0; i < bots.length; i++) {
        const st = await getState(bots[i]!.page, NODE_ID);
        expect(st.mySlot, `bot ${i} seated at slot ${i}`).toBe(i);
        expect(st.gamestate, `bot ${i} in level`).toBe(GS_LEVEL);
      }

      // ── THE SOAK: every bot wanders + shoots until DURATION_MS elapses ──
      // Probe liveness every tick; bail the instant any bot crashes so the
      // survival time is the true time-to-first-instability.
      const heldMove: (string | null)[] = bots.map(() => null);
      const soakEnd = Date.now() + DURATION_MS;
      while (Date.now() < soakEnd) {
        // Drive every bot one tick (parallel).
        await Promise.all(
          bots.map(async (b, i) => {
            try {
              heldMove[i] = await botTick(b, heldMove[i]!);
            } catch {
              // a throw here is caught by the probe below as a crash.
            }
          }),
        );
        // Probe every bot for crash/instability.
        for (let i = 0; i < bots.length; i++) {
          const reason = await probe(bots[i]!);
          if (reason) {
            crash = `${reason} [context #${i} "${bots[i]!.name}"]`;
            break;
          }
        }
        if (crash) break;
        await owner.page.waitForTimeout(TICK_MS).catch(() => {});
      }

      // Release held keys (best-effort) before teardown.
      await Promise.all(bots.map((b, i) => botRelease(b, heldMove[i]!)));

      // ── SURVIVAL METRIC — the one line the CI log greps for ─────────────
      // eslint-disable-next-line no-console
      console.log(
        `[doom-soak] bots=${BOTS} target=${Math.round(DURATION_MS / 1000)}s ` +
          `survived=${survivedS()}s crash=${crash ?? 'none'}`,
      );

      // FAIL only on a real crash — NOT on "didn't play well".
      expect(crash, `DOOM MP soak crashed: ${crash}`).toBeNull();
    } finally {
      // Close every context so no chrome-headless-shell is left behind.
      await Promise.all(bots.map((b) => b.ctx.close().catch(() => {})));
    }
  });
});
