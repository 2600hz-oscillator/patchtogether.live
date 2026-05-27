// e2e/tests/doom-mp-probe.spec.ts
//
// REUSABLE DOOM-multiplayer VISUAL PROBE — NOT a pass/fail gate.
//
// This is a self-verification harness so we can eyeball "does DOOM MP actually
// work?" without a human driving two browsers. It brings up TWO independent
// browser contexts sharing ONE rackspace via the in-memory Hocuspocus relay
// (the same @collab infra as doom-mp-real.spec.ts), then drives the REAL
// host->guest flow through the ACTUAL UI (real button clicks on Host
// Multiplayer / Launch / Join — NOT the __doomCards hooks; hook-only tests gave
// false confidence before). Hooks are used ONLY to READ state + set up the
// awareness identity / assets.
//
// At each phase it captures, to a STABLE dir /tmp/doom-mp-probe/ (persists
// across worktree teardown):
//   - a screenshot of EACH context's DOOM card (full — shows the P1/P2/HOST
//     badge, the Join button / "waiting" copy, the status line)
//   - a screenshot of EACH context's canvas (the rendered POV)
//   - state.json: per context per phase — mySlot, gamestate, isHost, badgeText,
//     memberIds.length, player x/y, and a cheap framebuffer signature so a
//     reviewer can tell the two POVs apart.
//
// It does NOT assert MP correctness (that's doom-mp-real.spec.ts's job). It only
// captures evidence + logs programmatic observations to console. A reviewer
// then judges the screenshots + state.json.
//
// GATING: this is a MANUAL probe that writes screenshots. It is OUT of the
// auto-run e2e / CI set: every test no-ops (skips) unless DOOM_PROBE=1 is set.
// It is NOT tagged @collab so `task collab` won't pick it up either.
//
// Run it:
//   flox activate -- task doom-probe
// or directly:
//   flox activate -- env DOOM_PROBE=1 npm exec -w e2e -- \
//     playwright test tests/doom-mp-probe.spec.ts --workers=1
//
// Requires the DOOM WASM + DOOM1.WAD assets (built/downloaded the same way CI
// does — see build-doom-wasm.sh + ci.yml). If absent the probe skips with a
// build hint rather than capturing blank evidence.

import { test, expect, type Page, type Browser, type BrowserContext } from '@playwright/test';
import { spawnPatch, type SpawnNode } from './_helpers';
import { mkdirSync, writeFileSync } from 'node:fs';

const ENABLED = process.env.DOOM_PROBE === '1';
const OUT_DIR = process.env.DOOM_PROBE_DIR ?? '/tmp/doom-mp-probe';
const NODE_ID = 'doom-mp';
const GS_LEVEL = 0;

interface Peer {
  ctx: BrowserContext;
  page: Page;
  userId: string;
  name: string;
  isOwner: boolean;
  tag: 'A' | 'B';
}

// One phase-row per context, accumulated into state.json.
interface PhaseRow {
  phase: string;
  context: 'A-owner' | 'B-guest';
  userId: string;
  mySlot: number | null;
  gamestate: number | null;
  isHost: boolean | null;
  badgeText: string | null;
  mpMode: string | undefined;
  mpLive: boolean | null;
  viewerStatus: string | null;
  memberCount: number | null;
  playerX: number | null;
  playerY: number | null;
  playerSlot: number | null;
  fbSig: number; // cheap canvas framebuffer signature
  note?: string;
}

const rows: PhaseRow[] = [];

// Bring up N independent contexts on the same rack via the in-memory relay,
// publishing each peer's awareness identity (owner with isRackOwner:true) the
// way r/[id]/+page.svelte does. Mirrors doom-mp-real.spec.ts boot().
async function boot(
  browser: Browser,
  rackId: string,
  specs: ReadonlyArray<{ userId: string; name: string; isOwner: boolean; tag: 'A' | 'B' }>,
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
  gamestate: number;
  isHost: boolean;
  badgeText: string;
  mpMode?: string;
  mpLive: boolean;
  viewerStatus: string;
  memberIds: string[];
}

