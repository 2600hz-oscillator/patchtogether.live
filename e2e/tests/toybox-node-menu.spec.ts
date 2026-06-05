// e2e/tests/toybox-node-menu.spec.ts
//
// TOYBOX combine-graph editor — the CONTEXTUAL right-click (contextmenu) menu.
//
// The in-card node-map editor (the bespoke SVG combine graph) has its own menu
// that is AWARE of what was right-clicked:
//   - NODE (op)     → Patch to output / Disconnect / Duplicate / Delete
//   - NODE (source) → Patch to output / Disconnect          (no Delete/Duplicate)
//   - NODE (output) → Disconnect                            (no Patch-to-output)
//   - PORT (output) → Patch to output / Disconnect this port / Begin wire
//   - PORT (input)  → Disconnect this port
//   - EDGE          → Delete edge
//   - CANVAS        → Add node ▸ (fade/lumakey/chromakey/map) / Clear / Reset
//
// HEADLINE story (the reason this feature exists): build a more-complex chain,
// then right-click the chain's FINAL node → "Patch to output". We assert both
// node.data.combine (the edge swap) AND a measurable composite change.
//
// CI robustness mirrors toybox-combine-editor.spec.ts: test.setTimeout(60s),
// pinViewport, seedTwoLayers, clickEd(force+noWaitAfter), expect.poll for the
// async Yjs → reactive settle on node.data reads.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch, ensureCombineOpen } from './_helpers';

type CombineNode = { id: string; kind: string };
type CombineEdge = { id: string; from: string; to: string; toPort: string };
type PatchGlobal = {
  __patch: {
    nodes: Record<
      string,
      { data?: { combine?: { nodes?: CombineNode[]; edges?: CombineEdge[] }; layers?: unknown[] } }
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

/** Seed two bright DISTINCT layers + clear the combine so the first editor touch
 *  seeds the default graph (matches the combine-editor spec). */
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
      return lit > c.width * c.height * 0.1;
    },
    { time },
    // CI's software WebGL renderer starves the main thread; a lit frozen
    // composite can take well past 10s. Match toybox-combine-editor's 30s.
    { timeout: 30_000 },
  );
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
  return page.evaluate(() => {
    const c = document.querySelector('[data-testid="toybox-canvas"]') as HTMLCanvasElement;
    const ctx = c.getContext('2d')!;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) {
      r += data[i]!; g += data[i + 1]!; b += data[i + 2]!; n++;
    }
    return [r / n, g / n, b / n] as [number, number, number];
  });
}

function dist(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Left-click an editor control by testid (force past the bottombar footer +
 *  noWaitAfter to skip the no-op navigation settle — see combine-editor spec). */
async function clickEd(page: Page, testid: string): Promise<void> {
  await page.locator(`[data-testid="${testid}"]`).click({ force: true, noWaitAfter: true });
}

/** Right-click an editor element by testid (opens the contextual menu). */
async function rightClickEd(page: Page, testid: string): Promise<void> {
  await page
    .locator(`[data-testid="${testid}"]`)
    .first()
    .click({ button: 'right', force: true, noWaitAfter: true });
}

/** Right-click a precise screen point with the right mouse button. */
async function rightClickAt(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.click(x, y, { button: 'right' });
}

/** Right-click an edge at its stroke MIDPOINT (screen coords mapped through the
 *  live CTM). The cable now has a wide transparent hit-path, so a coordinate
 *  right-click on the midpoint reliably lands on the stroke. */
async function rightClickEdge(page: Page, edgeId: string): Promise<void> {
  const p = await page.evaluate((edgeId) => {
    const el = document.querySelector(`[data-testid="toybox-edge-${edgeId}"]`) as SVGPathElement | null;
    if (!el) throw new Error(`edge ${edgeId} not found`);
    const len = el.getTotalLength();
    const pt = el.getPointAtLength(len / 2);
    const ctm = el.getScreenCTM()!;
    return { x: pt.x * ctm.a + pt.y * ctm.c + ctm.e, y: pt.x * ctm.b + pt.y * ctm.d + ctm.f };
  }, edgeId);
  await page.mouse.click(p.x, p.y, { button: 'right' });
}

/** Screen-space coords of an EMPTY point inside the SVG (top-right band, clear
 *  of the source/op/output node boxes), for the canvas-target right-click. */
async function emptyCanvasScreen(page: Page): Promise<{ x: number; y: number }> {
  const svg = page.locator('[data-testid="toybox-graph-svg"]');
  const box = (await svg.boundingBox())!;
  // The top-right ~quarter is empty (sources left, ops centre, output mid-right).
  return { x: box.x + box.width * 0.85, y: box.y + box.height * 0.18 };
}

/** Read the live combine graph from node.data. */
async function readCombine(page: Page): Promise<{ nodes: CombineNode[]; edges: CombineEdge[] }> {
  return page.evaluate(() => {
    const w = globalThis as unknown as PatchGlobal;
    const c = w.__patch.nodes['tb']?.data?.combine;
    return { nodes: c?.nodes ?? [], edges: c?.edges ?? [] };
  });
}

/** Find a node id by kind (first match, or one not already wired-to). */
async function findNodeId(page: Page, kind: string): Promise<string | null> {
  const { nodes } = await readCombine(page);
  return nodes.find((n) => n.kind === kind)?.id ?? null;
}

const menu = (page: Page) => page.locator('[data-testid="toybox-node-menu"]');

/** Boot a single toybox, seed two layers, open the editor + force a default-graph
 *  seed (the seed only exists AFTER the first mutation). Returns once the src/op/
 *  out testids exist. */
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
  // seedTwoLayers deleted node.data.combine, so the default graph only exists
  // after the first mutation. Adding an op seeds the default in place first.
  await clickEd(page, 'toybox-add-fade');
  // src0 / out testids now exist.
  await expect(page.locator('[data-testid="toybox-gnode-src0"]')).toBeVisible();
}

