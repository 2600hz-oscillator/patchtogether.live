// e2e/tests/acidwarp-face-screen.spec.ts
//
// THE ACIDWARP FACE SCREEN (#2111) — the render legs for a module that IS its
// display, plus the MEASUREMENT that justifies its `FACES_WITHOUT_SCENES` entry.
//
// ── WHY THIS SPEC CARRIES MORE THAN THE FLEET STANDARD ─────────────────────
//
// acidwarp is a pure-GPU plasma SOURCE: no input, no audio path, its whole
// product is the frame it synthesizes. Promotion removes `AcidwarpCard.svelte`
// from both surfaces, and that card owned the only picture — so on this module
// the SCREEN legs are not "does the monitor work", they are "is the module
// still there at all".
//
// It is also the ONLY faced module with no VRT scenes (`FACES_WITHOUT_SCENES`),
// so nothing downstream of this file looks at its pixels. The last test here is
// therefore not a nicety: it is the EVIDENCE for that exemption, run in the
// browser rather than argued from source, and it is deliberately shaped so that
// if acidwarp ever BECAME capturable this spec goes red and says so.

import { test, expect, type Page } from '@playwright/test';
import { SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';
import { spawnPatch } from './_helpers';

/**
 * Sample the face canvas twice, `frames` apart, IN THE PAGE.
 *
 * ⚠ ONE EVALUATE, NOT A PLAYWRIGHT POLL. Two round-trips on the same main
 * thread as the rAF loop under test is the starvation shape CLAUDE.md names —
 * "frozen" and "never looked" become indistinguishable from the output. The
 * accumulator goes in the page and reports what it actually saw.
 *
 * Returns a coarse signature of each sample plus how many frames elapsed, so a
 * failure can say WHICH of "did not paint" / "did not change" / "never ran" it
 * was.
 */
async function sampleTwice(page: Page, frames: number): Promise<{
  ok: boolean; first: string; second: string; elapsed: number; nonBlack: boolean;
}> {
  return page.evaluate(async (n: number) => {
    const el = document.querySelector<HTMLCanvasElement>('[data-testid="acidwarp-face-canvas"]');
    if (!el) return { ok: false, first: '', second: '', elapsed: 0, nonBlack: false };
    const sig = (): { s: string; lit: boolean } => {
      const ctx = el.getContext('2d');
      if (!ctx) return { s: '', lit: false };
      // A coarse signature: a sparse grid of pixels, quantised. Enough to tell
      // "the palette rotated" from "identical frame" without being so fine that
      // a single dithered pixel reads as motion.
      const pts: [number, number][] = [];
      for (let i = 1; i < 8; i++) for (let j = 1; j < 8; j++) {
        pts.push([Math.floor((el.width * i) / 8), Math.floor((el.height * j) / 8)]);
      }
      let lit = false;
      const s = pts.map(([x, y]) => {
        const d = ctx.getImageData(x, y, 1, 1).data;
        if (d[0]! + d[1]! + d[2]! > 24) lit = true;
        return `${d[0]! >> 4}${d[1]! >> 4}${d[2]! >> 4}`;
      }).join('');
      return { s, lit };
    };
    // Wait for the first painted frame, in FRAMES.
    let waited = 0;
    let a = sig();
    while (!a.lit && waited < 240) {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      waited++;
      a = sig();
    }
    for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(() => r(null)));
    const b = sig();
    return { ok: true, first: a.s, second: b.s, elapsed: waited + n, nonBlack: a.lit };
  }, frames);
}

async function openAcidwarpDock(page: Page) {
  const shell = page.locator('.svelte-flow__node[data-id="aw"] [data-testid="module-shell"]');
  await expect(shell, 'the promoted face renders a ModuleShell tile in the lane')
    .toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
  await shell.getByTestId('shell-open-dock').click();
  const faceplate = page.getByTestId('dock-full-view');
  await expect(faceplate).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
  const dockShell = faceplate.locator('[data-testid="module-shell"][data-shell-tier="dock"]');
  await expect(dockShell).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
  return dockShell;
}

const NODES = [
  { id: 'aw', type: 'acidwarp', position: { x: 120, y: 80 }, domain: 'video' as const },
];

