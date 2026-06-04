// e2e/tests/toybox-presets.spec.ts
//
// TOYBOX Phase 6 — bundled PRESETS. Spawns a TOYBOX, then for each of the 4
// bundled presets:
//   1. loads it via the debug hook window.__toyboxLoadPreset(id) (the same
//      in-place Yjs mutation the dropdown fires),
//   2. asserts node.data now reflects the preset's layers / combine / cvRoutes
//      (read back from the live patch),
//   3. freezes the engine clock + waits until the composited OUTPUT preview
//      renders NON-BLACK — proving the whole pipeline (load → layers incl
//      obj/gen/shader → combine DAG → cv) drives real pixels end-to-end.
//
// Also exercises the in-card DROPDOWN path for one preset (selecting the option
// applies it) so the UI control is covered, and confirms loading a SECOND
// preset over a first cleanly replaces node.data (the in-place trap).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

type PatchGlobal = {
  __patch: {
    nodes: Record<
      string,
      {
        data?: {
          layers?: { kind?: string; contentId?: string | null; material?: { modelId?: string } }[];
          combine?: { nodes?: { id?: string; kind?: string }[]; edges?: unknown[] };
          cvRoutes?: Record<string, { target?: string; nodeId?: string; layer?: number; param?: string }>;
        };
      }
    >;
  };
  __toyboxLoadPreset?: (id: string) => Promise<boolean>;
  __toyboxFreeze?: (t?: number) => void;
};

/** What each preset must look like in node.data after loading (the headline
 *  contract — distinct multi-source composites using only bundled content). */
const PRESETS: Array<{
  id: string;
  layer0Content?: string;
  expectKinds: string[];
  combineNodeIds: string[];
  cvRoutes: Record<string, { target: string; nodeId?: string; layer?: number; param: string }>;
}> = [
  {
    id: 'plasma-dissolve',
    layer0Content: 'hsv-plasma',
    expectKinds: ['shader', 'shader', 'off', 'off'],
    combineNodeIds: ['src0', 'src1', 'src2', 'src3', 'fade1', 'out'],
    cvRoutes: { cv1: { target: 'combine', nodeId: 'fade1', param: 'amount' } },
  },
  {
    id: 'cow-on-camera',
    layer0Content: 'worley-cells',
    expectKinds: ['gen', 'obj', 'off', 'off'],
    combineNodeIds: ['src0', 'src1', 'src2', 'src3', 'lk1', 'out'],
    cvRoutes: { cv3: { target: 'layer', layer: 1, param: 'material:spin' } },
  },
  {
    id: 'worley-bloom',
    layer0Content: 'worley-cells',
    expectKinds: ['gen', 'gen', 'shader', 'off'],
    combineNodeIds: ['src0', 'src1', 'src2', 'src3', 'ck1', 'map1', 'out'],
    cvRoutes: {
      cv2: { target: 'combine', nodeId: 'map1', param: 'amount' },
      cv5: { target: 'layer', layer: 0, param: 'density' },
    },
  },
  {
    id: 'reactor-field',
    layer0Content: 'noise-fbm',
    expectKinds: ['gen', 'gen', 'obj', 'off'],
    combineNodeIds: ['src0', 'src1', 'src2', 'src3', 'map1', 'lk1', 'out'],
    cvRoutes: {},
  },
  {
    // Phase-6 texmap showcase: layer 0 OBJ sphere whose SURFACE = layer 1's
    // worley field (material.surfaceSource = 1).
    id: 'textured-sphere',
    expectKinds: ['obj', 'gen', 'off', 'off'],
    combineNodeIds: ['src0', 'src1', 'src2', 'src3', 'fade1', 'out'],
    cvRoutes: {},
  },
];

