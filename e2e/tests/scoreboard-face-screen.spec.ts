// e2e/tests/scoreboard-face-screen.spec.ts
//
// THE SCOREBOARD FACE SCREEN (#2089) — the render legs for the SCREEN toggle,
// which the module's two VRT scenes cannot cover.
//
// ── WHAT THIS ADDS OVER THE BASELINES ──────────────────────────────────────
//
// Unlike the other video face this lane shipped, scoreboard DOES have dock and
// compact baselines, so what the plate LOOKS like is already pinned. A
// screenshot cannot see a TRANSITION though: that the canvas unmounts, that the
// state lands on `node.data` rather than in component state, and that switching
// back shows a live picture rather than a stale frame. Those are this file.
//
// ⚠ AND IT TAKES THE SLOW-BOOT BOUND FROM THE START. A sibling spec in this
// lane shipped without it and died on CI shard 6: Playwright's default per-test
// timeout is 30 s, this suite does not override it, and for any wait carrying no
// timeout of its own THE TEST BUDGET IS THE BOUND. `SLOW_RENDER` is
// `E2E_SWIFTSHADER || CI`, so opting in is what buys 90 s on the runners that
// need it. Per-spec via `describe.configure`, NEVER in
// `e2e/playwright.config.ts` — that file is in the WebGL attest basis, so an
// edit there costs a real-GPU re-attest while `e2e/tests/**` is
// hash-transparent by design.
//
// ⚠ ONE NODE, NO INPUT CHAIN. scoreboard is a generator whose only inputs are
// two CV gates; nothing needs patching for the toggle to be exercised. That is
// the cheapest honest boot for this subject, and cost is the axis a local
// SwiftShader run does NOT measure (it changes the renderer, not cold boot or
// shard contention).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

test.describe.configure({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

const NODES = [
  { id: 'sb', type: 'scoreboard', position: { x: 140, y: 80 }, domain: 'video' as const },
];

async function openScoreboardDock(page: Page) {
  const shell = page.locator('.svelte-flow__node[data-id="sb"] [data-testid="module-shell"]');
  await expect(shell, 'the promoted face renders a ModuleShell tile in the lane').toBeVisible();
  await shell.getByTestId('shell-open-dock').click();
  const faceplate = page.getByTestId('dock-full-view');
  await expect(faceplate).toBeVisible();
  const dockShell = faceplate.locator('[data-testid="module-shell"][data-shell-tier="dock"]');
  await expect(dockShell).toBeVisible();
  return dockShell;
}

/**
 * Has the display painted a lit (non-black) pixel yet?
 *
 * ⚠ SAMPLED IN THE PAGE, IN ONE EVALUATE, WAITING IN FRAMES. A Playwright-side
 * poll would be one round-trip per sample on the same main thread as the rAF
 * loop it is watching — the starvation shape where "not painted" and "never
 * looked" are indistinguishable from the output. Reports the frames waited so a
 * failure can say which it was.
 */
async function litWithin(page: Page, frames: number): Promise<{ lit: boolean; waited: number }> {
  return page.evaluate(async (n: number) => {
    const el = document.querySelector<HTMLCanvasElement>('[data-testid="scoreboard-face-canvas"]');
    if (!el) return { lit: false, waited: 0 };
    const anyLit = (): boolean => {
      const ctx = el.getContext('2d');
      if (!ctx) return false;
      // The digits sit on a soft-black field; sample a grid and look for glow.
      for (let i = 1; i < 8; i++) {
        for (let j = 1; j < 4; j++) {
          const d = ctx.getImageData(
            Math.floor((el.width * i) / 8),
            Math.floor((el.height * j) / 4),
            1,
            1,
          ).data;
          if (d[0]! + d[1]! + d[2]! > 60) return true;
        }
      }
      return false;
    };
    let waited = 0;
    while (!anyLit() && waited < n) {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      waited++;
    }
    return { lit: anyLit(), waited };
  }, frames);
}

test.describe('SCOREBOARD face — the screen', () => {
  test('SCREEN ON: the counter display paints on the faceplate', async ({ page }) => {
    await page.goto('/rack?shell=1&seed=none');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, NODES, []);

    const dockShell = await openScoreboardDock(page);
    const body = dockShell.getByTestId('scoreboard-screen-body');
    await expect(body, 'the fullViewBody paints at the dock').toBeVisible();

    const toggle = body.getByTestId('scoreboard-face-screen-toggle');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(toggle).toHaveText('SCREEN ON');
    await expect(body.getByTestId('scoreboard-face-canvas')).toBeVisible();

    // ⚠ THE ONE CONTROL IS A HUE WHEEL, NOT A KNOB — asserted here because it is
    // the face's single design decision and the dock baseline cannot say WHICH
    // primitive it is looking at, only what it looks like.
    await expect(
      dockShell.locator('[data-testid="control-color"]'),
      'the colour control renders as the hue wheel',
    ).toBeVisible();

    const s = await litWithin(page, 240);
    expect(
      s.lit,
      `the display never lit a pixel (waited ${s.waited} rAFs). On a module whose whole product ` +
        'is a number on a screen, a black canvas is the module missing — check ' +
        'blitOutputForPreview and the 8:3 letterbox fit.',
    ).toBe(true);
  });

  test('SCREEN OFF unmounts it, persists on node.data, and comes back LIVE', async ({ page }) => {
    await page.goto('/rack?shell=1&seed=none');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, NODES, []);

    const dockShell = await openScoreboardDock(page);
    const body = dockShell.getByTestId('scoreboard-screen-body');
    const toggle = body.getByTestId('scoreboard-face-screen-toggle');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(toggle).toHaveText('SCREEN OFF');
    await expect(
      body.getByTestId('scoreboard-face-canvas'),
      'SCREEN OFF unmounts the display and reclaims its space',
    ).toHaveCount(0);

    // ⚠ THE STATE IS ON `node.data`, NOT IN THE COMPONENT — the owner's stated
    // floor, and the #1531 / #1574 / #1583 class: this body unmounts on dock
    // collapse / LRU eviction, so component `$state` would lose the switch on
    // every remount and would never reach a collaborator. It is also the SHARED
    // `previewCollapsed` key, so a rack saved before this promotion keeps its
    // setting rather than silently re-opening.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const w = globalThis as unknown as {
              __patch: { nodes: Record<string, { data?: Record<string, unknown> } | undefined> };
            };
            return w.__patch.nodes.sb?.data?.previewCollapsed ?? null;
          }),
        { message: 'SCREEN OFF must persist on node.data.previewCollapsed (the shared key)' },
      )
      .toBe(true);

    // Back ON: the display returns and lights up again. The rAF loop never
    // stopped — it keeps taking the watch mark while collapsed — so there is
    // nothing to spin up and no stale frame to show (#1720 / #1721).
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(body.getByTestId('scoreboard-face-canvas')).toBeVisible();
    const back = await litWithin(page, 240);
    expect(back.lit, 'switching SCREEN back on shows a live picture').toBe(true);
  });
});
