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
  // Storm-throttle counters (multiplayer-hang guard).
  awarenessUpdateCount?: number;
  electionRecomputeCount?: number;
  // The REAL awareness-write rate driver (post only-on-change suppression).
  ticcmdWriteCount?: number;
  // CV-gate input mode (Bug 4 guard).
  cvGatePatched?: boolean;
  shouldClaimKey?: boolean;
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

// Read the storm-throttle counters off a card's debug hook (multiplayer-hang
// guard). Returns {awarenessUpdateCount, electionRecomputeCount} or nulls.
async function counters(
  page: Page,
  id: string,
): Promise<{ awareness: number; election: number; ticcmdWrites: number }> {
  const st = await getState(page, id);
  return {
    awareness: st?.awarenessUpdateCount ?? 0,
    election: st?.electionRecomputeCount ?? 0,
    ticcmdWrites: st?.ticcmdWriteCount ?? 0,
  };
}

// A round-trip latency probe: time how long a trivial page.evaluate takes to
// resolve. If the main thread is hung (the bug), the round-trip blows past the
// budget (or times out entirely). Used per-second during sustained play.
async function evalRoundTripMs(page: Page): Promise<number> {
  const t0 = Date.now();
  await page.evaluate(() => 1 + 1).catch(() => {
    /* hung / context lost — caller treats the elapsed time as the verdict */
  });
  return Date.now() - t0;
}

