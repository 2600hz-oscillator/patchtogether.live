// e2e/tests/workflow-dock-ux.spec.ts
//
// P1 DOCK/EXPAND UX fixes (owner-reported, `?shell=1` preview only):
//
//  1. EXPAND ↔ CLOSE toggle — while a module occupies the dock full-view its
//     lane tile's "⤢ EXPAND" pill reads "✕ CLOSE" and clicking it CLOSES the
//     full-view (wired to dockStore.fullViewNodeId).
//
//  2. Expanding module B while module A is open JOINS the dock (owner split
//     extension: up to two side-by-side panes; a third replaces the
//     least-recently-opened) — for BOTH migrated (curated shell face) and
//     un-migrated (verbatim legacy card) modules. The original owner repro
//     (tidyvco expanded → expand backdraft → NOTHING switched) was a
//     mid-flush crash: 18 legacy cards called `useStore()` un-guarded at
//     init, which THROWS outside the SvelteFlow provider (the dock full-view
//     is a plain-mount), aborting the Svelte flush and wedging the faceplate
//     on the previous occupant. Fixed by the guarded captureFlowStore seam
//     (card-kit) + a `{#key node.id}` remount per occupant in DockFullView.
//     The pageerror assertions here pin the crash class shut.
//
//  3. The PATCH drill-down opens ADJACENT to the invoking tile — the
//     lane-rail variant anchors beside the tile (right side, flipping left at
//     the screen edge) instead of the legacy edge-align model, and the anchor
//     resolves the `.rl-tile` itself.
//     NOTE (2026-07-27, PF-8): the DOCK half of this fix is superseded. The
//     migrated shell no longer renders the lane rail at view='dock-full' — it
//     was a DUPLICATE patch surface (dot-only, its EXPAND button already
//     suppressed) sitting under the faceplate's real one, the RearCard on flip,
//     and it cost ~23px of the dock's fold budget. The old "anchors to the
//     faceplate, not the origin" test is replaced by the no-duplicate-rail
//     gate at the bottom of this file, which also re-proves the rear card
//     still carries every declared hole.
//
// Runs on /rack (no DB/relay) — same lane as
// workflow-shell.spec.ts. All fixed behavior is ?shell=1-gated.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { pressFlipKey } from './_flip-key';
import {
  AUDIO_DOCK_FIXTURE,
  fixtureProblems,
  fixtureType,
} from './_face-fixtures';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';
import { settle } from '../_helpers/frames';

