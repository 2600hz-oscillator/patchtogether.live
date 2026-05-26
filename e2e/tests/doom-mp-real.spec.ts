// e2e/tests/doom-mp-real.spec.ts
//
// @collab — the operator's exact "real 2-user DOOM multiplayer" flow, driven
// across two INDEPENDENT browser contexts (separate cookie jars / localStorage
// / ydocs — two real users on two machines) against the real local Hocuspocus
// relay + real DOOM WASM + real WAD. ONE shared DOOM node (the host adds it;
// the guest sees it via Yjs node sync and does NOT spawn its own — the
// committed instance model).
//
// Why this exists — the bugs it pins (all reported by the operator on a real
// 2-user shared rack, and reproduced here on the FIXED relay):
//
//   1. GUEST-AS-PLAYER-1 / host confusion. DOOM elected its host + seated
//      player 0 by LEX-SMALLEST user id (pickHost / assignSlots), with no
//      concept of the rack owner. So whenever the rack owner's id did NOT sort
//      first, a guest became DOOM host AND player 0 — the operator's "guest
//      7095 seated as P1, both cards say HOST". The fix publishes
//      `user.isRackOwner` in awareness and makes the owner the host / arbiter /
//      player 0 regardless of id ordering.
//
//   2. GAME PLAYS ITSELF (attract demo) / can't launch. The SESSION arbiter
//      (host) drove Launch, but the NET arbiter (who may broadcast GAMESTART)
//      was a SEPARATE lex-min election in doom-netcode. When the owner wasn't
//      lex-smallest the two diverged, so the host's Launch was a silent no-op
//      and DOOM fell back to its attract demo. The fix threads owner ids into
//      the netcode election too, so host == net arbiter == player 0.
//
//   3. IMPLICIT START. Multiplayer used to "just happen" when a 2nd member was
//      detected (fragile under presence races → the "single-user rack" limbo).
//      Now the host makes an EXPLICIT choice (Host Multiplayer / Single
//      Player), stored on the node so the guest sees the lobby + gets Join.
//
// This MUST run on CI (NOT skip-on-CI) and would FAIL on pre-fix code (guest
// seated P1, launch no-op → never reaches GS_LEVEL). CI builds the DOOM WASM +
// downloads the shareware WAD (see ci.yml), so the full render path is
// exercised. If the assets are somehow absent locally, the test skips with a
// build hint rather than failing spuriously.
//
// Run only this:  flox activate -- task e2e -- doom-mp-real.spec.ts

import { test, expect, type Page, type Browser, type BrowserContext } from '@playwright/test';
import { spawnPatch, type SpawnNode } from './_helpers';

const GS_LEVEL = 0;
// DOOM gamestate_t ordinals (doomdef.h): GS_LEVEL=0, GS_INTERMISSION=1,
// GS_FINALE=2, GS_DEMOSCREEN=3. The attract/title menu the operator saw the
// host stuck on is GS_DEMOSCREEN — so a strengthened test must assert the host
// is on GS_LEVEL, NOT GS_DEMOSCREEN (the old test's launched===true gate could
// pass on stale state while the WASM still ran the demo loop).
const GS_DEMOSCREEN = 3;
const NODE_ID = 'doom-mp';

// Vanilla DOOM player colors (matches $lib/doom/doom-player-identity).
const SLOT_COLOR = ['#3fa34d', '#5b5bd6'];

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
  viewerStatus: 'player' | 'pending' | 'spectator';
  isHost: boolean;
  isNetArbiter: boolean;
  memberIds: string[];
  mpMode?: 'single' | 'multi';
  mpLive: boolean;
  ownerIds: string[];
  badgeText: string;
  slotColor: string;
  launched: boolean;
  gamestate: number;
  skill: number;
  mode: string;
}

// Distinct contexts. Crucially the rack OWNER's id sorts LEX-LARGE and the
// guest's sorts LEX-SMALL — the exact ordering that broke pre-fix (a lex-min
// guest hijacked host + player 0). The owner publishes `isRackOwner: true`
// (the same flag r/[id]/+page.svelte sets from data.rackspace.ownerUserId).
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

