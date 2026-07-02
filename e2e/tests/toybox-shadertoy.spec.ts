// e2e/tests/toybox-shadertoy.spec.ts
//
// TOYBOX Shadertoy runtime — end-to-end pixel proofs.
//
//   1. a FRAG shader (frag-invert-scan) VISIBLY TRANSFORMS the layer below it
//      (the FRAG composite differs from the raw layer-below composite),
//   2. the multi-buffer GROWING-PEAK preset renders NON-BLACK after advancing
//      several step()s (feedback convergence), AND a simulated iMouse click
//      changes the output (the click-to-grow raises the terrain).
//
// CONSOLIDATED 3→2 (webgl-suite-optimization §2): the former first test, a
// single-pass GEN Shadertoy shader (synthwave-sunset) rendering non-black through
// the mainImage->main shim, was DROPPED — it is a dup of two cheaper proofs: the
// toybox-new-content matrix already compiles+draws each GEN Shadertoy content id,
// and toybox-disk-loading already exercises the mainImage->main shim + uniform
// set on a custom GEN source. The two kept tests own the UNIQUE Shadertoy paths:
// FRAG-transforms-the-layer-below, and multi-buffer ping-pong + iMouse state.
//
// CI runs e2e on SwiftShader (slow). The multi-buffer raymarch is the most
// expensive thing TOYBOX does — generous timeouts per the
// `ci-swiftshader-video-e2e-timeouts` discipline.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

type STGlobal = {
  __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
  __ydoc: { transact: (fn: () => void) => void };
  __engine?: () => { getDomain: <T>(d: string) => T };
  __toyboxFreeze?: (t?: number) => void;
  __toyboxLoadPreset?: (id: string) => Promise<boolean>;
};

type VideoEngineLike = {
  step: () => void;
  setMouse: (nodeId: string, x: number, y: number, z: number, w: number) => void;
};

/** Sample the preview canvas: total lit pixels + a coarse colour signature. */
async function sampleCanvas(page: Page): Promise<{ lit: number; total: number; sig: string }> {
  return page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="toybox-canvas"]') as HTMLCanvasElement | null;
    if (!canvas) return { lit: 0, total: 0, sig: '' };
    const c2d = canvas.getContext('2d');
    if (!c2d) return { lit: 0, total: 0, sig: '' };
    const { data } = c2d.getImageData(0, 0, canvas.width, canvas.height);
    let lit = 0, r = 0, g = 0, b = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i]! > 16 || data[i + 1]! > 16 || data[i + 2]! > 16) lit++;
      r += data[i]!; g += data[i + 1]!; b += data[i + 2]!;
    }
    return {
      lit,
      total: canvas.width * canvas.height,
      sig: `${Math.round(r / 3000)},${Math.round(g / 3000)},${Math.round(b / 3000)}`,
    };
  });
}

async function spawnToybox(page: Page): Promise<void> {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [{ id: 'tb', type: 'toybox', position: { x: 80, y: 40 }, domain: 'video' }],
    [],
  );
  const card = page.locator('.svelte-flow__node-toybox').first();
  await card.waitFor({ state: 'visible', timeout: 10_000 });
}

