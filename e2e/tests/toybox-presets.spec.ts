// e2e/tests/toybox-presets.spec.ts
//
// TOYBOX Phase 6 — bundled PRESETS, the in-card DROPDOWN UI.
//
// Phase 2 lean (webgl-suite-optimization §2): the per-preset RENDER loop (the
// old test 1: "each preset loads into node.data + renders a non-black
// composite") was PRUNED — it is a true duplicate of the unit suite
// `toybox-presets.test.ts`, which reads the REAL static manifest and asserts,
// per preset, the layer kinds/content, that the combine field is a valid graph
// topo-sorting to a wired OUTPUT (i.e. "reaches the OUTPUT from at least one
// source — renders, not black"), and that every cvRoute targets a real param.
// The data contract + the "renders non-black" claim are both owned there (no
// GPU boot). What stays here is the DOM-only contract a unit test can't see: the
// in-card dropdown is populated from the manifest and selecting an option
// applies the preset (incl. the in-place-replace trap) to the live patch.
//
// SwiftShader RE-BIN (GPU-attest rebuild): this spec does NO pixel/canvas work —
// it fetches /toybox/manifest.json, asserts the preset <option> count, drives
// the dropdown, and polls __patch.nodes['tb'].data. The ONLY reason it was a
// heavy-lane / slow spec is that spawning TOYBOX spun up the video engine's rAF
// COMPOSITOR (live render), which starves CI's software renderer (SwiftShader)
// main thread and blew the per-test budget. We now PAUSE the engine rAF loop
// BEFORE boot via installRenderSmokeHooks() (sets __videoEnginePause=true in an
// addInitScript, so the loop idles and never calls step() — see engine.ts
// ensureLoop). The preset-apply path is a pure in-card onchange that writes
// node.data; it does not depend on a rendered frame, so EVERY assertion below is
// preserved bit-for-bit. With the compositor halted the spec is cheap on
// SwiftShader and runs in the parallel sharded matrix (no real-GPU attest).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks } from './_render-smoke';

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
};

async function pinViewport(page: Page): Promise<void> {
  await page.evaluate(() => {
    const vp = document.querySelector('.svelte-flow__viewport') as HTMLElement | null;
    if (!vp) return;
    vp.style.transition = 'none';
    vp.style.transform = 'translate(0px, 0px) scale(1)';
  });
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
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

test.describe('TOYBOX presets (Phase 6)', () => {
  test('the in-card PRESET dropdown applies a preset to node.data', async ({ page }) => {
    // Generous ceiling kept as headroom; the engine rAF compositor is PAUSED
    // (installRenderSmokeHooks below) so the goto + spawn + two preset applies +
    // node.data polls no longer compete with a live render loop on CI's software
    // renderer. The work here is pure DOM / Y.Doc.
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    // PAUSE the video engine's rAF compositor BEFORE the app boots. TOYBOX's
    // WebGL rAF render loop is what starved CI's SwiftShader main thread; this
    // spec reads only node.data (no pixels), so halting the loop removes the
    // cost without touching any assertion. addInitScript persists across the
    // page.goto below.
    await installRenderSmokeHooks(page);

    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    await spawnPatch(
      page,
      [{ id: 'tb', type: 'toybox', position: { x: 80, y: 40 }, domain: 'video' }],
      [],
    );
    const card = page.locator('.svelte-flow__node-toybox').first();
    await card.waitFor({ state: 'visible', timeout: 10_000 });
    await pinViewport(page);

    // The dropdown is populated from the static manifest (the SOURCE OF TRUTH).
    // Derive the expected option count from the manifest itself so the assertion
    // stays correct as presets are added, and avoids the off-by-one this hit when
    // a hand-maintained apply-list lagged. The full per-preset DATA contract is
    // unit-owned (toybox-presets.test.ts); here we just prove the dropdown is
    // manifest-driven + apply works.
    const sel = page.locator('[data-testid="toybox-preset-select"]');
    await sel.waitFor({ state: 'visible', timeout: 10_000 });
    const manifestPresetCount = await page.evaluate(async () => {
      const r = await fetch('/toybox/manifest.json');
      const m = (await r.json()) as { presets?: unknown[] };
      return Array.isArray(m.presets) ? m.presets.length : 0;
    });
    // Sanity: the manifest must declare presets (it carries 12 today).
    expect(manifestPresetCount).toBeGreaterThanOrEqual(5);
    // + 1 placeholder option. Generous timeout: the manifest fetch + Svelte
    // option render can lag on CI even with the compositor paused.
    await expect(sel.locator('option')).toHaveCount(manifestPresetCount + 1, { timeout: 15_000 });

    // Select WORLEY BLOOM via the dropdown → applies it to node.data.
    // noWaitAfter: the select is a pure in-card onchange (no navigation); without
    // it Playwright sits in the multi-second nav-settle window on CI per action.
    await sel.selectOption('worley-bloom', { noWaitAfter: true });
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
    await sel.selectOption('plasma-dissolve', { noWaitAfter: true });
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
