// e2e/tests/toybox-feedback-config.spec.ts
//
// TOYBOX "Configure feedback…" popover — the discoverable right-click config for
// a FEEDBACK combine node, mirroring the keyer-config popover so feedback is
// configurable the SAME way LUMAKEY/CHROMAKEY are.
//
//   - right-click a FEEDBACK node → "Configure feedback…" → a popover with a
//     MODE <select> (12 modes) + the relevant per-mode param knobs.
//   - picking a MODE writes node.data.combine fb.params.mode AND swaps the
//     visible knob set to that mode's relevant params (FEEDBACK_MODE_PARAMS).
//   - a non-feedback node (fade) shows NO "Configure feedback" item.
//
// DETERMINISTIC BY DESIGN: every assertion reads the on-card DOM or the live
// node.data (Yjs) — NO canvas/pixel averages — so it does not depend on the
// CI SwiftShader renderer (the source of the toybox video flake class). Still
// given a generous video-domain budget for the cold spawn + editor warm-up.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch, ensureCombineOpen } from './_helpers';

type CombineNode = { id: string; kind: string; params?: Record<string, number> };
type PatchGlobal = {
  __patch: {
    nodes: Record<string, { data?: { combine?: { nodes?: CombineNode[] }; layers?: unknown[] } }>;
  };
  __ydoc: { transact: (fn: () => void) => void };
};

async function pinViewport(page: Page): Promise<void> {
  await page.evaluate(() => {
    const vp = document.querySelector('.svelte-flow__viewport') as HTMLElement | null;
    if (!vp) return;
    vp.style.transition = 'none';
    vp.style.transform = 'translate(8px, -24px) scale(1)';
  });
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

async function seedTwoLayers(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = globalThis as unknown as PatchGlobal;
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['tb'];
      if (!n) return;
      if (!n.data) n.data = {};
      n.data.layers = [
        { kind: 'gen', contentId: 'noise-fbm', params: {} },
        { kind: 'gen', contentId: 'worley-cells', params: {} },
        { kind: 'off', contentId: null, params: {} },
        { kind: 'off', contentId: null, params: {} },
      ] as unknown[];
      delete (n.data as { combine?: unknown }).combine;
    });
  });
}

async function clickEd(page: Page, testid: string): Promise<void> {
  await page.locator(`[data-testid="${testid}"]`).click({ force: true, noWaitAfter: true });
}
async function rightClickEd(page: Page, testid: string): Promise<void> {
  await page.locator(`[data-testid="${testid}"]`).first().click({ button: 'right', force: true, noWaitAfter: true });
}
async function readNodes(page: Page): Promise<CombineNode[]> {
  return page.evaluate(() => {
    const w = globalThis as unknown as PatchGlobal;
    return w.__patch.nodes['tb']?.data?.combine?.nodes ?? [];
  });
}
async function findNodeId(page: Page, kind: string): Promise<string | null> {
  return (await readNodes(page)).find((n) => n.kind === kind)?.id ?? null;
}
async function nodeParam(page: Page, nodeId: string, pid: string): Promise<number | undefined> {
  return (await readNodes(page)).find((n) => n.id === nodeId)?.params?.[pid];
}

const menu = (page: Page) => page.locator('[data-testid="toybox-node-menu"]');
const fbPop = (page: Page) => page.locator('[data-testid="toybox-feedback-config"]');
const knob = (page: Page, pid: string) => page.locator(`[data-testid="toybox-feedback-knob-${pid}"]`);

/** Right-click a graph node until its context menu opens. The single right-click
 *  can land before the freshly-added node is interactive on cold SwiftShader, so
 *  we retry the (click → assert menu) pair — robust, never a one-shot race. */
async function openNodeMenu(page: Page, nid: string): Promise<void> {
  await expect(page.locator(`[data-testid="toybox-gnode-${nid}"]`)).toBeVisible({ timeout: 15_000 });
  await expect(async () => {
    await rightClickEd(page, `toybox-gnode-${nid}`);
    await expect(menu(page)).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 20_000 });
}

