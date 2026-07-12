// e2e/vrt/cellshade-composite.spec.ts
//
// Deterministic composite VRT for the CELLSHADE rebuild (4-pass cel engine —
// design: .myrobots/plans/cellshade-rebuild-2026-07-11.md). Each scene feeds a
// deterministic pure-UV source chain into CELLSHADE dialed to a visually
// distinct setting and captures the PAGE (the cube-adsr-composite recipe:
// source cards + patch cords + the CELLSHADE card with its live OUT preview
// INCLUDED — the canvas IS the regression target here, unlike the masked
// solo-spawn VRT). Page screenshots (not element screenshots) on purpose:
// Playwright's element-screenshot path runs a per-attempt scroll-into-view +
// element-stability wait that burned the whole toHaveScreenshot budget on
// this card (~2.4s per attempt, 2 attempts in 5s → 'Failed to take two
// consecutive stable screenshots' when minting) — the page path has neither
// step, and cube-adsr-composite proves it mints + gates reliably here.
//
//   cellshade-bands   SHAPEDRAMPS h_lin (colored via CHROMA tint) → hard
//                     4-band quantization, no ink, no smoothing: the flat
//                     tonal-band signature on a colored ramp.
//   cellshade-ink     LINES stripes (colored) → outline-dominant: low gate +
//                     thick solid-black ink over near-continuous bands.
//   cellshade-smooth  LINES fine grating at compressed contrast → SMOOTH = 1
//                     (the §12-required high-`smooth` isolation scene): the
//                     bilateral abstraction visibly flattens the texture,
//                     plus soft bands + mid ink.
//
// Determinism: the engine clock is pinned (`__videoEngineFreezeTime = 0`)
// BEFORE boot, so LINES renders a fixed-phase grating and SHAPEDRAMPS is a
// static pure-UV ramp — the whole chain is bit-stable; then the AudioContext
// is suspended so the card preview rAF holds the frozen frame (the
// vrt-colourofmagic recipe).
//
// Informational lane (`task vrt`) — darwin baselines captured locally; linux
// gated in EXEMPT_BASELINE_PAIRS until a vrt-update.yml workflow_dispatch runs
// (the standard darwin-first pattern; deficit ratchet bumped in vrt-meta).
//
// Output: e2e/vrt/__screenshots__/cellshade-composite.spec.ts/{platform}/<id>.png

import { test, expect } from '@playwright/test';
import { spawnPatch } from '../tests/_helpers';
import { EXEMPT_BASELINE_PAIRS } from './vrt-exemptions';

const VRT_PLATFORM = process.platform === 'darwin' ? 'darwin' : 'linux';

test.describe.configure({ mode: 'default' });

interface Node { id: string; type: string; position: { x: number; y: number }; domain: 'video'; params?: Record<string, number> }
interface Edge { id: string; from: { nodeId: string; portId: string }; to: { nodeId: string; portId: string }; sourceType?: string; targetType?: string }

interface Scene {
  id: string;
  nodes: Node[];
  edges: Edge[];
}

/** source → CHROMA tint → CELLSHADE, with per-scene params. */
function chain(
  id: string,
  src: { type: string; params?: Record<string, number>; outPort: string; outType: string },
  tint: Record<string, number>,
  cel: Record<string, number>,
): Scene {
  return {
    id,
    nodes: [
      { id: 'src', type: src.type, position: { x: 40, y: 40 }, domain: 'video', params: src.params },
      { id: 'tint', type: 'chroma', position: { x: 320, y: 40 }, domain: 'video', params: tint },
      { id: 'cel', type: 'cellshade', position: { x: 620, y: 60 }, domain: 'video', params: cel },
    ],
    edges: [
      { id: 'e-s', from: { nodeId: 'src', portId: src.outPort }, to: { nodeId: 'tint', portId: 'in' }, sourceType: src.outType, targetType: 'video' },
      { id: 'e-t', from: { nodeId: 'tint', portId: 'out' }, to: { nodeId: 'cel', portId: 'in' }, sourceType: 'video', targetType: 'video' },
    ],
  };
}

