// e2e/tests/timelorde-pinned-source.spec.ts
//
// THE PINNED ARM of the headless-source host — the sibling of #2148's full-view
// arm, on the only module that can reach it.
//
// ── THE DEFECT ──────────────────────────────────────────────────────────────
//
// `Canvas.svelte`'s headless-host derivation skipped every canvas-hidden node:
//
//     if (isCanvasHiddenNode(n)) continue;   // pinned singletons + hidden cameras
//
// The premise is that SOME OTHER surface mounts the real card, and for a PINNED
// drawer singleton that surface is the dock rail. `dockRailRendersFace` makes
// that premise FALSE the moment the module is promoted:
// `shellFaces && pinned && migrated` ⇒ the rail paints `<ModuleShell>` instead
// of the card. A pinned + card-owned-source + FACED module then mounts its
// producer card NOWHERE — no lane tile (canvas-hidden), no rail card (faced),
// no headless host (skipped above).
//
// ⚠ TIMELORDE IS THE ONLY MODULE THAT CAN REACH IT: the intersection of
// `CARD_PRODUCER_LANE_TYPES` (whose card pushes `write(node,'displayFrame')`)
// with the pinnable workflow trio is exactly {timelorde}. That is why this file
// is one module wide and why the fix is scoped to CARD_PRODUCER membership —
// hidden CAMERAS are the other canvas-hidden kind and are DOM_SOURCE, untouched.
//
// ⚠ AND THE FIX IS A PARITY RESTORATION, WHICH IS THE ARGUMENT THAT SETTLES IT.
// The skip's own stated reason is parity: canvas-hidden nodes "render no lane
// card in preview-off EITHER, so hosting them would ADD engine state the
// shell-off rack doesn't have". That inverts here. Under `?shell=legacy`
// `shellFaces` is false, the rail renders the CARD, and the producer is ALIVE;
// under the default shell it renders the face and the producer is DEAD. The two
// shells disagree — the very thing the skip exists to prevent. Both arms are
// asserted below.
//
// ── WHY NOT `toHaveCount(0)` ────────────────────────────────────────────────
//
// ⚠ THE PRECEDENT FILE RECORDS THIS MISTAKE AND IT IS NOT REPEATED HERE.
// `camerainput-shell-source.spec.ts` first asserted the lane no longer renders
// the legacy card with `toHaveCount(0)` — satisfied by BOTH "the card is hosted
// off-screen" (right) and "the card is not mounted anywhere at all" (the exact
// regression). A gate whose passing condition includes the defect.
//
// So this file asserts the mount is UNIQUE and INSIDE the host, which
// distinguishes the two worlds instead of collapsing them.

import { test, expect, type Page } from '@playwright/test';
import { SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

/** timelorde is an ALWAYS-ON pinned singleton, so a fresh `/rack` already holds
 *  it with `data.pinned === true` — the state under test needs no spawning. */
async function bootRack(page: Page, query = ''): Promise<void> {
  await page.goto(`/rack${query}`);
  await expect(page.getByTestId('workflow-topbar'))
    .toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

const host = (page: Page) =>
  page.locator('[data-testid="headless-source-host"][data-node-type="timelorde"]');

test.describe('timelorde — the PINNED arm keeps the producer card mounted', () => {
  test('faced + pinned: the rail paints the FACE and the real card is hosted, exactly once', async ({ page }) => {
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 2);
    await bootRack(page);

    // ── 1. THE PRECONDITION IS REAL, AND MEASURED FROM THE DOM ─────────────
    //
    // ⚠ NO PAGE HOOK. The first draft of this leg read a `__patchSnapshot`
    // global to assert `data.pinned === true` — a hook that DOES NOT EXIST in
    // this tree. It would have thrown, or worse, `?.()` would have returned
    // undefined and the leg would have asserted nothing. The pinned state is
    // observable without inventing anything: a pinned node is canvas-hidden, so
    // its card is absent from the lane pane while present in the rack.
    const card = page.locator('.mod-card.timelorde-card');
    await expect(card, 'the rack has no timelorde at all — every leg below would pass vacuously')
      .toHaveCount(1, { timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
    await expect(
      page.locator('.svelte-flow__pane:visible .mod-card.timelorde-card'),
      'timelorde has a LANE copy — it is not canvas-hidden, so the pinned arm under test is not engaged',
    ).toHaveCount(0);

    // ── 2. THE REAL CARD IS MOUNTED, OFF-SCREEN ────────────────────────────
    // The assertion the whole fix rests on. Without it the card is gone,
    // `write(node,'displayFrame')` never runs, and `video_out` goes dark.
    await expect(host(page), "HeadlessSourceHost keeps timelorde's real card alive while it is faced + pinned")
      .toHaveCount(1, { timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

    // ── 3. …AND EXACTLY ONE MOUNT, WHICH IS THE NON-INVERTED FORM ──────────
    await expect(
      host(page).locator('.mod-card.timelorde-card'),
      'the real card is mounted INSIDE the headless host',
    ).toHaveCount(1);

    // ── 4. ITS CONTROLS ARE REACHABLE ──────────────────────────────────────
    // ⚠ "Mounted" is not the same claim as "usable", and the difference is the
    // whole reason a hosted card can regress silently: an empty wrapper in the
    // host would satisfy leg 3. This reaches a real control inside the hosted
    // copy — timelorde's transport RUN button.
    await expect(
      host(page).locator('.run-btn'),
      "the hosted copy is the REAL card, not an empty shell — its transport RUN button is there",
    ).toHaveCount(1);
  });
  test('LEGACY SHELL: the rail renders the CARD, so there is no host — the parity half', async ({ page }) => {
    // ⚠ THE OTHER ARM, and it is what makes the fix a PARITY RESTORATION rather
    // than a new mount. With `shellFaces` false the rail renders the verbatim
    // card, so the producer is already alive and a headless host would be a
    // SECOND mount of the same card.
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 2);
    await bootRack(page, '?shell=legacy');

    await expect(
      host(page),
      'no headless host under ?shell=legacy — the rail mounts the real card itself, and a host would double-mount it',
    ).toHaveCount(0, { timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

    // ⚠ NOT A BARE toHaveCount(0). On its own that is satisfied by "the rack has
    // no timelorde at all". Pair it with the card actually being mounted, which
    // is the state this arm claims.
    await expect(
      page.locator('.mod-card.timelorde-card'),
      'the verbatim legacy card IS mounted — which is why no host is needed',
    ).toHaveCount(1);
  });
});
