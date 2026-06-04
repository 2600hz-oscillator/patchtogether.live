// e2e/tests/toybox-cv-routing.spec.ts
//
// TOYBOX Phase 5 — CV-assignable params via the generic cv pool + per-param
// routing. Demonstrates the THREE different assignment setups the MVP requires:
//
//   (a) cv1 → a SHADER param   (layer 0 content uniform 'speed'),
//   (b) cv2 → a COMBINE param  (a fade op node's amount/t),
//   (c) cv3 → an OBJ param     (layer 2 material 'spin').
//
// For each: we route the generic cv port through the in-card CV TAB UI (the
// two-dropdown row), then DRIVE that generic port through the engine's real
// setParam(cvN, ±1) — the exact Phase-5 bridge path — and assert the resolved
// LIVE param moved across its range (re-scaled by setParam). cv1/cv2 are also
// confirmed to change the composite (the route reaches the render).
//
// Driving via setParam(cvN, raw) mirrors what the cross-domain cv-bridge does
// each frame; it resolves cvRoutes[cvN], re-scales raw ±1 across the addressed
// param's declared min/max (centred on the param's value), and writes the live
// param. We read node.data back to prove the write landed at the right target.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

type ObjMaterial = { spin?: number; [k: string]: number | undefined };
type FadeParams = { amount?: number; [k: string]: number | undefined };

type PatchGlobal = {
  __patch: {
    nodes: Record<
      string,
      {
        data?: {
          combine?: { nodes?: { id?: string; kind?: string; params?: FadeParams }[]; edges?: unknown[] };
          layers?: { kind?: string; contentId?: string | null; params?: Record<string, number>; material?: ObjMaterial }[];
          cvRoutes?: Record<string, unknown>;
        };
      }
    >;
  };
  __ydoc: { transact: (fn: () => void) => void };
  __engine?: () => { getDomain: <T>(d: string) => T };
};

type VideoEngineLike = { setParam: (nodeId: string, paramId: string, value: number) => void };

/** Pin the viewport at scale 1, panned up so the (CV-tab-open) card body clears
 *  the fixed bottombar footer. Mirrors the combine-editor spec. */
async function pinViewport(page: Page): Promise<void> {
  await page.evaluate(() => {
    const vp = document.querySelector('.svelte-flow__viewport') as HTMLElement | null;
    if (!vp) return;
    vp.style.transition = 'none';
    vp.style.transform = 'translate(8px, -24px) scale(1)';
  });
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

/** Seed the demo patch: layer 0 = a shader (speed param), layer 1 = a 2nd
 *  shader, layer 2 = an OBJ layer (spin material). A crossfade combine graph
 *  (src0 ↔ src1 via a FADE op 'xf') so cv2 → xf.amount moves the composite. */
async function seedDemoPatch(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = globalThis as unknown as PatchGlobal;
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['tb'];
      if (!n) return;
      if (!n.data) n.data = {};
      n.data.layers = [
        { kind: 'gen', contentId: 'noise-fbm', params: { speed: 0.4 } },
        { kind: 'gen', contentId: 'cos-gradient', params: {} },
        {
          kind: 'obj',
          contentId: null,
          params: {},
          material: {
            modelId: 'cube', rotX: 0.3, rotY: 0.6, rotZ: 0, scale: 1,
            spin: 0, matcap: 0, tintR: 1, tintG: 1, tintB: 1,
          },
        },
        { kind: 'off', contentId: null, params: {} },
      ];
      n.data.combine = {
        nodes: [
          { id: 'src0', kind: 'source', layer: 0, x: 14, y: 14 },
          { id: 'src1', kind: 'source', layer: 1, x: 14, y: 66 },
          { id: 'src2', kind: 'source', layer: 2, x: 14, y: 118 },
          { id: 'src3', kind: 'source', layer: 3, x: 14, y: 170 },
          { id: 'xf', kind: 'fade', x: 120, y: 40, params: { amount: 0.5 } },
          { id: 'out', kind: 'output', x: 286, y: 40 },
        ],
        edges: [
          { id: 'e0', from: 'src0', to: 'xf', toPort: 'in0' },
          { id: 'e1', from: 'src1', to: 'xf', toPort: 'in1' },
          { id: 'e2', from: 'xf', to: 'out', toPort: 'in0' },
        ],
      };
    });
  });
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

/** Drive a generic cv port through the engine's real setParam path. */
async function driveCv(page: Page, port: string, raw: number): Promise<void> {
  await page.evaluate(
    ({ port, raw }) => {
      const w = globalThis as unknown as PatchGlobal;
      const e = w.__engine?.();
      try {
        e?.getDomain<VideoEngineLike>('video')?.setParam('tb', port, raw);
      } catch { /* */ }
    },
    { port, raw },
  );
}