async function getState(page: Page, id: string): Promise<CardState | null> {
  return await page
    .evaluate(
      (nid) =>
        (globalThis as unknown as { __doomCards: Record<string, { getState: () => CardState }> }).__doomCards[
          nid
        ]?.getState() ?? null,
      id,
    )
    .catch(() => null);
}

async function playerPos(
  page: Page,
  id: string,
): Promise<{ x: number; y: number; slot: number } | null> {
  return await page
    .evaluate((nid) => {
      const w = globalThis as unknown as {
        __doomCards?: Record<string, { getPlayerState: () => { x: number; y: number; slot: number } | null }>;
      };
      return w.__doomCards?.[nid]?.getPlayerState() ?? null;
    }, id)
    .catch(() => null);
}

// FNV-1a over a sub-sampled canvas — a cheap fingerprint of the rendered POV so
// distinct player views are detectable. -1 = no canvas yet.
async function fbSig(page: Page): Promise<number> {
  return await page
    .evaluate(() => {
      const cv = document.querySelector('[data-testid="doom-canvas"]') as HTMLCanvasElement | null;
      if (!cv) return -1;
      const ctx = cv.getContext('2d');
      if (!ctx) return -1;
      try {
        const { data } = ctx.getImageData(0, 0, cv.width, cv.height);
        let h = 2166136261;
        for (let i = 0; i < data.length; i += 64) {
          h ^= data[i]!;
          h = Math.imul(h, 16777619);
        }
        return h >>> 0;
      } catch {
        return -1;
      }
    })
    .catch(() => -1);
}

// Screenshot the DOOM card + canvas for one peer, and append a state row.
async function capture(peer: Peer, phase: string, idx: string, note?: string): Promise<PhaseRow> {
  const ctxName = peer.tag === 'A' ? 'A-owner' : 'B-guest';
  const cardBase = `${idx}-${phase}-${peer.tag}`;
  // Card (full module) — shows badge, status line, buttons.
  const card = peer.page.locator('[data-testid="doom-card"]').first();
  await card
    .screenshot({ path: `${OUT_DIR}/${cardBase}-card.png` })
    .catch(async () => {
      // Card not mounted yet (e.g. before the node syncs) — fall back to a
      // viewport shot so we still have *something* for the reviewer.
      await peer.page.screenshot({ path: `${OUT_DIR}/${cardBase}-card.png` }).catch(() => {});
    });
  // Canvas (the rendered POV).
  await peer.page
    .locator('[data-testid="doom-canvas"]')
    .first()
    .screenshot({ path: `${OUT_DIR}/${cardBase}-canvas.png` })
    .catch(() => {});

  const st = await getState(peer.page, NODE_ID);
  const pos = await playerPos(peer.page, NODE_ID);
  const sig = await fbSig(peer.page);
  const row: PhaseRow = {
    phase,
    context: ctxName,
    userId: peer.userId,
    mySlot: st?.mySlot ?? null,
    gamestate: st?.gamestate ?? null,
    isHost: st?.isHost ?? null,
    badgeText: st?.badgeText ?? null,
    mpMode: st?.mpMode,
    mpLive: st?.mpLive ?? null,
    viewerStatus: st?.viewerStatus ?? null,
    memberCount: st?.memberIds.length ?? null,
    playerX: pos?.x ?? null,
    playerY: pos?.y ?? null,
    playerSlot: pos?.slot ?? null,
    fbSig: sig,
    note,
  };
  rows.push(row);
  // eslint-disable-next-line no-console
  console.log(
    `[probe] ${idx} ${phase} ${peer.tag}: slot=${row.mySlot} gs=${row.gamestate} host=${row.isHost} badge=${row.badgeText} mpMode=${row.mpMode} mpLive=${row.mpLive} members=${row.memberCount} pos=(${row.playerX},${row.playerY}) fbSig=${row.fbSig}`,
  );
  return row;
}

