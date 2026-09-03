// e2e/tests/fader.spec.ts
//
// FADER — the card ↔ engine param-wiring chain. The per-module-per-port sweep
// proves the 3 inputs (A/B/RETURN) accept video + the 2 outputs (OUT/SEND)
// exist + emit (FADER is in EXEMPT_OUTPUT_EMIT_MODULES — black until an input is
// driven). The transition blend math is unit-tested in fader-transitions.test.ts.
// This proves the UNIQUE bit: the two faders + two transition dropdowns drive the
// engine params (node.params), the same path a CV cable would, with no GL errors.

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

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
 *  The card's <input>.fill() had exact-value semantics; a shell slider is a
 *  drawn control, so the claim becomes: the GESTURE writes the param, in the
 *  dragged direction. (Same shape as faces-parity-suite's dragKnob.) */
async function dragSlider(page: import('@playwright/test').Page, slider: import('@playwright/test').Locator, dyPx: number): Promise<void> {
  await slider.scrollIntoViewIfNeeded();
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
