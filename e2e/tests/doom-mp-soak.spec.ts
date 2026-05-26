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
//
// STAGGERED: 4 DOOM WASM instances cold-booting across 4 browser contexts on
// ONE CI runner is heavy (CPU/memory). The all-at-once boot starves contexts
// and a bot fails to seat / reach GS_LEVEL. We create contexts, navigate, and
// attach the provider SEQUENTIALLY (one bot fully through attach before the
// next starts) with a small settle gap, so each WASM/engine bring-up gets the
// runner to itself rather than contending with N-1 siblings.
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
    // Navigate + attach provider for THIS bot before starting the next, so the
    // engine/WASM bring-up doesn't contend with siblings booting in parallel.
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(
      () => typeof (window as unknown as { __attachProvider?: unknown }).__attachProvider === 'function',
    );
    await page.evaluate(
      async (args) => {
        const [id, uid, name, owner] = args as [string, string, string, boolean];
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
        w.__setAwarenessUser({ id: uid, displayName: name, color: '#0f0', isRackOwner: owner });
      },
      [rackId, bot.userId, bot.name, bot.isOwner],
    );
    // Settle gap between context bring-ups (relay sync + CPU breathing room).
    await page.waitForTimeout(500).catch(() => {});
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
  // waits to reach GS_LEVEL, which is the dominant cost. The PR #319 CI run
  // proved a 2-context cold-WASM bring-up alone took ~370 s on the runner — so
  // the prior 90 s base + 90 s/bot budget (270 s for 2 bots) UNDER-budgeted and
  // the 2-bot smoke timed out at 420 s before the soak window opened. Bring-up
  // is now STAGGERED (sequential per bot), so it's ~linear in bot count: budget
  // a generous 60 s base + 200 s/bot (≈ 460 s for 2 bots, ≈ 860 s ≈ 14 min for
  // 4 bots) so even a slow 4-bot boot has real headroom before the soak starts.
  // Total ceiling = setup + the soak window + 120 s teardown/report headroom,
  // capped at 40 min (the CI `doom-soak` job is timeout-minutes:40).
  const SETUP_BUDGET_MS = 60_000 + BOTS * 200_000;
  test.setTimeout(Math.min(SETUP_BUDGET_MS + DURATION_MS + 120_000, 40 * 60_000));

  test(`${BOTS} bots deathmatch survival soak (${Math.round(DURATION_MS / 1000)}s)`, async ({
    browser,
  }) => {
    // Two clocks: setup (boot → all bots in GS_LEVEL) is the bring-up cost; the
    // GAMEPLAY clock starts only once the soak loop begins. Survival = gameplay
    // seconds, the headline number; setup is logged separately so a fat setup
    // can never inflate the reported survival again (the PR #319 bug).
    const setupStart = Date.now();
    let gameplayStart = 0; // set at soak-loop start
    let setupEndMs = 0; // frozen when the soak loop begins (= bring-up done)
    let gameplayEndMs = 0; // frozen at soak-loop EXIT, before teardown can hang
    const targetS = Math.round(DURATION_MS / 1000);
    // setup = bring-up cost (test start → soak-loop start). Frozen once the loop
    // begins so post-soak teardown can't inflate it; for a setup-stage FAIL
    // (loop never reached) it falls back to live elapsed time.
    const setupS = () =>
      Math.round(((setupEndMs || Date.now()) - setupStart) / 1000);
    // gameplay = the headline survival number (soak-loop start → loop exit).
    // Frozen at loop exit so a hung botRelease/teardown can never inflate it.
    const gameplayS = () =>
      gameplayStart ? Math.round(((gameplayEndMs || Date.now()) - gameplayStart) / 1000) : 0;

    const rackId = `doom-soak-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const bots = await boot(browser, rackId, BOTS);
    const owner = bots[0]!;
    const guests = bots.slice(1);
    let crash: string | null = null;

    // Emit the one survival/diagnostic line CI greps for. `crash` carries the
    // outcome: 'none' (clean soak) or a reason — gameplay crash OR a setup-stage
    // failure (which bot, which stage). ALWAYS logged before we assert.
    const logSurvival = () => {
      // eslint-disable-next-line no-console
      console.log(
        `[doom-soak] bots=${BOTS} setup=${setupS()}s gameplay=${gameplayS()}s/${targetS}s ` +
          `crash=${crash ?? 'none'}`,
      );
    };

    try {
      if (!(await assetsPresent(owner.page))) {
        // The ONLY legitimate skip: environment precondition (assets absent).
        test.skip(true, 'DOOM WASM / WAD missing — run build-doom-wasm.sh + fetch DOOM1.WAD');
        return;
      }

      // ── Owner adds the single shared DOOM node ──────────────────────────
      const nodes: SpawnNode[] = [
        { id: NODE_ID, type: 'doom', position: { x: 120, y: 120 }, domain: 'video' },
      ];
      await spawnPatch(owner.page, nodes, []);

      // ── Every guest sees the SAME node via Yjs sync ─────────────────────
      // A guest that never sees the node is a REAL bring-up failure (relay /
      // sync instability) — REPORT + FAIL, do NOT skip-to-green.
      for (let gi = 0; gi < guests.length; gi++) {
        const g = guests[gi]!;
        const saw = await g.page
          .waitForFunction(
            (nid) =>
              Object.keys(
                (window as unknown as { __patch: { nodes: Record<string, unknown> } }).__patch.nodes,
              ).includes(nid),
            NODE_ID,
            { timeout: 45000 },
          )
          .then(() => true)
          .catch(() => false);
        if (!saw) {
          crash = `setup: cross-context node sync did not deliver the DOOM node [guest ${gi + 1} "${g.name}"]`;
          logSurvival();
          expect(crash, `DOOM MP soak bring-up failed: ${crash}`).toBeNull();
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
          crash = `setup: guest never saw the host-opened lobby (mpMode!=multi) [guest ${i + 1} "${g.name}"]`;
          logSurvival();
          expect(crash, `DOOM MP soak bring-up failed: ${crash}`).toBeNull();
          return;
        }
        await g.page.evaluate(
          (nid) =>
            (globalThis as unknown as { __doomCards: Record<string, { join: () => Promise<void> }> })
              .__doomCards[nid]!.join(),
          NODE_ID,
        );
        const seated = await waitForSlot(g.page, NODE_ID, i + 1, 45000);
        if (!seated) {
          crash = `setup: roster sync didn't seat guest at slot ${i + 1} [guest ${i + 1} "${g.name}"]`;
          logSurvival();
          expect(crash, `DOOM MP soak bring-up failed: ${crash}`).toBeNull();
          return;
        }
        // Stagger guest joins: let each seat settle in the roster before the
        // next guest joins, so 4 concurrent join()s don't race the arbiter.
        await g.page.waitForTimeout(500).catch(() => {});
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
      // A bot that never reaches GS_LEVEL is the central bring-up failure the
      // soak must SURFACE (cold-WASM contention / netgame init) — REPORT + FAIL,
      // never skip-to-green. Wait per bot (staggered launch confirmation).
      for (let i = 0; i < bots.length; i++) {
        const inLevel = await waitForLevel(bots[i]!.page, NODE_ID, 90000);
        if (!inLevel) {
          crash = `setup: bot never reached GS_LEVEL on launch (cold WASM / netgame init) [context #${i} "${bots[i]!.name}"]`;
          logSurvival();
          expect(crash, `DOOM MP soak bring-up failed: ${crash}`).toBeNull();
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
      // survival time is the true time-to-first-instability. START the GAMEPLAY
      // clock NOW — all bots are confirmed seated + in GS_LEVEL — so survival
      // measures gameplay only, excluding the (separately-logged) setup cost.
      gameplayStart = Date.now();
      setupEndMs = gameplayStart; // freeze the setup (bring-up) duration here
      const heldMove: (string | null)[] = bots.map(() => null);
      const soakEnd = gameplayStart + DURATION_MS;
      // Each per-bot page.evaluate (botTick / probe) round-trips through a
      // browser pinned by the DOOM render loop. Under N saturated WASM contexts
      // that latency is UNBOUNDED — a single slow evaluate can stall a tick for
      // many seconds, so a naive `while (now<end)` loop overruns its window by
      // orders of magnitude (a 15 s smoke ran 600 s, hitting the test timeout).
      // Defend with a HARD wall-clock deadline: every awaited op races a budget
      // computed from the time LEFT in the soak window, so the loop can never
      // run past soakEnd regardless of how slow/hung an individual evaluate is.
      const withDeadline = async <T>(p: Promise<T>, fallback: T): Promise<T> => {
        const budget = soakEnd - Date.now();
        if (budget <= 0) return fallback;
        let timer: ReturnType<typeof setTimeout>;
        const cap = new Promise<T>((res) => {
          timer = setTimeout(() => res(fallback), budget);
        });
        try {
          return await Promise.race([p, cap]);
        } finally {
          clearTimeout(timer!);
        }
      };
      while (Date.now() < soakEnd) {
        // Drive every bot one tick (parallel), each capped at the remaining
        // window so a stalled evaluate cannot push us past soakEnd.
        await withDeadline(
          Promise.all(
            bots.map(async (b, i) => {
              try {
                heldMove[i] = await botTick(b, heldMove[i]!);
              } catch {
                // a throw here is caught by the probe below as a crash.
              }
            }),
          ),
          undefined,
        );
        if (Date.now() >= soakEnd) break;
        // Probe every bot for crash/instability (also deadline-capped — a probe
        // that NEVER returns is itself a crash signal, surfaced via the timeout
        // sentinel rather than hanging the loop into the test timeout).
        for (let i = 0; i < bots.length; i++) {
          const reason = await withDeadline(probe(bots[i]!), 'PROBE_TIMEOUT' as const);
          if (reason === 'PROBE_TIMEOUT') {
            // Only treat as a crash if the window is NOT already over — a probe
            // cut short by the end-of-soak deadline is benign.
            if (Date.now() < soakEnd) {
              crash = `probe-unresponsive (relay/context stalled > remaining window) [context #${i} "${bots[i]!.name}"]`;
            }
            break;
          }
          if (reason) {
            crash = `${reason} [context #${i} "${bots[i]!.name}"]`;
            break;
          }
        }
        if (crash) break;
        if (Date.now() >= soakEnd) break;
        await withDeadline(owner.page.waitForTimeout(TICK_MS).then(() => undefined), undefined);
      }
      // FREEZE the gameplay survival number HERE — at the loop exit — before any
      // teardown. A best-effort botRelease() evaluate can HANG on a browser
      // pinned by the DOOM render loop (observed: it stalled ~575 s into the
      // per-test timeout); capturing now means a hung release can never inflate
      // the reported gameplay survival, and logSurvival() below uses the frozen
      // value rather than re-reading the (post-stall) clock.
      gameplayEndMs = Date.now();

      // Release held keys (best-effort) before teardown — but HARD-CAP it: a
      // pinned browser can make this evaluate never resolve, which previously
      // hung the whole test into its 595 s timeout. 5 s is plenty to flush keys.
      await Promise.race([
        Promise.all(bots.map((b, i) => botRelease(b, heldMove[i]!))),
        new Promise<void>((res) => setTimeout(res, 5_000)),
      ]);

      // ── SURVIVAL METRIC — the one line the CI log greps for ─────────────
      // setup=Xs (bring-up cost) and gameplay=Ys/targetS (the headline survival
      // number) are reported SEPARATELY so setup can never inflate survival.
      logSurvival();

      // FAIL only on a real crash — NOT on "didn't play well".
      expect(crash, `DOOM MP soak crashed: ${crash}`).toBeNull();
    } finally {
      // Close every context so no chrome-headless-shell is left behind.
      await Promise.all(bots.map((b) => b.ctx.close().catch(() => {})));
    }
  });
});
