// e2e/vrt/workflow-shell-zoom.spec.ts
//
// VRT: the `?shell=1` RACKLINE rack at THREE FIXED ZOOMS — the pixel gate for
// the owner-reported ZOOM-REPOSITION bug (P0.3b). The same framed rack region
// (lane 1..3 with one ch1 member + the video zone with its default trio) is
// captured at zoom 0.40 / 0.80 / 1.30 — one PINNED baseline per zoom, crossing
// the LOD tier boundaries (0.30 / 0.52 / 0.95). The e2e twin
// (workflow-shell.spec.ts "zoom is a geometric NO-OP on SCREEN") asserts the
// flow-normalized pair math; THESE scenes pin what the user actually sees: the
// tiles' position relative to the lane guide lines, the number badges, and the
// dashed video-zone band at each zoom. Any future reposition-vs-grid regression
// (e.g. the ChannelColumnsOverlay projection drifting from the node layer
// again) flips these baselines.
//
// PAGE-level capture (the workflow-dock-composite pattern): the spatial
// relationship IS the assertion. SvelteFlow floating chrome is hidden and the
// footer's live status text is masked.
//
// Baselines are authored by LINUX CI — one set, no {platform} segment (see
// vrt.config.ts). `task vrt:commit` dispatches the capture; a local macOS run
// is a smoke test, not a capture.

import { test, expect, type Page } from '@playwright/test';
import { pinVrtFonts, awaitVrtFonts } from './_fonts';

test.describe.configure({ mode: 'default' });

/** The scenes: one pinned baseline per zoom. `faceTier` is the settled
 *  data-shell-tier (the lane FACE tier — the LOD 'dock' band renders 'full'
 *  in the lane). */
const SCENES = [
  { id: 'workflow-shell-zoom-040', zoom: 0.4, faceTier: 'compact' },
  { id: 'workflow-shell-zoom-080', zoom: 0.8, faceTier: 'full' },
  { id: 'workflow-shell-zoom-130', zoom: 1.3, faceTier: 'full' },
] as const;

/** TIGHTENED per-scene diff budget (absolute pixels), overriding the global
 *  ratio budget in vrt.config.ts (0.05 of 1280×720 = 46_080 px — far too
 *  loose to gate THIS bug class). Measured with the paneLocalProjection fix
 *  REVERTED, the whole-grid 44/41px overlay drift changes only 9162 / 7640 /
 *  5528 px at zoom 0.40 / 0.80 / 1.30 — i.e. the scenes would still PASS
 *  under the default ratio budget. 1500 px flips all three RED on that
 *  drift (min observed 5528) while sitting far above run-to-run noise:
 *  the tiles are static (animations are killed via the style tag below +
 *  `animations: 'disabled'`), and 3× re-runs per scene reported 0 diff
 *  pixels. Playwright combines per-call maxDiffPixels with the config's
 *  maxDiffPixelRatio by taking the MIN, so this is the effective budget. */
const SCENE_MAX_DIFF_PIXELS: Record<(typeof SCENES)[number]['id'], number> = {
  'workflow-shell-zoom-040': 1500,
  'workflow-shell-zoom-080': 1500,
  'workflow-shell-zoom-130': 1500,
};

/** Wait until the Canvas dev spawn/viewport hooks are registered. */
async function waitForHooks(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as {
        __setSpawnFlowPos?: unknown;
        __spawnFromPalette?: unknown;
        __flow?: unknown;
      };
      return (
        typeof w.__setSpawnFlowPos === 'function' &&
        typeof w.__spawnFromPalette === 'function' &&
        !!w.__flow
      );
    },
    undefined,
    { timeout: 20_000 },
  );
}