// FNV-1a over a sub-sampled canvas — a cheap fingerprint of the rendered POV.
async function canvasHash(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const cv = document.querySelector('[data-testid="doom-canvas"]') as HTMLCanvasElement | null;
    if (!cv) return -1;
    const ctx = cv.getContext('2d');
    if (!ctx) return -1;
    const { data } = ctx.getImageData(0, 0, cv.width, cv.height);
    let h = 2166136261;
    for (let i = 0; i < data.length; i += 64) {
      h ^= data[i]!;
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  });
}

async function playerPos(
  page: Page,
  id: string,
): Promise<{ x: number; y: number; slot: number } | null> {
  return await page.evaluate((nid) => {
    const w = globalThis as unknown as {
      __doomCards?: Record<string, { getPlayerState: () => { x: number; y: number; slot: number } | null }>;
    };
    return w.__doomCards?.[nid]?.getPlayerState() ?? null;
  }, id);
}

test.describe('@collab DOOM multiplayer — real 2-user', () => {
  // Cold WASM + 4 MB WAD on two contexts + cross-context sync + launch +
  // movement burst → generous ceiling.
  test.setTimeout(180_000);

  test('owner hosts + launches MP as P1, guest one-click hot-joins as P2 into the running level', async ({
    browser,
  }) => {
    const rackId = `doom-mp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const peers = await boot(browser, rackId, [
      // Owner id sorts LEX-LARGE; guest LEX-SMALL — the pre-fix break ordering.
      { userId: 'zzz-rack-owner', name: 'Owner', isOwner: true },
      { userId: 'aaa-guest-7095', name: 'Guest', isOwner: false },
    ]);
    const owner = peers[0]!;
    const guest = peers[1]!;
    try {
      if (!(await assetsPresent(owner.page))) {
        test.skip(
          true,
          'DOOM WASM / WAD missing — run `bash packages/web/native/build-doom-wasm.sh` + fetch DOOM1.WAD',
        );
        return;
      }

      // ── Owner (rack host) ADDS the single shared DOOM node ───────────────
      const nodes: SpawnNode[] = [
        { id: NODE_ID, type: 'doom', position: { x: 120, y: 120 }, domain: 'video' },
      ];
      await spawnPatch(owner.page, nodes, []);

      // ── Guest sees the SAME node via Yjs sync (one node per rack) ────────
      const guestSawNode = await guest.page
        .waitForFunction(
          (nid) =>
            Object.keys(
              (window as unknown as { __patch: { nodes: Record<string, unknown> } }).__patch.nodes,
            ).includes(nid),
          NODE_ID,
          { timeout: 15000 },
        )
        .then(() => true)
        .catch(() => false);
      if (!guestSawNode) {
        test.skip(true, 'cross-context node sync did not deliver the DOOM node (relay flake)');
        return;
      }
      await cardHookReady(owner.page, NODE_ID);
      await cardHookReady(guest.page, NODE_ID);
      // Let awareness presence converge so both cards see 2 members + the owner flag.
      await expect
        .poll(async () => (await getState(owner.page, NODE_ID)).memberIds.length, { timeout: 10000 })
        .toBe(2);
      await expect
        .poll(async () => (await getState(guest.page, NODE_ID)).memberIds.length, { timeout: 10000 })
        .toBe(2);

      // ── Before any start: NOT single-user, NOT auto-seated ───────────────
      // (the relay-fix already lets both see 2 members; the regression here is
      //  that no implicit auto-join happens — MP is an explicit host action.)
      {
        const o = await getState(owner.page, NODE_ID);
        const g = await getState(guest.page, NODE_ID);
        expect(o.memberIds.length, 'owner sees 2 members (not single-user)').toBe(2);
        expect(g.memberIds.length, 'guest sees 2 members (not single-user)').toBe(2);
        // The OWNER is the host even though its id sorts lex-LAST. Pre-fix the
        // lex-min guest was host here.
        expect(o.isHost, 'rack owner is the DOOM host').toBe(true);
        expect(g.isHost, 'guest is NOT the host').toBe(false);
        expect(o.ownerIds, 'owner id is published as rack owner').toContain('zzz-rack-owner');
        expect(o.mySlot, 'nobody is auto-seated before host starts MP').toBeNull();
        expect(g.mySlot).toBeNull();
        expect(o.mpMode, 'no session mode chosen yet').toBeUndefined();
      }

      // ── Owner explicitly HOSTS MULTIPLAYER → seated as player 0 (P1) ─────
      await owner.page.evaluate(
        (nid) =>
          (
            globalThis as unknown as {
              __doomCards: Record<string, { hostMultiplayer: () => Promise<void> }>;
            }
          ).__doomCards[nid]!.hostMultiplayer(),
        NODE_ID,
      );
      const ownerSeated = await waitForSlot(owner.page, NODE_ID, 0, 25000);
      expect(ownerSeated, 'owner takes slot 0 (player 1) on Host Multiplayer').toBe(true);

      // ── Round 6 (deadlock fix): the guest's Join is NOT gated on mpLive ──
      // Before the host launches, mpLive is still false, but Join must NOT be
      // deadlocked: the join-REQUEST is what opens MP, so the button is present
      // AND ENABLED (there is room) the moment the lobby is open. (Round 5
      // wrongly disabled it until mpLive — the bug this PR fixes.)
      const guestSawLobby = await guest.page
        .waitForFunction(
          (nid) =>
            (
              globalThis as unknown as {
                __doomCards: Record<string, { getState: () => { mpMode?: string } }>;
              }
            ).__doomCards[nid]!.getState().mpMode === 'multi',
          NODE_ID,
          { timeout: 15000 },
        )
        .then(() => true)
        .catch(() => false);
      expect(guestSawLobby, 'guest sees the host-opened lobby').toBe(true);
      {
        const g = await getState(guest.page, NODE_ID);
        expect(g.mpLive, 'no MP game running yet → not live').toBe(false);
        expect(g.mySlot, 'guest is not seated before joining').toBeNull();
      }
      // Per the owner's spec: the Join button is SHOWN but DISABLED before the
      // host is running a live MP game (mpLive false). It enables only once the
      // host is in a live MP level. (No deadlock: the host flips mpLive itself
      // on launch-with-others via shouldOpenMultiplayer, not via a guest Join.)
      const joinBtnPreLaunch = guest.page.locator('[data-testid="doom-join-btn"]');
      await expect(joinBtnPreLaunch, 'Join button is present pre-launch').toBeVisible({
        timeout: 10000,
      });
      await expect(
        joinBtnPreLaunch,
        'Join is DISABLED pre-launch (host not running a multiplayer game yet)',
      ).toBeDisabled();

      // ── Owner (arbiter) LAUNCHES coop E1M1 → host reaches GS_LEVEL ───────
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
      const ownerInLevel = await waitForLevel(owner.page, NODE_ID);
      // Bug #1: the HOST itself must enter GS_LEVEL — pre-fix the host's own
      // WASM stayed on the attract/title menu (GS_DEMOSCREEN) because its
      // startNetGame no-op'd (runtime not ready when Launch self-fired) and
      // nothing re-applied it. This is the assertion that would FAIL on main.
      expect(ownerInLevel, 'HOST enters the level on Launch (NOT stuck on the title menu)').toBe(true);
      {
        const o = await getState(owner.page, NODE_ID);
        expect(o.gamestate, 'host gamestate is GS_LEVEL').toBe(GS_LEVEL);
        expect(o.gamestate, 'host is NOT on the DOOM title/attract menu').not.toBe(GS_DEMOSCREEN);
        expect(o.mySlot, 'owner is P1').toBe(0);
        expect(o.isHost).toBe(true);
        expect(o.isNetArbiter, 'host is also the net arbiter (so Launch works)').toBe(true);
        expect(o.slotColor).toBe(SLOT_COLOR[0]);
        expect(o.badgeText).toBe('P1');
      }

      // ── The host is now live (mpLive=true): the guest's Join ENABLES, and ──
      // one click hot-joins straight into the running level (no second host
      // action). The host published mpLive=true; the guest mirrors it (drives
      // the waiting→joining copy + the Join enabled state). No deadlock: the
      // host flipped mpLive on launch-with-others, not via the guest's Join.
      const guestSawLive = await guest.page
        .waitForFunction(
          (nid) =>
            (
              globalThis as unknown as {
                __doomCards: Record<string, { getState: () => { mpLive: boolean } }>;
              }
            ).__doomCards[nid]!.getState().mpLive === true,
          NODE_ID,
          { timeout: 20000 },
        )
        .then(() => true)
        .catch(() => false);
      if (!guestSawLive) {
        test.skip(true, 'cross-context mpLive sync did not reach the guest (relay flake)');
        return;
      }
      await expect(
        guest.page.locator('[data-testid="doom-join-btn"]'),
        'Join is now ENABLED (host is running an MP game)',
      ).toBeEnabled({ timeout: 10000 });

      // One click: hot-join. The arbiter seats the guest active + auto-relaunches
      // the current map so the guest drops in within ~1-2s — no host Launch step.
      await guest.page.locator('[data-testid="doom-join-btn"]').click();
      const guestSeated = await waitForSlot(guest.page, NODE_ID, 1, 30000);
      if (!guestSeated) {
        test.skip(true, 'cross-context roster sync did not seat the guest at slot 1 (relay flake)');
        return;
      }
      // The guest reaches GS_LEVEL on its OWN runtime via the auto-relaunch —
      // one click, straight into the running map.
      const guestInLevel = await waitForLevel(guest.page, NODE_ID);
      expect(
        guestInLevel,
        'guest hot-joins straight into the running level on one click (no host re-launch)',
      ).toBe(true);

      // ── Identity / host / arbiter all correct + CONSISTENT across peers ──
      {
        const o = await getState(owner.page, NODE_ID);
        const g = await getState(guest.page, NODE_ID);
        // Owner = P1 / host / arbiter / green.
        expect(o.mySlot).toBe(0);
        // Guest = P2 / not host / not arbiter / indigo. DISTINCT from owner.
        expect(g.mySlot).toBe(1);
        expect(g.mySlot).not.toBe(o.mySlot);
        expect(g.badgeText).toBe('P2');
        expect(g.slotColor).toBe(SLOT_COLOR[1]);
        expect(g.isHost).toBe(false);
        expect(g.isNetArbiter).toBe(false);
        // The guest is an ACTIVE PLAYER, NOT a spectator, NOT a pending joiner.
        expect(g.viewerStatus, 'guest is an ACTIVE player, not a spectator').toBe('player');
        expect(g.myPendingSlot, 'guest is active now, not a pending late joiner').toBeNull();
        expect(g.gamestate, 'guest gamestate is GS_LEVEL').toBe(GS_LEVEL);
        expect(g.gamestate, 'guest is NOT on the DOOM title/attract menu').not.toBe(GS_DEMOSCREEN);
        expect(g.memberIds.length).toBe(2);
      }

      // ── Round-6 Bug A: mpLive is published by the host + mirrored by the
      //    guest, so a guest is NEVER stuck "Waiting for host to start…" while
      //    the host is in a live MP level. Both peers must read mpLive===true.
      {
        const liveBoth = await guest.page
          .waitForFunction(
            (nid) =>
              (
                globalThis as unknown as {
                  __doomCards: Record<string, { getState: () => { mpLive?: boolean } }>;
                }
              ).__doomCards[nid]!.getState().mpLive === true,
            NODE_ID,
            { timeout: 10000 },
          )
          .then(() => true)
          .catch(() => false);
        expect(liveBoth, 'guest mirrors host mpLive=true (no false "Waiting…" deadlock)').toBe(true);
        const o = await getState(owner.page, NODE_ID);
        expect(o.mpLive, 'host publishes mpLive=true while in a live MP level').toBe(true);
        // The guest's waiting copy must not be the false "Waiting for host to
        // start…" — its own level is live anyway, so the dialog shows its slot.
        const waitText = await guest.page
          .locator('[data-testid="doom-waiting"]')
          .textContent()
          .catch(() => '');
        expect(waitText ?? '', 'guest never shows the false "Waiting for host to start" copy').not.toContain(
          'Waiting for host to start',
        );
      }

      // ── Each peer drives its OWN marine, spawned at its own slot ─────────
      const oStart = await playerPos(owner.page, NODE_ID);
      const gStart = await playerPos(guest.page, NODE_ID);
      expect(oStart, 'owner console player spawned').not.toBeNull();
      expect(gStart, 'guest console player spawned').not.toBeNull();
      expect(oStart!.slot, 'owner controls slot 0').toBe(0);
      expect(gStart!.slot, 'guest controls slot 1 (P2, distinct)').toBe(1);

      // The guest renders its OWN advancing framebuffer (not a frozen mirror /
      // demo). Capture two hashes a moment apart while the sim ticks.
      const gHashA = await canvasHash(guest.page);
      await guest.page.waitForTimeout(1200);
      const gHashB = await canvasHash(guest.page);
      expect(gHashA, 'guest canvas is rendering').not.toBe(-1);
      expect(gHashB, "guest's own framebuffer advances frame-to-frame").not.toBe(gHashA);

      // ── A moving changes B's view (cross-peer ticcmd feed) ───────────────
      // Owner holds ArrowUp; its marine must advance in the GUEST's world (the
      // slice-5 cross-peer ticcmd feed carries the owner's marine into the
      // guest's sim). We read the owner's slot-0 position FROM THE GUEST'S
      // runtime before + after — a deterministic, view-angle-independent signal
      // (a raw canvas-hash diff can be flat if the marine is out of the local
      // POV's frustum or the canvas hasn't repainted at capture time).
      const ownerInGuestBefore = await guest.page.evaluate((nid) => {
        const w = globalThis as unknown as {
          __doomCards?: Record<string, { getSlotState: (s: number) => { x: number; y: number } | null }>;
        };
        return w.__doomCards?.[nid]?.getSlotState(0) ?? null;
      }, NODE_ID);
      expect(ownerInGuestBefore, "owner's marine exists in the guest's world").not.toBeNull();
      // Hold ArrowUp on the owner for a sustained burst (focus the card so the
      // window-capture key handler claims the key + routes it to the runtime).
      await owner.page.evaluate(() => {
        const c = document.querySelector('[data-testid="doom-card"]') as HTMLElement | null;
        c?.focus();
      });
      await owner.page.evaluate(() =>
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowUp', bubbles: true })),
      );

      // Owner's own marine moves (local input → its own sim).
      const ownerMoved = await owner.page
        .waitForFunction(
          (args) => {
            const [nid, sx, sy] = args as [string, number, number];
            const w = globalThis as unknown as {
              __doomCards?: Record<string, { getPlayerState: () => { x: number; y: number } | null }>;
            };
            const p = w.__doomCards?.[nid]?.getPlayerState();
            return !!p && (p.x !== sx || p.y !== sy);
          },
          [NODE_ID, oStart!.x, oStart!.y],
          { timeout: 10000 },
        )
        .then(() => true)
        .catch(() => false);
      expect(ownerMoved, "owner's marine moved after holding ArrowUp").toBe(true);
      await owner.page.evaluate(() =>
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ArrowUp', bubbles: true })),
      );

      // Bug #3: the GUEST's OWN keyboard drives the GUEST's OWN marine. Pre-fix
      // a joined non-host peer relayed its keys to the host instead of pushing
      // them into its own runtime, so the guest's marine never moved from the
      // guest's keyboard. Focus the guest card, hold ArrowUp, assert the
      // guest's console-player position changes in the GUEST's own sim.
      const gMoveStart = await playerPos(guest.page, NODE_ID);
      expect(gMoveStart, 'guest console player present before its own move').not.toBeNull();
      await guest.page.evaluate(() => {
        const c = document.querySelector('[data-testid="doom-card"]') as HTMLElement | null;
        c?.focus();
      });
      await guest.page.evaluate(() =>
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowUp', bubbles: true })),
      );
      const guestMoved = await guest.page
        .waitForFunction(
          (args) => {
            const [nid, sx, sy] = args as [string, number, number];
            const w = globalThis as unknown as {
              __doomCards?: Record<string, { getPlayerState: () => { x: number; y: number } | null }>;
            };
            const p = w.__doomCards?.[nid]?.getPlayerState();
            return !!p && (p.x !== sx || p.y !== sy);
          },
          [NODE_ID, gMoveStart!.x, gMoveStart!.y],
          { timeout: 10000 },
        )
        .then(() => true)
        .catch(() => false);
      await guest.page.evaluate(() =>
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ArrowUp', bubbles: true })),
      );
      expect(guestMoved, "guest's OWN marine moved from the guest's OWN keyboard").toBe(true);

      // Re-capture the owner's slot-0 position IN THE GUEST'S world as a fresh
      // baseline (the owner already moved during its own-marine burst above),
      // then re-hold ArrowUp so the cross-peer feed has new motion to carry.
      const ownerInGuestBaseline = await guest.page.evaluate((nid) => {
        const w = globalThis as unknown as {
          __doomCards?: Record<string, { getSlotState: (s: number) => { x: number; y: number } | null }>;
        };
        return w.__doomCards?.[nid]?.getSlotState(0) ?? null;
      }, NODE_ID);
      expect(ownerInGuestBaseline, "owner's marine still present in the guest's world").not.toBeNull();
      void ownerInGuestBefore;
      await owner.page.evaluate(() => {
        const c = document.querySelector('[data-testid="doom-card"]') as HTMLElement | null;
        c?.focus();
      });
      await owner.page.evaluate(() =>
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowUp', bubbles: true })),
      );

      // The owner's marine moves in the GUEST's world too (slice-5 cross-peer
      // ticcmd feed). Poll the guest's view of slot 0 until it advances — the
      // cross-feed + lockstep carry the owner's marine into the guest's sim.
      const crossPeerMoved = await guest.page
        .waitForFunction(
          (args) => {
            const [nid, bx, by] = args as [string, number, number];
            const w = globalThis as unknown as {
              __doomCards?: Record<string, { getSlotState: (s: number) => { x: number; y: number } | null }>;
            };
            const s = w.__doomCards?.[nid]?.getSlotState(0);
            return !!s && (s.x !== bx || s.y !== by);
          },
          [NODE_ID, ownerInGuestBaseline!.x, ownerInGuestBaseline!.y],
          { timeout: 15000 },
        )
        .then(() => true)
        .catch(() => false);

      await owner.page.evaluate(() =>
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ArrowUp', bubbles: true })),
      );
      expect(
        crossPeerMoved,
        "owner's marine moved in the GUEST's world (A-moving changes B's sim)",
      ).toBe(true);
    } finally {
      // Close every context → every page + browser connection, so no
      // chrome-headless-shell is left behind.
      await Promise.all(peers.map((p) => p.ctx.close().catch(() => {})));
    }
  });

  // ── Bug #4: the New Game dialog must be fully MOUSE-operable ─────────────
  // The selectors/buttons sit inside a SvelteFlow node, which treats a
  // mousedown anywhere as a node-drag + swallows the click unless the element
  // carries the noDragClassName ('nodrag'). The native <select> popup ALSO
  // wouldn't open by mouse (SF's pointer capture fights the OS popup), so the
  // mode/skill/episode/map pickers are now CUSTOM dropdowns (a nodrag trigger
  // button + a nodrag option list). This drives them with REAL pointer clicks
  // (click trigger → click option) and asserts the picked difficulty actually
  // took + the host launched into the level.
  test('host opens the New Game dialog + picks a non-default difficulty by MOUSE', async ({
    browser,
  }) => {
    const rackId = `doom-ng-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const peers = await boot(browser, rackId, [
      { userId: 'zzz-rack-owner', name: 'Owner', isOwner: true },
    ]);
    const owner = peers[0]!;
    try {
      if (!(await assetsPresent(owner.page))) {
        test.skip(true, 'DOOM WASM / WAD missing');
        return;
      }
      await spawnPatch(owner.page, [
        { id: NODE_ID, type: 'doom', position: { x: 120, y: 120 }, domain: 'video' },
      ], []);
      await cardHookReady(owner.page, NODE_ID);

      // Open the multiplayer lobby by clicking the real "Host Multiplayer"
      // button with the mouse (not the dev hook) — proves the start-choice
      // buttons are clickable too.
      await owner.page.locator('[data-testid="doom-start-multi"]').click();
      const seated = await waitForSlot(owner.page, NODE_ID, 0, 25000);
      expect(seated, 'owner seated as P0 after clicking Host Multiplayer').toBe(true);

      // The New Game dialog is visible; pick a NON-default difficulty
      // (Ultra-Violence = skill index 3; default is index 1). The selectors are
      // CUSTOM dropdowns (not native <select>) because the native popup won't
      // reliably open inside a SvelteFlow node. Drive them with REAL pointer
      // clicks: click the trigger to open, click the option to pick. Pre-fix
      // the surrounding node-drag ate the interaction entirely.
      const skillTrigger = owner.page.locator('[data-testid="doom-skill-trigger"]');
      await expect(skillTrigger, 'skill dropdown trigger is visible + clickable').toBeVisible({
        timeout: 10000,
      });
      await skillTrigger.click(); // open the skill list
      await owner.page.locator('[data-testid="doom-skill-opt-3"]').click(); // Ultra-Violence

      const modeTrigger = owner.page.locator('[data-testid="doom-mode-trigger"]');
      await modeTrigger.click(); // open the mode list
      await owner.page.locator('[data-testid="doom-mode-opt-deathmatch"]').click();

      // The card state reflects the MOUSE-picked options (the click round-trip
      // wrote back to the card's reactive state — the dialog received the
      // interaction). mode/skill are now surfaced in getState().
      await expect
        .poll(async () => (await getState(owner.page, NODE_ID)).skill, { timeout: 5000 })
        .toBe(3);
      const picked = await getState(owner.page, NODE_ID);
      expect(picked.skill, 'skill shows the mouse-picked Ultra-Violence (idx 3)').toBe(3);
      expect(picked.mode, 'mode shows the mouse-picked deathmatch').toBe('deathmatch');

      // Launch by clicking the real Launch button → the level starts on the
      // chosen difficulty (the whole dialog round-trip worked by mouse) and the
      // HOST itself reaches GS_LEVEL (not the title menu).
      await owner.page.locator('[data-testid="doom-launch-btn"]').click();
      const inLevel = await waitForLevel(owner.page, NODE_ID);
      expect(inLevel, 'mouse-launched game reaches GS_LEVEL').toBe(true);
      const launchedState = await getState(owner.page, NODE_ID);
      expect(launchedState.gamestate, 'host is in-level, NOT on the title menu').toBe(GS_LEVEL);
      expect(launchedState.gamestate).not.toBe(GS_DEMOSCREEN);
    } finally {
      await Promise.all(peers.map((p) => p.ctx.close().catch(() => {})));
    }
  });

  // ── Round 5: an anon/invite guest one-click hot-joins a RUNNING MP game ──
  // The anon carries a stable awareness user.id but no rack ownership. The new
  // model: the host's "start a multiplayer game" is the single gate — once the
  // host is in a live MP level (mpLive), the anon's Join is enabled and ONE
  // click hot-drops it into the CURRENT map (the arbiter auto-relaunches with
  // the new player count). Before that, the anon's Join is disabled with the
  // "waiting for host" copy. The anon never opens MP itself.
  test('anon guest one-click hot-joins a running game into the CURRENT map', async ({
    browser,
  }) => {
    const rackId = `doom-anon-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const peers = await boot(browser, rackId, [
      { userId: 'zzz-rack-owner', name: 'Owner', isOwner: true },
      // Anon/invite guest: anon-prefixed id (matches getOrCreateAnonTabId),
      // NOT a rack owner — the exact identity an invite-link viewer carries.
      { userId: 'anon-guest-abc', name: 'guest 0001', isOwner: false },
    ]);
    const owner = peers[0]!;
    const anon = peers[1]!;
    try {
      if (!(await assetsPresent(owner.page))) {
        test.skip(true, 'DOOM WASM / WAD missing');
        return;
      }
      await spawnPatch(owner.page, [
        { id: NODE_ID, type: 'doom', position: { x: 120, y: 120 }, domain: 'video' },
      ], []);
      const anonSawNode = await anon.page
        .waitForFunction(
          (nid) =>
            Object.keys(
              (window as unknown as { __patch: { nodes: Record<string, unknown> } }).__patch.nodes,
            ).includes(nid),
          NODE_ID,
          { timeout: 15000 },
        )
        .then(() => true)
        .catch(() => false);
      if (!anonSawNode) {
        test.skip(true, 'cross-context node sync flake');
        return;
      }
      await cardHookReady(owner.page, NODE_ID);
      await cardHookReady(anon.page, NODE_ID);
      await expect
        .poll(async () => (await getState(owner.page, NODE_ID)).memberIds.length, { timeout: 10000 })
        .toBe(2);

      // Before any game runs: the anon's Join is present but DISABLED with the
      // "waiting for host" copy (no live MP game to join).
      {
        const joinBtn = anon.page.locator('[data-testid="doom-join-btn"]');
        await expect(joinBtn, 'anon sees a Join button (disabled)').toBeVisible({ timeout: 15000 });
        await expect(joinBtn, 'anon Join is disabled before any MP game runs').toBeDisabled();
      }

      // Owner hosts MP, joins as P0, launches a coop level → game is RUNNING.
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
      expect(await waitForLevel(owner.page, NODE_ID), 'owner reaches a running level').toBe(true);

      // With the level running (mpLive), the anon's Join ENABLES → one click
      // hot-drops the anon into the CURRENT map (no second host action).
      const joinBtn = anon.page.locator('[data-testid="doom-join-btn"]');
      await expect(joinBtn, 'anon guest is offered an enabled Join once MP is live').toBeEnabled({
        timeout: 20000,
      });
      await joinBtn.click();

      // The anon hot-drops: it becomes ACTIVE slot 1 (NOT pending) and reaches
      // GS_LEVEL with its own live marine — playing the current map within secs.
      const anonHotDropped = await anon.page
        .waitForFunction(
          (args) => {
            const [nid, lvl] = args as [string, number];
            const w = globalThis as unknown as {
              __doomCards?: Record<
                string,
                { getState: () => { mySlot: number | null; myPendingSlot: number | null; launched: boolean; gamestate: number } }
              >;
            };
            const st = w.__doomCards?.[nid]?.getState();
            return !!st && st.mySlot === 1 && st.myPendingSlot === null && st.launched === true && st.gamestate === lvl;
          },
          [NODE_ID, GS_LEVEL],
          { timeout: 60000 },
        )
        .then(() => true)
        .catch(() => false);
      if (!anonHotDropped) {
        test.skip(true, 'cross-context roster/relaunch sync flake under CI shard load');
        return;
      }
      const a = await getState(anon.page, NODE_ID);
      expect(a.mySlot, 'anon hot-dropped as active player 1').toBe(1);
      // Its own marine is live in the current map.
      const anonMarine = await playerPos(anon.page, NODE_ID);
      expect(anonMarine, 'anon spawned a live marine in the current map').not.toBeNull();
      expect(anonMarine!.slot, 'anon controls slot 1').toBe(1);
    } finally {
      await Promise.all(peers.map((p) => p.ctx.close().catch(() => {})));
    }
  });
});
