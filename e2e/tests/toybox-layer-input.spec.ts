// e2e/tests/toybox-layer-input.spec.ts
//
// TOYBOX LAYER INPUT (feedback-tap source) — Phase 1. Proves the END-TO-END path
// through the real UI + engine for the new "sample a NODE OUTPUT (incl. the
// post-feedback OUT) as a layer's texture source" feature:
//
//   1. Seed layer 0 = OBJ (sphere) + layer 1 = a bright deterministic shader,
//      combine OUTPUT showing layer 0 (so a matcap→texture swap is visible).
//   2. UNWIRED no-op: pick SURFACE = LAYER INPUT with NO src0.in0 edge wired.
//      The sentinel persists (-2) but, with no tap, the layer stays matcap-only
//      (composite unchanged vs the matcap baseline).
//   3. WIRED feedback loop: wire the OUTPUT's feeder → src0.in0 (a graph cycle
//      exempt from cycle-rejection — the LAYER INPUT tap). Now the OBJ samples
//      the PREVIOUS-frame OUT. Assert the composite CHANGED vs matcap AND the
//      loop is STABLE — never all-black, never blown out to all-white (a feedback
//      divergence), across a couple of frozen frames.
//
// The .selectOption uses { force, noWaitAfter } (load-bearing on CI): TOYBOX's
// WebGL rAF compositor starves the main thread so Playwright's default post-
// action nav-wait is pathologically slow here (mirrors toybox-texture-source).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

type ObjMaterial = { surfaceSource?: number; [k: string]: number | undefined };

type Edge = { id: string; from: string; to: string; toPort: string };

type PatchGlobal = {
  __patch: {
    nodes: Record<
      string,
      {
        data?: {
          layers?: { kind?: string; contentId?: string | null; material?: ObjMaterial }[];
          combine?: { nodes: { id: string; kind: string }[]; edges: Edge[] };
        };
      }
    >;
  };
  __ydoc: { transact: (fn: () => void) => void };
};

/** Pin the viewport at scale 1 so the canvas DOM box is stable. */
async function pinViewport(page: Page): Promise<void> {
  await page.evaluate(() => {
    const vp = document.querySelector('.svelte-flow__viewport') as HTMLElement | null;
    if (!vp) return;
    vp.style.transition = 'none';
    vp.style.transform = 'translate(8px, -8px) scale(1)';
  });
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

/** Seed layer 0 = OBJ sphere (matcap-only to start, spin 0 for determinism),
 *  layer 1 = a bright cos-gradient shader. The combine OUTPUT shows layer 0 (the
 *  sphere) so a matcap→texture change is visible in the composite. */
async function seedObjAndShader(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = globalThis as unknown as PatchGlobal;
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['tb'];
      if (!n) return;
      if (!n.data) n.data = {};
      n.data.layers = [
        {
          kind: 'obj',
          contentId: null,
          params: {},
          material: {
            modelId: 'sphere', rotX: 0.3, rotY: 0.6, rotZ: 0, scale: 1,
            spin: 0, matcap: 0, tintR: 1, tintG: 1, tintB: 1,
          },
        },
        { kind: 'gen', contentId: 'cos-gradient', params: { speed: 0.5, phase: 0.3, scale: 4 } },
        { kind: 'off', contentId: null, params: {} },
        { kind: 'off', contentId: null, params: {} },
      ];
      // OUTPUT shows layer 0 (the sphere) so the matcap→texture swap moves the
      // composite. fade amount 0 = pass the base (layer 0) through.
      n.data.combine = {
        nodes: [
          { id: 'src0', kind: 'source', layer: 0, x: 14, y: 14 },
          { id: 'src1', kind: 'source', layer: 1, x: 14, y: 66 },
          { id: 'src2', kind: 'source', layer: 2, x: 14, y: 118 },
          { id: 'src3', kind: 'source', layer: 3, x: 14, y: 170 },
          { id: 'pass', kind: 'fade', x: 120, y: 40, params: { amount: 0 } },
          { id: 'out', kind: 'output', x: 286, y: 40 },
        ],
        edges: [
          { id: 'e0', from: 'src0', to: 'pass', toPort: 'in0' },
          { id: 'e1', from: 'src1', to: 'pass', toPort: 'in1' },
          { id: 'e2', from: 'pass', to: 'out', toPort: 'in0' },
        ],
      } as PatchGlobal['__patch']['nodes'][string]['data']['combine'];
    });
  });
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

/** Wire the OUTPUT's feeder ('pass') → src0.in0: the LAYER INPUT feedback tap.
 *  Pushed directly onto combine.edges (the same plain shape connectCombine
 *  appends), so the engine's layerInputWanted resolves the tap. */
async function wireLayerInputTap(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = globalThis as unknown as PatchGlobal;
    w.__ydoc.transact(() => {
      const c = w.__patch.nodes['tb']?.data?.combine;
      if (!c) return;
      c.edges.push({ id: 'tap', from: 'pass', to: 'src0', toPort: 'in0' });
    });
  });
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

/** Freeze iTime to `time`, wait until the frozen preview is non-black + stable,
 *  then return the canvas average [r,g,b] over the whole frame. */
