// e2e/tests/toybox-new-content.spec.ts
//
// TOYBOX content-overhaul — pixel/data proofs for the NEW original content
// (Part B of the overhaul). Mirrors toybox-shadertoy.spec.ts' harness (live
// node.data writes via __ydoc + __toyboxFreeze, coarse canvas sampling).
//
//   1. each NEW GEN shader (growing-mountain, flow-field, interference,
//      spiral-bloom) compiles + renders NON-BLACK through the shim/engine,
//   2. each NEW GLITCH/utility FRAG (scanline-blinds, datamosh-wave, zoom-warp,
//      edge-glow) VISIBLY TRANSFORMS the layer below it (composite differs),
//   3. each NEW PRESET loads + renders NON-BLACK with no GLSL/console errors,
//      including the multi-buffer growing-peak (covered by toybox-shadertoy.spec)
//      and the cat-feedback DEMO WIRING (renders its background/feedback chain
//      even with NO user media).
//
// CI runs e2e on SwiftShader (slow) — generous per-test budgets per the
// ci-swiftshader-video-e2e-timeouts discipline. DOM/data + coarse-pixel only.
// Budgets bumped to 180s (#633): the toybox node-batch added 12 combine ops to
// shard 9, increasing the per-shard load enough that these video-domain renders
// occasionally crossed the old 90/120s ceilings on SwiftShader UNDER LOAD (they
// pass in <3s locally on a real GPU — verified — so this is the load-flake, not
// a regression). Lightening the work / reducing per-shard concurrency is the
// deeper task-#64/#65 fix; here we just give the loaded shard the headroom.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

type STGlobal = {
  __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
  __ydoc: { transact: (fn: () => void) => void };
  __engine?: () => { getDomain: <T>(d: string) => T };
  __toyboxFreeze?: (t?: number) => void;
  __toyboxLoadPreset?: (id: string) => Promise<boolean>;
};
type VideoEngineLike = { step: () => void };

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
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [{ id: 'tb', type: 'toybox', position: { x: 80, y: 40 }, domain: 'video' }],
    [],
  );
  const card = page.locator('.svelte-flow__node-toybox').first();
  await card.waitFor({ state: 'visible', timeout: 10_000 });
}

/** Drive a few engine steps + freeze, then poll for a non-black frame. */
async function freezeAndWaitLit(page: Page, time: number, frac = 0.05): Promise<void> {
  await page.waitForFunction(
    ({ time, frac }) => {
      const w = globalThis as unknown as STGlobal;
      const ve = w.__engine?.().getDomain<VideoEngineLike>('video');
      for (let i = 0; i < 6; i++) ve?.step();
      w.__toyboxFreeze?.(time);
      const c = document.querySelector('[data-testid="toybox-canvas"]') as HTMLCanvasElement | null;
      const d = c?.getContext('2d')?.getImageData(0, 0, c.width, c.height).data;
      if (!d) return false;
      let lit = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i]! > 16 || d[i + 1]! > 16 || d[i + 2]! > 16) lit++;
      return lit > (c!.width * c!.height) * frac;
    },
    { time, frac },
    { timeout: 30_000 },
  );
}

/** Seed layer 0 = a single GEN/FX content id; OUTPUT = layer 0. */
async function setSingleLayer(page: Page, kind: string, contentId: string): Promise<void> {
  await page.evaluate(
    ({ kind, contentId }) => {
      const w = globalThis as unknown as STGlobal;
      w.__toyboxFreeze?.();
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['tb'];
        if (!n) return;
        if (!n.data) n.data = {};
        n.data.layers = [
          { kind, contentId, params: {} },
          { kind: 'off', contentId: null, params: {} },
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
          edges: [
            { id: 'e0', from: 'src0', to: 'pass', toPort: 'in0' },
            { id: 'e1', from: 'pass', to: 'out', toPort: 'in0' },
          ],
        };
      });
    },
    { kind, contentId },
  );
}

