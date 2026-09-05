// e2e/tests/workflow-dock-occupancy.spec.ts
//
// DOCK UNIFICATION — ONE bottom-drawer occupant (owner design call): the
// pinned M/E drawer and the expanded module full-view share a single
// bottom-drawer slot — pinned XOR full-view, never both stacked.
//
// The original owner bug: pressing `c` while the full-view was open opened the
// clip launcher BEHIND the faceplate (two independent bottom overlays, z-31
// over z-30 — unusable). Fixed at BOTH layers:
//   * dockStore models one bottom occupancy — openFullView() closes the
//     pinned occupant; toggle('bottom', …) closes the full-view and OPENS the
//     requested pinned drawer (replace, not stack);
//   * Canvas renders the two from one {#if}/{:else} container, so the
//     exclusivity is STRUCTURAL — the elements can never coexist in the DOM.
//
// SPLIT EXTENSION (owner): the full-view holds up to TWO modules SIDE-BY-SIDE
// (50/50), each pane its own overflow container (independent scroll, both
// axes); closing one pane returns the survivor to full width; `m`/`e`
// close the ENTIRE split; the flip key is the rear-card flip seam.
//
// >>> THE BUILT-IN CLIP PLAYER IS A DOCK PANE (owner 2026-07-26) <<<
// "need to be able to have clip player (built in) open along side a module in
// drawer. we can use our side by side view, opening clip player with c is same
// as expanding any other module." This SUPERSEDES the mutual exclusion for the
// clip player specifically: `c` now routes through
// dockStore.toggleFullView('pinned-clipplayer'), so the clip player is an
// ordinary full-view PANE — backed by the REAL pinned node, with the same
// faceplate frame, the same per-pane ✕, the same LRU third-expand replacement
// and the same flip key. Only `m` / `e` still take the exclusive-drawer branch.
//
// Contracts pinned here:
//   1. `c` toggles the clip-player PANE (closed → open, open → closed) and
//      never stacks two panes for it;
//   2. module full-view open → `c` → SIDE-BY-SIDE 50/50, BOTH interactable
//      (real clicks land in each), and the mirror image (EXPAND beside an open
//      clip player);
//   3. `m` / `e` still REPLACE the whole full-view with their pinned drawer;
//   4. ESC closes whichever occupant is open (the full-view as a WHOLE);
//   5. per-pane ✕ closes ONLY the clip player's pane; `c` at capacity
//      replaces the least-recently-opened pane (the shared LRU policy);
//   6. the flip key flips BOTH panes together — the clip player pane shows its
//      def-driven REAR jack field like any other un-migrated occupant;
//   7. A+B split 50/50 with independent pane scroll; pane ✕ → survivor full
//      width; `m` swaps out the whole split; the flip key toggles the flip attr;
//   8. the `c` behavior is IDENTICAL with the `?shell=1` preview flag OFF
//      (the dock full-view was never flag-gated — see the
//      shell-flag-not-a-complete-gate finding), while `m`/`e` stay the shipped
//      drawer toggles there.
//
// Runs on /rack (no DB/relay) — same lane as
// workflow-shell.spec.ts / workflow-dock-ux.spec.ts.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { pressFlipKey } from './_flip-key';
import { installRenderSmokeHooks } from './_render-smoke';
import { settle } from '../_helpers/frames';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

// ⚠ THE PER-TEST BUDGET IS A BOUND, AND IT WAS THE INVISIBLE 30 s DEFAULT.
//
// This file bounds its boot waits with `BOOT_MS` — 30 000 on CI, IDENTICAL to
// the 30 000 default budget they were running inside. 3 sites, 1.00x.
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

/** The pinned trio's deterministic node ids (graph/workflow-pins.ts). */
const PINNED_IDS = ['pinned-mixmstrs', 'pinned-electraControl', 'pinned-clipplayer'] as const;

/** Wait until the workflow ensure effect has written the pinned trio (the
 *  dock keymap only toggles once the pinned node exists). */
async function waitForPinnedTrio(page: Page): Promise<void> {
  await page.waitForFunction(
    (ids) => {
      const w = globalThis as unknown as {
        __patch?: { nodes: Record<string, { data?: { pinned?: boolean } } | undefined> };
      };
      if (!w.__patch) return false;
      return ids.every((id) => w.__patch!.nodes[id]?.data?.pinned === true);
    },
    PINNED_IDS as unknown as string[],
    { timeout: BOOT_MS },
  );
}

async function gotoShellWorkflow(page: Page): Promise<void> {
  await page.goto('/rack');
  // First-load budget (the workflow-shell.spec.ts pattern): on a COLD dev
  // server the very first /rack compile can exceed the 5s expect default —
  // reproduced locally with a cleared .vite cache; every later load is ~1s.
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
  await waitForPinnedTrio(page);
}