const SCENES: Scene[] = [
  // (a) bands only — hard 4-band quantization of a colored luminance ramp.
  chain(
    'cellshade-bands',
    { type: 'shapedramps', outPort: 'h_lin', outType: 'mono-video' },
    { hue: 0, saturation: 1, tintR: 0.85, tintG: 0.5, tintB: 0.65, tintMix: 0.55 },
    { threshold: 0.95, thickness: 1, bits: 2, softness: 0, smooth: 0, ink: 0 },
  ),
  // (b) ink-dominant — low gate + thick solid ink over near-continuous bands.
  chain(
    'cellshade-ink',
    { type: 'lines', params: { orient: 0, amp: 9, phase: 0 }, outPort: 'out', outType: 'mono-video' },
    { hue: 0, saturation: 1, tintR: 0.55, tintG: 0.75, tintB: 0.5, tintMix: 0.5 },
    { threshold: 0.08, thickness: 3, bits: 4, softness: 1, smooth: 0, ink: 1 },
  ),
  // (c) HIGH SMOOTH isolation — the bilateral abstraction flattens a fine
  // compressed-contrast grating (plus soft bands + mid ink).
  chain(
    'cellshade-smooth',
    { type: 'lines', params: { orient: 0, amp: 50, thickness: 0.35, phase: 0 }, outPort: 'out', outType: 'mono-video' },
    { hue: 0, saturation: 1, tintR: 0.6, tintG: 0.45, tintB: 0.7, tintMix: 0.7 },
    { threshold: 0.3, thickness: 2, bits: 2, softness: 0.5, smooth: 1, ink: 0.6 },
  ),
];

test.describe('VRT: CELLSHADE rebuild composite scenes', () => {
  for (const scene of SCENES) {
    test(`${scene.id} matches baseline`, async ({ page }) => {
      test.skip(
        EXEMPT_BASELINE_PAIRS.has(`${VRT_PLATFORM}/${scene.id}`),
        `${scene.id} on ${VRT_PLATFORM}: baseline pending (see EXEMPT_BASELINE_PAIRS)`,
      );

      test.setTimeout(90_000);

      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

      // Pin the engine clock BEFORE boot → LINES renders a fixed-phase
      // grating, the whole chain is bit-stable (no per-frame drift).
      await page.addInitScript(() => {
        (globalThis as unknown as { __videoEngineFreezeTime?: number }).__videoEngineFreezeTime = 0;
      });

      await page.goto('/rack');
      await page.waitForLoadState('networkidle');

      // Hide SvelteFlow's floating chrome (minimap / controls / attribution)
      // for the capture — the vrt.spec.ts recipe (a page capture would
      // otherwise diff on the minimap's viewport rect). display:none doesn't
      // reflow the flow content.
      await page.addStyleTag({
        content:
          '.svelte-flow__minimap,.svelte-flow__controls,.svelte-flow__attribution{display:none !important;}',
      });

      await spawnPatch(page, scene.nodes, scene.edges);

      const card = page.locator('.svelte-flow__node-cellshade').first();
      await card.waitFor({ state: 'visible', timeout: 15_000 });
      await expect(page.locator('canvas[data-testid="cellshade-preview"]')).toHaveCount(1);

      // Let the frozen frame settle into the preview.
      await page.waitForTimeout(700);
      // Suspend the AudioContext so the preview rAF holds the frozen frame.
      await page.evaluate(async () => {
        const w = globalThis as unknown as { __engine?: () => { ctx: AudioContext } | null };
        const eng = w.__engine?.();
        if (eng) { try { await eng.ctx.suspend(); } catch { /* already suspended */ } }
      });
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
      }
      await page.waitForTimeout(200);

      await expect(page).toHaveScreenshot(`${scene.id}.png`, {
        maskColor: '#ff00ff',
        fullPage: false,
      });

      expect(
        errors.filter((e) => !e.includes('AudioContext')),
        `${scene.id}: no console / page errors`,
      ).toEqual([]);
    });
  }
});
