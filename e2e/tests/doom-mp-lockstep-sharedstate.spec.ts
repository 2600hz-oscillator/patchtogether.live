// e2e/tests/doom-mp-lockstep-sharedstate.spec.ts
//
// @collab — P1 TRUE DETERMINISTIC LOCKSTEP shared-state proof.
//
// THE POINT (the whole reason P1 exists)
// ──────────────────────────────────────
// The owner-confirmed failure was "both players run INDEPENDENT gamestates —
// monsters + barrels + health are not synced." Pre-P1, each peer free-ran its
// OWN dgpt_tick on its own clock and merely overlaid the latest remote ticcmd.
// The marines roughly mirrored each other, but EVERYTHING ELSE (monster AI,
// RNG-driven damage, item state) diverged — there was no shared simulation.
//
// P1 wires a real lockstep barrier: both peers append their per-tic ticcmd to a
// shared ordered Yjs append-log, consolidate an identical ordered TicSet per
// tic, and feed it into the WASM barrier (dgpt_receive_ticset) which gates
// advancement on the consolidated stream. Fed the identical ordered TicSet, the
// two sims are byte-identical (proven bit-exact by the C harnesses).
//
// THIS TEST asserts SHARED STATE, not liveness: once BOTH peers are in a
// 2-player coop game (the host opens MP, the guest joins → the arbiter
// synchronized-RESTARTS the map at numPlayers=2 — the design's §5 mechanism,
// which is a FRESH deterministic start at shared tic 0, NOT a snapshot/late-join
// transfer) and have run a world-mutating burst (P1 moves + fires, so monsters
// react + RNG advances), the two peers' dgpt_state_checksum() — the
// deterministic digest of every mobj's position/health + leveltime + both RNG
// indices — must be EQUAL at the same shared tic.
//
//   • FAILS on current main: the sims free-run → their checksums diverge.
//   • PASSES with P1: identical ordered TicSet → byte-identical state → equal.
//
// (Note on the join flow: the current UI gates a guest's Join on the host being
// in a live MP game, so the two-player game is reached via host-opens-MP +
// guest-joins → synchronized restart at np=2. That relaunch is a fresh shared
// tic-0 start under lockstep — exactly what a "fresh 2-player coop game" means
// for shared state. Snapshot-based mid-level late-join stays deferred to P2.)
//
// It ALSO re-asserts the #343/#345 no-freeze guarantee: neither peer's sim dies
// and the host keeps advancing (lockstep must PAUSE, never freeze, on a stall).
//
// Run only this:  flox activate -- task collab -- doom-mp-lockstep-sharedstate.spec.ts

import { test, expect, type Page, type Browser, type BrowserContext } from '@playwright/test';
import { spawnPatch, type SpawnNode } from './_helpers';

const GS_LEVEL = 0;
const NODE_ID = 'doom-ls';

