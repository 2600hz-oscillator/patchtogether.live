// e2e/tests/cloudseed.spec.ts
//
// CLOUDSEED end-to-end smoke. Spawns ANALOGVCO → CLOUDSEED → AUDIOOUT,
// verifies the card mounts, the 4 preset slots cycle, the DECAY readout
// updates, and a sweep of macro knobs doesn't produce console errors.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

test('CLOUDSEED card mounts + audio flows VCO → CLOUDSEED → OUTPUT', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'a-vco', type: 'analogVco', position: { x: 60,  y: 60 }, domain: 'audio' },
      { id: 'a-cs',  type: 'cloudseed', position: { x: 360, y: 60 }, domain: 'audio' },
      { id: 'a-out', type: 'audioOut',  position: { x: 760, y: 60 }, domain: 'audio' },
    ],
    [
      { id: 'e1', from: { nodeId: 'a-vco', portId: 'saw' },  to: { nodeId: 'a-cs',  portId: 'in_l' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e2', from: { nodeId: 'a-vco', portId: 'saw' },  to: { nodeId: 'a-cs',  portId: 'in_r' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e3', from: { nodeId: 'a-cs',  portId: 'out_l' }, to: { nodeId: 'a-out', portId: 'L' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e4', from: { nodeId: 'a-cs',  portId: 'out_r' }, to: { nodeId: 'a-out', portId: 'R' },
        sourceType: 'audio', targetType: 'audio' },
    ],
  );

  const card = page.locator('.svelte-flow__node-cloudseed');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('CLOUDSEED');
  // Sub-panel labels — proves the layout rendered.
  await expect(card).toContainText('TAPS');
  await expect(card).toContainText('DIFFUSION');
  await expect(card).toContainText('LATE REFLECTIONS');
  await expect(card).toContainText('EQUALISATION');

  await page.waitForTimeout(500);
  expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
});

test('CLOUDSEED preset slots cycle + name and DECAY readout update', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [{ id: 'a-cs', type: 'cloudseed', position: { x: 100, y: 100 } }],
    [],
  );

  await expect(page.locator('.svelte-flow__node-cloudseed')).toHaveCount(1);

  // Slot 0 active by default (DIVINE INSPIRATION).
  const slot0 = page.locator('[data-testid="cs-preset-slot-0"]');
  const slot1 = page.locator('[data-testid="cs-preset-slot-1"]');
  const slot3 = page.locator('[data-testid="cs-preset-slot-3"]');
  const name  = page.locator('[data-testid="cs-preset-name"]');
  const decay = page.locator('[data-testid="cs-decay-readout"]');

  await expect(slot0).toBeVisible();
  await expect(name).toContainText('DIVINE INSPIRATION');
  const startDecay = await decay.innerText();

  // Click slot 1 (SHORT ROOM).
  await slot1.click();
  await expect(name).toContainText('SHORT ROOM');
  // Decay readout should change vs the start.
  const shortDecay = await decay.innerText();
  expect(shortDecay).not.toBe(startDecay);

  // Click slot 3 (INFINITE PAD) — longest tail.
  await slot3.click();
  await expect(name).toContainText('INFINITE PAD');
  const infDecay = await decay.innerText();
  expect(infDecay).not.toBe(shortDecay);

  // Click prev arrow — goes to BRIGHT HALL.
  await page.locator('[data-testid="cs-preset-prev"]').click();
  await expect(name).toContainText('BRIGHT HALL');
  // Click next twice — wraps around back to DIVINE INSPIRATION via INFINITE PAD.
  await page.locator('[data-testid="cs-preset-next"]').click();
  await page.locator('[data-testid="cs-preset-next"]').click();
  await expect(name).toContainText('DIVINE INSPIRATION');
});

test('CLOUDSEED survives macro-knob sweeps without console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'a-vco', type: 'analogVco', position: { x: 60,  y: 60 } },
      { id: 'a-cs',  type: 'cloudseed', position: { x: 360, y: 60 } },
      { id: 'a-out', type: 'audioOut',  position: { x: 760, y: 60 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'a-vco', portId: 'saw' },   to: { nodeId: 'a-cs',  portId: 'in_l' } },
      { id: 'e2', from: { nodeId: 'a-vco', portId: 'saw' },   to: { nodeId: 'a-cs',  portId: 'in_r' } },
      { id: 'e3', from: { nodeId: 'a-cs',  portId: 'out_l' }, to: { nodeId: 'a-out', portId: 'L' } },
      { id: 'e4', from: { nodeId: 'a-cs',  portId: 'out_r' }, to: { nodeId: 'a-out', portId: 'R' } },
    ],
  );

  await page.waitForTimeout(300);

  // Sweep every macro AudioParam through its 0..1 range. Any worklet-level
  // assertion failure or NaN-propagation will surface in the console.
  const macros: ReadonlyArray<string> = ['dry_out', 'early_out', 'late_out', 'input_mix', 'low_cut', 'high_cut', 'cross_seed'];
  const values: ReadonlyArray<number> = [0, 0.25, 0.5, 0.75, 1, 0.5];
  for (const macro of macros) {
    for (const v of values) {
      await page.evaluate(([m, vv]) => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { params: Record<string, number> }> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => {
          const n = w.__patch.nodes['a-cs'];
          if (n) n.params[m as string] = vv as number;
        });
      }, [macro, v] as const);
      await page.waitForTimeout(30);
    }
  }

  // Also toggle the panel-pill switches — exercises the message-port path.
  const pills = ['cs-tap-enabled', 'cs-diff-enabled', 'cs-late-diffuse-enabled', 'cs-eq-low', 'cs-eq-high', 'cs-eq-lp', 'cs-loc-enabled', 'cs-hic-enabled'];
  for (const t of pills) {
    await page.locator(`[data-testid="${t}"]`).click();
    await page.waitForTimeout(40);
  }

  expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
});