test.describe('ACIDWARP face — the screen', () => {
  // ⚠ THE CEILING THIS FILE NEVER SET, AND THE ONE THAT ACTUALLY FIRED. CI run
  // 32614572680 shard 5 reddened here with `Test timeout of 30000ms exceeded` on
  // the SCREEN OFF leg — Playwright's flat per-test DEFAULT, because this file
  // declared no budget of its own.
  //
  // ⚠ IT IS NOT THE hot-shard STORY, AND THE NUMBER SAYS SO: that shard finished
  // at 532s of 1020s = 52% of budget, nowhere near the 85% line. So this is not a
  // shard packed too hot, it is a test that was never given room. This file's own
  // PENDING entry measured ~11.1 s per pass under SwiftShader LOCALLY and warned
  // in capitals to "budget the 2-core CI VM at roughly the SwiftShader figure
  // plus VM overhead" — which lands at or past 30 s. The measurement was right;
  // nothing consumed it.
  //
  // Taken from the ONE export site rather than typed, so it moves with the fleet
  // instead of drifting: a flat wall-clock number is a different assertion on
  // every runner (#1875/#1906). It BOUNDS the failure; it is not the gate.
  test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS);

  test('SCREEN ON: the plasma display paints a live picture on the faceplate', async ({ page }) => {
    await page.goto('/rack?shell=1&seed=none');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, NODES, []);

    const dockShell = await openAcidwarpDock(page);
    const body = dockShell.getByTestId('acidwarp-screen-body');
    await expect(body, 'the fullViewBody paints at the dock')
      .toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

    const toggle = body.getByTestId('acidwarp-face-screen-toggle');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(toggle).toHaveText('SCREEN ON');
    await expect(body.getByTestId('acidwarp-face-canvas'))
      .toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

    const s = await sampleTwice(page, 20);
    expect(s.ok, 'the face canvas exists').toBe(true);
    expect(
      s.nonBlack,
      `the plasma never painted a non-black frame (waited ${s.elapsed} rAFs). On a module whose ` +
        'whole product is the frame, a black canvas is the module missing — check ' +
        'blitOutputForPreview and the worker render path.',
    ).toBe(true);
  });

  test('SCREEN OFF unmounts the canvas, persists on node.data, and comes back LIVE', async ({ page }) => {
    await page.goto('/rack?shell=1&seed=none');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, NODES, []);

    const dockShell = await openAcidwarpDock(page);
    const body = dockShell.getByTestId('acidwarp-screen-body');
    const toggle = body.getByTestId('acidwarp-face-screen-toggle');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(toggle).toHaveText('SCREEN OFF');
    await expect(
      body.getByTestId('acidwarp-face-canvas'),
      'SCREEN OFF unmounts the display and reclaims its space',
    ).toHaveCount(0);

    // ⚠ THE STATE IS ON `node.data`, NOT IN THE COMPONENT — the owner's stated
    // floor, and the #1531 / #1574 / #1583 class: this body unmounts on dock
    // collapse / LRU eviction, so component `$state` would lose the switch on
    // every remount, and would never reach a collaborator.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const w = globalThis as unknown as {
            __patch: { nodes: Record<string, { data?: Record<string, unknown> } | undefined> };
          };
          return w.__patch.nodes.aw?.data?.previewCollapsed ?? null;
        }),
        {
          message: 'SCREEN OFF must persist on node.data.previewCollapsed (the shared key)',
          // Same export site as the ceiling above — an unbounded poll here would
          // be the next thing to fire once the test ceiling stopped being the
          // first to run out.
          timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
        },
      )
      .toBe(true);

    // Back ON: the picture returns, and it is LIVE rather than a stale frame —
    // the #1720 / #1721 class. The rAF loop never stopped (it keeps taking the
    // watch mark while collapsed), so there is nothing to spin up.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(body.getByTestId('acidwarp-face-canvas'))
      .toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
    const back = await sampleTwice(page, 20);
    expect(back.nonBlack, 'switching SCREEN back on shows a picture').toBe(true);
  });

  // ── THE EVIDENCE FOR `FACES_WITHOUT_SCENES` ────────────────────────────────
  test('⚠ freeze does NOT stop the picture — the reason this face has no VRT scene', async ({ page }) => {
    await page.goto('/rack?shell=1&seed=none');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, NODES, []);
    await openAcidwarpDock(page);

    // Write the module's own `freeze` param — EXACTLY what `freezeFaceVideo`
    // does to freeze a video face for capture. On every other faced video
    // module that stops the picture. Here it halts only the scene cycler.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> } | undefined> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes.aw;
        if (n) n.params.freeze = 1;
      });
    });

    const s = await sampleTwice(page, 30);
    expect(s.nonBlack, 'the display is painting at all').toBe(true);
    expect(
      s.second,
      'ACIDWARP\'s picture MOVED ACROSS 30 FRAMES WITH freeze=1 — which is the whole argument ' +
        'for its FACES_WITHOUT_SCENES entry: `freezeFaceVideo` writes exactly this param, and ' +
        'on this module it halts only the scene cycler while the palette keeps rotating. ' +
        '⚠ IF THIS ASSERTION EVER FAILS (i.e. the picture DID stop), the exemption is stale — ' +
        'acidwarp became capturable, and it should move from FACES_WITHOUT_SCENES into the ' +
        'FACES roster with real baselines rather than keep an argument that no longer holds.',
    ).not.toBe(s.first);
  });
});