/** Pan the viewport so node `id`'s tile lands near screen-top — the lane tile
 *  must sit ABOVE the bottom drawer so real clicks land on it while a drawer /
 *  full-view is open (the workflow-dock-ux pattern). */
async function panTileTo(page: Page, id: string, top: number): Promise<void> {
  await page.evaluate(
    ({ id, top }) => {
      const f = (globalThis as unknown as { __flow: { getViewport: () => { x: number; y: number; zoom: number }; setViewport: (v: { x: number; y: number; zoom: number }, o?: { duration: number }) => void } }).__flow;
      const el = document.querySelector(`.svelte-flow__node[data-id="${id}"]`);
      if (!el || !f) return;
      const r = el.getBoundingClientRect();
      const vp = f.getViewport();
      f.setViewport({ x: vp.x, y: vp.y - (r.top - top), zoom: vp.zoom }, { duration: 0 });
    },
    { id, top },
  );
  // `duration: 0` makes the pan instant IN THE STORE; the real clicks below
  // need the new transform PAINTED, which is a frame count, not a duration —
  // 120 ms was ~7 frames locally and under one on CI's SwiftShader (7.9 fps
  // measured). Two rAFs is Svelte-flush + paint.
  await settle(page);
}

/** The clip player's deterministic pinned node id — the pane's backing node. */
const CLIP_ID = 'pinned-clipplayer';

// ⚠ `dx7` IS THE WIDE SUBJECT, AND IT IS LOAD-BEARING (#1796). Any test below
// that asserts a pane SCROLLS sideways needs a pane whose content genuinely
// exceeds a half-width pane. Until the plate became content-sized, every
// curated face got that for free from a defect — `.faceplate-body` forced all
// of them to 900 px, so even `vca` (measured 247 px of real content)
// overflowed. Now they fit, and an assertion written against the old default
// passes vacuously or fails outright. dx7 is the widest face in the roster
// (measured 1139 px of content), so its overflow is a property of the module
// rather than of a layout bug.
const WIDE_FACE = 'dx7';

/** A full-view pane by its backing node id (module OR the clip player). */
const paneFor = (page: Page, id: string) =>
  page.locator(`[data-testid="dock-fullview-pane"][data-pane-node="${id}"]`);

/**
 * Open the CLIP PLAYER pane's `playback` page — where `snh` lives.
 *
 * ⚠ WHY THIS EXISTS. This file uses `control-snh` as its "a real control in the
 * clip pane is live" witness, and the clip player's face became TAB RAILED on
 * 2026-09-04 (owner P0 — the launch grid and the piano roll are two VIEWS, so a
 * double-clicked pad REPLACES the grid; `face.tabbed` is what hides a band).
 * `snh` is on the fourth of the four pages, so the witness is in the DOM and
 * out of view until its page is asked for.
 *
 * The tab click is not scaffolding around the assertion, it is part of it: a
 * pane that could not switch page fails HERE, on the chip, instead of
 * confusingly on the control.
 */
async function openClipPlaybackPage(page: Page, id: string): Promise<void> {
  const tab = paneFor(page, id).getByTestId('faceplate-tab-playback');
  await tab.click();
  await expect(tab, 'the clip pane switches to its playback page').toHaveAttribute(
    'aria-selected',
    'true',
  );
}

/** Spawn one migrated module and return its shell tile + EXPAND pill.
 *  spawnPatch WIPES the rack, so the workflow ensure re-spawns the pinned
 *  trio — re-wait for it before any hotkey (the keymap is inert until the
 *  pinned node exists). */
async function spawnExpandableTile(page: Page) {
  await spawnPatch(page, [{ id: 'm1', type: WIDE_FACE, position: { x: 30, y: 40 } }]);
  const tile = page.locator('.svelte-flow__node[data-id="m1"] [data-testid="module-shell"]');
  await expect(tile).toBeVisible();
  await waitForPinnedTrio(page);
  await panTileTo(page, 'm1', 90);
  return { tile, pill: tile.getByTestId('shell-open-dock') };
}