test.describe('TOYBOX Shadertoy runtime', () => {
  test('a FRAG shader visibly transforms the layer below it', async ({ page }) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await spawnToybox(page);

    // First: just the GEN layer below (worley), OUTPUT = layer 0. Capture its sig.
    await page.evaluate(() => {
      const w = globalThis as unknown as STGlobal;
      w.__toyboxFreeze?.();
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['tb'];
        if (!n) return;
        if (!n.data) n.data = {};
        n.data.layers = [
          { kind: 'gen', contentId: 'worley-cells', params: {} },
          { kind: 'off', contentId: null, params: {} },
          { kind: 'off', contentId: null, params: {} },
          { kind: 'off', contentId: null, params: {} },
        ];
        // OUTPUT = layer 0 (the raw worley field).
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
            { id: 'e1', from: 'pass', to: 'out', toPort: 'in0' },
          ],
        };
      });
    });
    await page.waitForFunction(
      () => {
        const w = globalThis as unknown as STGlobal;
        w.__toyboxFreeze?.(2.0);
        const c = document.querySelector('[data-testid="toybox-canvas"]') as HTMLCanvasElement | null;
        const d = c?.getContext('2d')?.getImageData(0, 0, c.width, c.height).data;
        if (!d) return false;
        let lit = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i]! > 16 || d[i + 1]! > 16 || d[i + 2]! > 16) lit++;
        return lit > (c!.width * c!.height) * 0.1;
      },
      undefined,
      { timeout: 30_000 },
    );
    const below = await sampleCanvas(page);

    // Now: add a FRAG layer 1 (invert-scan) above it, OUTPUT = layer 1 (which
    // receives layer 0 as iChannel0 and inverts it). The composite MUST differ.
    await page.evaluate(() => {
      const w = globalThis as unknown as STGlobal;
      w.__toyboxFreeze?.();
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['tb'];
        if (!n || !n.data) return;
        n.data.layers = [
          { kind: 'gen', contentId: 'worley-cells', params: {} },
          { kind: 'frag', contentId: 'frag-invert-scan', params: { amount: 1.0, split: 3.0 } },
          { kind: 'off', contentId: null, params: {} },
          { kind: 'off', contentId: null, params: {} },
        ];
        n.data.combine = {
          nodes: [
            { id: 'src0', kind: 'source', layer: 0, x: 14, y: 14 },
            { id: 'src1', kind: 'source', layer: 1, x: 14, y: 66 },
            { id: 'src2', kind: 'source', layer: 2, x: 14, y: 118 },
            { id: 'src3', kind: 'source', layer: 3, x: 14, y: 170 },
            { id: 'pass', kind: 'fade', x: 120, y: 40, params: { amount: 0 } },
            { id: 'out', kind: 'output', x: 286, y: 40 },
          ],
          // OUTPUT shows layer 1 (the FRAG output).
          edges: [
            { id: 'e0', from: 'src1', to: 'pass', toPort: 'in0' },
            { id: 'e1', from: 'pass', to: 'out', toPort: 'in0' },
          ],
        };
      });
    });
    await page.waitForFunction(
      () => {
        const w = globalThis as unknown as STGlobal;
        w.__toyboxFreeze?.(2.0);
        const c = document.querySelector('[data-testid="toybox-canvas"]') as HTMLCanvasElement | null;
        const d = c?.getContext('2d')?.getImageData(0, 0, c.width, c.height).data;
        if (!d) return false;
        let lit = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i]! > 16 || d[i + 1]! > 16 || d[i + 2]! > 16) lit++;
        return lit > (c!.width * c!.height) * 0.1;
      },
      undefined,
      { timeout: 30_000 },
    );
    const fragged = await sampleCanvas(page);

    expect(fragged.lit, 'FRAG renders non-black').toBeGreaterThan(fragged.total * 0.1);
    // The FRAG inverts the layer below → the composite signature MUST differ.
    expect(fragged.sig, 'FRAG visibly transforms the layer below').not.toEqual(below.sig);
    expect(errors.filter((e) => !e.includes('AudioContext')), 'no errors').toEqual([]);
  });

  test('the multi-buffer growing-peak preset renders + click-to-grow changes it', async ({ page }) => {
    // The heaviest TOYBOX path on SwiftShader: a multi-pass float raymarch with
    // feedback. We only need to prove the multi-pass pipeline RUNS + RESPONDS
    // here — full growth convergence + the pretty peak are the darwin VRT's job —
    // so we advance a tiny fixed batch of heavy frames and bound the budget (the
    // un-reduced version starved the shard per ci-swiftshader-video-e2e-timeouts).
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await spawnToybox(page);

    // Load the bundled multi-buffer preset (fetches the pass GLSL files +
    // Common, assembles layer.project, writes node.data in place).
    await page.waitForFunction(
      () => typeof (globalThis as unknown as STGlobal).__toyboxLoadPreset === 'function',
      undefined,
      { timeout: 15_000 },
    );
    await page.evaluate(async () => {
      const w = globalThis as unknown as STGlobal;
      w.__toyboxFreeze?.();
      await w.__toyboxLoadPreset?.('growing-peak');
    });

    // Advance a SMALL fixed batch of heavy frames — enough to raymarch the
    // sky+peak and fill the ping-pong heightmap buffer. The raymarch fills most
    // of the frame from the first frames (the weather sky is non-black regardless
    // of growth convergence), so a tiny batch clears the non-black bar without
    // the shard-starving 100+ frame loop the original used.
    await page.evaluate(() => {
      const w = globalThis as unknown as STGlobal;
      const ve = w.__engine?.().getDomain<VideoEngineLike>('video');
      for (let i = 0; i < 12; i++) ve?.step();
      w.__toyboxFreeze?.(2.0);
    });

    const beforeClick = await sampleCanvas(page);
    expect(beforeClick.lit, 'growing-peak preset renders non-black').toBeGreaterThan(beforeClick.total * 0.05);

    // Simulate a held iMouse press in the centre of the terrain (engine px) and
    // run more steps — the growable heightmap rises where the cursor is, changing
    // the rendered output (click-to-grow raises the mountain).
    await page.evaluate(() => {
      const w = globalThis as unknown as STGlobal;
      const ve = w.__engine?.().getDomain<VideoEngineLike>('video');
      if (!ve) return;
      // Engine res is 640×480; press near the centre, button down (z>0, w>0).
      // A short held-press batch is enough to raise a bump into BufferA and
      // propagate it through Image so the composite signature differs.
      for (let i = 0; i < 10; i++) {
        ve.setMouse('tb', 320, 240, 320, 240); // held press at centre
        ve.step();
      }
    });
    await page.evaluate(() => {
      const w = globalThis as unknown as STGlobal;
      w.__toyboxFreeze?.(2.0);
    });
    const afterClick = await sampleCanvas(page);

    // The raised bump changes the terrain → the composite signature differs.
    expect(afterClick.sig, 'iMouse click-to-grow changes the terrain').not.toEqual(beforeClick.sig);
    expect(errors.filter((e) => !e.includes('AudioContext')), 'no errors').toEqual([]);
  });
});
