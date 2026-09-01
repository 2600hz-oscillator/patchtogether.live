// e2e/tests/adsr-face.spec.ts
//
// The adsr FACE, at the tiers that show a SUBSET — the half of the curation
// nothing else covers.
//
// faces-parity drives every control of every face at the DOCK, where all of
// them render; the VRT face scenes pin the compact tile as pixels. Neither can
// say WHICH control the ranking promoted, and a pixel pin cannot tell a rank
// swap from a re-render. But the ranking is the whole artifact: `face.order` is
// what the mini tile and the compact row select from, so if `order` silently
// drifts back to declaration order (or someone "fixes" it to match `pages`),
// every gate stays green and the module's glance tier quietly shows a different
// knob.
//
// So this spec asserts three things a generic sweep structurally cannot:
//   1. at MINI exactly ONE control renders and it is RELEASE (rank 1);
//   2. driving it changes the GRAPH (`__patch`), not just the DOM;
//   3. the dial's ACCESSIBLE VALUE is the DEF's formatter reaching the DOM —
//      "300 ms", never the raw "0.30" a magnitude-banded fallback prints.
//
// ⚠ (3) USED TO READ A PAINTED `readout-release` LINE. The owner removed the
// resting number from every face (2026-08-17), and every adsr param declares a
// `format`, so no adsr dial paints anything at all now. The STRING did not
// change: `aria-valuetext` is `knobValueReadout`, the same ladder the readout
// printed, so the assertion moved surface without being weakened. It is also
// the only live-value observable this face has left — the resofilter-face
// precedent.
//
// Runs on /rack (no DB/relay), the normal e2e lane.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

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

/** Read the live graph value of one param (null when unset). */
function readParam(page: Page, nodeId: string, pid: string): Promise<number | null> {
  return page.evaluate(
    ({ nodeId, pid }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params?: Record<string, number> } | undefined> };
      };
      return w.__patch.nodes[nodeId]?.params?.[pid] ?? null;
    },
    { nodeId, pid },
  );
}

/** Set the viewport zoom and wait for the LOD tier to settle on the tile. */
async function setZoomTier(page: Page, nodeId: string, zoom: number, tier: string): Promise<void> {
  await page.evaluate((z) => {
    const f = (
      globalThis as unknown as {
        __flow: {
          getViewport: () => { x: number; y: number; zoom: number };
          setViewport: (vp: { x: number; y: number; zoom: number }, o?: { duration?: number }) => void;
        };
      }
    ).__flow;
    const vp = f.getViewport();
    f.setViewport({ x: vp.x, y: vp.y, zoom: z }, { duration: 0 });
  }, zoom);
  await page.waitForFunction(
    ({ nodeId, tier }) => {
      const el = document.querySelector(
        `.svelte-flow__node[data-id="${nodeId}"] [data-testid="module-shell"]`,
      );
      return !!el && el.getAttribute('data-shell-tier') === tier;
    },
    { nodeId, tier },
    { timeout: 10_000 },
  );
}

test.describe('adsr curated face — the ranked tiers', () => {
  test('rank 1 is RELEASE at mini, it writes the graph, and it reads out in real units', async ({
    page,
  }) => {
    await page.goto('/rack');
    await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
    await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
    await spawnPatch(page, [{ id: 'env', type: 'adsr', position: { x: 460, y: 240 } }]);

    const shell = page.locator('.svelte-flow__node[data-id="env"] [data-testid="module-shell"]');
    await expect(shell).toHaveAttribute('data-shell-type', 'adsr');

    // ── 1. MINI: the whole front-side budget is ONE cell. Which one IS the
    //       ranking, made observable.
    await setZoomTier(page, 'env', 0.2, 'mini');
    const cells = shell.locator('[data-cell-key]');
    await expect(cells, 'mini renders exactly one control cell').toHaveCount(1);
    await expect(
      cells.first(),
      "mini's one cell is RELEASE — the only stage that always runs (rank 1)",
    ).toHaveAttribute('data-cell-key', 'release');

    // ── 3a. The dial SPEAKS the DEF's `format`, not KnobConic's magnitude-
    //        banded fallback (which says 0.30 with no unit). Nothing is painted
    //        under the dial any more; `aria-valuetext` carries the identical
    //        string, so this is the same assertion on the surviving surface.
    const knob = shell.locator('[data-testid="control-release"]');
    await expect(knob, 'the release dial reads out in real time units').toHaveAttribute(
      'aria-valuetext',
      '300 ms',
    );
    await expect(
      shell.getByTestId('readout-release'),
      'and it paints NOTHING: `release` declares a `format`, which is exactly the case the ' +
        'owner removed — a NAME would still print, a number never does',
    ).toHaveCount(0);

    // ── 2. Driving the ranked control changes the GRAPH.
    // A fresh spawn stores NO explicit value — the dial (and the '300 ms'
    // accessible value above) is reading the def's declared default through the
    // shell, which is exactly the fallback path a re-typed card range would break.
    const before = await readParam(page, 'env', 'release');
    expect(before, 'a fresh spawn stores no explicit release value').toBeNull();
    const box = (await knob.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy - 60, { steps: 8 });
    await page.mouse.up();
    await expect
      .poll(() => readParam(page, 'env', 'release'), {
        message: 'dragging the mini tile\'s one knob commits a release change into __patch',
      })
      .not.toBe(before);
    const after = (await readParam(page, 'env', 'release'))!;
    // The default is the value the drag started FROM (see above), so this is
    // the direction check, not a re-read of the same number.
    expect(after, 'an upward drag raises the release time above the 0.3 s default').toBeGreaterThan(
      0.3,
    );

    // ── 3b. …and the spoken value TRACKS it, still in real units. (A value that
    //        never moves is the same class of dead surface as an inert cell, and
    //        it is now the ONLY way to see that from the DOM — there is no
    //        painted line left to read.)
    await expect(knob).not.toHaveAttribute('aria-valuetext', '300 ms');
    await expect(knob).toHaveAttribute('aria-valuetext', /^\d+(\.\d+)? (ms|s)$/);

    // ── 1b. COMPACT: two cells, in RANK order — release then attack. DOM order
    //        is the assertion: a face that drifted back to declaration order
    //        would render the same two controls the other way round.
    await setZoomTier(page, 'env', 0.45, 'compact');
    await expect(shell.locator('[data-cell-key]')).toHaveCount(2);
    expect(
      await shell.locator('[data-cell-key]').evaluateAll((els) =>
        els.map((e) => e.getAttribute('data-cell-key')),
      ),
    ).toEqual(['release', 'attack']);
  });
});
