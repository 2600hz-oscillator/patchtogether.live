// e2e/vrt/vrt-surface-probe.spec.ts
//
// MEASUREMENT TOOL, not a gate. Opt-in via `VRT_PROBE=1` (see the testMatch
// switch in vrt.config.ts) so it never costs CI a second.
//
// Purpose: before you write a companion assertion for a masked live surface,
// you have to know what the surface actually SCORES. Guessing a floor is how
// you end up with either a vacuous companion (floor 0) or a flaky one (floor
// above the run-to-run minimum). This spec spawns a module exactly the way
// vrt.spec.ts does and prints the region statistics for every canvas on the
// card, plus the same statistics with the region force-killed — i.e. the two
// numbers a companion has to sit between.
//
//   VRT_PROBE=1 PROBE_MODULES=scope,dockscope,cube \
//     npx --workspace e2e playwright test --config=vrt/vrt.config.ts vrt-surface-probe
//
// Output lines are greppable:
//   [probe] type=scope idx=0 count=1 320x120 ink=0.0271 sd=21.44 buckets=4 chroma=3.11
//   [probe] type=scope idx=0 DEAD ink=0.0000 sd=0.00 buckets=1 chroma=0.00
//
// It deliberately prints rather than asserts: a probe that fails is a probe
// you can't read.

import { test } from '@playwright/test';
import { spawnPatch } from '../tests/_helpers';
import { REGISTRY } from '../tests/_registry';
import { applyVrtScene, VRT_SCENES } from './vrt-scenes';
import { pinVrtFonts, awaitVrtFonts } from './_fonts';
import { killSurface, readSurfaceStats, type SurfaceStats } from './vrt-surface-stats';

const WANTED = (process.env.PROBE_MODULES ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const TARGETS = REGISTRY.filter((m) => WANTED.includes(m.type));

test.describe.configure({ mode: 'default' });

function fmt(s: SurfaceStats): string {
  return (
    `${s.width}x${s.height} ink=${s.inkFraction.toFixed(4)} sd=${s.lumaStdDev.toFixed(2)} ` +
    `buckets=${s.distinctLumaBuckets} chroma=${s.meanChroma.toFixed(2)} ` +
    `meanLuma=${s.meanLuma.toFixed(1)}`
  );
}

test.describe('VRT surface probe (measurement only)', () => {
  for (const mod of TARGETS) {
    test(`probe ${mod.type}`, async ({ page }) => {
      await pinVrtFonts(page);
      await page.goto('/rack?shell=legacy&seed=none');
      await page.waitForLoadState('networkidle');
      await awaitVrtFonts(page);
      await page.addStyleTag({
        content:
          '.svelte-flow__minimap,.svelte-flow__controls,.svelte-flow__attribution{display:none !important;}',
      });

      const usedScene = await applyVrtScene(page, mod.type);
      if (!usedScene) {
        await spawnPatch(page, [
          { id: 'vrt-1', type: mod.type, position: { x: 80, y: 80 }, domain: mod.domain },
        ]);
      }

      const card = page.locator(`.svelte-flow__node-${mod.type}`).first();
      await card.waitFor({ state: 'visible', timeout: 15_000 });
      await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

      const canvases = card.locator('canvas');
      const count = await canvases.count();
      // eslint-disable-next-line no-console
      console.log(
        `[probe] type=${mod.type} scene=${mod.type in VRT_SCENES} canvasCount=${count}`,
      );
      for (let i = 0; i < count; i++) {
        const loc = canvases.nth(i);
        let live: SurfaceStats | null = null;
        try {
          live = await readSurfaceStats(loc);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.log(`[probe] type=${mod.type} idx=${i} UNREADABLE ${(e as Error).message}`);
          continue;
        }
        // eslint-disable-next-line no-console
        console.log(`[probe] type=${mod.type} idx=${i} LIVE ${fmt(live)}`);

        const restore = await killSurface(loc);
        try {
          const dead = await readSurfaceStats(loc);
          // eslint-disable-next-line no-console
          console.log(`[probe] type=${mod.type} idx=${i} DEAD ${fmt(dead)}`);
        } finally {
          await restore();
        }
      }
    });
  }
});