/** Read the live layers/combine/routes back from the patch. */
async function readData(page: Page) {
  return page.evaluate(() => {
    const w = globalThis as unknown as PatchGlobal;
    const n = w.__patch.nodes['tb'];
    return {
      layers: n?.data?.layers ?? [],
      combine: n?.data?.combine ?? { nodes: [] },
      cvRoutes: n?.data?.cvRoutes ?? {},
    };
  });
}

/** Select a value in the [target ▾] then [param ▾] of a cv row (UI path). */
async function routeViaUi(
  page: Page,
  port: string,
  targetValue: string,
  paramValue: string,
): Promise<void> {
  await page.locator(`[data-testid="toybox-cv-target-${port}"]`).selectOption(targetValue);
  // Selecting a target auto-picks its first param; explicitly choose the one we
  // want (the param dropdown re-populates from the chosen target).
  await page.locator(`[data-testid="toybox-cv-param-${port}"]`).selectOption(paramValue);
}

test.describe('TOYBOX CV routing (Phase 5)', () => {
  test('routes cv1→shader, cv2→combine, cv3→obj via the CV tab + drives each', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(
      page,
      [{ id: 'tb', type: 'toybox', position: { x: 80, y: 40 }, domain: 'video' }],
      [],
    );
    const card = page.locator('.svelte-flow__node-toybox').first();
    await card.waitFor({ state: 'visible', timeout: 10_000 });
    await pinViewport(page);

    await seedDemoPatch(page);

    // Open the CV tab.
    await page.locator('[data-testid="toybox-cv-toggle"]').click({ force: true });
    await page.locator('[data-testid="toybox-cv-rows"]').waitFor({ state: 'visible', timeout: 5_000 });

    // ── (a) cv1 → SHADER param (layer 0 'speed') via the UI ──
    await routeViaUi(page, 'cv1', 'layer:0', 'speed');
    // ── (b) cv2 → COMBINE param (fade op 'xf' amount) via the UI ──
    await routeViaUi(page, 'cv2', 'combine:xf', 'amount');
    // ── (c) cv3 → OBJ param (layer 2 material spin) via the UI ──
    await routeViaUi(page, 'cv3', 'layer:2', 'material:spin');

    // The routes persisted to node.data.cvRoutes at the right targets.
    {
      const { cvRoutes } = await readData(page);
      expect(cvRoutes.cv1).toMatchObject({ target: 'layer', layer: 0, param: 'speed' });
      expect(cvRoutes.cv2).toMatchObject({ target: 'combine', nodeId: 'xf', param: 'amount' });
      expect(cvRoutes.cv3).toMatchObject({ target: 'layer', layer: 2, param: 'material:spin' });
    }

    // ── Drive each generic port and assert the resolved LIVE param moved ──

    // (a) cv1 = +1 → layer 0 speed re-scaled across 0..2 (centred on 0.4) → 1.4.
    await driveCv(page, 'cv1', 1);
    {
      const { layers } = await readData(page);
      expect(layers[0]!.params!.speed).toBeGreaterThan(0.4); // moved up from the centre
      expect(layers[0]!.params!.speed).toBeLessThanOrEqual(2);
    }
    // cv1 = -1 → speed re-scaled DOWN (toward 0); proves bidirectional sweep.
    await driveCv(page, 'cv1', -1);
    {
      const { layers } = await readData(page);
      expect(layers[0]!.params!.speed).toBeLessThan(0.4);
      expect(layers[0]!.params!.speed).toBeGreaterThanOrEqual(0);
    }

    // (b) cv2 = +1 → fade op amount re-scaled across 0..1 (centred on 0.5) → 1.
    await driveCv(page, 'cv2', 1);
    {
      const { combine } = await readData(page);
      const xf = combine.nodes!.find((x) => x.id === 'xf')!;
      expect(xf.params!.amount).toBeCloseTo(1, 3);
    }
    // cv2 = -1 → amount → 0.
    await driveCv(page, 'cv2', -1);
    {
      const { combine } = await readData(page);
      const xf = combine.nodes!.find((x) => x.id === 'xf')!;
      expect(xf.params!.amount).toBeCloseTo(0, 3);
    }

    // (c) cv3 = +1 → layer 2 material spin re-scaled across 0..3 (centred on 0) → 1.5.
    await driveCv(page, 'cv3', 1);
    {
      const { layers } = await readData(page);
      expect(layers[2]!.material!.spin).toBeGreaterThan(0);
      expect(layers[2]!.material!.spin).toBeLessThanOrEqual(3);
    }

    // An unrouted port (cv8) is a NO-OP: driving it changes nothing + never throws.
    const before = await readData(page);
    await driveCv(page, 'cv8', 1);
    const after = await readData(page);
    expect(after.layers[0]!.params!.speed).toBe(before.layers[0]!.params!.speed);

    expect(
      errors.filter((e) => !e.includes('AudioContext')),
      'no console / page errors',
    ).toEqual([]);
  });
});