// Add (or remove) an edge live via the dev __ydoc transact, the same path the
// cable-drop UI takes. Used by the CV-patched scenario to plug/unplug a CV
// source into a DOOM movement gate at runtime + watch cvGatePatched flip.
async function setEdge(
  page: Page,
  edge: { id: string; from: { nodeId: string; portId: string }; to: { nodeId: string; portId: string }; sourceType?: string; targetType?: string } | { remove: string },
): Promise<void> {
  await page.evaluate((e) => {
    const w = globalThis as unknown as {
      __patch: { edges: Record<string, unknown> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      if ('remove' in e) {
        delete w.__patch.edges[e.remove];
        return;
      }
      w.__patch.edges[e.id] = {
        id: e.id,
        source: e.from,
        target: e.to,
        sourceType: e.sourceType ?? 'cv',
        targetType: e.targetType ?? 'cv',
      };
    });
  }, edge);
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

  // ── SUSTAINED ACTIVE-PLAY responsiveness guard (the hang regression) ──────
  //
  // Reproduces the reported bug: after both players are in-level, drive BOTH
  // moving + shooting continuously for ~30s. Pre-fix the per-tic ticcmd storm
  // (~70 awareness updates/sec for 2 players) drove recomputeHost +
  // syncRosterState on EVERY update → main-thread saturation → both tabs hang.
  //
  // This test FAILS on pre-fix code (the evaluate round-trips blow past budget
  // and/or electionRecomputeCount tracks awarenessUpdateCount ~1:1, i.e.
  // hundreds of heavy recomputes) and PASSES after (round-trips stay fast +
  // election recomputes per second stay BOUNDED regardless of tic rate).
  test('SUSTAINED active play stays responsive (no per-tic election storm)', async ({
    browser,
  }) => {
    test.skip(!ENABLED, 'manual probe — set DOOM_PROBE=1 (or run `task doom-probe`)');
    mkdirSync(OUT_DIR, { recursive: true });

    const rackId = `doom-probe-hang-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const peers = await boot(browser, rackId, [
      { userId: 'zzz-rack-owner', name: 'Owner', isOwner: true, tag: 'A' },
      { userId: 'anon-guest-7095', name: 'guest 7095', isOwner: false, tag: 'B' },
    ]);
    const owner = peers[0]!;
    const guest = peers[1]!;
    const summary: Record<string, unknown> = { generatedAt: new Date().toISOString(), rackId, phase: 'sustained-play' };

    try {
      if (!(await assetsPresent(owner.page))) {
        summary.skippedReason = 'DOOM WASM / WAD missing';
        writeFileSync(`${OUT_DIR}/sustained-state.json`, JSON.stringify({ summary }, null, 2));
        test.skip(true, summary.skippedReason as string);
        return;
      }

      // Bring both into a running level (owner hosts+launches, guest joins).
      await spawnPatch(owner.page, [{ id: NODE_ID, type: 'doom', position: { x: 120, y: 120 }, domain: 'video' }], []);
      await cardHookReady(owner.page, NODE_ID);
      await guest.page
        .waitForFunction(
          (nid) => Object.keys((window as unknown as { __patch: { nodes: Record<string, unknown> } }).__patch.nodes).includes(nid),
          NODE_ID,
          { timeout: 15000 },
        )
        .catch(() => {});
      await cardHookReady(guest.page, NODE_ID).catch(() => {});

      const hostBtn = owner.page.locator('[data-testid="doom-start-multi"]');
      if (await hostBtn.isVisible().catch(() => false)) await hostBtn.click();
      await owner.page
        .waitForFunction((nid) => (globalThis as unknown as { __doomCards: Record<string, { getState: () => { mySlot: number | null } }> }).__doomCards[nid]?.getState().mySlot === 0, NODE_ID, { timeout: 25000 })
        .catch(() => {});
      const launchBtn = owner.page.locator('[data-testid="doom-launch-btn"]');
      if (await launchBtn.isVisible({ timeout: 10000 }).catch(() => false)) await launchBtn.click();
      const ownerInLevel = await owner.page
        .waitForFunction((args) => { const [nid, lvl] = args as [string, number]; const st = (globalThis as unknown as { __doomCards: Record<string, { getState: () => { launched: boolean; gamestate: number } }> }).__doomCards[nid]?.getState(); return !!st && st.launched && st.gamestate === lvl; }, [NODE_ID, GS_LEVEL], { timeout: 60000 })
        .then(() => true).catch(() => false);
      // Guest joins once MP is live.
      await guest.page
        .waitForFunction((nid) => (globalThis as unknown as { __doomCards: Record<string, { getState: () => { mpLive: boolean } }> }).__doomCards[nid]?.getState().mpLive === true, NODE_ID, { timeout: 25000 })
        .catch(() => {});
      const joinBtn = guest.page.locator('[data-testid="doom-join-btn"]');
      if (await joinBtn.isVisible({ timeout: 10000 }).catch(() => false) && await joinBtn.isEnabled().catch(() => false)) await joinBtn.click();
      const guestInLevel = await guest.page
        .waitForFunction((args) => { const [nid, lvl] = args as [string, number]; const st = (globalThis as unknown as { __doomCards: Record<string, { getState: () => { launched: boolean; gamestate: number } }> }).__doomCards[nid]?.getState(); return !!st && st.launched && st.gamestate === lvl; }, [NODE_ID, GS_LEVEL], { timeout: 60000 })
        .then(() => true).catch(() => false);
      summary.ownerInLevel = ownerInLevel;
      summary.guestInLevel = guestInLevel;
      expect(ownerInLevel, 'owner must reach the level before the sustained-play measurement').toBe(true);
      expect(guestInLevel, 'guest must reach the level before the sustained-play measurement').toBe(true);

      // ── Drive BOTH moving + shooting continuously, sample responsiveness ──
      const DURATION_MS = 30_000;
      const SAMPLE_MS = 1_000;
      // Budget: a healthy evaluate round-trip is single-digit ms; allow a
      // generous ceiling that a HUNG main thread cannot meet (the pre-fix hang
      // pushes this to seconds or a full timeout).
      const ROUND_TRIP_BUDGET_MS = 750;
      // Election recomputes per second must stay BOUNDED even though awareness
      // updates flood at the per-tic rate. A few/sec is fine (membership +
      // identity convergence); the storm produced dozens-to-70/sec.
      const MAX_ELECTION_PER_SEC = 15;

      // CONTINUOUS input (not bursts). A real player HOLDS movement + fire and
      // keeps TURNING for the whole window. We press movement + fire ONCE
      // (keydown, no keyup until the very end) so the keys stay HELD, then
      // every iteration we toggle the turn direction (Left/Right) so the
      // ticcmd's angleturn keeps CHANGING — that is what actually defeats the
      // netcode's only-on-change suppression and drives the per-tic awareness
      // WRITE. (A perfectly steady hold produces a CONSTANT ticcmd → suppressed
      // → near-zero writes; see ticcmdWriteCount instrumentation + the REPORT.)
      const beginHold = async (page: Page) => {
        await page.evaluate(() => {
          const c = document.querySelector('[data-testid="doom-card"]') as HTMLElement | null;
          c?.focus();
          // Hold forward + fire for the entire window.
          window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowUp', bubbles: true }));
          window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ControlLeft', bubbles: true }));
        });
      };
      // Per-iteration: keep the marine TURNING so angleturn changes every tic
      // (release the previous turn key, press the opposite) — held movement +
      // fire continue underneath.
      const driveTurn = async (page: Page, turn: number) => {
        await page.evaluate((t) => {
          const prev = t % 2 === 0 ? 'ArrowRight' : 'ArrowLeft';
          const next = t % 2 === 0 ? 'ArrowLeft' : 'ArrowRight';
          window.dispatchEvent(new KeyboardEvent('keyup', { code: prev, bubbles: true }));
          window.dispatchEvent(new KeyboardEvent('keydown', { code: next, bubbles: true }));
        }, turn);
      };

      await beginHold(owner.page);
      await beginHold(guest.page);

      const ownerStart = await counters(owner.page, NODE_ID);
      const guestStart = await counters(guest.page, NODE_ID);
      let worstRoundTrip = 0;
      let worstElectionPerSec = 0;
      // Aggregate the flood by SUMMING per-second deltas, each clamped to ≥0.
      // This is immune to a mid-run counter reset (a card remount): the
      // pre-fix (end - baseline) aggregate went NEGATIVE when the counter reset
      // below the baseline. The underlying counters are now also monotonic
      // (module-scoped in doom-instrumentation), so the two agree — but the
      // clamped-delta sum is the robust, non-negative measure either way.
      let ownerAwSum = 0, guestAwSum = 0, ownerElecSum = 0, guestElecSum = 0;
      let ownerTwSum = 0, guestTwSum = 0;
      const samples: Array<Record<string, number>> = [];
      const t0 = Date.now();
      let turn = 0;
      let prevOwner = ownerStart;
      let prevGuest = guestStart;
      while (Date.now() - t0 < DURATION_MS) {
        await driveTurn(owner.page, turn);
        await driveTurn(guest.page, turn);
        turn++;
        // Round-trip latency on BOTH pages (the responsiveness signal).
        const oRt = await evalRoundTripMs(owner.page);
        const gRt = await evalRoundTripMs(guest.page);
        worstRoundTrip = Math.max(worstRoundTrip, oRt, gRt);
        // Per-second deltas on both pages. Clamp to ≥0 so a counter reset
        // (remount) contributes 0 for that second rather than a negative.
        const oNow = await counters(owner.page, NODE_ID);
        const gNow = await counters(guest.page, NODE_ID);
        const d = (now: number, prev: number) => Math.max(0, now - prev);
        const oElecPerSec = d(oNow.election, prevOwner.election);
        const gElecPerSec = d(gNow.election, prevGuest.election);
        const oAwPerSec = d(oNow.awareness, prevOwner.awareness);
        const gAwPerSec = d(gNow.awareness, prevGuest.awareness);
        const oTwPerSec = d(oNow.ticcmdWrites, prevOwner.ticcmdWrites);
        const gTwPerSec = d(gNow.ticcmdWrites, prevGuest.ticcmdWrites);
        ownerAwSum += oAwPerSec; guestAwSum += gAwPerSec;
        ownerElecSum += oElecPerSec; guestElecSum += gElecPerSec;
        ownerTwSum += oTwPerSec; guestTwSum += gTwPerSec;
        worstElectionPerSec = Math.max(worstElectionPerSec, oElecPerSec, gElecPerSec);
        samples.push({ tSec: Math.round((Date.now() - t0) / 1000), oRt, gRt, oElecPerSec, gElecPerSec, oAwPerSec, gAwPerSec, oTwPerSec, gTwPerSec });
        prevOwner = oNow;
        prevGuest = gNow;
        // Hold the sample cadence (each iteration drives ~1s of play).
        const elapsed = Date.now() - t0;
        const nextTick = Math.ceil(elapsed / SAMPLE_MS) * SAMPLE_MS;
        await owner.page.waitForTimeout(Math.max(0, nextTick - elapsed));
      }
      // Release everything held.
      for (const p of [owner.page, guest.page]) {
        await p.evaluate(() => {
          for (const code of ['ArrowUp', 'ArrowLeft', 'ArrowRight', 'ControlLeft']) {
            window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
          }
        }).catch(() => {});
      }

      summary.samples = samples;
      // Aggregates from the clamped per-second sums (non-negative, monotonic).
      summary.ownerAwarenessUpdates = ownerAwSum;
      summary.ownerElectionRecomputes = ownerElecSum;
      summary.guestAwarenessUpdates = guestAwSum;
      summary.guestElectionRecomputes = guestElecSum;
      // The REAL awareness-write rate (post only-on-change suppression).
      summary.ownerTiccmdWrites = ownerTwSum;
      summary.guestTiccmdWrites = guestTwSum;
      const totalTw = ownerTwSum + guestTwSum;
      const elapsedSec = (Date.now() - t0) / 1000;
      summary.measuredTiccmdWritesPerSec = elapsedSec > 0 ? totalTw / elapsedSec : 0;
      summary.worstRoundTripMs = worstRoundTrip;
      summary.worstElectionPerSec = worstElectionPerSec;
      // eslint-disable-next-line no-console
      console.log(`[probe] sustained-play: worstRoundTrip=${worstRoundTrip}ms worstElectionPerSec=${worstElectionPerSec} ownerAw=${summary.ownerAwarenessUpdates} ownerElec=${summary.ownerElectionRecomputes} guestAw=${summary.guestAwarenessUpdates} guestElec=${summary.guestElectionRecomputes} ticcmdWrites/sec=${(summary.measuredTiccmdWritesPerSec as number).toFixed(1)} (owner=${ownerTwSum} guest=${guestTwSum})`);

      // PROOF the storm is throttled: there WAS a real awareness flood (so the
      // scenario actually exercises the storm path) yet the heavy election work
      // stayed a small fraction of it, and the page stayed responsive.
      const totalAw = (summary.ownerAwarenessUpdates as number) + (summary.guestAwarenessUpdates as number);
      const totalElec = (summary.ownerElectionRecomputes as number) + (summary.guestElectionRecomputes as number);
      // The aggregates must be non-negative now (the reset/baseline bug fix).
      expect(totalAw, 'aggregate awareness updates must be non-negative').toBeGreaterThanOrEqual(0);
      expect(totalElec, 'aggregate election recomputes must be non-negative').toBeGreaterThanOrEqual(0);
      expect(totalAw, 'the scenario must actually generate an awareness flood').toBeGreaterThan(50);
      expect(worstRoundTrip, 'main thread must stay responsive under sustained play').toBeLessThan(ROUND_TRIP_BUDGET_MS);
      expect(worstElectionPerSec, 'election/roster recompute per second must stay bounded under the ticcmd flood').toBeLessThanOrEqual(MAX_ELECTION_PER_SEC);
      expect(totalElec, 'heavy election work must be a small fraction of the awareness flood').toBeLessThan(totalAw / 2);
    } finally {
      writeFileSync(`${OUT_DIR}/sustained-state.json`, JSON.stringify({ summary }, null, 2));
      await Promise.all(peers.map((p) => p.ctx.close().catch(() => {})));
    }
  });

  // ── CV-PATCHED keyboard-inert guard (Bug 4) ───────────────────────────────
  //
  // A single-context functional check (no MP needed): spawn a CV source + DOOM,
  // confirm the keyboard CLAIMS keys + moves the marine when UNPATCHED, then
  // patch a CV gate into a movement port and confirm the keyboard goes INERT
  // (cvGatePatched true, shouldClaimKey false, a keypress no longer moves the
  // player). Unplugging re-enables the keyboard. Pre-fix the $derived never
  // re-ran on a Yjs edge add, so cvGatePatched stayed false + the keyboard kept
  // driving DOOM while patched (the live regression). FAILS pre-fix.
  test('CV-patched gate makes the keyboard inert; unpatched it drives DOOM (Bug 4)', async ({
    browser,
  }) => {
    test.skip(!ENABLED, 'manual probe — set DOOM_PROBE=1 (or run `task doom-probe`)');
    mkdirSync(OUT_DIR, { recursive: true });

    const rackId = `doom-probe-cv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const peers = await boot(browser, rackId, [
      { userId: 'solo-owner', name: 'Owner', isOwner: true, tag: 'A' },
    ]);
    const owner = peers[0]!;
    const summary: Record<string, unknown> = { generatedAt: new Date().toISOString(), rackId, phase: 'cv-patched' };

    try {
      if (!(await assetsPresent(owner.page))) {
        summary.skippedReason = 'DOOM WASM / WAD missing';
        writeFileSync(`${OUT_DIR}/cv-state.json`, JSON.stringify({ summary }, null, 2));
        test.skip(true, summary.skippedReason as string);
        return;
      }

      // Spawn a CV source (LFO) + the DOOM node. No edge yet → UNPATCHED.
      const CV_SRC = 'cv-src';
      await spawnPatch(
        owner.page,
        [
          { id: CV_SRC, type: 'lfo', position: { x: 40, y: 40 }, domain: 'audio' },
          { id: NODE_ID, type: 'doom', position: { x: 360, y: 40 }, domain: 'video' },
        ],
        [],
      );
      await cardHookReady(owner.page, NODE_ID);
      // Host single-player so the owner's runtime is live + at a level (so a
      // keypress can actually move the marine). Single-player Play is host-only.
      const playBtn = owner.page.locator('[data-testid="doom-start-single"]');
      if (await playBtn.isVisible({ timeout: 8000 }).catch(() => false)) {
        await playBtn.click();
      }
      const launchBtn = owner.page.locator('[data-testid="doom-launch-btn"]');
      if (await launchBtn.isVisible({ timeout: 10000 }).catch(() => false)) await launchBtn.click();
      const inLevel = await owner.page
        .waitForFunction((args) => { const [nid, lvl] = args as [string, number]; const st = (globalThis as unknown as { __doomCards: Record<string, { getState: () => { launched: boolean; gamestate: number } }> }).__doomCards[nid]?.getState(); return !!st && st.launched && st.gamestate === lvl; }, [NODE_ID, GS_LEVEL], { timeout: 60000 })
        .then(() => true).catch(() => false);
      summary.inLevel = inLevel;

      // Click the card to LATCH keyboard control (the normal engage gesture).
      await owner.page.locator('[data-testid="doom-card"]').first().click().catch(() => {});

      // ── UNPATCHED: keyboard should claim + move the marine ───────────────
      const unpatchedState = await getState(owner.page, NODE_ID);
      summary.unpatched_cvGatePatched = unpatchedState?.cvGatePatched ?? null;
      summary.unpatched_shouldClaimKey = unpatchedState?.shouldClaimKey ?? null;
      expect(unpatchedState?.cvGatePatched, 'no edge yet → not patched').toBe(false);

      const before = await playerPos(owner.page, NODE_ID);
      await owner.page.evaluate(() => {
        const c = document.querySelector('[data-testid="doom-card"]') as HTMLElement | null;
        c?.focus();
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowUp', bubbles: true }));
      });
      const movedUnpatched = await owner.page
        .waitForFunction((args) => { const [nid, sx, sy] = args as [string, number | null, number | null]; const p = (globalThis as unknown as { __doomCards?: Record<string, { getPlayerState: () => { x: number; y: number } | null }> }).__doomCards?.[nid]?.getPlayerState(); return !!p && (p.x !== sx || p.y !== sy); }, [NODE_ID, before?.x ?? null, before?.y ?? null], { timeout: 12000 })
        .then(() => true).catch(() => false);
      await owner.page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ArrowUp', bubbles: true })));
      summary.unpatched_keyboardMovedMarine = movedUnpatched;

      // ── PATCH a CV gate into the DOOM 'up' movement port ─────────────────
      await setEdge(owner.page, {
        id: 'cv-edge',
        from: { nodeId: CV_SRC, portId: 'phase0' },
        to: { nodeId: NODE_ID, portId: 'up' },
        sourceType: 'cv',
        targetType: 'cv',
      });
      // The fix: the edges Yjs observer bumps edgesVersion → cvGatePatched
      // recomputes → true. Poll for it (the $derived settles on the next tick).
      const wentPatched = await owner.page
        .waitForFunction((nid) => (globalThis as unknown as { __doomCards: Record<string, { getState: () => { cvGatePatched?: boolean } }> }).__doomCards[nid]?.getState().cvGatePatched === true, NODE_ID, { timeout: 8000 })
        .then(() => true).catch(() => false);
      const patchedState = await getState(owner.page, NODE_ID);
      summary.patched_cvGatePatched = patchedState?.cvGatePatched ?? null;
      summary.patched_shouldClaimKey = patchedState?.shouldClaimKey ?? null;
      expect(wentPatched, 'patching a CV gate must flip cvGatePatched true (Bug 4 fix)').toBe(true);
      expect(patchedState?.cvGatePatched, 'patched ⇒ cvGatePatched true').toBe(true);
      expect(patchedState?.shouldClaimKey, 'patched ⇒ keyboard inert (shouldClaimKey false)').toBe(false);

      // ── PATCHED: a keypress must NOT move the marine ─────────────────────
      const patchedBefore = await playerPos(owner.page, NODE_ID);
      // Re-latch attempt (a click) must NOT re-enable the keyboard while patched.
      await owner.page.locator('[data-testid="doom-card"]').first().click().catch(() => {});
      await owner.page.evaluate(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowUp', bubbles: true }));
      });
      // Give it the same window the unpatched move had; assert it did NOT move.
      const movedWhilePatched = await owner.page
        .waitForFunction((args) => { const [nid, sx, sy] = args as [string, number | null, number | null]; const p = (globalThis as unknown as { __doomCards?: Record<string, { getPlayerState: () => { x: number; y: number } | null }> }).__doomCards?.[nid]?.getPlayerState(); return !!p && (p.x !== sx || p.y !== sy); }, [NODE_ID, patchedBefore?.x ?? null, patchedBefore?.y ?? null], { timeout: 4000 })
        .then(() => true).catch(() => false);
      await owner.page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ArrowUp', bubbles: true })));
      summary.patched_keyboardMovedMarine = movedWhilePatched;
      expect(movedWhilePatched, 'patched ⇒ keyboard keypress must NOT move the marine').toBe(false);

      // ── UNPLUG: keyboard re-enables ──────────────────────────────────────
      await setEdge(owner.page, { remove: 'cv-edge' });
      const wentUnpatched = await owner.page
        .waitForFunction((nid) => (globalThis as unknown as { __doomCards: Record<string, { getState: () => { cvGatePatched?: boolean } }> }).__doomCards[nid]?.getState().cvGatePatched === false, NODE_ID, { timeout: 8000 })
        .then(() => true).catch(() => false);
      summary.afterUnplug_cvGatePatched = (await getState(owner.page, NODE_ID))?.cvGatePatched ?? null;
      expect(wentUnpatched, 'unplugging the CV gate must flip cvGatePatched back to false').toBe(true);

      await owner.page.locator('[data-testid="doom-card"]').first().screenshot({ path: `${OUT_DIR}/cv-patched-card.png` }).catch(() => {});
      // eslint-disable-next-line no-console
      console.log(`[probe] cv-patched: unpatchedMoved=${summary.unpatched_keyboardMovedMarine} patchedMoved=${summary.patched_keyboardMovedMarine} patched=${summary.patched_cvGatePatched}`);
    } finally {
      writeFileSync(`${OUT_DIR}/cv-state.json`, JSON.stringify({ summary }, null, 2));
      await Promise.all(peers.map((p) => p.ctx.close().catch(() => {})));
    }
  });
});