async function setup(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'tb', type: 'toybox', position: { x: 80, y: 40 }, domain: 'video' }], []);
  await page.locator('.svelte-flow__node-toybox').first().waitFor({ state: 'visible', timeout: 10_000 });
  await pinViewport(page);
  await seedTwoLayers(page);
  // Cold SwiftShader (CI + local --use-angle=swiftshader) can take well over 5s
  // to first-render the toybox card's combine editor; wait generously for the
  // graph BEFORE ensureCombineOpen's tighter internal toggle wait so the setup
  // never flakes on a slow cold first paint (the editor is open by default).
  await page.locator('[data-testid="toybox-graph-svg"]').waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {});
  await ensureCombineOpen(page);
  await expect(page.locator('[data-testid="toybox-graph-svg"]')).toBeVisible({ timeout: 15_000 });
  await clickEd(page, 'toybox-add-fade'); // seeds the default graph in place
  await expect(page.locator('[data-testid="toybox-gnode-src0"]')).toBeVisible({ timeout: 15_000 });
}

/** Open the Configure-feedback popover for a freshly-added feedback node. */
async function addFeedbackAndOpen(page: Page): Promise<string> {
  await clickEd(page, 'toybox-add-feedback');
  const fb = (await findNodeId(page, 'feedback'))!;
  expect(fb, 'a feedback node was added').toBeTruthy();
  await openNodeMenu(page, fb);
  await expect(page.locator('[data-testid="toybox-menu-configure-feedback"]')).toBeVisible();
  await page.locator('[data-testid="toybox-menu-configure-feedback"]').click({ noWaitAfter: true });
  await expect(fbPop(page)).toBeVisible({ timeout: 10_000 });
  return fb;
}

test.describe('TOYBOX Configure-feedback popover', () => {
  test('right-click FEEDBACK → Configure feedback → MODE select + per-mode knobs', async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await setup(page);
    await addFeedbackAndOpen(page);

    // MODE select present; default mode 0 (TUNNEL) → zoom/rotate/decay knobs, NOT blur.
    await expect(page.locator('[data-testid="toybox-feedback-config-mode-select"]')).toBeVisible();
    await expect(knob(page, 'zoom')).toBeVisible();
    await expect(knob(page, 'rotate')).toBeVisible();
    await expect(knob(page, 'decay')).toBeVisible();
    await expect(knob(page, 'blur')).toHaveCount(0);

    expect(errors.filter((e) => !e.includes('AudioContext')), 'no console / page errors').toEqual([]);
  });

  test('picking a MODE writes fb.params.mode + swaps the visible knob set', async ({ page }) => {
    test.setTimeout(120_000);
    await setup(page);
    const fb = await addFeedbackAndOpen(page);

    // Switch to BLUR (mode 5): node param updates + BLUR knob appears, ZOOM goes.
    await page.locator('[data-testid="toybox-feedback-config-mode-select"]').selectOption('5');
    await expect.poll(async () => await nodeParam(page, fb, 'mode'), { timeout: 10_000 }).toBe(5);
    await expect(knob(page, 'blur')).toBeVisible();
    await expect(knob(page, 'zoom')).toHaveCount(0);

    // Switch to LUMAGATE (mode 10): THRESH knob appears.
    await page.locator('[data-testid="toybox-feedback-config-mode-select"]').selectOption('10');
    await expect.poll(async () => await nodeParam(page, fb, 'mode'), { timeout: 10_000 }).toBe(10);
    await expect(knob(page, 'thresh')).toBeVisible();
  });

  test('dragging a knob writes the combine-node param in place', async ({ page }) => {
    test.setTimeout(120_000);
    await setup(page);
    const fb = await addFeedbackAndOpen(page);

    // DECAY is relevant to every mode; drag it up and confirm node.data updates.
    const decayBefore = (await nodeParam(page, fb, 'decay')) ?? 0.9;
    const box = (await knob(page, 'decay').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y - 40, { steps: 6 });
    await page.mouse.up();

    await expect
      .poll(async () => (await nodeParam(page, fb, 'decay')) ?? decayBefore, { timeout: 10_000 })
      .not.toBe(decayBefore);

    // Done closes the popover.
    await page.locator('[data-testid="toybox-feedback-config-done"]').click({ noWaitAfter: true });
    await expect(fbPop(page)).toHaveCount(0);
  });

  test('a non-feedback node (fade) has NO Configure feedback item', async ({ page }) => {
    test.setTimeout(120_000);
    await setup(page);
    const fade = (await findNodeId(page, 'fade'))!;
    await openNodeMenu(page, fade);
    await expect(page.locator('[data-testid="toybox-menu-configure-feedback"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
  });
});