test.describe('DOOM MP visual probe (manual; gated behind DOOM_PROBE=1)', () => {
  // Cold WASM on two contexts + cross-sync + launch + join + movement bursts +
  // screenshots at each phase → generous ceiling, still bounded.
  test.setTimeout(240_000);

  test('owner hosts + launches MP, guest joins via real UI clicks; capture both POVs each phase', async ({
    browser,
  }) => {
    test.skip(!ENABLED, 'manual probe — set DOOM_PROBE=1 (or run `task doom-probe`) to capture evidence');

    mkdirSync(OUT_DIR, { recursive: true });

    const rackId = `doom-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Owner id sorts LEX-LARGE, guest LEX-SMALL — the pre-fix break ordering.
    // Guest uses an anon-prefixed id (the exact identity an invite-link viewer
    // carries) so we exercise the anon-guest path the operator hits.
    const peers = await boot(browser, rackId, [
      { userId: 'zzz-rack-owner', name: 'Owner', isOwner: true, tag: 'A' },
      { userId: 'anon-guest-7095', name: 'guest 7095', isOwner: false, tag: 'B' },
    ]);
    const owner = peers[0]!;
    const guest = peers[1]!;

    const summary: Record<string, unknown> = {
      generatedAt: new Date().toISOString(),
      rackId,
      contexts: {
        'A-owner': { userId: owner.userId, isRackOwner: true, identity: 'member (rack owner)' },
        'B-guest': { userId: guest.userId, isRackOwner: false, identity: 'anon/invite guest' },
      },
      uiClicks: {} as Record<string, boolean>,
      observations: {} as Record<string, unknown>,
    };

    try {
      const haveAssets = await assetsPresent(owner.page);
      summary.assetsPresent = haveAssets;
      if (!haveAssets) {
        // Still write a state.json so the reviewer sees WHY there's no evidence.
        summary.skippedReason =
          'DOOM WASM / WAD missing — run `bash packages/web/native/build-doom-wasm.sh` + fetch DOOM1.WAD';
        writeFileSync(`${OUT_DIR}/state.json`, JSON.stringify({ summary, rows }, null, 2));
        test.skip(true, summary.skippedReason as string);
        return;
      }

      // ── PHASE 01: owner ADDS the single shared DOOM node ─────────────────
      const nodes: SpawnNode[] = [
        { id: NODE_ID, type: 'doom', position: { x: 120, y: 120 }, domain: 'video' },
      ];
      await spawnPatch(owner.page, nodes, []);
      await cardHookReady(owner.page, NODE_ID);
      await capture(owner, 'owner-added', '01', 'owner added DOOM node');
      // Guest still likely has no card yet — capture viewport as a baseline.
      await capture(guest, 'owner-added', '01', 'guest before node sync');

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
      summary.observations = { ...(summary.observations as object), guestSawNode };
      await cardHookReady(guest.page, NODE_ID).catch(() => {});

      // Converge presence: both should see 2 members.
      const ownerMembers2 = await expect
        .poll(async () => (await getState(owner.page, NODE_ID))?.memberIds.length ?? 0, { timeout: 12000 })
        .toBe(2)
        .then(() => true)
        .catch(() => false);
      const guestMembers2 = await expect
        .poll(async () => (await getState(guest.page, NODE_ID))?.memberIds.length ?? 0, { timeout: 12000 })
        .toBe(2)
        .then(() => true)
        .catch(() => false);
      summary.observations = {
        ...(summary.observations as object),
        ownerSees2Members: ownerMembers2,
        guestSees2Members: guestMembers2,
      };

      // ── PHASE 02: owner HOSTS MULTIPLAYER via the REAL UI button ─────────
      const hostBtn = owner.page.locator('[data-testid="doom-start-multi"]');
      let hostClicked = false;
      if (await hostBtn.isVisible().catch(() => false)) {
        await hostBtn.click();
        hostClicked = true;
      }
      (summary.uiClicks as Record<string, boolean>)['host-multiplayer'] = hostClicked;
      // Wait for the host to seat as P0 and reach the level. Launch is a second
      // real UI click once the New Game dialog is up. The host is the arbiter,
      // so the New Game dialog (mode/skill/episode/map + Launch) is shown.
      const ownerSeated = await owner.page
        .waitForFunction(
          (nid) =>
            (globalThis as unknown as { __doomCards: Record<string, { getState: () => { mySlot: number | null } }> })
              .__doomCards[nid]?.getState().mySlot === 0,
          NODE_ID,
          { timeout: 25000 },
        )
        .then(() => true)
        .catch(() => false);
      summary.observations = { ...(summary.observations as object), ownerSeatedP0: ownerSeated };

      // ── PHASE 02 (continued): owner clicks the REAL Launch button ────────
      const launchBtn = owner.page.locator('[data-testid="doom-launch-btn"]');
      let launchClicked = false;
      if (await launchBtn.isVisible({ timeout: 10000 }).catch(() => false)) {
        await launchBtn.click();
        launchClicked = true;
      }
      (summary.uiClicks as Record<string, boolean>)['launch'] = launchClicked;

      const ownerInLevel = await owner.page
        .waitForFunction(
          (args) => {
            const [nid, lvl] = args as [string, number];
            const st = (
              globalThis as unknown as {
                __doomCards: Record<string, { getState: () => { launched: boolean; gamestate: number } }>;
              }
            ).__doomCards[nid]?.getState();
            return !!st && st.launched === true && st.gamestate === lvl;
          },
          [NODE_ID, GS_LEVEL],
          { timeout: 60000 },
        )
        .then(() => true)
        .catch(() => false);
      summary.observations = { ...(summary.observations as object), ownerReachedLevel: ownerInLevel };
      await capture(owner, 'host-inlevel', '02', 'host started MP + clicked Launch');
      await capture(guest, 'host-inlevel', '02', 'guest while host launches');

      // ── PHASE 03: guest SEES the widget + the Join affordance, then ──────
      //              clicks the REAL Join button when enabled.
      // First confirm the guest sees the lobby / live game.
      const guestSawLive = await guest.page
        .waitForFunction(
          (nid) =>
            (globalThis as unknown as { __doomCards: Record<string, { getState: () => { mpLive: boolean } }> })
              .__doomCards[nid]?.getState().mpLive === true,
          NODE_ID,
          { timeout: 25000 },
        )
        .then(() => true)
        .catch(() => false);
      summary.observations = { ...(summary.observations as object), guestSawMpLive: guestSawLive };
      await capture(guest, 'guest-sees-widget', '03a', 'guest sees live MP game (Join should enable)');

      const joinBtn = guest.page.locator('[data-testid="doom-join-btn"]');
      const joinVisible = await joinBtn.isVisible({ timeout: 10000 }).catch(() => false);
      const joinEnabled = await joinBtn.isEnabled().catch(() => false);
      summary.observations = {
        ...(summary.observations as object),
        guestJoinVisible: joinVisible,
        guestJoinEnabled: joinEnabled,
      };
      let joinClicked = false;
      if (joinVisible && joinEnabled) {
        await joinBtn.click();
        joinClicked = true;
      }
      (summary.uiClicks as Record<string, boolean>)['guest-join'] = joinClicked;

      // Guest should seat at slot 1 and reach the level on its own runtime.
      const guestSeated = await guest.page
        .waitForFunction(
          (nid) =>
            (globalThis as unknown as { __doomCards: Record<string, { getState: () => { mySlot: number | null } }> })
              .__doomCards[nid]?.getState().mySlot === 1,
          NODE_ID,
          { timeout: 30000 },
        )
        .then(() => true)
        .catch(() => false);
      const guestInLevel = await guest.page
        .waitForFunction(
          (args) => {
            const [nid, lvl] = args as [string, number];
            const st = (
              globalThis as unknown as {
                __doomCards: Record<string, { getState: () => { launched: boolean; gamestate: number } }>;
              }
            ).__doomCards[nid]?.getState();
            return !!st && st.launched === true && st.gamestate === lvl;
          },
          [NODE_ID, GS_LEVEL],
          { timeout: 60000 },
        )
        .then(() => true)
        .catch(() => false);
      summary.observations = {
        ...(summary.observations as object),
        guestSeatedSlot1: guestSeated,
        guestReachedLevel: guestInLevel,
      };
      await capture(owner, 'guest-join-clicked', '03', 'owner view after guest clicked Join');
      await capture(guest, 'guest-join-clicked', '03', 'guest after clicking Join (+ waited for level)');

      // ── PHASE 04: both DRIVE movement (real keyboard events on each) ─────
      const oBefore = await playerPos(owner.page, NODE_ID);
      const gBefore = await playerPos(guest.page, NODE_ID);
      // Owner moves.
      await owner.page.evaluate(() => {
        const c = document.querySelector('[data-testid="doom-card"]') as HTMLElement | null;
        c?.focus();
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowUp', bubbles: true }));
      });
      // Guest moves.
      await guest.page.evaluate(() => {
        const c = document.querySelector('[data-testid="doom-card"]') as HTMLElement | null;
        c?.focus();
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowUp', bubbles: true }));
      });
      const ownerMoved = await owner.page
        .waitForFunction(
          (args) => {
            const [nid, sx, sy] = args as [string, number | null, number | null];
            const p = (
              globalThis as unknown as {
                __doomCards?: Record<string, { getPlayerState: () => { x: number; y: number } | null }>;
              }
            ).__doomCards?.[nid]?.getPlayerState();
            return !!p && (p.x !== sx || p.y !== sy);
          },
          [NODE_ID, oBefore?.x ?? null, oBefore?.y ?? null],
          { timeout: 12000 },
        )
        .then(() => true)
        .catch(() => false);
      const guestMoved = await guest.page
        .waitForFunction(
          (args) => {
            const [nid, sx, sy] = args as [string, number | null, number | null];
            const p = (
              globalThis as unknown as {
                __doomCards?: Record<string, { getPlayerState: () => { x: number; y: number } | null }>;
              }
            ).__doomCards?.[nid]?.getPlayerState();
            return !!p && (p.x !== sx || p.y !== sy);
          },
          [NODE_ID, gBefore?.x ?? null, gBefore?.y ?? null],
          { timeout: 12000 },
        )
        .then(() => true)
        .catch(() => false);
      // Release keys.
      await owner.page.evaluate(() =>
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ArrowUp', bubbles: true })),
      );
      await guest.page.evaluate(() =>
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ArrowUp', bubbles: true })),
      );
      summary.observations = {
        ...(summary.observations as object),
        ownerMarineMoved: ownerMoved,
        guestMarineMoved: guestMoved,
      };
      const o4 = await capture(owner, 'after-move', '04', 'owner after ArrowUp burst');
      const g4 = await capture(guest, 'after-move', '04', 'guest after ArrowUp burst');
      summary.observations = {
        ...(summary.observations as object),
        distinctFramebufferSigs: o4.fbSig !== g4.fbSig && o4.fbSig !== -1 && g4.fbSig !== -1,
        ownerFbSig: o4.fbSig,
        guestFbSig: g4.fbSig,
      };
    } finally {
      writeFileSync(`${OUT_DIR}/state.json`, JSON.stringify({ summary, rows }, null, 2));
      // eslint-disable-next-line no-console
      console.log(`[probe] wrote ${OUT_DIR}/state.json + screenshots to ${OUT_DIR}`);
      await Promise.all(peers.map((p) => p.ctx.close().catch(() => {})));
    }
  });
});
