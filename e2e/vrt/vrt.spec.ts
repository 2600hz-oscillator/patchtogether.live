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
// under e2e/vrt/__screenshots__/vrt.spec.ts/<type>.png
// (LFS-tracked).
//
// MASKS come from ONE of two places, and the difference matters:
//
//   * e2e/vrt/vrt-live-surfaces.ts — the LIVE-SURFACE REGISTRY. Each masked
//     region states WHY it is non-deterministic and carries a COMPANION
//     assertion (plus a per-run negative control) so the mask cannot silently
//     delete coverage. This is where new masks go.
//   * vrt-exemptions.ts:VRT_MODULE_MASKS — the PRE-REGISTRY canvas-mask table.
//     Those masks have no companion: the module is free to render nothing and
//     still pass. It is capped by a shrinking ratchet in
//     packages/web/src/lib/ui/vrt-live-surfaces.test.ts and exists only until
//     each entry is migrated into the registry with a measured companion.
//
// A module in the registry is masked+companioned; a module in neither is
// strict everywhere, which is the default and the strong position.

import { test, expect } from '@playwright/test';
import { spawnPatch } from '../tests/_helpers';
import { REGISTRY } from '../tests/_registry';
import {
  EXEMPT_FROM_VRT,
  STRICT_VRT_MODULES,
  VRT_MODULE_MASKS,
} from './vrt-exemptions';
import { applyVrtScene, VRT_SCENES } from './vrt-scenes';
import { expectVrtSceneScreenshot } from './vrt-capture';
import { pinVrtFonts, awaitVrtFonts } from './_fonts';

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
      // Capture page errors so a broken card fails the test before the
      // screenshot diff does — easier to debug than a thousand-pixel diff.
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });

      // Pin card text to the bundled Inter (sans) + JetBrains Mono (mono)
      // faces BEFORE first paint. The app's generic stacks (`--font-ui:
      // 'Inter', system-ui, …` with Inter NOT bundled; `ui-monospace,
      // monospace` for labels) otherwise resolve via the runner's
      // fontconfig to whatever face is installed — a selection that is NOT
      // stable run-to-run, so the SAME commit renders card glyphs with
      // different shapes AND different metrics (a wider face → +Npx card
      // width; a taller line-box → +1px height) and the screenshot
      // hard-fails on the dimension mismatch. Bundling + force-applying a
      // single deterministic face removes that nondeterminism at the root.
      // See e2e/vrt/_fonts.ts for the full root-cause writeup.
      await pinVrtFonts(page);

      await page.goto('/rack');
      await page.waitForLoadState('networkidle');
      // Decode + apply the bundled faces, then await document.fonts.ready,
      // so no screenshot is taken while a face is still pending. (Bravura,
      // for SCORE's SMuFL glyphs, is the only OTHER @font-face and is also
      // covered by document.fonts.ready here.)
      await awaitVrtFonts(page);

      // Hide SvelteFlow's floating chrome (minimap / controls / attribution)
      // for the capture. A large card spawned near the pane corner (e.g.
      // videoOut) otherwise catches the minimap overlay inside its element
      // screenshot — the card is fine, but the baseline isn't. The minimap is
      // an absolute overlay, so display:none doesn't reflow the flow content;
      // only cards that actually overlapped it change.
      await page.addStyleTag({
        content:
          '.svelte-flow__minimap,.svelte-flow__controls,.svelte-flow__attribution{display:none !important;}',
      });

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

      // Settle: wait until the card's layout box stops changing across
      // consecutive animation frames before we snap.
      //
      // Background on the chronic broad text-only VRT flake this guards
      // against: card text (title / knob+fader labels / port labels)
      // renders in `system-ui` — there is NO card webfont, so
      // `document.fonts.ready` (above) is a no-op for card glyphs. The
      // card box height is fractional (e.g. 317.531px from a 0.85rem /
      // line-height:normal title), and that fractional height rasterises
      // to a whole-pixel screenshot that can land one device pixel
      // taller/shorter than a baseline captured under slightly different
      // settle timing. A 1px vertical shift relands every text row on a
      // new scanline, so EVERY glyph diffs and the card trips the
      // maxDiffPixelRatio budget ("expected 319px, received 318px") —
      // intermittently, because the AA jitter only sometimes pushes it
      // over the threshold. It is a layout/raster-rounding issue, NOT a
      // fallback-vs-webfont swap.
      //
      // Two-part fix: (1) baselines were recaptured against the settled
      // render so the committed height is the deterministic one; (2) this
      // loop replaces the old single-rAF settle — a single rAF can snap
      // inside the unsettled post-mount frame, and a Svelte $effect can
      // reflow a frame later. Polling getBoundingClientRect() until the
      // rounded height is stable for several frames in a row makes the
      // capture deterministic on BOTH platforms.
      await card.evaluate(
        (el) =>
          new Promise<void>((resolve) => {
            let lastH = -1;
            let stable = 0;
            const tick = () => {
              const h = Math.round(el.getBoundingClientRect().height);
              if (h === lastH) {
                // Require 3 identical consecutive frames so a late
                // $effect-driven reflow can't sneak in after we snap.
                if (++stable >= 3) return resolve();
              } else {
                stable = 0;
                lastH = h;
              }
              requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          }),
      );

      // LEGACY masks (no companion). VRT_MODULE_MASKS keyed by module type.
      // Modules with a registered scene drop their default canvas mask —
      // applyVrtScene() drives the canvas with deterministic content, so the
      // rendered pixels belong in the diff. A module in the live-surface
      // registry is never also here (the anti-vacuity guard asserts the two
      // tables are disjoint).
      const legacyMasks = mod.type in VRT_SCENES ? [] : (VRT_MODULE_MASKS[mod.type] ?? []);

      // The seam runs every registered companion + its negative control,
      // THEN takes the strict masked screenshot. Animations are frozen by the
      // config-level expect.toHaveScreenshot settings.
      await expectVrtSceneScreenshot({
        page,
        sceneId: mod.type,
        target: card,
        legacyMaskSelectors: legacyMasks.map((m) => m.selector),
      });

      expect(errors, `${mod.type}: no console / page errors`).toEqual([]);
    });
  }
});