test.describe('bottom-drawer occupancy: pinned XOR full-view (?shell=1)', () => {
  test.beforeEach(async ({ page }) => {
    await installRenderSmokeHooks(page);
  });

  // (1) `c` IS EXPAND: one press opens the clip player's own pane, a second
  // closes it, and two presses never stack two panes for it.
  test('`c` TOGGLES the clip player pane — open, close, never two panes', async ({ page }) => {
    await gotoShellWorkflow(page);
    const drawer = page.getByTestId('dock-fullview-drawer');

    // Closed → open, as a full-view pane (the SAME frame a module gets).
    await page.keyboard.press('c');
    await expect(drawer).toHaveAttribute('data-pane-count', '1');
    await expect(paneFor(page, CLIP_ID)).toBeVisible();
    await expect(paneFor(page, CLIP_ID).getByTestId('dock-full-view')).toHaveAttribute(
      'data-fullview-node',
      CLIP_ID,
    );
    // The pinned M/E drawer is NOT what opened (the superseded path).
    await expect(page.getByTestId('dock-zone-bottom')).toHaveCount(0);

    // Open → closed.
    await page.keyboard.press('c');
    await expect(drawer).toHaveCount(0);

    // …and re-opening still yields exactly ONE pane for it.
    await page.keyboard.press('c');
    await expect(drawer).toHaveAttribute('data-pane-count', '1');
    await expect(paneFor(page, CLIP_ID)).toHaveCount(1);
  });

  // (2) THE OWNER REQUEST: clip player BESIDE a module, both live. Asserted on
  // SCREEN GEOMETRY (not just state) and with REAL clicks in both panes.
  test('`c` while a module full-view is open sits BESIDE it 50/50 — both INTERACTABLE', async ({ page }) => {
    await gotoShellWorkflow(page);
    const { pill } = await spawnExpandableTile(page);
    const drawer = page.getByTestId('dock-fullview-drawer');

    await pill.click();
    await expect(drawer).toHaveAttribute('data-pane-count', '1');
    await expect(pill).toContainText('CLOSE');

    await page.keyboard.press('c');
    // BOTH panes live — the module pane SURVIVES (this is the whole ask).
    await expect(drawer).toHaveAttribute('data-pane-count', '2');
    await expect(paneFor(page, 'm1')).toBeVisible();
    await expect(paneFor(page, CLIP_ID)).toBeVisible();
    // The module's pill still reads CLOSE — it was NOT evicted.
    await expect(pill).toContainText('CLOSE');
    await expect(pill).toHaveAttribute('data-expanded', 'true');
    // No pinned drawer anywhere.
    await expect(page.getByTestId('dock-zone-bottom')).toHaveCount(0);

    // SCREEN GEOMETRY: module (opened first) LEFT, clip player RIGHT, ordered,
    // gapped, and both inside the drawer.
    //
    // #1573 CHANGED THIS CONTRACT. Panes used to divide the viewport (`flex: 1 1 0`),
    // so any two panes were equal and together filled the drawer. They now size to
    // their CONTENT, because a ~300px card sitting in a ~1200px tray was hiding the
    // canvas behind empty chrome. A module face (900px kit) and the clip player have
    // genuinely different content widths, so equality is no longer a property of the
    // layout — asserting it would be asserting the bug.
    //
    // What survives is what the test was really protecting: ORDER, a real GAP, and
    // both panes fitting on screen. Sibling test "A+B sit SIDE-BY-SIDE 50/50" still
    // asserts equality for two panes of the SAME kit width, which is where equality
    // is still meaningful.
    const a = (await paneFor(page, 'm1').boundingBox())!;
    const b = (await paneFor(page, CLIP_ID).boundingBox())!;
    const d = (await drawer.boundingBox())!;
    expect(a.x, 'module renders LEFT of the clip player (open order)').toBeLessThan(b.x);
    const GAP = b.x - (a.x + a.width);
    expect(GAP).toBeGreaterThanOrEqual(4);
    expect(GAP).toBeLessThanOrEqual(16);
    expect(
      a.width + b.width + GAP + 16,
      '2 panes + gap + padding fit INSIDE the drawer (they no longer have to fill it)',
    ).toBeLessThanOrEqual(d.width + 4);
    expect(a.width, 'each pane still has real width').toBeGreaterThan(0);
    expect(b.width).toBeGreaterThan(0);

    // INDEPENDENT SCROLL: each pane owns its overflow container.
    //
    // ⚠ THE SCROLLED PANE IS THE MODULE, NOT THE CLIP PLAYER — it was the other
    // way round, and the swap is the point. The clip pane used to overflow
    // because the MODULE pane hogged 900 px of the drawer and squeezed it; with
    // the plate content-sized (#1796) the module takes what it needs, the clip
    // pane gets more room, and it simply fits. Asserting overflow there now
    // asserts a defect. dx7 overflows a half-width pane on its own merits, so
    // the independence claim is exercised against real travel either way.
    const wideScroll = paneFor(page, 'm1').locator('.faceplate-scroll');
    const scrolled = await wideScroll.evaluate((el) => {
      el.scrollLeft = 120;
      return { scrollable: el.scrollWidth > el.clientWidth, scrollLeft: el.scrollLeft };
    });
    expect(scrolled.scrollable, 'half-width module pane has sideways overflow').toBe(true);
    expect(scrolled.scrollLeft, 'module pane scrolled').toBeGreaterThan(0);
    expect(
      await paneFor(page, CLIP_ID)
        .locator('.faceplate-scroll')
        .evaluate((el) => ({ left: el.scrollLeft, top: el.scrollTop })),
      'clip pane unmoved',
    ).toEqual({ left: 0, top: 0 });

    // BOTH INTERACTABLE: a real click lands in the clip player pane (its S&H
    // switch reports state) AND in the module pane (the vca shell).
    //
    // ⚠ `control-snh` AND `aria-checked`, BOTH BECAUSE OF THE PROMOTION. This
    // pane used to paint the legacy card, whose S&H was a toggle BUTTON
    // (`clipplayer-snh-toggle`, `aria-pressed`). `snh` is a ranked PARAM on the
    // face, so it renders as the shared shell control — `control-snh`, the
    // testid `faces-parity` asserts against the def — and that control is a
    // `role="switch"`, whose state attribute is `aria-checked`. Not a
    // workaround: `aria-pressed` belongs to a toggle button and `aria-checked`
    // to a switch, so the faceplate is the more correct of the two.
    // …and its page has to be OPEN — this face is tab-railed (see
    // `openClipPlaybackPage`), which is itself a second interaction in the pane.
    await openClipPlaybackPage(page, CLIP_ID);
    const snh = paneFor(page, CLIP_ID).getByTestId('control-snh');
    await expect(snh).toBeVisible();
    const before = await snh.getAttribute('aria-checked');
    await snh.click();
    await expect(snh).toHaveAttribute('aria-checked', before === 'true' ? 'false' : 'true');
    await expect(paneFor(page, 'm1').getByTestId('faceplate-editor')).toBeVisible();
  });

  // (2b) The mirror image: EXPAND a module while the clip player pane is open
  // → they sit side-by-side too (order reversed).
  test('EXPAND while the clip player pane is open joins it (clip LEFT, module RIGHT)', async ({ page }) => {
    await gotoShellWorkflow(page);
    const { pill } = await spawnExpandableTile(page);
    const drawer = page.getByTestId('dock-fullview-drawer');

    await page.keyboard.press('c');
    await expect(drawer).toHaveAttribute('data-pane-count', '1');

    await pill.click();
    await expect(drawer).toHaveAttribute('data-pane-count', '2');
    await expect(pill).toContainText('CLOSE');
    await expect(pill).toHaveAttribute('data-expanded', 'true');
    const clip = (await paneFor(page, CLIP_ID).boundingBox())!;
    const mod = (await paneFor(page, 'm1').boundingBox())!;
    expect(clip.x, 'clip player opened FIRST → renders left').toBeLessThan(mod.x);
    // #1573: panes size to content, so a clip player and a module face are no longer
    // equal by construction. Order is the property this test is about.
    expect(clip.width, 'clip pane has real width').toBeGreaterThan(0);
    expect(mod.width, 'module pane has real width').toBeGreaterThan(0);
  });

  // (2c) Per-pane ✕ closes ONLY the clip player's pane; the module survives
  // (the shared per-pane close, unchanged). Since #1573 the survivor keeps its
  // CONTENT width rather than stretching to the drawer.
  test("the clip pane's own ✕ closes only IT — the module survives", async ({ page }) => {
    await gotoShellWorkflow(page);
    const { pill } = await spawnExpandableTile(page);
    const drawer = page.getByTestId('dock-fullview-drawer');

    await pill.click();
    await page.keyboard.press('c');
    await expect(drawer).toHaveAttribute('data-pane-count', '2');

    await paneFor(page, CLIP_ID).getByTestId('faceplate-close').click();
    await expect(drawer).toHaveAttribute('data-pane-count', '1');
    await expect(paneFor(page, CLIP_ID)).toHaveCount(0);
    await expect(paneFor(page, 'm1')).toBeVisible();
    const m = (await paneFor(page, 'm1').boundingBox())!;
    const d = (await drawer.boundingBox())!;
    // #1573: the survivor keeps its CONTENT width instead of stretching to the
    // drawer. Expanding to full width is precisely the behaviour the owner asked us
    // to remove ("the tray should not take up more horizontal space than it needs"),
    // so the old assertion now encodes the bug. What matters is that the survivor is
    // still laid out inside the drawer with real width.
    expect(m.width, 'survivor still has real width').toBeGreaterThan(0);
    expect(m.width + 16, 'survivor fits inside the drawer').toBeLessThanOrEqual(d.width + 4);
    expect(m.x, 'survivor starts inside the drawer').toBeGreaterThanOrEqual(d.x - 1);
    await expect(pill).toContainText('CLOSE');
    // …and `c` re-opens it beside the survivor.
    await page.keyboard.press('c');
    await expect(drawer).toHaveAttribute('data-pane-count', '2');
  });

  // (3) `m` / `e` follow the same replace pattern — and the shipped
  // drawer-to-drawer replacement between them still works.
  test('`m` and `e` replace the full-view the same way (and each other)', async ({ page }) => {
    await gotoShellWorkflow(page);
    const { pill } = await spawnExpandableTile(page);
    const faceplate = page.getByTestId('dock-full-view');
    const drawer = page.getByTestId('dock-zone-bottom');

    // m replaces the full-view with the mixer drawer.
    await pill.click();
    await expect(faceplate).toBeVisible();
    await page.keyboard.press('m');
    await expect(faceplate).toHaveCount(0);
    await expect(drawer).toHaveAttribute('data-dock-type', 'mixmstrs');

    // e replaces m (shipped one-at-a-time drawer semantics, unchanged).
    await page.keyboard.press('e');
    await expect(drawer).toHaveCount(1);
    await expect(drawer).toHaveAttribute('data-dock-type', 'electraControl');

    // EXPAND replaces the e drawer with the full-view again…
    await pill.click();
    await expect(drawer).toHaveCount(0);
    await expect(faceplate).toBeVisible();

    // …and e replaces the full-view.
    await page.keyboard.press('e');
    await expect(faceplate).toHaveCount(0);
    await expect(drawer).toHaveAttribute('data-dock-type', 'electraControl');
  });

  // (4) ESC closes whichever occupant is open — INCLUDING the split that holds
  // the clip player (the whole view goes, both panes).
  test('ESC closes the current occupant — full-view (incl. the clip pane) or pinned drawer', async ({ page }) => {
    await gotoShellWorkflow(page);
    const { pill } = await spawnExpandableTile(page);
    const faceplate = page.getByTestId('dock-full-view');
    const drawer = page.getByTestId('dock-zone-bottom');

    // Full-view open → ESC closes it; nothing else opens behind it.
    await pill.click();
    await expect(faceplate).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(faceplate).toHaveCount(0);
    await expect(drawer).toHaveCount(0);
    await expect(pill).toContainText('EXPAND');

    // Module + clip player split → ESC closes BOTH panes.
    await pill.click();
    await page.keyboard.press('c');
    await expect(page.getByTestId('dock-fullview-drawer')).toHaveAttribute('data-pane-count', '2');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('dock-fullview-drawer')).toHaveCount(0);
    await expect(drawer).toHaveCount(0);

    // Pinned M drawer open → ESC closes it (unchanged).
    await page.keyboard.press('m');
    await expect(drawer).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
  });

  // (4b) TYPING GUARD: `c` must stay inert in a text-entry context — the SAME
  // isTypingTarget guard the M/E drawer keys use. Typing a `c` into a module's
  // name box must not fling the clip player open.
  test('`c` is INERT while typing in an input / contenteditable', async ({ page }) => {
    await gotoShellWorkflow(page);
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.id = 'clip-typing-probe';
      document.body.appendChild(input);
      const ce = document.createElement('div');
      ce.id = 'clip-ce-probe';
      ce.contentEditable = 'true';
      ce.textContent = 'edit me';
      document.body.appendChild(ce);
    });

    await page.locator('#clip-typing-probe').click();
    await page.keyboard.type('clip');
    await expect(page.locator('#clip-typing-probe')).toHaveValue('clip');
    await expect(page.getByTestId('dock-fullview-drawer')).toHaveCount(0);

    await page.locator('#clip-ce-probe').click();
    await page.keyboard.type('c');
    await expect(page.getByTestId('dock-fullview-drawer')).toHaveCount(0);

    // Positive control: the same key on the canvas DOES open the pane, so the
    // assertions above are about the guard and not a dead hotkey.
    await page.locator('.svelte-flow__pane:visible').first().click({ position: { x: 500, y: 120 } });
    await page.keyboard.press('c');
    await expect(page.getByTestId('dock-fullview-drawer')).toHaveAttribute('data-pane-count', '1');
  });
});

