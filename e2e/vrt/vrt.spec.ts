// e2e/vrt/vrt.spec.ts
//
// Visual Regression Test suite. One test per registered module type,
// derived from the synthesised registry manifest (`e2e/.generated/
// registry-manifest.json`) — adding a new module auto-enrols it unless
// explicitly listed in `e2e/vrt/vrt-exemptions.ts:EXEMPT_FROM_VRT`.
//
// Spawns the module via the dev __ydoc/__patch globals, waits for first
// paint, screenshots the card element, asserts byte-equal (under the
// tolerance budget set in vrt.config.ts) against the committed baseline
// under e2e/vrt/__screenshots__/vrt.spec.ts/{platform}/<type>.png
// (LFS-tracked).
//
// Per-module mask config (regions to fill with a uniform colour before
// diff — animated canvases, scope sweep, etc.) lives in
// vrt-exemptions.ts:VRT_MODULE_MASKS so the spec file stays terse.

import { test, expect } from '@playwright/test';
import { spawnPatch } from '../tests/_helpers';
import { REGISTRY } from '../tests/_registry';
import {
  EXEMPT_FROM_VRT,
  EXEMPT_BASELINE_PAIRS,
  VRT_MODULE_MASKS,
} from './vrt-exemptions';

const VRT_PLATFORM = process.platform === 'darwin' ? 'darwin' : 'linux';

// Every registered module that isn't in the exempt list. Order matches
// the manifest (alphabetical by type) for stable Playwright report
// grouping.
const COVERED_MODULES = REGISTRY.filter((m) => !(m.type in EXEMPT_FROM_VRT));

// 'default' mode = independent tests; one failing doesn't skip the
// rest. We keep workers: 1 in vrt.config.ts so paint-timing variability
// stays bounded, but unlike 'serial' we get a full report of every
// drifted baseline in one CI run.
test.describe.configure({ mode: 'default' });

test.describe('VRT: every module card matches its baseline', () => {
  for (const mod of COVERED_MODULES) {
    test(`${mod.type} card matches baseline`, async ({ page }) => {
      test.skip(
        EXEMPT_BASELINE_PAIRS.has(`${VRT_PLATFORM}/${mod.type}`),
        `${mod.type} on ${VRT_PLATFORM}: baseline pending (see EXEMPT_BASELINE_PAIRS)`,
      );
      // Capture page errors so a broken card fails the test before the
      // screenshot diff does — easier to debug than a thousand-pixel diff.
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });

      await page.goto('/');
      await page.waitForLoadState('networkidle');

      await spawnPatch(page, [
        {
          id: 'vrt-1',
          type: mod.type,
          position: { x: 80, y: 80 },
          domain: mod.domain,
        },
      ]);

      const card = page.locator(`.svelte-flow__node-${mod.type}`).first();
      await card.waitFor({ state: 'visible', timeout: 10_000 });

      // Settle: wait one rAF tick after the card mounts so any one-frame
      // post-mount layout shift (Svelte $effect fires async to DOM
      // attach) is done before we snap.
      await page.evaluate(
        () => new Promise<void>((r) => requestAnimationFrame(() => r())),
      );

      // Resolve the masking rects on the actual rendered card. Masks
      // come from VRT_MODULE_MASKS keyed by module type.
      const masks = VRT_MODULE_MASKS[mod.type] ?? [];
      const maskLocators = masks.map((m) => card.locator(m.selector));

      await expect(card).toHaveScreenshot(`${mod.type}.png`, {
        // Mask non-deterministic regions (canvases, scope sweep, etc.)
        // — Playwright fills them with maskColor in both baseline +
        // actual before diffing.
        mask: maskLocators,
        maskColor: '#ff00ff',
        // Animations frozen by config-level expect.toHaveScreenshot.
      });

      expect(errors, `${mod.type}: no console / page errors`).toEqual([]);
    });
  }
});