// ⚠ THE PER-TEST BUDGET IS A BOUND, AND IT WAS THE INVISIBLE 30 s DEFAULT.
//
// This file bounds its boot wait with `BOOT_MS` — 30 000 on CI, IDENTICAL to
// the 30 000 default budget it was running inside. 1 site, 1.00x.
//
// An inner bound at or above the budget that CONTAINS it can never come true:
// the outer clock kills the test first, so a legible `element not found` is
// converted into an illegible `Test timeout of 30000ms exceeded` — the class
// #2291 root-caused and #2293 repaired at its second call site. Nothing in this
// file said "30000"; `e2e/playwright.config.ts` never overrides Playwright's
// default, so there was nothing to grep for except the ABSENCE of a budget.
//
// The budget therefore comes from `boot-budget` (90 000 on CI/SwiftShader,
// 30 000 local) instead of the invisible default. A bound only costs wall-clock
// when it is EXCEEDED, so this adds exactly zero to a green run; lane cost stays
// gauged by `--global-timeout`, not by this.
//
// ⚠ BOUNDS ONLY. No assertion, subject or wait target changed here.
test.describe.configure({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

async function gotoWorkflow(page: Page): Promise<void> {
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

/** Pan the viewport so node `id`'s tile lands at screen (targetLeft?, targetTop?)
 *  — keeps zoom; the lane tiles must sit ABOVE the bottom drawer so real
 *  clicks land on them while the full-view is open. */
async function panTileTo(
  page: Page,
  id: string,
  target: { top?: number; left?: number },
): Promise<void> {
  await page.evaluate(
    ({ id, target }) => {
      const f = (globalThis as unknown as { __flow: { getViewport: () => { x: number; y: number; zoom: number }; setViewport: (v: { x: number; y: number; zoom: number }, o?: { duration: number }) => void } }).__flow;
      const el = document.querySelector(`.svelte-flow__node[data-id="${id}"]`);
      if (!el || !f) return;
      const r = el.getBoundingClientRect();
      const vp = f.getViewport();
      f.setViewport(
        {
          x: target.left !== undefined ? vp.x - (r.left - target.left) : vp.x,
          y: target.top !== undefined ? vp.y - (r.top - target.top) : vp.y,
          zoom: vp.zoom,
        },
        { duration: 0 },
      );
    },
    { id, target },
  );
  // `duration: 0` makes the pan instant IN THE STORE; the real clicks below
  // need the new transform PAINTED, which is a frame count, not a duration —
  // 120 ms was ~7 frames locally and under one on CI's SwiftShader (7.9 fps
  // measured). Two rAFs is Svelte-flush + paint.
  await settle(page);
}

// ── THE VIDEO FIXTURE IS HEALTHY (#1864) ────────────────────────────────────
//
// ⚠ IT RUNS EVEN THOUGH ITS CONSUMER IS PARKED, AND THAT IS THE POINT. The
// split-pane case below is the only test that spawns the video fixture and it
// is `test.fixme` (FLAKE-PARK #1847) — so while the old hand-picked list was
// draining, nothing in this file could have reddened on it. What it would have
// done instead is worse: the list resolved at IMPORT and threw when empty, so
// the notification was every spec importing `_face-fixtures.ts` failing before
// it ran a line, for a reason none of them had anything to do with.
//
// Deriving the pool removed the throw. This is what replaces it: one named
// test, in the suite that owns the fixture, red at the point of promotion.
// (The DENIED map's artifact anchor is asserted once for BOTH domains, in
// workflow-shell.spec.ts, where the audio half's gate lives.)
test('the derived audio dock fixture is healthy', () => {
  expect(fixtureProblems(AUDIO_DOCK_FIXTURE), AUDIO_DOCK_FIXTURE.why).toEqual([]);
});

test.describe('P1 dock/expand UX fixes (?shell=1)', () => {
  // FIX 1 — the tile pill is a TOGGLE: EXPAND opens the full-view and flips to
  // CLOSE; CLOSE closes it and flips back. Covers the migrated shell AND the
  // un-migrated placeholder (both route through the same PatchPanel rail).
  test('EXPAND toggles to CLOSE while expanded, and CLOSE closes the full-view', async ({ page }) => {
    // ⚠ TWO TILES ARE THE POINT, and the SECOND ONE IS WHAT THE ASSERTION
    // NEEDS — this leg proves the pill is a per-tile TOGGLE, so it has to watch
    // one tile flip to CLOSE while the OTHER stays EXPAND. The pair used to be
    // "a migrated one and an un-migrated one" because those were two render
    // paths; there is one path now, so it is simply two modules, and the second
    // is DERIVED rather than named so a future exclusion cannot rot it.
    await gotoWorkflow(page);
    await spawnPatch(page, [
      { id: 'm1', type: 'vca', position: { x: 30, y: 40 } },
      { id: 'u1', type: fixtureType(AUDIO_DOCK_FIXTURE), position: { x: 250, y: 40 } },
    ]);
    const shellTile = page.locator('.svelte-flow__node[data-id="m1"] [data-testid="module-shell"]');
    const placeholderTile = page.locator('.svelte-flow__node[data-id="u1"] [data-testid="module-shell"]');
    await expect(shellTile).toBeVisible();
    await expect(placeholderTile).toBeVisible();
    await panTileTo(page, 'm1', { top: 90 });

    const faceplate = page.getByTestId('dock-full-view');
    const mBtn = shellTile.getByTestId('shell-open-dock');
    const uBtn = placeholderTile.getByTestId('shell-open-dock');

    // Closed state: both pills read EXPAND.
    await expect(mBtn).toContainText('EXPAND');
    await expect(mBtn).toHaveAttribute('data-expanded', 'false');

    // MIGRATED: expand → the pill flips to CLOSE; the OTHER tile stays EXPAND.
    await mBtn.click();
    await expect(faceplate).toBeVisible();
    await expect(mBtn).toContainText('CLOSE');
    await expect(mBtn).toHaveAttribute('data-expanded', 'true');
    await expect(uBtn).toContainText('EXPAND');
    // …CLOSE closes the full-view and flips back.
    await mBtn.click();
    await expect(faceplate).toHaveCount(0);
    await expect(mBtn).toContainText('EXPAND');
    await expect(mBtn).toHaveAttribute('data-expanded', 'false');

    // UN-MIGRATED placeholder: same toggle contract.
    await uBtn.click();
    await expect(faceplate).toBeVisible();
    await expect(uBtn).toContainText('CLOSE');
    await uBtn.click();
    await expect(faceplate).toHaveCount(0);
    await expect(uBtn).toContainText('EXPAND');
  });

  // FIX 2 (re-specced for the owner SPLIT extension) — expand migrated A,
  // then un-migrated B (its verbatim LEGACY card — a VIDEO card, i.e. one of
  // the 18 useStore()-at-init cards that crashed the old swap): A+B sit
  // SIDE-BY-SIDE.
  //
  // ⚠ B IS A VIDEO MODULE ON PURPOSE — the split has to hold across DOMAINS,
  // which is what makes this more than a repeat of the two-audio-tile case. It
  // was hard-coded to `backdraft`, then to a four-deep hand-picked list, then
  // to a derived pool of un-faced video modules; each of those rotted as the
  // video faces landed. It is named again now, and safely, because the property
  // it needed — "renders something other than what A renders" — is no longer a
  // property of any module: both panes are faceplates, and `backdraft` is
  // simply a video module with one.
  // Then migrated C: it replaces the least-recently-opened pane (A). ESC
  // closes the whole view. Every step is a REAL click on the lane pill; zero
  // pageerrors allowed (the crash class stays shut across pane mounts).
  // ⏸ FLAKE-PARK #1847 — parked with `test.fixme`; the body and its assertions are UNCHANGED.
  // NONDETERMINISM: 1 recovered-on-retry observation(s) across 1 SHA(s) / 1 branch(es) in the
  // 96 h CI census to 2026-08-18 — never a hard failure, so every one of those jobs reported SUCCESS.
  // LOST WHILE PARKED: the owner split extension — two side-by-side dock panes with LRU replacement, asserted across DOMAINS (an audio pane beside a video one).
  // Re-enable only on a root cause (#1847); "it passes now" is not one.
  test.fixme('expanding B while A is open SPLITS the dock; a third replaces the oldest — migrated AND legacy cards', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — nondeterministic on CI: 1 recovered-on-retry observation in the 96 h census to 2026-08-18; parked until root-caused' } }, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await gotoWorkflow(page);
    await spawnPatch(page, [
      { id: 'a1', type: 'tidyVco', position: { x: 30, y: 40 } }, // migrated
      { id: 'b1', type: 'backdraft', position: { x: 250, y: 40 } }, // video domain
      { id: 'c1', type: 'vca', position: { x: 470, y: 40 } }, // migrated
    ]);
    const tileA = page.locator('.svelte-flow__node[data-id="a1"] [data-testid="module-shell"]');
    const tileB = page.locator('.svelte-flow__node[data-id="b1"] [data-testid="module-shell"]');
    const tileC = page.locator('.svelte-flow__node[data-id="c1"] [data-testid="module-shell"]');
    await expect(tileA).toBeVisible();
    await expect(tileB).toBeVisible();
    await expect(tileC).toBeVisible();
    await panTileTo(page, 'a1', { top: 90 });

    const drawer = page.getByTestId('dock-fullview-drawer');
    const paneOf = (id: string) => page.locator(`[data-testid="dock-fullview-pane"][data-pane-node="${id}"]`);

    // Expand A (migrated) → one full-width pane with its curated dock face.
    await tileA.getByTestId('shell-open-dock').click();
    await expect(drawer).toHaveAttribute('data-pane-count', '1');
    await expect(paneOf('a1').locator('[data-testid="module-shell"][data-shell-tier="dock"]')).toBeVisible();

    // Expand B (video) while A is open → SIDE-BY-SIDE: both panes hold their
    // own dock faceplate; both pills read CLOSE.
    await tileB.getByTestId('shell-open-dock').click();
    await expect(drawer).toHaveAttribute('data-pane-count', '2');
    await expect(paneOf('a1').locator('[data-testid="module-shell"][data-shell-tier="dock"]')).toBeVisible();
    await expect(paneOf('b1').locator('[data-testid="module-shell"][data-shell-tier="dock"]')).toBeVisible();
    await expect(tileA.getByTestId('shell-open-dock')).toContainText('CLOSE');
    await expect(tileB.getByTestId('shell-open-dock')).toContainText('CLOSE');

    // Expand C (migrated) while A+B are open → C replaces the LEAST-RECENTLY-
    // OPENED pane (A); B stays; A's pill returns to EXPAND.
    await tileC.getByTestId('shell-open-dock').click();
    await expect(drawer).toHaveAttribute('data-pane-count', '2');
    await expect(paneOf('a1')).toHaveCount(0);
    await expect(paneOf('b1').locator('[data-testid="module-shell"][data-shell-tier="dock"]')).toBeVisible();
    await expect(paneOf('c1').locator('[data-testid="module-shell"][data-shell-tier="dock"]')).toBeVisible();
    await expect(tileA.getByTestId('shell-open-dock')).toContainText('EXPAND');
    await expect(tileC.getByTestId('shell-open-dock')).toContainText('CLOSE');

    // ESC closes the WHOLE view; every pill reads EXPAND again.
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(tileB.getByTestId('shell-open-dock')).toContainText('EXPAND');
    await expect(tileC.getByTestId('shell-open-dock')).toContainText('EXPAND');

    // The crash class stays shut: no useStore-outside-provider throw, no
    // torn-flush TypeError loop.
    expect(errors, `pageerrors during the split flow: ${errors.join(' | ')}`).toEqual([]);
  });

  // FIX 3 — the drill-down anchors ADJACENT to the invoking tile: beside its
  // right edge normally, flipping to the left side at the right screen edge —
  // never at a far-away/stale position (pre-fix: the viewport origin).
  // ⏸ FLAKE-PARK #1847 — parked with `test.fixme`; the body and its assertions are UNCHANGED.
  // NONDETERMINISM: 2 recovered-on-retry observation(s) across 1 SHA(s) / 1 branch(es) in the
  // 96 h CI census to 2026-08-18 — never a hard failure, so every one of those jobs reported SUCCESS.
  // LOST WHILE PARKED: that the patch drill-down opens adjacent to its tile at BOTH screen edges — the same off-screen-menu class as the patch-panel edge alignment, in the dock.
  // Re-enable only on a root cause (#1847); "it passes now" is not one.
  test.fixme('patch drill-down opens adjacent to the tile at BOTH screen edges', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — nondeterministic on CI: 2 recovered-on-retry observations in the 96 h census to 2026-08-18; parked until root-caused' } }, async ({ page }) => {
    await gotoWorkflow(page);
    await spawnPatch(page, [{ id: 'p1', type: 'vca', position: { x: 30, y: 40 } }]);
    const tile = page.locator('.svelte-flow__node[data-id="p1"] [data-testid="module-shell"]');
    await expect(tile).toBeVisible();

    const GAP = 8; // computeAdjacentRect default
    const vw = page.viewportSize()!.width;
    // Clear of the workflow left/right dock rails (they'd intercept the
    // click) while still exercising both anchor sides.
    const EDGE_INSET = 90;

    // (a) Tile near the LEFT screen edge → the menu opens on its RIGHT side.
    await panTileTo(page, 'p1', { top: 120, left: EDGE_INSET });
    await tile.getByTestId('patch-trigger').click();
    const menu = page.getByTestId('patch-panel');
    await expect(menu).toBeVisible();
    let tileBox = (await tile.boundingBox())!;
    let menuBox = (await menu.boundingBox())!;
    expect(
      Math.abs(menuBox.x - (tileBox.x + tileBox.width + GAP)),
      'menu left edge sits ~GAP right of the tile',
    ).toBeLessThanOrEqual(3);
    expect(Math.abs(menuBox.y - tileBox.y), 'menu top-aligns with the tile').toBeLessThanOrEqual(8);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    // (b) Tile near the RIGHT screen edge → no room on the right (the 280px
    //     menu can't fit in the inset), the menu FLIPS to the tile's LEFT
    //     side and stays fully on-screen.
    await panTileTo(page, 'p1', { top: 120 });
    const w = (await tile.boundingBox())!.width;
    await panTileTo(page, 'p1', { left: vw - w - EDGE_INSET });
    await tile.getByTestId('patch-trigger').click();
    await expect(menu).toBeVisible();
    tileBox = (await tile.boundingBox())!;
    menuBox = (await menu.boundingBox())!;
    expect(
      Math.abs(menuBox.x + menuBox.width - (tileBox.x - GAP)),
      'menu right edge sits ~GAP left of the tile (flipped)',
    ).toBeLessThanOrEqual(3);
    expect(Math.abs(menuBox.y - tileBox.y), 'menu top-aligns with the tile').toBeLessThanOrEqual(8);
    expect(menuBox.x, 'menu fully on-screen (left)').toBeGreaterThanOrEqual(0);
    expect(menuBox.x + menuBox.width, 'menu fully on-screen (right)').toBeLessThanOrEqual(vw + 0.5);
    await page.keyboard.press('Escape');
  });

  // FIX 3 (dock seam), SUPERSEDED — see the header note. The dock full-view's
  // migrated shell no longer renders a lane rail at all, so there is no
  // drill-down to anchor there. This is the replacement gate: the DUPLICATE
  // patch surface is gone, and the dock's REAL one (the RearCard on flip) still
  // carries every declared hole — i.e. the removal cost the user nothing.
  // ⏸ FLAKE-PARK #1847 — parked with `test.fixme`; the body and its assertions are UNCHANGED.
  // NONDETERMINISM: 1 recovered-on-retry observation(s) across 1 SHA(s) / 1 branch(es) in the
  // 96 h CI census to 2026-08-18 — never a hard failure, so every one of those jobs reported SUCCESS.
  // LOST WHILE PARKED: the dock full-view's structural contract — no lane rail, and the REAR card is the patch surface; a stray rail here is the layout regression class that also moves VRT baselines.
  // Re-enable only on a root cause (#1847); "it passes now" is not one.
  test.fixme('the dock full-view shell renders NO lane rail; the rear card is its patch surface', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — nondeterministic on CI: 1 recovered-on-retry observation in the 96 h census to 2026-08-18; parked until root-caused' } }, async ({ page }) => {
    await gotoWorkflow(page);
    await spawnPatch(page, [{ id: 'm1', type: 'vca', position: { x: 30, y: 40 } }]);
    const tile = page.locator('.svelte-flow__node[data-id="m1"] [data-testid="module-shell"]');
    await expect(tile).toBeVisible();
    // The LANE tile keeps its rail — that is where the drill-down belongs.
    await expect(tile.getByTestId('lane-jack-rail'), 'lane tile keeps its rail').toBeVisible();

    await panTileTo(page, 'm1', { top: 90 });
    await tile.getByTestId('shell-open-dock').click();

    const faceplate = page.getByTestId('dock-full-view');
    await expect(faceplate).toBeVisible();
    const dockShell = faceplate.locator('[data-testid="module-shell"][data-shell-tier="dock"]');
    await expect(dockShell).toBeVisible();

    // NO duplicate rail on the faceplate: no jack dots, no second drill-down
    // trigger, and no "▶ out" flow label the title bar already prints.
    await expect(dockShell.getByTestId('lane-jack-rail'), 'no duplicate rail in the dock').toHaveCount(0);
    await expect(dockShell.getByTestId('patch-trigger'), 'no duplicate drill-down trigger').toHaveCount(0);

    // …because the dock's patch surface is the REAR CARD. The flip key reaches it and
    // it carries EVERY declared port (vca: audio + cv in, audio + audio_inv
    // out), so nothing patchable was lost with the rail.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await pressFlipKey(page);
    await expect(faceplate).toHaveAttribute('data-flipped', 'true');
    const rear = faceplate.getByTestId('rear-card');
    await expect(rear).toBeVisible();
    await expect(rear.locator('[data-testid="back-jack"]'), 'every declared vca port is a hole').toHaveCount(4);
    await pressFlipKey(page);
    await expect(faceplate).toHaveAttribute('data-flipped', 'false');
  });
});