// (6) THE SPLIT (owner extension): two side-by-side 50/50 panes, independent
// scroll, per-pane close, whole-split swap-out, and the flip-key seam.
test.describe('full-view SPLIT: two panes, one drawer occupant (?shell=1)', () => {
  test.beforeEach(async ({ page }) => {
    await installRenderSmokeHooks(page);
  });

  /** Spawn TWO migrated modules and return their tiles' EXPAND pills. */
  async function spawnTwoTiles(page: Page) {
    await spawnPatch(page, [
      // ⚠ BOTH PANES ARE THE SAME FACE, and that is what makes the 50/50
      // claim mean anything (#1796). Panes are content-sized now, so two
      // DIFFERENT faces are naturally different widths — measured vca 247 px
      // against dx7 1139 px, a 734 px gap — and asserting equality across them
      // would be asserting the old `min-width: 900px` defect that made every
      // face the same size. The sibling test already says this in prose:
      // "equality is no longer a property of the layout — asserting it would be
      // asserting the bug". Two instances of the WIDE face give equality AND
      // the real horizontal travel the independent-scroll leg needs.
      { id: 'm1', type: WIDE_FACE, position: { x: 30, y: 40 } },
      { id: 'm2', type: WIDE_FACE, position: { x: 250, y: 40 } },
    ]);
    const tile1 = page.locator('.svelte-flow__node[data-id="m1"] [data-testid="module-shell"]');
    const tile2 = page.locator('.svelte-flow__node[data-id="m2"] [data-testid="module-shell"]');
    await expect(tile1).toBeVisible();
    await expect(tile2).toBeVisible();
    await waitForPinnedTrio(page); // spawnPatch wiped the rack; ensure re-spawns
    await panTileTo(page, 'm1', 90);
    return { pill1: tile1.getByTestId('shell-open-dock'), pill2: tile2.getByTestId('shell-open-dock') };
  }

  test('A+B sit SIDE-BY-SIDE 50/50; each pane scrolls INDEPENDENTLY', async ({ page }) => {
    await gotoShellWorkflow(page);
    const { pill1, pill2 } = await spawnTwoTiles(page);
    const drawer = page.getByTestId('dock-fullview-drawer');

    await pill1.click();
    await expect(drawer).toHaveAttribute('data-pane-count', '1');
    await pill2.click();
    await expect(drawer).toHaveAttribute('data-pane-count', '2');
    await expect(pill1).toContainText('CLOSE');
    await expect(pill2).toContainText('CLOSE');

    // 50/50 GEOMETRY: A (opened first) left, B right; equal widths; the two
    // panes + the 8px gap fill the drawer's inner width.
    const a = (await paneFor(page, 'm1').boundingBox())!;
    const b = (await paneFor(page, 'm2').boundingBox())!;
    const d = (await drawer.boundingBox())!;
    expect(a.x, 'A renders LEFT of B (open order)').toBeLessThan(b.x);
    expect(Math.abs(a.width - b.width), 'panes split 50/50').toBeLessThanOrEqual(2);
    const GAP = b.x - (a.x + a.width);
    expect(GAP, 'the split gap sits between the panes').toBeGreaterThanOrEqual(4);
    expect(GAP).toBeLessThanOrEqual(16);
    // container padding (8px sides) + gap accounts for the leftover width
    expect(Math.abs(d.width - (a.width + b.width + GAP + 16)), '2 panes + gap + padding = drawer').toBeLessThanOrEqual(4);

    // INDEPENDENT SCROLL: each pane's .faceplate-scroll is its OWN overflow
    // container on BOTH axes.
    //
    // ⚠ THE HORIZONTAL TRAVEL IS NOW A PROPERTY OF THE MODULE, NOT OF THE KIT.
    // This comment used to read "the kit faceplate's 900px min-width guarantees
    // horizontal travel in a half-width pane" — which was true and was the
    // defect: every face was padded to 900 px whether it needed it or not
    // (#1796). Pane B is the widest face in the roster so the travel is real;
    // pane A is a narrow one that legitimately does NOT scroll, which is why
    // only B is scrolled below.
    const scrollBoxes = page.locator('[data-testid="dock-fullview-pane"] .faceplate-scroll');
    await expect(scrollBoxes).toHaveCount(2);
    const overflow = await scrollBoxes.first().evaluate((el) => {
      const cs = getComputedStyle(el);
      return { x: cs.overflowX, y: cs.overflowY };
    });
    expect(overflow, 'pane scroll container overflows on both axes').toEqual({ x: 'auto', y: 'auto' });
    // Scroll pane B sideways → B moves, A stays put (no shared scrollbar).
    const scrolled = await paneFor(page, 'm2')
      .locator('.faceplate-scroll')
      .evaluate((el) => {
        el.scrollLeft = 150;
        return { scrollable: el.scrollWidth > el.clientWidth, scrollLeft: el.scrollLeft };
      });
    expect(scrolled.scrollable, 'half-width pane has sideways overflow to scroll').toBe(true);
    expect(scrolled.scrollLeft, 'pane B scrolled').toBeGreaterThan(0);
    const aScroll = await paneFor(page, 'm1')
      .locator('.faceplate-scroll')
      .evaluate((el) => ({ left: el.scrollLeft, top: el.scrollTop }));
    expect(aScroll, 'pane A unmoved').toEqual({ left: 0, top: 0 });
  });

  test('closing ONE pane returns the survivor to full width', async ({ page }) => {
    await gotoShellWorkflow(page);
    const { pill1, pill2 } = await spawnTwoTiles(page);
    const drawer = page.getByTestId('dock-fullview-drawer');

    await pill1.click();
    await pill2.click();
    await expect(drawer).toHaveAttribute('data-pane-count', '2');

    // Close pane A via ITS ✕ — B remains, back at full drawer width.
    await paneFor(page, 'm1').getByTestId('faceplate-close').click();
    await expect(drawer).toHaveAttribute('data-pane-count', '1');
    await expect(paneFor(page, 'm1')).toHaveCount(0);
    await expect(paneFor(page, 'm2')).toBeVisible();
    const b = (await paneFor(page, 'm2').boundingBox())!;
    const d = (await drawer.boundingBox())!;
    // #1573: content-sized, so the survivor does NOT stretch back to full width.
    expect(b.width, 'survivor still has real width').toBeGreaterThan(0);
    expect(b.width + 16, 'survivor fits inside the drawer').toBeLessThanOrEqual(d.width + 4);
    // The pills track per-module presence.
    await expect(pill1).toContainText('EXPAND');
    await expect(pill2).toContainText('CLOSE');
  });

  test('`m` closes the ENTIRE split and opens the pinned drawer', async ({ page }) => {
    await gotoShellWorkflow(page);
    const { pill1, pill2 } = await spawnTwoTiles(page);
    const drawer = page.getByTestId('dock-fullview-drawer');

    await pill1.click();
    await pill2.click();
    await expect(drawer).toHaveAttribute('data-pane-count', '2');

    await page.keyboard.press('m');
    await expect(drawer).toHaveCount(0); // both panes gone — not one
    const pinned = page.getByTestId('dock-zone-bottom');
    await expect(pinned).toBeVisible();
    await expect(pinned).toHaveAttribute('data-dock-type', 'mixmstrs');
    await expect(pill1).toContainText('EXPAND');
    await expect(pill2).toContainText('EXPAND');
  });

  // `c` is EXPAND, so at capacity it follows the SHARED policy: replace the
  // LEAST-RECENTLY-OPENED pane (never a third pane, never a no-op).
  test('`c` with two modules open REPLACES the least-recently-opened pane', async ({ page }) => {
    await gotoShellWorkflow(page);
    const { pill1, pill2 } = await spawnTwoTiles(page);
    const drawer = page.getByTestId('dock-fullview-drawer');

    await pill1.click(); // m1 = least-recently-opened
    await pill2.click();
    await expect(drawer).toHaveAttribute('data-pane-count', '2');

    await page.keyboard.press('c');
    await expect(drawer).toHaveAttribute('data-pane-count', '2'); // still two, never three
    await expect(paneFor(page, 'm1')).toHaveCount(0); // LRU evicted
    await expect(paneFor(page, 'm2')).toBeVisible();
    await expect(paneFor(page, CLIP_ID)).toBeVisible();
    // m2 opened first of the survivors → renders LEFT of the clip player.
    const b = (await paneFor(page, 'm2').boundingBox())!;
    const c = (await paneFor(page, CLIP_ID).boundingBox())!;
    expect(b.x).toBeLessThan(c.x);
    await expect(pill1).toContainText('EXPAND');
    await expect(pill2).toContainText('CLOSE');
  });

  test('the flip key toggles the rear-card flip seam attr on the open view', async ({ page }) => {
    await gotoShellWorkflow(page);
    const { pill1, pill2 } = await spawnTwoTiles(page);
    const drawer = page.getByTestId('dock-fullview-drawer');

    await pill1.click();
    await expect(drawer).toHaveAttribute('data-fullview-flipped', 'false');
    await pressFlipKey(page);
    await expect(drawer).toHaveAttribute('data-fullview-flipped', 'true');
    // The flip is GLOBAL for the view: a second pane joins the flipped state.
    await pill2.click();
    await expect(drawer).toHaveAttribute('data-pane-count', '2');
    await expect(drawer).toHaveAttribute('data-fullview-flipped', 'true');
    await pressFlipKey(page);
    await expect(drawer).toHaveAttribute('data-fullview-flipped', 'false');
  });

  // FLIP DECISION (owner-facing): the clip player pane is backed by a REAL node
  // with a REAL def, so it takes the SAME un-migrated branch every other
  // un-migrated occupant takes — the flip key flips it to its def-driven RearCard jack
  // field alongside its sibling. No synthetic "stays front" carve-out.
  test('the flip key flips the CLIP PLAYER pane to its REAR jack field alongside the module', async ({ page }) => {
    await gotoShellWorkflow(page);
    const { pill1 } = await spawnTwoTiles(page);
    const drawer = page.getByTestId('dock-fullview-drawer');

    await pill1.click();
    await page.keyboard.press('c');
    await expect(drawer).toHaveAttribute('data-pane-count', '2');

    const clipFace = paneFor(page, CLIP_ID).getByTestId('dock-full-view');
    const modFace = paneFor(page, 'm1').getByTestId('dock-full-view');
    await expect(clipFace).toHaveAttribute('data-flipped', 'false');

    // ⚠ OPEN `snh`'s PAGE BEFORE THE FLIP, and the POSITIVE CONTROL is the
    // reason rather than tidiness. This leg's claim is "the FRONT controls go
    // away while flipped and come back after"; on a tab-railed face (this one,
    // since 2026-09-04) `control-snh` is hidden by its own rail until its page
    // is asked for, so a `toBeHidden` taken without this line would have been
    // green for the wrong reason and told us nothing about the flip at all.
    await openClipPlaybackPage(page, CLIP_ID);
    await expect(
      paneFor(page, CLIP_ID).getByTestId('control-snh'),
      'POSITIVE CONTROL: the front control is on screen BEFORE the flip',
    ).toBeVisible();

    await pressFlipKey(page);
    await expect(drawer).toHaveAttribute('data-fullview-flipped', 'true');
    // BOTH panes flipped — including the clip player.
    await expect(clipFace).toHaveAttribute('data-flipped', 'true');
    await expect(modFace).toHaveAttribute('data-flipped', 'true');
    // The clip pane shows the REAR chip + a real jack field with its ports…
    await expect(paneFor(page, CLIP_ID).getByTestId('rear-chip')).toBeVisible();
    const clipJacks = paneFor(page, CLIP_ID).getByTestId('back-jack');
    expect(await clipJacks.count(), 'clip player rear card renders its jacks').toBeGreaterThan(0);
    // …and its FRONT controls are gone while flipped.
    await expect(paneFor(page, CLIP_ID).getByTestId('control-snh')).toBeHidden();

    // Flip back → front controls return, no reboot of the occupant.
    await pressFlipKey(page);
    await expect(clipFace).toHaveAttribute('data-flipped', 'false');
    await expect(paneFor(page, CLIP_ID).getByTestId('control-snh')).toBeVisible();
  });
});

