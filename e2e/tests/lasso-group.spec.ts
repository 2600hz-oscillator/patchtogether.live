// e2e/tests/lasso-group.spec.ts
//
// Right-click-driven group lasso (replaces PR-133 left-drag marquee).
//
// User flow:
//   1. left-drag empty pane → SvelteFlow pans (default behavior restored)
//   2. right-click empty pane → ModulePalette opens
//   3. click "Create group" → lasso mode engages, bounding box follows cursor
//   4. nodes inside the box highlight (lasso-hit class) live as cursor moves
//   5. right-click (or left-click) commits → GroupBuilderModal opens with
//      the lassoed ids pre-selected
//   6. Esc cancels silently — no modal, no graph mutation
//
// Pointer events through Svelte Flow's pane handler are notoriously
// timing-sensitive across CI + headed runs, so the lasso drive uses the
// dev-mode `__lasso` window probe (matches the pattern established by
// `__openGroupBuilder` in grouping-phase1.spec.ts). The render path +
// hit-test logic still get hit; only the synthetic pointer events are
// short-circuited.

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

interface PatchNode {
  id: string;
  type: string;
  position: { x: number; y: number };
}

async function setupChain(page: Page): Promise<void> {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      { id: 'lfo-1', type: 'lfo',      position: { x: 100, y: 100 }, domain: 'audio' },
      { id: 'flt-1', type: 'filter',   position: { x: 400, y: 100 }, domain: 'audio' },
      { id: 'out-1', type: 'audioOut', position: { x: 800, y: 100 }, domain: 'audio' },
    ],
    [],
  );
  await expect(page.locator('.svelte-flow__node[data-id="lfo-1"]')).toBeVisible();
  await expect(page.locator('.svelte-flow__node[data-id="flt-1"]')).toBeVisible();
  await expect(page.locator('.svelte-flow__node[data-id="out-1"]')).toBeVisible();
}

test('left-drag empty pane pans the SvelteFlow viewport (default behavior restored)', async ({ page, rack }) => {
  await spawnPatch(
    page,
    [{ id: 'lfo-1', type: 'lfo', position: { x: 100, y: 100 }, domain: 'audio' }],
    [],
  );
  await expect(page.locator('.svelte-flow__node[data-id="lfo-1"]')).toBeVisible();

  const readTransform = async (): Promise<string> =>
    await page.locator('.svelte-flow__viewport').first().evaluate(
      (el) => getComputedStyle(el as HTMLElement).transform,
    );

  const before = await readTransform();

  const pane = page.locator('.svelte-flow__pane');
  const box = await pane.boundingBox();
  if (!box) throw new Error('no pane');
  // Start far from the centered single node to ensure we're over empty pane.
  const startX = box.x + box.width * 0.85;
  const startY = box.y + box.height * 0.5;
  await page.mouse.move(startX, startY);
  await page.mouse.down({ button: 'left' });
  await page.mouse.move(startX - 80, startY - 40, { steps: 12 });
  await page.mouse.move(startX - 160, startY - 80, { steps: 12 });
  await page.mouse.up({ button: 'left' });

  const after = await readTransform();
  expect(after).not.toBe(before);
});

test('right-click pane → palette shows "Create group" tool entry', async ({ page, rack }) => {
  const pane = page.locator('.svelte-flow__pane');
  const box = await pane.boundingBox();
  if (!box) throw new Error('no pane');
  await page.mouse.click(box.x + 200, box.y + 200, { button: 'right' });
  await expect(page.locator('.module-palette')).toBeVisible();
  const createGroup = page.locator('[data-testid="palette-create-group"]');
  await expect(createGroup).toBeVisible();
  await expect(createGroup).toHaveText(/Create instrument/);
});

test('clicking "Create group" closes palette and enters lasso mode', async ({ page }) => {
  await setupChain(page);
  const pane = page.locator('.svelte-flow__pane');
  const box = await pane.boundingBox();
  if (!box) throw new Error('no pane');
  // Right-click EMPTY pane to open the palette. The chain nodes sit in a
  // horizontal band near the vertical center after fitView; the rack-sized
  // cards (lfo is 2u = 360px tall) now reach the top-left corner where this
  // used to click, so target the lower-center band which stays empty (#759).
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height - 60, { button: 'right' });
  await expect(page.locator('.module-palette')).toBeVisible();
  await page.locator('[data-testid="palette-create-group"]').click();
  await expect(page.locator('.module-palette')).toHaveCount(0);
  await expect(page.locator('[data-testid="canvas-root"].lasso-mode')).toHaveCount(1);
  await expect(page.locator('[data-testid="lasso-overlay"]')).toHaveCount(1);
});

