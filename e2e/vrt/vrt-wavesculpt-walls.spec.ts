// e2e/vrt/vrt-wavesculpt-walls.spec.ts
//
// VRT baselines for WAVESCULPT's VIDEO WALL inputs (6 cross-domain video
// inputs textured onto the 6 faces of the 3D room). Two deterministic cases:
//
//   * walls-flat       — a SHAPES test pattern textured onto FRONT (wall1) at
//                        100% transparency, DISTORT 0 → a FLAT quad on the
//                        −Z face. EYEBALL: the shape pattern is visible as a
//                        flat wall behind the ribbons.
//   * walls-mid-distort— the SAME SHAPES pattern on FRONT at 100%, DISTORT
//                        0.5 → the wall bulges into a partial convex dome
//                        toward the camera. EYEBALL: the pattern is warped
//                        (fisheye) + the quad visibly domes inward vs flat.
//
// Determinism: SHAPES is a STATIC (time-independent) pattern source — its
// fragment shader has no `uTime`, so the wall texture is identical every
// frame. The card's own time-driven inputs (CRT post, wave-phase, bolt) are
// pinned by the SAME freeze hook (globalThis.__wavesculptVrtFreeze) the
// blink baselines use, and audio is suspended after a settle. So a single
// screenshot is reproducible across runs/rAFs.
//
// ⚠ WebGL rasterization differs sub-thresholdly across GPU drivers, which is
// why these scenes were dark on linux for months. They are not any more: the
// baseline IS the linux render, so the only driver in the comparison is the
// runner's.
// Baselines are authored by LINUX CI — one set, no {platform} segment (see
// vrt.config.ts). `task vrt:commit` dispatches the capture; a local macOS run
// is a smoke test, not a capture.

import { test, expect } from '@playwright/test';
import { spawnPatch, canvasNode } from '../tests/_helpers';
import { pinVrtFonts, awaitVrtFonts } from './_fonts';

interface WallCase {
  name: string;
  distort: number;
}

const CASES: WallCase[] = [
  { name: 'walls-flat', distort: 0 },
  { name: 'walls-mid-distort', distort: 0.5 },
];

test.describe.configure({ mode: 'default' });

test.describe('VRT: WAVESCULPT video walls', () => {
  for (const c of CASES) {
    test(`${c.name} matches baseline`, async ({ page }) => {

      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });

      // Pin the bundled Inter/JetBrains Mono BEFORE the first navigation and
      // await their decode after load — the app resolves card text through
      // GENERIC stacks (system-ui / ui-monospace) that fontconfig picks
      // nondeterministically, and document.fonts.ready can't see them. Without
      // this the captured text metrics differ run-to-run and platform-to-platform.
      // Full root cause: e2e/vrt/_fonts.ts.
      await pinVrtFonts(page);
      await page.goto('/rack?seed=none');
      await page.waitForLoadState('networkidle');
      await awaitVrtFonts(page);

      // SHAPES (a static test pattern) → wall1 (FRONT face). Camera nudged
      // off-axis (rot + a little height) so the FRONT wall is clearly in
      // view and the dome bulge reads as 3D. wall1_alpha=100 (opaque),
      // wall1_distort per case. The frame carries WAVESCULPT's own light CRT
      // pass (bloom/noise are baked constants, not params); the frozen uTime
      // keeps its grain deterministic.
      await spawnPatch(
        page,
        [
          { id: 'pat', type: 'shapes', position: { x: 40, y: 40 }, domain: 'video', params: { shape: 1, tile: 1, tileN: 4, zoom: 1 } },
          {
            id: 'vrt-walls',
            type: 'wavesculpt',
            position: { x: 480, y: 40 },
            domain: 'audio',
            params: {
              wall1_alpha: 100,
              wall1_distort: c.distort,
              rot: 0.35, pos_z: 0.2, zoom: 1.2,
            },
          },
        ],
        [
          {
            id: 'e_pat_wall1',
            from: { nodeId: 'pat', portId: 'out' },
            to: { nodeId: 'vrt-walls', portId: 'wall1' },
            sourceType: 'video',
            targetType: 'video',
          },
        ],
      );

      // ⚠ BY NODE ID, NOT NODE TYPE. xyflow tags a lane node with its NODE TYPE
      // and every lane node is `moduleShell`, so a per-module class matches
      // nothing (the mechanism `e2e/tests/ptzcam.spec.ts` records).
      const card = canvasNode(page, 'vrt-walls');
      await card.waitFor({ state: 'visible', timeout: 10_000 });

      // Let the wall texture upload + a couple of feedback frames settle,
      // then freeze the time-derived inputs + suspend audio.
      await page.waitForTimeout(600);
      await page.evaluate(() => {
        (globalThis as unknown as { __wavesculptVrtFreeze?: boolean }).__wavesculptVrtFreeze = true;
      });
      await page.evaluate(async () => {
        const w = globalThis as unknown as { __engine?: () => { ctx: AudioContext } | null };
        const eng = w.__engine?.();
        if (eng) { try { await eng.ctx.suspend(); } catch { /* */ } }
      });
      await page.evaluate(
        () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
      );

      await expect(card).toHaveScreenshot(`wavesculpt-${c.name}.png`, {
        maskColor: '#ff00ff',
      });

      expect(errors, `wavesculpt ${c.name}: no console / page errors`).toEqual([]);
    });
  }
});