test.describe('VRT: ?shell=1 rack holds position vs the lane grid at fixed zooms', () => {
  for (const { id, zoom, faceTier } of SCENES) {
    test(`${id}: the framed rack region matches baseline at zoom ${zoom}`, async ({ page }) => {

      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));

      await pinVrtFonts(page);
      await page.goto('/rack?mode=workflow&shell=1');
      await page.waitForLoadState('networkidle');
      await awaitVrtFonts(page);
      await waitForHooks(page);

      // The default video-zone trio + ONE deterministic ch1 member (a vca —
      // auto-named VCA1) so the tile↔lane-line relationship is in frame.
      // videoOut renders its verbatim LEGACY card (NON_SHELL video-surface
      // snowflake — the shell video-visibility fix); the other two are tiles
      // whose glyph slot is the LIVE-THUMB well (static dark here: VRT never
      // boots the engine, so the thumb canvas stays its deterministic idle
      // background — no masking needed).
      await page
        .locator('.svelte-flow__node[data-id="workflow-videoOut"] [data-testid="video-out-card"]')
        .waitFor({ state: 'attached', timeout: 15_000 });
      for (const vz of ['workflow-recorderbox', 'workflow-synesthesia']) {
        await page
          .locator(`.svelte-flow__node[data-id="${vz}"] [data-testid="module-shell-placeholder"]`)
          .waitFor({ state: 'attached', timeout: 15_000 });
      }
      await page.evaluate(() => {
        const w = globalThis as unknown as {
          __setSpawnFlowPos: (p: { x: number; y: number }) => void;
          __spawnFromPalette: (t: string) => void;
        };
        // x=30 lands inside narrowed column 1's [0, SHELL_COLUMN_W) band.
        w.__setSpawnFlowPos({ x: 30, y: 40 });
        w.__spawnFromPalette('vca');
      });
      await page.waitForFunction(() => {
        const w = globalThis as unknown as {
          __patch?: { nodes: Record<string, { data?: { columns?: Record<string, string[]> } } | undefined> };
        };
        return (w.__patch?.nodes['pinned-mixmstrs']?.data?.columns?.['1'] ?? []).length === 1;
      });

      // Stable page capture: hide the floating flow chrome + kill animation
      // jitter (the placeholder wave dash-scan etc.).
      await page.addStyleTag({
        content:
          '.svelte-flow__minimap,.svelte-flow__controls,.svelte-flow__attribution,.minimap-toggle{display:none !important;}' +
          '*,*::before,*::after{animation:none !important;transition:none !important;}',
      });

      // Frame the SAME rack region at every zoom: lane 1..3 (the ch1 member +
      // its badge + guide lines) and the video-zone top edge with its tiles,
      // centered on one fixed flow anchor so only the ZOOM differs per scene.
      await page.evaluate((z) => {
        const f = (globalThis as unknown as {
          __flow: {
            setViewport: (vp: { x: number; y: number; zoom: number }, o?: { duration?: number }) => void;
          };
        }).__flow;
        const pane = document.querySelector('.svelte-flow') as HTMLElement;
        const r = pane.getBoundingClientRect();
        const cx = 300; // mid lane 1..3 at the tight 216px pitch
        const cy = 4200; // just above the lane baseline (4320) → video zone in frame
        f.setViewport({ x: r.width / 2 - cx * z, y: r.height / 2 - cy * z, zoom: z }, { duration: 0 });
      }, zoom);
      // The LOD face tier settles on every tile before capture.
      await page.waitForFunction(
        (t) => {
          const tiles = Array.from(document.querySelectorAll('[data-shell-tier]'));
          return tiles.length > 0 && tiles.every((el) => el.getAttribute('data-shell-tier') === t);
        },
        faceTier,
        { timeout: 10_000 },
      );
      // Two rAFs so the overlay re-projection + tier content swap settle.
      await page.evaluate(
        () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
      );

      await expect(page).toHaveScreenshot(`${id}.png`, {
        maxDiffPixels: SCENE_MAX_DIFF_PIXELS[id],
        mask: [
          // Live status text (ctx/sr/lat readouts + the trace counter) —
          // environment/timing-dependent; the rack-vs-grid geometry is the
          // assertion.
          page.locator('footer.bottombar .status'),
          page.locator('details.trace-panel summary'),
        ],
        maskColor: '#ff00ff',
        fullPage: false,
      });

      expect(
        errors.filter((e) => !/getUserMedia|audio/i.test(e)),
        `pageerrors: ${errors.join(' | ')}`,
      ).toEqual([]);
    });
  }
});