async function frozenAverage(page: Page, time: number): Promise<[number, number, number]> {
  await page.waitForFunction(
    ({ time }) => {
      const g = globalThis as unknown as {
        __toyboxFreeze?: (t?: number) => void;
        __toyboxPrevSig?: string;
      };
      g.__toyboxFreeze?.(time);
      const canvas = document.querySelector('[data-testid="toybox-canvas"]') as HTMLCanvasElement | null;
      if (!canvas) return false;
      const c2d = canvas.getContext('2d');
      if (!c2d) return false;
      const { data } = c2d.getImageData(0, 0, canvas.width, canvas.height);
      let lit = 0, r = 0, gg = 0, b = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i]! > 16 || data[i + 1]! > 16 || data[i + 2]! > 16) lit++;
        r += data[i]!; gg += data[i + 1]!; b += data[i + 2]!;
      }
      if (lit <= canvas.width * canvas.height * 0.02) return false;
      const sig = `${Math.round(r / 5000)},${Math.round(gg / 5000)},${Math.round(b / 5000)}`;
      const prev = g.__toyboxPrevSig;
      g.__toyboxPrevSig = sig;
      return prev === sig;
    },
    { time },
    { timeout: 15_000 },
  );
  return page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="toybox-canvas"]') as HTMLCanvasElement;
    const c2d = canvas.getContext('2d')!;
    const { data } = c2d.getImageData(0, 0, canvas.width, canvas.height);
    let r = 0, gg = 0, b = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) {
      r += data[i]!; gg += data[i + 1]!; b += data[i + 2]!; n++;
    }
    return [r / n, gg / n, b / n] as [number, number, number];
  });
}

function dist(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Reset the stability tracker so a prior signature can't satisfy the wait. */
async function resetSig(page: Page): Promise<void> {
  await page.evaluate(() => {
    (globalThis as unknown as { __toyboxPrevSig?: string }).__toyboxPrevSig = '';
  });
}

test.describe('TOYBOX LAYER INPUT (feedback-tap source)', () => {
  test('SURFACE = LAYER INPUT: no-op unwired, textures + stable when the tap is wired', async ({ page }) => {
    // TOYBOX runs a WebGL rAF compositor; on CI's software renderer every op is
    // slow. Give headroom beyond the 30s default (mirrors the texture-source spec).
    test.setTimeout(60_000);
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

    await seedObjAndShader(page);

    // Baseline: matcap-only sphere.
    await resetSig(page);
    const matcapAvg = await frozenAverage(page, 1.0);

    // (1) UNWIRED no-op: pick SURFACE = LAYER INPUT with NO src0.in0 edge. The
    // sentinel persists, but with no tap the layer stays matcap-only.
    await page.evaluate(() => {
      const g = globalThis as unknown as { __toyboxFreeze?: (t?: number) => void };
      g.__toyboxFreeze?.();
    });
    await page
      .locator('[data-testid="toybox-surface-select"]')
      .selectOption('-2', { force: true, noWaitAfter: true });
    {
      const surfaceSource = await page.evaluate(() => {
        const w = globalThis as unknown as PatchGlobal;
        return w.__patch.nodes['tb']?.data?.layers?.[0]?.material?.surfaceSource;
      });
      expect(surfaceSource, 'LAYER INPUT sentinel (-2) persisted').toBe(-2);
    }
    await resetSig(page);
    const unwiredAvg = await frozenAverage(page, 1.0);
    // No tap wired → identical to the matcap baseline (a pure no-op).
    expect(dist(matcapAvg, unwiredAvg), 'unwired LAYER INPUT is a no-op').toBeLessThan(3);

    // (2) WIRED feedback loop: wire pass → src0.in0 (the post-OUT tap). Now the
    // OBJ samples the previous-frame OUT. Resume the clock so the loop runs.
    await wireLayerInputTap(page);
    await page.evaluate(() => {
      const g = globalThis as unknown as { __toyboxFreeze?: (t?: number) => void };
      g.__toyboxFreeze?.();
    });

    await resetSig(page);
    const tappedAvg = await frozenAverage(page, 1.0);
    // (a) The composite CHANGED — the sphere now shows the fed-back OUT, not a
    // flat matcap.
    expect(dist(matcapAvg, tappedAvg), 'wired LAYER INPUT textures the OBJ').toBeGreaterThan(4);
    // (b) STABLE: the loop is bounded — never collapses to all-black nor blows
    // out to all-white (a divergent feedback). Each channel sits well inside the
    // 8-bit range across two frozen times.
    for (const c of tappedAvg) {
      expect(c, 'feedback loop is not all-black').toBeGreaterThan(2);
      expect(c, 'feedback loop did not blow out to all-white').toBeLessThan(250);
    }
    await resetSig(page);
    const tappedAvg2 = await frozenAverage(page, 2.0);
    for (const c of tappedAvg2) {
      expect(c, 'feedback loop stays bounded at a later frame').toBeGreaterThan(2);
      expect(c, 'feedback loop stays bounded at a later frame').toBeLessThan(250);
    }

    expect(
      errors.filter((e) => !e.includes('AudioContext')),
      'no console / page errors (no crash from the feedback loop)',
    ).toEqual([]);
  });
});