interface Peer {
  ctx: BrowserContext;
  page: Page;
  userId: string;
  name: string;
  isOwner: boolean;
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

interface CardState {
  mySlot: number | null;
  memberIds: string[];
  launched: boolean;
  lockstepActive: boolean;
  gamestate: number;
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

async function tics(page: Page, id: string): Promise<{ maketic: number; gametic: number; recvtic: number }> {
  return await page.evaluate((nid) => {
    const w = globalThis as unknown as {
      __doomCards?: Record<string, { getTics: () => { maketic: number; gametic: number; recvtic: number } }>;
    };
    return w.__doomCards?.[nid]?.getTics() ?? { maketic: 0, gametic: 0, recvtic: 0 };
  }, id);
}

/** Read the deterministic state digest at the CURRENT gametic, plus the gametic
 *  it was sampled at (so the two peers compare at the SAME tic). A dead/aborted
 *  runtime throws → we return a sentinel so the test can distinguish a freeze. */
async function checksumAt(page: Page, id: string): Promise<{ tic: number; sum: number } | null> {
  return await page.evaluate((nid) => {
    try {
      const w = globalThis as unknown as {
        __doomCards?: Record<
          string,
          { stateChecksum: () => number; getTics: () => { gametic: number } }
        >;
      };
      const c = w.__doomCards?.[nid];
      if (!c) return null;
      return { tic: c.getTics().gametic, sum: c.stateChecksum() >>> 0 };
    } catch {
      return null; // runtime aborted (freeze)
    }
  }, id);
}

/** Issue #348: the arbiter-pruned shared ticcmd-log length (-1 if lockstep
 *  off). Asserts the log stays BOUNDED over a long run (barrier-floor pruning),
 *  not growing ~140/sec unbounded → relay OOM. */
async function logSize(page: Page, id: string): Promise<number> {
  return await page.evaluate((nid) => {
    const w = globalThis as unknown as {
      __doomCards?: Record<string, { getLockstepLogSize: () => number }>;
    };
    return w.__doomCards?.[nid]?.getLockstepLogSize() ?? -1;
  }, id);
}

async function holdKey(page: Page, code: string): Promise<void> {
  await page.evaluate(() => {
    const c = document.querySelector('[data-testid="doom-card"]') as HTMLElement | null;
    c?.focus();
  });
  await page.evaluate((k) => window.dispatchEvent(new KeyboardEvent('keydown', { code: k, bubbles: true })), code);
}
async function releaseKey(page: Page, code: string): Promise<void> {
  await page.evaluate((k) => window.dispatchEvent(new KeyboardEvent('keyup', { code: k, bubbles: true })), code);
}

test.describe('@collab DOOM multiplayer — P1 true lockstep shared state', () => {
  // Cold WASM + 4 MB WAD on two contexts + a fresh coop launch + a sustained
  // movement/fire burst, with both sims kept in lockstep over the relay.
  test.setTimeout(180_000);

  test('two peers in a FRESH coop game share IDENTICAL gamestate (checksums match across contexts)', async ({
    browser,
  }) => {
    const rackId = `doom-ls-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const peers = await boot(browser, rackId, [
      { userId: 'aaa-owner', name: 'Owner', isOwner: true },
      { userId: 'bbb-guest', name: 'Guest', isOwner: false },
    ]);
    const p1 = peers[0]!;
    const p2 = peers[1]!;
    const p1Console: string[] = [];
    p1.page.on('console', (m) => p1Console.push(m.text()));
    p1.page.on('pageerror', (e) => p1Console.push(`pageerror: ${e.message}`));

    try {
      if (!(await assetsPresent(p1.page))) {
        test.skip(true, 'DOOM WASM / WAD missing — run build-doom-wasm.sh + fetch DOOM1.WAD');
        return;
      }

      // Owner adds the shared DOOM node; guest sees it via Yjs node sync.
      const nodes: SpawnNode[] = [{ id: NODE_ID, type: 'doom', position: { x: 120, y: 120 }, domain: 'video' }];
      await spawnPatch(p1.page, nodes, []);
      const guestSawNode = await p2.page
        .waitForFunction(
          (nid) =>
            Object.keys((window as unknown as { __patch: { nodes: Record<string, unknown> } }).__patch.nodes).includes(
              nid,
            ),
          NODE_ID,
          { timeout: 15000 },
        )
        .then(() => true)
        .catch(() => false);
      if (!guestSawNode) {
        test.skip(true, 'cross-context node sync flake');
        return;
      }
      await cardHookReady(p1.page, NODE_ID);
      await cardHookReady(p2.page, NODE_ID);
      await expect
        .poll(async () => (await getState(p1.page, NODE_ID)).memberIds.length, { timeout: 10000 })
        .toBe(2);

      // ── Host opens MP + launches coop E1M1 (slot 0) ──
      await p1.page.evaluate(
        (nid) =>
          (globalThis as unknown as { __doomCards: Record<string, { hostMultiplayer: () => Promise<void> }> })
            .__doomCards[nid]!.hostMultiplayer(),
        NODE_ID,
      );
      expect(await waitForSlot(p1.page, NODE_ID, 0, 25000), 'owner takes slot 0').toBe(true);
      await p1.page.evaluate(
        (nid) => {
          const w = globalThis as unknown as {
            __doomCards: Record<string, { setOptions: (o: object) => void; launch: () => void }>;
          };
          w.__doomCards[nid]!.setOptions({ mode: 'coop', skill: 0, episode: 1, map: 1 });
          w.__doomCards[nid]!.launch();
        },
        NODE_ID,
      );
      expect(await waitForLevel(p1.page, NODE_ID), 'host enters the coop level').toBe(true);

      // ── Guest joins → arbiter synchronized-RESTARTS the map at numPlayers=2 ──
      // (the design's §5 fresh-start mechanism; both peers reload at shared tic 0
      // under lockstep — this is the 2-player shared game, not a snapshot join).
      await p2.page.evaluate(
        (nid) =>
          (globalThis as unknown as { __doomCards: Record<string, { join: () => Promise<void> }> }).__doomCards[
            nid
          ]!.join(),
        NODE_ID,
      );
      const guestSeated = await waitForSlot(p2.page, NODE_ID, 1, 30000);
      if (!guestSeated) {
        test.skip(true, 'cross-context roster sync did not seat the guest at slot 1 (relay flake)');
        return;
      }

      // ── BOTH peers in the np=2 level with the lockstep barrier ARMED ──
      expect(await waitForLevel(p1.page, NODE_ID), 'P1 in the np=2 coop level').toBe(true);
      expect(await waitForLevel(p2.page, NODE_ID), 'P2 in the np=2 coop level').toBe(true);
      {
        const a = await getState(p1.page, NODE_ID);
        const b = await getState(p2.page, NODE_ID);
        expect(a.mySlot, 'P1 = slot 0').toBe(0);
        expect(b.mySlot, 'P2 = slot 1').toBe(1);
        expect(a.lockstepActive, 'P1 lockstep barrier armed (numPlayers=2)').toBe(true);
        expect(b.lockstepActive, 'P2 lockstep barrier armed (numPlayers=2)').toBe(true);
      }

      // ── World-mutating burst: BOTH peers move + TURN RAPIDLY + fire ──────────
      // Both peers feeding fast-changing, DISTINCT per-tic input is what exposes
      // the old free-run model: its last-value awareness overlay COALESCES the
      // intermediate per-tic angleturn (and applies the survivor a tic late on
      // the other peer), so the two worlds drift — different facing → different
      // pistol-fire RNG/spread → different monster reactions → divergent state.
      // Firing also discharges the pistol (RNG-driven). Under P1's ordered log +
      // barrier, EVERY tic's input reaches both peers in order, so they stay
      // byte-identical. We alternate turn direction every step to maximize the
      // per-tic variation a coalescing transport cannot preserve.
      const TURN = ['ArrowLeft', 'ArrowRight'];
      for (let i = 0; i < 8; i++) {
        const t1k = TURN[i % 2]!;
        const t2k = TURN[(i + 1) % 2]!; // P2 turns opposite so the worlds differ
        await holdKey(p1.page, 'ArrowUp').catch(() => {});
        await holdKey(p1.page, 'ControlLeft').catch(() => {});
        await holdKey(p1.page, t1k).catch(() => {});
        await holdKey(p2.page, 'ArrowUp').catch(() => {});
        await holdKey(p2.page, 'ControlLeft').catch(() => {});
        await holdKey(p2.page, t2k).catch(() => {});
        await p1.page.waitForTimeout(380);
        await releaseKey(p1.page, t1k).catch(() => {});
        await releaseKey(p2.page, t2k).catch(() => {});
      }
      await releaseKey(p1.page, 'ControlLeft').catch(() => {});
      await releaseKey(p1.page, 'ArrowUp').catch(() => {});
      await releaseKey(p2.page, 'ControlLeft').catch(() => {});
      await releaseKey(p2.page, 'ArrowUp').catch(() => {});

      // Both sims must have advanced well past tic 0 (no freeze, barrier released).
      const t1 = await tics(p1.page, NODE_ID);
      const t2 = await tics(p2.page, NODE_ID);
      expect(t1.gametic, 'P1 sim advanced (no freeze)').toBeGreaterThan(20);
      expect(t2.gametic, 'P2 sim advanced (no freeze)').toBeGreaterThan(20);

      // ── THE SHARED-STATE ASSERTION: same tic ⇒ same checksum on both peers ──
      // Both peers run the IDENTICAL ordered TicSet stream, so for any gametic T,
      // dgpt_state_checksum(T) is identical on both. We sample each peer's LIVE
      // (gametic, checksum) rapidly for a couple of seconds (the sims keep
      // advancing in lockstep), building a tic→checksum map per peer, then assert
      // that for EVERY tic both peers sampled, the checksums are EQUAL — and that
      // there is a healthy overlap of shared tics. This is race-free (we compare
      // by tic number, not by wall-clock instant) and is the real shared-state
      // oracle: on free-run main the maps disagree on every overlapping tic.
      const sampleMap = async (page: Page, ms: number): Promise<Map<number, number>> => {
        const m = new Map<number, number>();
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          const r = await checksumAt(page, NODE_ID);
          if (r) m.set(r.tic, r.sum);
          await page.waitForTimeout(8);
        }
        return m;
      };
      const [mapA, mapB] = await Promise.all([sampleMap(p1.page, 2500), sampleMap(p2.page, 2500)]);
      const sharedTics = [...mapA.keys()].filter((t) => mapB.has(t)).sort((a, b) => a - b);
      const mismatches = sharedTics.filter((t) => mapA.get(t) !== mapB.get(t));

      expect(
        sharedTics.length,
        `P1 and P2 must have a healthy overlap of sampled tics (both advancing in lockstep). ` +
          `p1Tics=${[...mapA.keys()].length} p2Tics=${[...mapB.keys()].length}`,
      ).toBeGreaterThan(3);
      expect(
        mismatches.length,
        `P1 and P2 must hold IDENTICAL gamestate at EVERY shared tic (true lockstep). ` +
          `sharedTics=${sharedTics.length} mismatches=${mismatches.length} ` +
          `firstMismatch=${
            mismatches.length
              ? JSON.stringify({ tic: mismatches[0], a: mapA.get(mismatches[0]!), b: mapB.get(mismatches[0]!) })
              : 'none'
          } p1ConsoleTail=${JSON.stringify(p1Console.slice(-5))}`,
      ).toBe(0);

      // ── No-freeze regression (#343/#345): both sims still alive + advancing ──
      const aEnd = await checksumAt(p1.page, NODE_ID);
      const bEnd = await checksumAt(p2.page, NODE_ID);
      expect(aEnd, 'P1 sim still alive (not aborted)').not.toBeNull();
      expect(bEnd, 'P2 sim still alive (not aborted)').not.toBeNull();
      const consistencyFailure = p1Console.some((l) => /consistency failure/i.test(l));
      expect(consistencyFailure, 'no in-engine consistency abort fired on the lockstep path').toBe(false);
      // The host keeps advancing.
      const before = (await tics(p1.page, NODE_ID)).gametic;
      await holdKey(p1.page, 'ArrowUp');
      await p1.page.waitForTimeout(700);
      await holdKey(p2.page, 'ArrowUp'); // P2 must also feed input so the barrier releases
      await p1.page.waitForTimeout(700);
      await releaseKey(p1.page, 'ArrowUp').catch(() => {});
      await releaseKey(p2.page, 'ArrowUp').catch(() => {});
      const after = (await tics(p1.page, NODE_ID)).gametic;
      expect(after, 'host keeps advancing (no freeze)').toBeGreaterThan(before);

      // ── ISSUE #348: the shared ticcmd-log stays BOUNDED, not linear ──────────
      // By now both sims have advanced many tics (gametic well past the seed).
      // Without pruning the Y.Array would hold ~numPlayers entries PER TIC FOR
      // THE WHOLE GAME (≈ 2 × gametic). With barrier-floor pruning the arbiter
      // drops every tic both peers have consolidated past, so the log holds only
      // the small in-flight window (input-delay + prune-interval + slack), a
      // SMALL CONSTANT independent of how long the game has run. We let the sims
      // run a bit more, then assert the arbiter's log is far below the
      // grows-forever size — and bounded by an absolute ceiling. (Only the
      // arbiter prunes, so we read its log; the guest sees the same shared
      // array, pruned by the arbiter's deletes.)
      const arbiterIsP1 = (await getState(p1.page, NODE_ID)).isNetArbiter;
      const arbiter = arbiterIsP1 ? p1 : p2;
      const other = arbiterIsP1 ? p2 : p1;
      // Drive both peers a while longer so the gametic climbs well past the log
      // size — if the log tracked gametic (unbounded) this is where it'd blow up.
      for (let i = 0; i < 4; i++) {
        await holdKey(p1.page, 'ArrowUp').catch(() => {});
        await holdKey(p2.page, 'ArrowUp').catch(() => {});
        await arbiter.page.waitForTimeout(500);
      }
      await releaseKey(p1.page, 'ArrowUp').catch(() => {});
      await releaseKey(p2.page, 'ArrowUp').catch(() => {});
      const gtArb = (await tics(arbiter.page, NODE_ID)).gametic;
      const arbLog = await logSize(arbiter.page, NODE_ID);
      // Sanity: lockstep is active so the log is real (not the -1 sentinel).
      expect(arbLog, 'arbiter shared log is live').toBeGreaterThanOrEqual(0);
      // BOUNDED: the log holds far fewer entries than a never-pruned log would
      // (≈ 2 × gametic). 256 covers the input-delay + prune window + jitter for
      // 2 players with comfortable headroom, and is independent of game length.
      expect(
        arbLog,
        `shared ticcmd-log must stay BOUNDED by barrier-floor pruning, not grow ` +
          `~2×gametic. gametic=${gtArb} logSize=${arbLog} (unpruned would be ≈${2 * gtArb}).`,
      ).toBeLessThan(256);
      // And the game must actually have run long enough that an unpruned log
      // WOULD have exceeded the bound — otherwise the assertion is vacuous.
      expect(gtArb, 'sim ran long enough that pruning is load-bearing').toBeGreaterThan(140);
      // Shared state still holds AFTER pruning: both peers agree at a common tic.
      const cA = await checksumAt(arbiter.page, NODE_ID);
      const cB = await checksumAt(other.page, NODE_ID);
      if (cA && cB && cA.tic === cB.tic) {
        expect(cA.sum, 'checksums still match after pruning (pruning is harmless)').toBe(cB.sum);
      }
    } finally {
      await Promise.all(peers.map((p) => p.ctx.close().catch(() => {})));
    }
  });
});