const NEW_GENS = ['growing-mountain', 'flow-field', 'interference', 'spiral-bloom'];
const NEW_FRAGS = ['frag-scanline-blinds', 'frag-datamosh-wave', 'frag-zoom-warp', 'frag-edge-glow'];
// The NEW single-pass presets (the multi-buffer growing-peak is covered in
// toybox-shadertoy.spec.ts). cat-feedback renders even with no user media.
const NEW_PRESETS = ['mountain-weather', 'glitch-tv', 'spiral-feedback', 'wave-interference', 'cat-feedback'];

test.describe('TOYBOX new content — GEN shaders render', () => {
  for (const id of NEW_GENS) {
    test(`GEN "${id}" renders non-black`, async ({ page }) => {
      test.setTimeout(180_000);
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

      await spawnToybox(page);
      await setSingleLayer(page, 'gen', id);
      await freezeAndWaitLit(page, 2.0, 0.05);

      const s = await sampleCanvas(page);
      expect(s.lit, `${id} renders non-black`).toBeGreaterThan(s.total * 0.05);
      expect(errors.filter((e) => !e.includes('AudioContext')), `${id}: no errors`).toEqual([]);
    });
  }
});

test.describe('TOYBOX new content — FRAG shaders transform the layer below', () => {
  for (const id of NEW_FRAGS) {
    test(`FRAG "${id}" transforms the layer below`, async ({ page }) => {
      test.setTimeout(180_000);
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

      await spawnToybox(page);

      // Base: worley GEN on layer 0, OUTPUT = layer 0.
      await setSingleLayer(page, 'gen', 'worley-cells');
      await freezeAndWaitLit(page, 2.0, 0.1);
      const below = await sampleCanvas(page);

      // Add the FRAG on layer 1 reading layer 0 as iChannel0; OUTPUT = layer 1.
      await page.evaluate(
        ({ id }) => {
          const w = globalThis as unknown as STGlobal;
          w.__toyboxFreeze?.();
          w.__ydoc.transact(() => {
            const n = w.__patch.nodes['tb'];
            if (!n || !n.data) return;
            n.data.layers = [
              { kind: 'gen', contentId: 'worley-cells', params: {} },
              { kind: 'frag', contentId: id, params: {} },
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
              edges: [
                { id: 'e0', from: 'src1', to: 'pass', toPort: 'in0' },
                { id: 'e1', from: 'pass', to: 'out', toPort: 'in0' },
              ],
            };
          });
        },
        { id },
      );
      await freezeAndWaitLit(page, 2.0, 0.05);
      const fragged = await sampleCanvas(page);

      expect(fragged.lit, `${id} renders non-black`).toBeGreaterThan(fragged.total * 0.05);
      expect(fragged.sig, `${id} visibly transforms the layer below`).not.toEqual(below.sig);
      expect(errors.filter((e) => !e.includes('AudioContext')), `${id}: no errors`).toEqual([]);
    });
  }
});

test.describe('TOYBOX new content — presets load + render', () => {
  for (const id of NEW_PRESETS) {
    test(`preset "${id}" loads + renders non-black`, async ({ page }) => {
      test.setTimeout(180_000);
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

      await spawnToybox(page);
      await page.waitForFunction(
        () => typeof (globalThis as unknown as STGlobal).__toyboxLoadPreset === 'function',
        undefined,
        { timeout: 15_000 },
      );
      await page.evaluate(async ({ id }) => {
        const w = globalThis as unknown as STGlobal;
        w.__toyboxFreeze?.();
        await w.__toyboxLoadPreset?.(id);
      }, { id });

      await freezeAndWaitLit(page, 2.0, 0.04);
      const s = await sampleCanvas(page);
      expect(s.lit, `${id} renders non-black`).toBeGreaterThan(s.total * 0.04);
      expect(errors.filter((e) => !e.includes('AudioContext')), `${id}: no errors`).toEqual([]);
    });
  }
});