// (8) PREVIEW-OFF (?shell absent). `?shell=1` gates the LANE TILES, never the
// dock full-view (Canvas renders <DockFullView> off `migrated(type)` +
// fullViewNodeIds, with no shellPreview conjunction — the owner-confirmed
// shell-flag-not-a-complete-gate finding). So `c` = EXPAND is UNIFORM: the
// clip player opens as a dock pane with the flag off exactly as with it on,
// which is what "same as expanding any other module" has to mean. `m`/`e`
// remain the shipped drawer toggles here (the full sweep stays pinned in
// workflow-mode.spec.ts).
test.describe('bottom-drawer occupancy: preview-off M/E drawer + the same C pane', () => {
  test.beforeEach(async ({ page }) => {
    await installRenderSmokeHooks(page);
  });

  test('`c` opens the SAME clip pane flag-off; `m`/`e` still toggle the shipped drawer', async ({ page }) => {
    await page.goto('/rack');
    // Same first-load budget as gotoShellWorkflow (cold-compile latency).
    await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
    await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
    await waitForPinnedTrio(page);

    const drawer = page.getByTestId('dock-zone-bottom');
    const fullView = page.getByTestId('dock-fullview-drawer');

    // C → the clip player PANE (not the pinned drawer), flag or no flag.
    await page.keyboard.press('c');
    await expect(fullView).toHaveAttribute('data-pane-count', '1');
    await expect(paneFor(page, CLIP_ID)).toBeVisible();
    await expect(drawer).toHaveCount(0);
    // …and its real controls are live in the pane, one rail click away (this
    // face is tab-railed — see `openClipPlaybackPage`).
    await openClipPlaybackPage(page, CLIP_ID);
    await expect(paneFor(page, CLIP_ID).getByTestId('control-snh')).toBeVisible();

    // C again closes it.
    await page.keyboard.press('c');
    await expect(fullView).toHaveCount(0);

    // M/E: the shipped exclusive drawer, untouched.
    await page.keyboard.press('m');
    await expect(drawer).toHaveAttribute('data-dock-type', 'mixmstrs');
    await expect(fullView).toHaveCount(0);

    await page.keyboard.press('e');
    await expect(drawer).toHaveAttribute('data-dock-type', 'electraControl');

    await page.keyboard.press('e'); // same key toggles closed (shipped semantics)
    await expect(drawer).toHaveCount(0);
    await expect(fullView).toHaveCount(0);

    // And the handoff still works BOTH ways: C over an open M drawer replaces
    // it (one bottom occupant), M over the clip pane replaces that.
    await page.keyboard.press('m');
    await expect(drawer).toBeVisible();
    await page.keyboard.press('c');
    await expect(drawer).toHaveCount(0);
    await expect(fullView).toHaveAttribute('data-pane-count', '1');
    await page.keyboard.press('m');
    await expect(fullView).toHaveCount(0);
    await expect(drawer).toHaveAttribute('data-dock-type', 'mixmstrs');
  });
});
