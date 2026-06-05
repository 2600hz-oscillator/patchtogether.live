// e2e/tests/toybox-keyer-config.spec.ts
//
// TOYBOX keyer-config popover + the CV-model/combine-graph refinements:
//
//   1. KEYER CONFIG (the feature): right-click a LUMAKEY / CHROMAKEY combine
//      node → "Configure keyer…" → a popover with THRESHOLD + SHARPNESS knobs
//      (both keyers) + a COLOR PICKER (chromakey). Changing threshold moves the
//      node's `amount` param + the live composite changes; the colour picker
//      drives keyR/keyG/keyB. A non-keyer node (fade/map) shows NO configure item.
//   2. UNIQUE NODE NAMES (#58): two LUMAKEY nodes render distinct labels
//      (LUMA 1 / LUMA 2) in the node map.
//   3. CV REACTIVITY (#60): contenting a 3rd layer makes it appear as a CV target
//      with params (the stale-list regression).
//   4. ORPHAN AUTO-UNMAP (#60): route a CV port to a combine node, delete that
//      node → the route is auto-cleared from node.data.cvRoutes.
//
// CI robustness mirrors toybox-node-menu.spec.ts: generous video-domain
// test.setTimeout (CI's software WebGL starves the main thread — see repo memory
// ci-swiftshader-video-e2e-timeouts), pinViewport, clickEd(force+noWaitAfter),
// expect.poll for the async Yjs → reactive settle on node.data reads.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch, ensureCombineOpen } from './_helpers';

type CombineNode = { id: string; kind: string; params?: Record<string, number> };
type CombineEdge = { id: string; from: string; to: string; toPort: string };
type PatchGlobal = {
  __patch: {
    nodes: Record<
      string,
      {
        data?: {
          combine?: { nodes?: CombineNode[]; edges?: CombineEdge[] };
          layers?: unknown[];
          cvRoutes?: Record<string, { target?: string; nodeId?: string; layer?: number; param?: string } | null>;
        };
      }
    >;
  };
  __ydoc: { transact: (fn: () => void) => void };
  __toyboxFreeze?: (t?: number) => void;
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

/** Seed two distinct GEN layers + clear the combine so the first editor touch
 *  seeds the default graph. */
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
  await page
    .locator(`[data-testid="${testid}"]`)
    .first()
    .click({ button: 'right', force: true, noWaitAfter: true });
}

async function readCombine(page: Page): Promise<{ nodes: CombineNode[]; edges: CombineEdge[] }> {
  return page.evaluate(() => {
    const w = globalThis as unknown as PatchGlobal;
    const c = w.__patch.nodes['tb']?.data?.combine;
    return { nodes: c?.nodes ?? [], edges: c?.edges ?? [] };
  });
}
async function readCvRoutes(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    const w = globalThis as unknown as PatchGlobal;
    return (w.__patch.nodes['tb']?.data?.cvRoutes ?? {}) as Record<string, unknown>;
  });
}
async function findNodeId(page: Page, kind: string): Promise<string | null> {
  const { nodes } = await readCombine(page);
  return nodes.find((n) => n.kind === kind)?.id ?? null;
}
async function findNodeIds(page: Page, kind: string): Promise<string[]> {
  const { nodes } = await readCombine(page);
  return nodes.filter((n) => n.kind === kind).map((n) => n.id);
}
async function nodeParam(page: Page, nodeId: string, pid: string): Promise<number | undefined> {
  const { nodes } = await readCombine(page);
  return nodes.find((n) => n.id === nodeId)?.params?.[pid];
}

const menu = (page: Page) => page.locator('[data-testid="toybox-node-menu"]');
const keyerPop = (page: Page) => page.locator('[data-testid="toybox-keyer-config"]');

async function frozenAverage(page: Page, time: number): Promise<[number, number, number]> {
  await page.waitForFunction(
    ({ time }) => {
      const g = globalThis as unknown as PatchGlobal;
      g.__toyboxFreeze?.(time);
      const c = document.querySelector('[data-testid="toybox-canvas"]') as HTMLCanvasElement | null;
      if (!c) return false;
      const ctx = c.getContext('2d');
      if (!ctx) return false;
      const { data } = ctx.getImageData(0, 0, c.width, c.height);
      let lit = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i]! > 16 || data[i + 1]! > 16 || data[i + 2]! > 16) lit++;
      }
      return lit > c.width * c.height * 0.05;
    },
    { time },
    { timeout: 30_000 },
  );
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
  return page.evaluate(() => {
    const c = document.querySelector('[data-testid="toybox-canvas"]') as HTMLCanvasElement;
    const ctx = c.getContext('2d')!;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) { r += data[i]!; g += data[i + 1]!; b += data[i + 2]!; n++; }
    return [r / n, g / n, b / n] as [number, number, number];
  });
}
function dist(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Boot a toybox, seed two layers, open the editor + seed the default graph. */
async function setup(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [{ id: 'tb', type: 'toybox', position: { x: 80, y: 40 }, domain: 'video' }],
    [],
  );
  await page.locator('.svelte-flow__node-toybox').first().waitFor({ state: 'visible', timeout: 10_000 });
  await pinViewport(page);
  await seedTwoLayers(page);
  await ensureCombineOpen(page);
  await expect(page.locator('[data-testid="toybox-graph-svg"]')).toBeVisible();
  await clickEd(page, 'toybox-add-fade'); // seeds the default graph in place
  await expect(page.locator('[data-testid="toybox-gnode-src0"]')).toBeVisible();
}