async function pinViewport(page: Page): Promise<void> {
  await page.evaluate(() => {
    const vp = document.querySelector('.svelte-flow__viewport') as HTMLElement | null;
    if (!vp) return;
    vp.style.transition = 'none';
    vp.style.transform = 'translate(0px, 0px) scale(1)';
  });
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

/** Load a preset via the debug hook + wait until the live patch reflects it. */
async function loadPreset(page: Page, id: string): Promise<void> {
  await page.evaluate(async (id) => {
    const w = globalThis as unknown as PatchGlobal;
    await w.__toyboxLoadPreset?.(id);
  }, id);
}

/** Read node.data back from the live patch. */
async function readData(page: Page) {
  return page.evaluate(() => {
    const w = globalThis as unknown as PatchGlobal;
    const n = w.__patch.nodes['tb'];
    return {
      layers: n?.data?.layers ?? [],
      combine: n?.data?.combine ?? { nodes: [], edges: [] },
      cvRoutes: n?.data?.cvRoutes ?? {},
    };
  });
}

/** Freeze the clock at `time`, poll until the composited preview is non-black. */
async function freezeUntilNonBlack(page: Page, time: number): Promise<number> {
  return page.waitForFunction(
    ({ time }) => {
      const w = globalThis as unknown as PatchGlobal;
      w.__toyboxFreeze?.(time);
      const canvas = document.querySelector('[data-testid="toybox-canvas"]') as HTMLCanvasElement | null;
      if (!canvas) return 0;
      const c2d = canvas.getContext('2d');
      if (!c2d) return 0;
      const { data } = c2d.getImageData(0, 0, canvas.width, canvas.height);
      let lit = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i]! > 16 || data[i + 1]! > 16 || data[i + 2]! > 16) lit++;
      }
      // ≥2% lit covers the framed-OBJ presets (cow / reactor) too.
      const frac = lit / (canvas.width * canvas.height);
      return frac > 0.02 ? lit : 0;
    },
    { time },
    { timeout: 12_000 },
  ).then((h) => h.jsonValue() as Promise<number>);
}

test.describe('TOYBOX presets (Phase 6)', () => {
  test('each preset loads into node.data + renders a non-black composite', async ({ page }) => {
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

    // Wait for the preset hook to be installed (catalog loaded in onMount).
    await page.waitForFunction(
      () => typeof (globalThis as unknown as PatchGlobal).__toyboxLoadPreset === 'function',
      undefined,
      { timeout: 10_000 },
    );

    let prevTime = 1.0;
    for (const p of PRESETS) {
      // Resume the clock so the new content compiles before we re-freeze.
      await page.evaluate(() => (globalThis as unknown as PatchGlobal).__toyboxFreeze?.());

      await loadPreset(page, p.id);

      // node.data reflects the preset.
      const { layers, combine, cvRoutes } = await readData(page);
      expect(layers.map((l) => l.kind), `${p.id} layer kinds`).toEqual(p.expectKinds);
      if (p.layer0Content) {
        expect(layers[0]!.contentId, `${p.id} layer0 content`).toBe(p.layer0Content);
      }
      expect(
        (combine.nodes ?? []).map((n) => n.id),
        `${p.id} combine node ids`,
      ).toEqual(p.combineNodeIds);
      for (const [port, route] of Object.entries(p.cvRoutes)) {
        expect(cvRoutes[port], `${p.id} ${port}`).toMatchObject(route);
      }

      // The composited OUTPUT renders non-black (whole pipeline drives pixels).
      const lit = await freezeUntilNonBlack(page, (prevTime += 0.5));
      expect(lit, `${p.id} non-black composite`).toBeGreaterThan(0);
    }

    expect(
      errors.filter((e) => !e.includes('AudioContext')),
      'no console / page errors',
    ).toEqual([]);
  });

  test('the in-card PRESET dropdown applies a preset to node.data', async ({ page }) => {
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

    // The dropdown is populated once the manifest presets load.
    const sel = page.locator('[data-testid="toybox-preset-select"]');
    await sel.waitFor({ state: 'visible', timeout: 10_000 });
    await expect(sel.locator('option')).toHaveCount(PRESETS.length + 1); // + placeholder

    // Select WORLEY BLOOM via the dropdown → applies it to node.data.
    await sel.selectOption('worley-bloom');
    await expect
      .poll(async () => (await readData(page)).combine.nodes?.map((n) => n.id).join(','))
      .toBe('src0,src1,src2,src3,ck1,map1,out');
    {
      const { layers, cvRoutes } = await readData(page);
      expect(layers.map((l) => l.kind)).toEqual(['gen', 'gen', 'shader', 'off']);
      expect(cvRoutes.cv2).toMatchObject({ target: 'combine', nodeId: 'map1', param: 'amount' });
    }

    // Loading a SECOND preset over the first cleanly REPLACES node.data
    // (the in-place trap — must not leave stale nodes/routes).
    await sel.selectOption('plasma-dissolve');
    await expect
      .poll(async () => (await readData(page)).combine.nodes?.map((n) => n.id).join(','))
      .toBe('src0,src1,src2,src3,fade1,out');
    {
      const { layers, cvRoutes } = await readData(page);
      expect(layers.map((l) => l.kind)).toEqual(['shader', 'shader', 'off', 'off']);
      expect(cvRoutes.cv1).toMatchObject({ target: 'combine', nodeId: 'fade1', param: 'amount' });
      // worley-bloom's cv2/cv5 routes are gone.
      expect(cvRoutes.cv2).toBeUndefined();
      expect(cvRoutes.cv5).toBeUndefined();
    }

    expect(
      errors.filter((e) => !e.includes('AudioContext')),
      'no console / page errors',
    ).toEqual([]);
  });
});
