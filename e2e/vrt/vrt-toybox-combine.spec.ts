// e2e/vrt/vrt-toybox-combine.spec.ts
//
// Per-combine-mode VRT for TOYBOX (Phase 2). The KEY proof that the four
// combine operators each mix/alter their two inputs DIFFERENTLY.
//
// Setup (identical across all four baselines):
//   - layer 0 = cos-gradient (FX) — a bright multi-hue cosine-palette field.
//   - layer 1 = worley-cells (GEN) — a teal cellular pattern.
//   Both are FROZEN at a fixed iTime (window.__toyboxFreeze) so each shader is
//   a pure function of pixel coords + uniforms → pixel-stable across runs.
//
// Per test we install a MINIMAL 2-input combine graph — `op(a=L0, b=L1) →
// output` — with the op set to fade / lumakey / chromakey / map(screen) at
// FIXED params, then snapshot the card's live preview canvas. Because the two
// input layers are identical across all four, any pixel difference between the
// baselines is PURELY the combine op's doing → the four baselines are visibly
// distinct, proving each operator composites differently.
//
// Informational lane (`task vrt`, FULL_MATCH) — darwin baseline captured
// locally; linux pending a `task vrt:update` on CI.
//
// Output: e2e/vrt/__screenshots__/vrt-toybox-combine.spec.ts/{platform}/<mode>.png

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from '../tests/_helpers';

const VRT_PLATFORM = process.platform === 'darwin' ? 'darwin' : 'linux';

// Fixed iTime for both layers — same for every mode so the inputs are
// identical and the only variable is the combine op.
const FREEZE_TIME = 4.0;

// Layer params pinned to manifest defaults (explicit so a future default
// change can't silently move the baseline).
const L0 = { kind: 'shader', contentId: 'cos-gradient', params: { speed: 0.5, phase: 0.0, scale: 3.0 } };
const L1 = { kind: 'gen', contentId: 'worley-cells', params: { density: 6.0, edge: 1.0, speed: 0.6 } };

// The four combine ops + the fixed op-node params that produce a clear,
// distinct composite. `op(a=L0, b=L1) → output`.
const MODES: Array<{ name: string; op: string; params: Record<string, number> }> = [
  { name: 'fade', op: 'fade', params: { t: 0.5 } },
  { name: 'lumakey', op: 'lumakey', params: { threshold: 0.5, softness: 0.1, invert: 0 } },
  { name: 'chromakey', op: 'chromakey', params: { keyR: 0.0, keyG: 1.0, keyB: 0.0, tolerance: 0.3, softness: 0.2, spillSuppress: 0.5 } },
  { name: 'map-screen', op: 'map', params: { mode: 0, mix: 1.0 } },
];

test.describe.configure({ mode: 'default' });

/** Install layers 0+1 (frozen content) + a 2-input combine graph for `op`,
 *  freeze the clock, and wait until the preview shows real (non-black)
 *  content. */
async function setupCombine(
  page: Page,
  op: string,
  params: Record<string, number>,
): Promise<void> {
  // Resume the clock first so the new content compiles + renders.
  await page.evaluate(() => {
    const g = globalThis as unknown as { __toyboxFreeze?: (t?: number) => void };
    g.__toyboxFreeze?.();
  });

  await page.evaluate(
    ({ op, params, L0, L1 }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['tb'];
        if (!n) return;
        if (!n.data) n.data = {};
        n.data.layers = [
          L0,
          L1,
          { kind: 'off', contentId: null, params: {} },
          { kind: 'off', contentId: null, params: {} },
        ];
        // Minimal 2-input combine: op(a=layer0, b=layer1) → output.
        n.data.combine = {
          nodes: [
            { id: 'op', type: 'op', op, params },
            { id: 'out', type: 'output' },
          ],
          edges: [
            { source: 'layer0', target: 'op', inlet: 'a' },
            { source: 'layer1', target: 'op', inlet: 'b' },
            { source: 'op', target: 'out', inlet: 'in' },
          ],
        };
      });
    },
    { op, params, L0, L1 },
  );

  // Poll until the live preview shows non-black pixels (both layer shaders
  // fetched + compiled + the op pass ran), then freeze.
  await page.waitForFunction(
    ({ time }) => {
      const g = globalThis as unknown as { __toyboxFreeze?: (t?: number) => void };
      g.__toyboxFreeze?.(time);
      const canvas = document.querySelector(
        '[data-testid="toybox-canvas"]',
      ) as HTMLCanvasElement | null;
      if (!canvas) return false;
      const c2d = canvas.getContext('2d');
      if (!c2d) return false;
      const { data } = c2d.getImageData(0, 0, canvas.width, canvas.height);
      let lit = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i]! > 16 || data[i + 1]! > 16 || data[i + 2]! > 16) lit++;
      }
      return lit > (canvas.width * canvas.height) * 0.1;
    },
    { time: FREEZE_TIME },
    { timeout: 10_000 },
  );

  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

test.describe('VRT: TOYBOX per-combine-mode frozen composite', () => {
  for (const m of MODES) {
    test(`${m.name} composites distinctly`, async ({ page }) => {
      test.skip(
        VRT_PLATFORM === 'linux',
        `linux/toybox-combine-${m.name}: darwin baseline only; linux pending a vrt:update on CI`,
      );

      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(msg.text());
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

      await setupCombine(page, m.op, m.params);

      const canvas = page.locator('[data-testid="toybox-canvas"]');
      await expect(canvas).toHaveScreenshot(`${m.name}.png`, {
        maskColor: '#ff00ff',
      });

      expect(
        errors.filter((e) => !e.includes('AudioContext')),
        'no console / page errors',
      ).toEqual([]);
    });
  }
});
