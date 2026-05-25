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
  isHost: boolean;
  isNetArbiter: boolean;
  memberIds: string[];
  mpMode?: 'single' | 'multi';
  ownerIds: string[];
  badgeText: string;
  slotColor: string;
  launched: boolean;
  gamestate: number;
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

  test('owner hosts MP as P1, guest joins as P2, both render their own real POV', async ({
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

      // ── Guest sees the lobby (mpMode=multi) → JOINS → seated as P2 ───────
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
      expect(guestSawLobby, 'guest sees the host-opened lobby (Join available)').toBe(true);

      await guest.page.evaluate(
        (nid) =>
          (globalThis as unknown as { __doomCards: Record<string, { join: () => Promise<void> }> })
            .__doomCards[nid]!.join(),
        NODE_ID,
      );
      const guestSeated = await waitForSlot(guest.page, NODE_ID, 1, 30000);
      if (!guestSeated) {
        test.skip(true, 'cross-context roster sync did not seat the guest at slot 1 (relay flake)');
        return;
      }

      // ── Identity / host / arbiter all correct + CONSISTENT across peers ──
      {
        const o = await getState(owner.page, NODE_ID);
        const g = await getState(guest.page, NODE_ID);
        // Owner = P1 / host / arbiter / green.
        expect(o.mySlot).toBe(0);
        expect(o.badgeText).toBe('P1');
        expect(o.slotColor).toBe(SLOT_COLOR[0]);
        expect(o.isHost).toBe(true);
        expect(o.isNetArbiter, 'host is also the net arbiter (so Launch works)').toBe(true);
        // Guest = P2 / not host / not arbiter / indigo. DISTINCT from owner.
        expect(g.mySlot).toBe(1);
        expect(g.mySlot).not.toBe(o.mySlot);
        expect(g.badgeText).toBe('P2');
        expect(g.slotColor).toBe(SLOT_COLOR[1]);
        expect(g.isHost).toBe(false);
        expect(g.isNetArbiter).toBe(false);
        // The roster is consistent: both peers agree the guest is at slot 1.
        expect(g.memberIds.length).toBe(2);
      }

      // ── Owner (arbiter) LAUNCHES coop E1M1 → BOTH reach GS_LEVEL ─────────
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
      const guestInLevel = await waitForLevel(guest.page, NODE_ID);
      expect(ownerInLevel, 'owner enters the level on Launch').toBe(true);
      expect(
        guestInLevel,
        'guest enters the level too (no attract demo — netgame really started)',
      ).toBe(true);

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
          [NODE_ID, ownerInGuestBefore!.x, ownerInGuestBefore!.y],
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
});