test.describe('TOYBOX node-map contextual menu', () => {
  test('per-target menu items are correct + Escape closes', async ({ page }) => {
    test.setTimeout(120_000); // menu + chain-build + patch is heavier than combine-editor; CI WebGL starvation needs the headroom
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await setup(page);

    // ---- NODE (op) ----
    const opId = await findNodeId(page, 'fade');
    expect(opId).toBeTruthy();
    await rightClickEd(page, `toybox-gnode-${opId}`);
    await expect(menu(page)).toBeVisible();
    await expect(page.locator('[data-testid="toybox-menu-patch-output"]')).toBeVisible();
    await expect(page.locator('[data-testid="toybox-menu-disconnect"]')).toBeVisible();
    await expect(page.locator('[data-testid="toybox-menu-duplicate"]')).toBeVisible();
    await expect(page.locator('[data-testid="toybox-menu-delete-node"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu(page)).toHaveCount(0);

    // ---- NODE (source): Patch to output + Disconnect, NO Delete/Duplicate ----
    await rightClickEd(page, 'toybox-gnode-src0');
    await expect(menu(page)).toBeVisible();
    await expect(page.locator('[data-testid="toybox-menu-patch-output"]')).toBeVisible();
    await expect(page.locator('[data-testid="toybox-menu-disconnect"]')).toBeVisible();
    await expect(page.locator('[data-testid="toybox-menu-delete-node"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="toybox-menu-duplicate"]')).toHaveCount(0);
    await page.keyboard.press('Escape');

    // ---- NODE (output): Disconnect only, NO Patch-to-output / Delete ----
    const outId = await findNodeId(page, 'output');
    await rightClickEd(page, `toybox-gnode-${outId}`);
    await expect(menu(page)).toBeVisible();
    await expect(page.locator('[data-testid="toybox-menu-disconnect"]')).toBeVisible();
    await expect(page.locator('[data-testid="toybox-menu-patch-output"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="toybox-menu-delete-node"]')).toHaveCount(0);
    await page.keyboard.press('Escape');

    // ---- PORT (output dot): Patch to output present + Begin wire ----
    await rightClickEd(page, 'toybox-outport-src0');
    await expect(menu(page)).toBeVisible();
    await expect(page.locator('[data-testid="toybox-menu-patch-output"]')).toBeVisible();
    await expect(page.locator('[data-testid="toybox-menu-disconnect-port"]')).toBeVisible();
    await expect(page.locator('[data-testid="toybox-menu-begin-wire"]')).toBeVisible();
    await page.keyboard.press('Escape');

    // ---- PORT (input dot): only Disconnect this port ----
    await rightClickEd(page, `toybox-inport-${outId}-in0`);
    await expect(menu(page)).toBeVisible();
    await expect(page.locator('[data-testid="toybox-menu-disconnect-port"]')).toBeVisible();
    await expect(page.locator('[data-testid="toybox-menu-patch-output"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="toybox-menu-begin-wire"]')).toHaveCount(0);
    await page.keyboard.press('Escape');

    // ---- EDGE: Delete edge ---- (right-click the path's stroke midpoint, since
    // a thin diagonal bezier's bbox centre lands on background).
    const { edges } = await readCombine(page);
    const anyEdge = edges[0];
    expect(anyEdge).toBeTruthy();
    await rightClickEdge(page, anyEdge!.id);
    await expect(menu(page)).toBeVisible();
    await expect(page.locator('[data-testid="toybox-menu-delete-edge"]')).toBeVisible();
    await page.keyboard.press('Escape');

    // ---- CANVAS (empty): Add node submenu + Clear + Reset ----
    const empty = await emptyCanvasScreen(page);
    await rightClickAt(page, empty.x, empty.y);
    await expect(menu(page)).toBeVisible();
    await expect(page.locator('[data-testid="toybox-menu-add"]')).toBeVisible();
    await expect(page.locator('[data-testid="toybox-menu-clear"]')).toBeVisible();
    await expect(page.locator('[data-testid="toybox-menu-reset"]')).toBeVisible();
    // Expand the Add submenu → the 4 op kinds.
    await page.locator('[data-testid="toybox-menu-add"]').click({ noWaitAfter: true });
    for (const k of ['fade', 'lumakey', 'chromakey', 'map']) {
      await expect(page.locator(`[data-testid="toybox-menu-add-${k}"]`)).toBeVisible();
    }
    await page.keyboard.press('Escape');
    await expect(menu(page)).toHaveCount(0);

    expect(errors.filter((e) => !e.includes('AudioContext')), 'no console / page errors').toEqual([]);
  });

  test('HEADLINE: build a 2-op chain, then right-click the final node → Patch to output', async ({ page }) => {
    test.setTimeout(120_000); // menu + chain-build + patch is heavier than combine-editor; CI WebGL starvation needs the headroom
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await setup(page);

    const before = await frozenAverage(page, 2.0);

    // Add a 2nd op, then wire a chain: src0 → A.in0, src1 → A.in1, A → B.in0.
    await clickEd(page, 'toybox-add-map');
    const { nodes } = await readCombine(page);
    // The two FREE ops we just added (no incoming edges yet).
    const { edges: edges0 } = await readCombine(page);
    const wiredTo = new Set(edges0.map((e) => e.to));
    const freeOps = nodes.filter((n) => (n.kind === 'fade' || n.kind === 'map') && !wiredTo.has(n.id));
    const a = freeOps[0]!.id;
    const b = freeOps[1]!.id;
    expect(a && b).toBeTruthy();

    // Wire the chain via the existing click-to-wire UX (untouched by this feature).
    await clickEd(page, 'toybox-outport-src0');
    await clickEd(page, `toybox-inport-${a}-in0`);
    await clickEd(page, 'toybox-outport-src1');
    await clickEd(page, `toybox-inport-${a}-in1`);
    await clickEd(page, `toybox-outport-${a}`);
    await clickEd(page, `toybox-inport-${b}-in0`);

    // The chain a → b exists; b is the FINAL node. Capture the prior OUTPUT.in0
    // source so we can prove it changed.
    const outId = (await findNodeId(page, 'output'))!;
    const priorOutFrom = await page.evaluate(
      ({ outId }) => {
        const w = globalThis as unknown as PatchGlobal;
        const c = w.__patch.nodes['tb']?.data?.combine;
        return (c?.edges ?? []).find((e) => e.to === outId && e.toPort === 'in0')?.from ?? null;
      },
      { outId },
    );

    // HEADLINE ACTION: right-click the final node → Patch to output.
    await rightClickEd(page, `toybox-gnode-${b}`);
    await expect(menu(page)).toBeVisible();
    await page.locator('[data-testid="toybox-menu-patch-output"]').click({ noWaitAfter: true });

    // node.data.combine: OUTPUT.in0 now sourced from b, exactly once, and the
    // prior in0 edge is gone.
    await expect
      .poll(async () => {
        const { edges } = await readCombine(page);
        const into = edges.filter((e) => e.to === outId && e.toPort === 'in0');
        return into.length === 1 && into[0]!.from === b;
      }, { timeout: 10_000 })
      .toBe(true);
    expect(priorOutFrom).not.toBe(b);

    // Composite changed: the chain (layer0 mapped by layer1 etc) now feeds OUT.
    const after = await frozenAverage(page, 2.0);
    expect(dist(before, after), 'patching the chain to output changes the live output').toBeGreaterThan(4);

    expect(errors.filter((e) => !e.includes('AudioContext')), 'no console / page errors').toEqual([]);
  });

  test('canvas menu: Clear node map empties edges, Reset to default restores them', async ({ page }) => {
    test.setTimeout(120_000); // menu + chain-build + patch is heavier than combine-editor; CI WebGL starvation needs the headroom
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await setup(page);

    // Default graph has edges; Clear removes them all (nodes remain).
    const beforeNodes = (await readCombine(page)).nodes.length;
    expect((await readCombine(page)).edges.length).toBeGreaterThan(0);

    const empty = await emptyCanvasScreen(page);
    await rightClickAt(page, empty.x, empty.y);
    await expect(menu(page)).toBeVisible();
    await page.locator('[data-testid="toybox-menu-clear"]').click({ noWaitAfter: true });

    await expect
      .poll(async () => (await readCombine(page)).edges.length, { timeout: 10_000 })
      .toBe(0);
    // Nodes are untouched by Clear.
    expect((await readCombine(page)).nodes.length).toBe(beforeNodes);

    // Reset to default re-seeds the default wiring (edges back).
    await rightClickAt(page, empty.x, empty.y);
    await expect(menu(page)).toBeVisible();
    await page.locator('[data-testid="toybox-menu-reset"]').click({ noWaitAfter: true });

    await expect
      .poll(async () => {
        const { nodes, edges } = await readCombine(page);
        const out = nodes.find((n) => n.kind === 'output');
        return (
          edges.length > 0 &&
          !!out &&
          edges.some((e) => e.to === out.id && e.toPort === 'in0') &&
          nodes.filter((n) => n.kind === 'source').length === 4
        );
      }, { timeout: 10_000 })
      .toBe(true);

    expect(errors.filter((e) => !e.includes('AudioContext')), 'no console / page errors').toEqual([]);
  });
});
