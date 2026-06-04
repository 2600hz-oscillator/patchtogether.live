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
  STRICT_VRT_MODULES,
  VRT_MODULE_MASKS,
} from './vrt-exemptions';
import { applyVrtScene, VRT_SCENES } from './vrt-scenes';

const VRT_PLATFORM = process.platform === 'darwin' ? 'darwin' : 'linux';

// `VRT_STRICT=1` filters the suite down to the deterministic, pure-DOM
// knob/fader cards listed in STRICT_VRT_MODULES. Used by `task vrt:strict`
// (the gate inside `task ci`) so a fast deterministic VRT pass can block
// the local PR-gate without dragging in the canvas-driven/animated cards
// that legitimately flake. The full sweep (`task vrt`) still runs all
// covered modules in CI as the informational lane.
const STRICT = process.env.VRT_STRICT === '1';

// Every registered module that isn't in the exempt list. Order matches
// the manifest (alphabetical by type) for stable Playwright report
// grouping. Under VRT_STRICT we further restrict to the strict subset.
const COVERED_MODULES = REGISTRY
  .filter((m) => !(m.type in EXEMPT_FROM_VRT))
  .filter((m) => !STRICT || STRICT_VRT_MODULES.has(m.type));

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
      // Wait for the webfont to finish loading BEFORE any screenshot. On a slow
      // font load the card text renders in a fallback face and every text glyph
      // diffs against the baseline — a broad, intermittent VRT flake that gets
      // reliably triggered by pages with more text (e.g. extra topbar buttons).
      // networkidle does not guarantee font readiness; document.fonts.ready does.
      await page.evaluate(() => document.fonts.ready);

      // Use a registered scene if one exists for this module type
      // (drives the card's canvas with real content so the baseline
      // is informative + the diff catches rendering regressions).
      // Otherwise fall back to the default solo-spawn flow.
      const usedScene = await applyVrtScene(page, mod.type);
      if (!usedScene) {
        await spawnPatch(page, [
          {
            id: 'vrt-1',
            type: mod.type,
            position: { x: 80, y: 80 },
            domain: mod.domain,
          },
        ]);
      }

      const card = page.locator(`.svelte-flow__node-${mod.type}`).first();
      await card.waitFor({ state: 'visible', timeout: 10_000 });

      // Settle: wait one rAF tick after the card mounts so any one-frame
      // post-mount layout shift (Svelte $effect fires async to DOM
      // attach) is done before we snap.
      await page.evaluate(
        () => new Promise<void>((r) => requestAnimationFrame(() => r())),
      );

      // Resolve the masking rects on the actual rendered card. Masks
      // come from VRT_MODULE_MASKS keyed by module type. Modules with
      // a registered scene drop their default canvas mask — the
      // freeze-after-suspend trick in applyVrtScene() makes the
      // canvas pixel-stable, so it's safe (and useful) to include the
      // rendered content in the diff.
      const masks = mod.type in VRT_SCENES ? [] : (VRT_MODULE_MASKS[mod.type] ?? []);
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