test('lasso mode highlights overlapping nodes and commits to group builder', async ({ page }) => {
  await setupChain(page);

  // Drive the lasso bounding box to cover lfo-1 + flt-1 but not out-1.
  // We compute flow→screen via the viewport CSS transform so the box
  // matches whatever fitView settled on for this run.
  await page.evaluate(() => {
    const w = window as unknown as {
      __lasso: {
        enter: (x: number, y: number) => void;
        setCursor: (x: number, y: number) => void;
      };
    };
    const fScreen = (p: { x: number; y: number }) => {
      const el = document.querySelector('.svelte-flow__viewport') as HTMLElement | null;
      if (!el) return p;
      const m = new DOMMatrix(getComputedStyle(el).transform);
      return { x: p.x * m.a + m.e, y: p.y * m.d + m.f };
    };
    const screenStart = fScreen({ x: 50, y: 50 });
    const screenEnd = fScreen({ x: 600, y: 250 });
    w.__lasso.enter(screenStart.x, screenStart.y);
    w.__lasso.setCursor(screenEnd.x, screenEnd.y);
  });

  const hits = await page.evaluate(() => {
    const w = window as unknown as { __lasso: { hits: () => string[] } };
    return w.__lasso.hits();
  });
  expect(hits).toContain('lfo-1');
  expect(hits).toContain('flt-1');
  expect(hits).not.toContain('out-1');

  await expect(page.locator('.svelte-flow__node[data-id="lfo-1"].lasso-hit')).toHaveCount(1);
  await expect(page.locator('.svelte-flow__node[data-id="flt-1"].lasso-hit')).toHaveCount(1);
  await expect(page.locator('.svelte-flow__node[data-id="out-1"].lasso-hit')).toHaveCount(0);

  await page.evaluate(() => {
    const w = window as unknown as { __lasso: { commit: () => void } };
    w.__lasso.commit();
  });
  await expect(page.locator('[data-testid="group-builder-modal"]')).toBeVisible();
  await expect(page.locator('[data-testid="canvas-root"].lasso-mode')).toHaveCount(0);
});

test('Escape cancels lasso silently (no modal, no graph mutation)', async ({ page }) => {
  await setupChain(page);
  const beforeNodes = await page.evaluate(() => {
    const w = window as unknown as { __patch: { nodes: Record<string, PatchNode> } };
    return Object.keys(w.__patch.nodes).length;
  });

  await page.evaluate(() => {
    const w = window as unknown as {
      __lasso: {
        enter: (x: number, y: number) => void;
        setCursor: (x: number, y: number) => void;
      };
    };
    w.__lasso.enter(100, 100);
    w.__lasso.setCursor(800, 400);
  });
  await expect(page.locator('[data-testid="canvas-root"].lasso-mode')).toHaveCount(1);

  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="canvas-root"].lasso-mode')).toHaveCount(0);
  await expect(page.locator('[data-testid="group-builder-modal"]')).toHaveCount(0);

  const afterNodes = await page.evaluate(() => {
    const w = window as unknown as { __patch: { nodes: Record<string, PatchNode> } };
    return Object.keys(w.__patch.nodes).length;
  });
  expect(afterNodes).toBe(beforeNodes);
});

test('lasso with <2 nodes inside aborts silently (no modal)', async ({ page }) => {
  await setupChain(page);

  await page.evaluate(() => {
    const w = window as unknown as {
      __lasso: {
        enter: (x: number, y: number) => void;
        setCursor: (x: number, y: number) => void;
        commit: () => void;
      };
    };
    const fScreen = (p: { x: number; y: number }) => {
      const el = document.querySelector('.svelte-flow__viewport') as HTMLElement | null;
      if (!el) return p;
      const m = new DOMMatrix(getComputedStyle(el).transform);
      return { x: p.x * m.a + m.e, y: p.y * m.d + m.f };
    };
    const s1 = fScreen({ x: 80, y: 80 });
    const s2 = fScreen({ x: 180, y: 200 });
    w.__lasso.enter(s1.x, s1.y);
    w.__lasso.setCursor(s2.x, s2.y);
    w.__lasso.commit();
  });

  await expect(page.locator('[data-testid="group-builder-modal"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="canvas-root"].lasso-mode')).toHaveCount(0);
});
