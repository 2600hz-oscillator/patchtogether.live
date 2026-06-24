// e2e/tests/fader.spec.ts
//
// FADER — the card ↔ engine param-wiring chain. The per-module-per-port sweep
// proves the 3 inputs (A/B/RETURN) accept video + the 2 outputs (OUT/SEND)
// exist + emit (FADER is in EXEMPT_OUTPUT_EMIT_MODULES — black until an input is
// driven). The transition blend math is unit-tested in fader-transitions.test.ts.
// This proves the UNIQUE bit: the two faders + two transition dropdowns drive the
// engine params (node.params), the same path a CV cable would, with no GL errors.

import { test, expect, type Page } from '@playwright/test';
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

test.describe('FADER — card ↔ engine param wiring', () => {
  test('mounts; the A/B + dry/wet faders and transition dropdowns drive node.params', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, [
      { id: 'fd', type: 'fader', position: { x: 200, y: 120 }, domain: 'video' },
    ]);
    await expect(page.locator('[data-testid="fader-card"]')).toHaveCount(1);

    // A/B fader → params.fader
    await page.locator('[data-testid="fader-ab"]').fill('0.8');
    await expect.poll(() => param(page, 'fd', 'fader'), { message: 'A/B fader → params.fader' })
      .toBeCloseTo(0.8, 5);

    // dry/wet fader → params.dryWet
    await page.locator('[data-testid="fader-drywet"]').fill('0.3');
    await expect.poll(() => param(page, 'fd', 'dryWet'), { message: 'dry/wet fader → params.dryWet' })
      .toBeCloseTo(0.3, 5);

    // transition dropdowns → params (index): dissolve=2, star=3
    await page.locator('[data-testid="fader-ab-fx"]').selectOption({ value: '2' });
    await expect.poll(() => param(page, 'fd', 'abTransition'), { message: 'A/B transition → params.abTransition' })
      .toBe(2);

    await page.locator('[data-testid="fader-drywet-fx"]').selectOption({ value: '3' });
    await expect.poll(() => param(page, 'fd', 'dwTransition'), { message: 'D/W transition → params.dwTransition' })
      .toBe(3);

    expect(errors, `no console / page errors: ${errors.join('; ')}`).toEqual([]);
  });
});
