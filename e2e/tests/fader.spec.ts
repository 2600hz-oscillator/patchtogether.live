// e2e/tests/fader.spec.ts
//
// FADER — the face ↔ engine param-wiring chain. The per-module-per-port sweep
// proves the 3 inputs (A/B/RETURN) accept video + the 2 outputs (OUT/SEND)
// exist + emit (FADER is in EXEMPT_OUTPUT_EMIT_MODULES — black until an input is
// driven). The transition blend math is unit-tested in fader-transitions.test.ts.
// This proves the UNIQUE bit: the two faders + two transition dropdowns drive the
// engine params (node.params), the same path a CV cable would, with no GL errors.
//
// ── ⚠ WHY THIS FILE CARRIES A PER-TEST BOUND (2026-09-05) ──────────────────
//
// It timed out on CI three runs running — `Test timeout of 31751 ms exceeded`
// inside `scrollIntoViewIfNeeded`, then inside `mouse.move` — while passing
// LOCALLY IN 8.0 s. Nothing about the subject is slow; the re-point off the
// deleted surface added a DOCK OPEN, and a dock mount no longer overlaps page
// load, so the boot that used to run behind the first assertion now runs in
// front of it (memory: repointing-a-spec-off-legacy-serializes-cold-boots).
// The measured CI cost of this file went 6.6 s -> a 30 s wall.
//
// This suite does not override Playwright's 30 s default, so a spec whose
// actions carry no bound of their own is bounded by the TEST BUDGET and
// nothing else — the exact subject of `SLOW_BOOT_TEST_TIMEOUT_MS`. That is a
// BOUND, not an assertion: this file claims nothing about latency, and a bound
// only costs wall-clock when it is exceeded. Lane cost stays gauged by
// `--global-timeout`, which is a different instrument and is not touched here.

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

function param(page: Page, id: string, name: string): Promise<number | undefined> {
  return page.evaluate(
    ({ id, name }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params?: Record<string, number> }> };
      };
      return w.__patch.nodes[id]?.params?.[name];
    },
    { id, name },
  );
}

/** Pointer-drag a dock slider vertically and return the param delta direction.
 *  An `<input>.fill()` had exact-value semantics; a shell slider is a drawn
 *  control, so the claim becomes: the GESTURE writes the param, in the dragged
 *  direction. (Same shape as faces-parity-suite's dragKnob.)
 *
 *  ⚠ `scrollIntoViewIfNeeded()` STOOD ON THE FIRST LINE AND IS DELIBERATELY
 *  NOT USED. It is an ACTIONABILITY call: before scrolling it waits for the
 *  element to be STABLE — the same bounding box across two animation frames —
 *  and that wait carries NO timeout of its own, so it is bounded only by the
 *  test budget. The fader's dock body is a live video surface whose rAF loop
 *  keeps the pane painting, and on a loaded SwiftShader runner the box does
 *  not settle inside the budget: the CI failure was 31.7 s spent inside this
 *  one call, on a page that was fully rendered the whole time.
 *
 *  `scrollIntoView` via `evaluate` is the DOM call underneath it with no
 *  actionability contract at all, so the scroll happens on the first tick and
 *  the test still drives a REAL pointer at the REAL element afterwards.
 *  Nothing is weakened: `boundingBox()` and the mouse gestures below are
 *  unchanged, and a slider that never rendered still fails on the box. */
async function dragSlider(page: import('@playwright/test').Page, slider: import('@playwright/test').Locator, dyPx: number): Promise<void> {
  await slider.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const box = (await slider.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy + dyPx, { steps: 8 });
  await page.mouse.up();
}

test.describe('FADER — face ↔ engine param wiring', () => {
  test('mounts; the A/B + dry/wet faders and transition dropdowns drive node.params', async ({ page, rack, errorWatch }) => {
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS);
    await spawnPatch(page, [
      { id: 'fd', type: 'fader', position: { x: 200, y: 120 }, domain: 'video' },
    ]);
    const tile = page.locator('.svelte-flow__node[data-id="fd"] [data-testid="module-shell"]');
    await expect(tile).toBeVisible();
    await tile.getByTestId('shell-open-dock').click();
    const dock = page.getByTestId('dock-full-view');
    await expect(dock).toBeVisible();

    // A/B fader → params.fader (drag up = raise; default 0.5)
    const before = (await param(page, 'fd', 'fader')) ?? 0.5;
    await dragSlider(page, dock.getByTestId('control-fader'), -40);
    await expect.poll(async () => ((await param(page, 'fd', 'fader')) ?? 0.5) > before, { message: 'A/B fader drag raises params.fader' })
      .toBe(true);

    // dry/wet fader → params.dryWet (drag down = lower; default 1?) — assert it MOVED.
    const dwBefore = (await param(page, 'fd', 'dryWet')) ?? 0;
    await dragSlider(page, dock.getByTestId('control-dryWet'), 40);
    await expect.poll(async () => (await param(page, 'fd', 'dryWet')) !== dwBefore, { message: 'dry/wet fader drag writes params.dryWet' })
      .toBe(true);

    // transition radiogroups → params (index): dissolve=2, star=3
    await dock.getByTestId('control-abTransition').locator('[role="radio"]').nth(2).click();
    await expect.poll(() => param(page, 'fd', 'abTransition'), { message: 'A/B transition → params.abTransition' })
      .toBe(2);

    await dock.getByTestId('control-dwTransition').locator('[role="radio"]').nth(3).click();
    await expect.poll(() => param(page, 'fd', 'dwTransition'), { message: 'D/W transition → params.dwTransition' })
      .toBe(3);

  });
});