test.describe('TOYBOX keyer-config + CV refinements', () => {
  test('LUMAKEY: Configure keyer → THRESHOLD changes the node param + output', async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await setup(page);

    // Add a LUMAKEY + wire src0/src1 into it + it to OUTPUT so it drives output.
    await clickEd(page, 'toybox-add-lumakey');
    const lk = (await findNodeId(page, 'lumakey'))!;
    expect(lk).toBeTruthy();
    await clickEd(page, 'toybox-outport-src0');
    await clickEd(page, `toybox-inport-${lk}-in0`);
    await clickEd(page, 'toybox-outport-src1');
    await clickEd(page, `toybox-inport-${lk}-in1`);
    await rightClickEd(page, `toybox-gnode-${lk}`);
    await expect(menu(page)).toBeVisible();
    await page.locator('[data-testid="toybox-menu-patch-output"]').click({ noWaitAfter: true });

    const before = await frozenAverage(page, 1.5);

    // Configure keyer → popover with THRESHOLD + SHARPNESS, NO colour picker.
    await rightClickEd(page, `toybox-gnode-${lk}`);
    await expect(menu(page)).toBeVisible();
    await expect(page.locator('[data-testid="toybox-menu-configure-keyer"]')).toBeVisible();
    await page.locator('[data-testid="toybox-menu-configure-keyer"]').click({ noWaitAfter: true });
    await expect(keyerPop(page)).toBeVisible();
    await expect(page.locator('[data-testid="toybox-keyer-threshold"]')).toBeVisible();
    await expect(page.locator('[data-testid="toybox-keyer-sharpness"]')).toBeVisible();
    await expect(page.locator('[data-testid="toybox-keyer-color"]')).toHaveCount(0); // lumakey: no colour

    // Drag the THRESHOLD knob up → its `amount` param moves.
    const amtBefore = (await nodeParam(page, lk, 'amount')) ?? 0.5;
    const knob = page.locator('[data-testid="toybox-keyer-threshold"]').locator('canvas, svg, [role="slider"]').first();
    const box = (await page.locator('[data-testid="toybox-keyer-threshold"]').boundingBox())!;
    // Vertical drag UP increases the value.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y - 40, { steps: 6 });
    await page.mouse.up();
    void knob;

    await expect
      .poll(async () => (await nodeParam(page, lk, 'amount')) ?? amtBefore, { timeout: 10_000 })
      .not.toBe(amtBefore);

    // Live composite changed.
    const after = await frozenAverage(page, 1.5);
    expect(dist(before, after), 'changing threshold changes the keyer output').toBeGreaterThan(2);

    await page.locator('[data-testid="toybox-keyer-done"]').click({ noWaitAfter: true });
    await expect(keyerPop(page)).toHaveCount(0);

    expect(errors.filter((e) => !e.includes('AudioContext')), 'no console / page errors').toEqual([]);
  });

  test('CHROMAKEY: Configure keyer shows a COLOR PICKER that drives keyR/keyG/keyB', async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await setup(page);
    await clickEd(page, 'toybox-add-chromakey');
    const ck = (await findNodeId(page, 'chromakey'))!;
    expect(ck).toBeTruthy();

    await rightClickEd(page, `toybox-gnode-${ck}`);
    await expect(menu(page)).toBeVisible();
    await page.locator('[data-testid="toybox-menu-configure-keyer"]').click({ noWaitAfter: true });
    await expect(keyerPop(page)).toBeVisible();
    const colorInput = page.locator('[data-testid="toybox-keyer-color"]');
    await expect(colorInput).toBeVisible();

    // Default key colour = green (0,1,0). Set it to pure red via the picker.
    await colorInput.evaluate((el: HTMLInputElement) => {
      el.value = '#ff0000';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await expect
      .poll(async () => {
        const r = await nodeParam(page, ck, 'keyR');
        const g = await nodeParam(page, ck, 'keyG');
        const b = await nodeParam(page, ck, 'keyB');
        return `${r},${g},${b}`;
      }, { timeout: 10_000 })
      .toBe('1,0,0');

    // The old single `key` param is never (re)introduced.
    expect(await nodeParam(page, ck, 'key')).toBeUndefined();

    expect(errors.filter((e) => !e.includes('AudioContext')), 'no console / page errors').toEqual([]);
  });

  test('non-keyer node (fade) has NO Configure keyer item', async ({ page }) => {
    test.setTimeout(120_000);
    await setup(page);
    const fade = (await findNodeId(page, 'fade'))!;
    await rightClickEd(page, `toybox-gnode-${fade}`);
    await expect(menu(page)).toBeVisible();
    await expect(page.locator('[data-testid="toybox-menu-configure-keyer"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
  });

  test('UNIQUE node names (#58): two LUMAKEY nodes render LUMA 1 / LUMA 2', async ({ page }) => {
    test.setTimeout(120_000);
    await setup(page);
    await clickEd(page, 'toybox-add-lumakey');
    await clickEd(page, 'toybox-add-lumakey');
    const lks = await findNodeIds(page, 'lumakey');
    expect(lks.length).toBe(2);
    const labels = await Promise.all(
      lks.map(async (nid) =>
        ((await page.locator(`[data-testid="toybox-gnode-${nid}"] .gnode-label`).first().textContent()) ?? '').trim(),
      ),
    );
    expect(new Set(labels).size).toBe(2); // distinct
    expect(labels.sort()).toEqual(['LUMA 1', 'LUMA 2']);
  });

  test('CV REACTIVITY (#60): a newly-contented 3rd layer appears as a CV target with params', async ({ page }) => {
    test.setTimeout(120_000);
    await setup(page);

    // Open CV section + count the layer targets visible in IN1's target dropdown.
    const targetSel = page.locator('[data-testid="toybox-cv-target-cv1"]');
    await expect(targetSel).toBeVisible();

    // Content the 3rd layer (index 2) — was 'off', tag it as a GEN layer.
    // SyncedStore arrays don't support index assignment; splice in place.
    await page.evaluate(() => {
      const w = globalThis as unknown as PatchGlobal;
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['tb']!;
        const layers = n.data!.layers as unknown[];
        layers.splice(2, 1, { kind: 'gen', contentId: 'noise-fbm', params: {} });
      });
    });

    // Route IN1 → Layer 3 (value layer:2). The option must EXIST + selecting it
    // populates the param dropdown (reactivity: the list recomputed live).
    await expect
      .poll(async () => {
        const opts = await targetSel.locator('option').allTextContents();
        return opts.some((o) => /^Layer 3 /.test(o));
      }, { timeout: 10_000 })
      .toBe(true);

    await targetSel.selectOption('layer:2');
    const paramSel = page.locator('[data-testid="toybox-cv-param-cv1"]');
    await expect
      .poll(async () => (await paramSel.locator('option').count()), { timeout: 10_000 })
      .toBeGreaterThan(0);
    await expect(paramSel).toBeEnabled();

    // The route persisted to node.data.cvRoutes pointing at layer 2.
    await expect
      .poll(async () => {
        const r = (await readCvRoutes(page)).cv1 as { layer?: number } | null;
        return r?.layer;
      }, { timeout: 10_000 })
      .toBe(2);
  });

  test('ORPHAN auto-unmap (#60): deleting a routed combine node clears its CV route', async ({ page }) => {
    test.setTimeout(120_000);
    await setup(page);

    // Add a chromakey node + route IN2 → it.
    await clickEd(page, 'toybox-add-chromakey');
    const ck = (await findNodeId(page, 'chromakey'))!;
    const targetSel = page.locator('[data-testid="toybox-cv-target-cv2"]');
    await expect
      .poll(async () => {
        const vals = await targetSel.locator('option').evaluateAll((els) =>
          (els as HTMLOptionElement[]).map((e) => e.value),
        );
        return vals.includes(`combine:${ck}`);
      }, { timeout: 10_000 })
      .toBe(true);
    await targetSel.selectOption(`combine:${ck}`);

    await expect
      .poll(async () => {
        const r = (await readCvRoutes(page)).cv2 as { nodeId?: string } | null;
        return r?.nodeId;
      }, { timeout: 10_000 })
      .toBe(ck);

    // Delete the routed node via its delete affordance.
    await clickEd(page, `toybox-delnode-${ck}`);

    // The orphaned route is auto-unmapped (cleared to null).
    await expect
      .poll(async () => {
        const r = (await readCvRoutes(page)).cv2;
        return r ?? null;
      }, { timeout: 10_000 })
      .toBeNull();
    // The node is gone from the combine graph.
    expect(await findNodeId(page, 'chromakey')).toBeNull();
  });
});
