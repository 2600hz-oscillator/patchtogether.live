// e2e/vrt/workflow-shell-faces.spec.ts
//
// VRT: the P1 CURATED FACES — the pixel gate for every migrated module under
// `?shell=1`. Batch 1: adsr / cloudseed / kickdrum / lfo / tidyVco / vca.
// Batch 2: dx7 / qbrt / shimmershine / sixstrum / snaredrum / tomtom.
// Batch 3: delay / filter / karplus / mixer / reverb.
// Two PINNED baselines per module:
//
//   face-<type>-compact — the COMPACT LANE TILE (zoom 0.45, LOD 'compact'):
//     the design-point tile — the fit-planned curated knobs (laneBodyPlan:
//     WHOLE cells only — top-2 + the fluid domain-hued glyph for glyph faces,
//     top-3 for glyph-less) inside the uniform RACKLINE frame, exactly as the
//     lane shows it.
//   face-<type>-dock    — the DOCK FULL-VIEW faceplate (view='dock-full',
//     face tier 'dock'): the glyph hero + one labeled SECTION BAND per curated
//     `face.pages` page, ALL controls rendered.
//
// The glyphs are LIVE-BOUND (shell-glyph-live.ts) but render DETERMINISTIC
// pixels here: no audio flows in these scenes, and ScopeScreen's live
// waveform mode draws the SAME flat centerline whether the tap is unattached
// or reading silence (VuMeter unlit at level 0; the adsr envelope / lfo
// wave-morph curves derive from the ParamDef defaults). Every knob sits at
// its default, so the scenes are pixel-deterministic without masks
// (animations killed via the style tag + `animations: 'disabled'`). Tight
// per-scene budgets, the workflow-shell-zoom precedent.
//
// darwin-first: darwin baselines are captured locally (3× stable); the linux
// pairs are EXEMPT_BASELINE_PAIRS-deferred until a vrt-update.yml dispatch
// lands them (vrt-meta's linux-deficit ratchet accounts for the pairs). Batch
// 1's 12 linux baselines have already landed that way; batch 2's 12 and batch
// 3's 10 are the currently-pending set.

import { test, expect, type Page } from '@playwright/test';
import { EXEMPT_BASELINE_PAIRS } from './vrt-exemptions';
import { pinVrtFonts, awaitVrtFonts } from './_fonts';

const VRT_PLATFORM = process.platform === 'darwin' ? 'darwin' : 'linux';
test.describe.configure({ mode: 'default' });

/** The P1 migrated set (= STRICT_FACES). `pages` = the declared face.pages
 *  count the dock scene must render as labeled section bands — a per-scene
 *  structural gate that fails BEFORE the pixel pin if a page is dropped. */
const FACES = [
  // batch 1
  { type: 'tidyVco', pages: 5 },
  { type: 'kickdrum', pages: 5 },
  { type: 'adsr', pages: 1 },
  { type: 'vca', pages: 1 },
  { type: 'lfo', pages: 1 },
  { type: 'cloudseed', pages: 8 },
  // batch 2 — the two pitched voices, the two drums, the two processors
  { type: 'dx7', pages: 4 },
  { type: 'sixstrum', pages: 6 },
  { type: 'snaredrum', pages: 5 },
  { type: 'tomtom', pages: 4 },
  { type: 'shimmershine', pages: 3 },
  { type: 'qbrt', pages: 2 },
  // batch 3 — the plucked-string voice + the four workhorse processors
  { type: 'karplus', pages: 3 },
  { type: 'filter', pages: 2 },
  { type: 'mixer', pages: 2 },
  // 2 → 1: `output blend` held a single knob and was a house template copied
  // across four defs; the three knobs are one idea and the band header now says
  // which of them sit inside the loop.
  { type: 'delay', pages: 1 },
  { type: 'reverb', pages: 2 },
  // batch B+ — the stereo crush
  { type: 'ringback', pages: 2 },
] as const;

/** TIGHT per-scene diff budgets (absolute pixels; Playwright takes the MIN of
 *  this and the config ratio budget). The compact tile is a small element
 *  capture (~86×81 px at zoom 0.45 — the whole image is ~7k px, so the global
 *  0.05 ratio budget would allow only ~350 px anyway); 150 px flips on any
 *  real knob/label/glyph change while sitting above rounding noise. The dock
 *  faceplate is a full-width element (~1264×≤432): 1500 px matches the
 *  workflow-shell-zoom scene budget. */
const COMPACT_MAX_DIFF = 150;
const DOCK_MAX_DIFF = 1500;

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

/** Boot `?shell=1`, spawn `type` into lane 1 via the REAL palette-drop path,
 *  and return the member's node id. Also kills animation jitter + hides the
 *  floating flow chrome (the zoom-scene stability recipe). */
async function bootWithFace(page: Page, type: string): Promise<string> {
  await pinVrtFonts(page);
  await page.goto('/rack?mode=workflow&shell=1');
  await page.waitForLoadState('networkidle');
  await awaitVrtFonts(page);
  await waitForHooks(page);

  await page.evaluate((t) => {
    const w = globalThis as unknown as {
      __setSpawnFlowPos: (p: { x: number; y: number }) => void;
      __spawnFromPalette: (t: string) => void;
    };
    // x=30 lands inside narrowed column 1's [0, SHELL_COLUMN_W) band.
    w.__setSpawnFlowPos({ x: 30, y: 40 });
    w.__spawnFromPalette(t);
  }, type);
  await page.waitForFunction(() => {
    const w = globalThis as unknown as {
      __patch?: { nodes: Record<string, { data?: { columns?: Record<string, string[]> } } | undefined> };
    };
    return (w.__patch?.nodes['pinned-mixmstrs']?.data?.columns?.['1'] ?? []).length === 1;
  });
  const memberId = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: { columns?: Record<string, string[]> } } | undefined> };
    };
    return (w.__patch.nodes['pinned-mixmstrs']?.data?.columns?.['1'] ?? [])[0] ?? '';
  });
  expect(memberId, `${type}: the lane-1 member spawned`).not.toBe('');

  await page.addStyleTag({
    content:
      '.svelte-flow__minimap,.svelte-flow__controls,.svelte-flow__attribution,.minimap-toggle{display:none !important;}' +
      '*,*::before,*::after{animation:none !important;transition:none !important;}',
  });
  return memberId;
}

/** Center the viewport on the lane-1 member (members bottom-anchor toward the
 *  4320 lane baseline) at `zoom`, then wait for the LOD face tier to settle on
 *  the member's tile + two rAFs so the tier content swap lands. */
async function frameMember(page: Page, memberId: string, zoom: number, tier: string): Promise<void> {
  await page.evaluate(
    ({ memberId, zoom }) => {
      const w = globalThis as unknown as {
        __flow: {
          getInternalNode: (id: string) => { internals?: { positionAbsolute?: { x: number; y: number } }; position?: { x: number; y: number }; measured?: { width?: number; height?: number } } | undefined;
          setViewport: (vp: { x: number; y: number; zoom: number }, o?: { duration?: number }) => void;
        };
      };
      const inode = w.__flow.getInternalNode(memberId);
      const x = inode?.internals?.positionAbsolute?.x ?? inode?.position?.x ?? 0;
      const y = inode?.internals?.positionAbsolute?.y ?? inode?.position?.y ?? 0;
      const cx = x + (inode?.measured?.width ?? 192) / 2;
      const cy = y + (inode?.measured?.height ?? 180) / 2;
      const pane = document.querySelector('.svelte-flow') as HTMLElement;
      const r = pane.getBoundingClientRect();
      w.__flow.setViewport({ x: r.width / 2 - cx * zoom, y: r.height / 2 - cy * zoom, zoom }, { duration: 0 });
    },
    { memberId, zoom },
  );
  await page.waitForFunction(
    ({ memberId, tier }) => {
      const el = document.querySelector(
        `.svelte-flow__node[data-id="${memberId}"] [data-testid="module-shell"]`,
      );
      return !!el && el.getAttribute('data-shell-tier') === tier;
    },
    { memberId, tier },
    { timeout: 10_000 },
  );
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
}

test.describe('VRT: P1 curated faces (?shell=1) — compact lane tile + dock full-view', () => {
  for (const { type, pages } of FACES) {
    test(`face-${type}-compact: the compact lane tile matches baseline`, async ({ page }) => {
      test.skip(
        EXEMPT_BASELINE_PAIRS.has(`${VRT_PLATFORM}/face-${type}-compact`),
        `face-${type}-compact on ${VRT_PLATFORM}: baseline pending (see EXEMPT_BASELINE_PAIRS)`,
      );
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));

      const memberId = await bootWithFace(page, type);
      // zoom 0.45 = the LOD 'compact' band [0.30, 0.52) — the design-point tile.
      await frameMember(page, memberId, 0.45, 'compact');

      const tile = page.locator(`.svelte-flow__node[data-id="${memberId}"] [data-testid="module-shell"]`);
      await expect(tile).toHaveScreenshot(`face-${type}-compact.png`, {
        maxDiffPixels: COMPACT_MAX_DIFF,
      });

      expect(
        errors.filter((e) => !/getUserMedia|audio/i.test(e)),
        `pageerrors: ${errors.join(' | ')}`,
      ).toEqual([]);
    });

    test(`face-${type}-dock: the dock full-view faceplate matches baseline`, async ({ page }) => {
      test.skip(
        EXEMPT_BASELINE_PAIRS.has(`${VRT_PLATFORM}/face-${type}-dock`),
        `face-${type}-dock on ${VRT_PLATFORM}: baseline pending (see EXEMPT_BASELINE_PAIRS)`,
      );
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));

      const memberId = await bootWithFace(page, type);
      // Frame at the 'full' tier so the jack-rail EXPAND affordance is
      // comfortably clickable, then open the dock full-view.
      await frameMember(page, memberId, 0.7, 'full');
      await page
        .locator(`.svelte-flow__node[data-id="${memberId}"] [data-testid="module-shell"]`)
        .getByTestId('shell-open-dock')
        .click();

      const faceplate = page.getByTestId('dock-full-view');
      await expect(faceplate).toBeVisible();
      // The migrated shell mounts at the 'dock' face tier with its curated
      // SECTION BANDS — one per declared face page.
      await expect(faceplate.locator('[data-testid="module-shell"][data-shell-tier="dock"]')).toBeVisible();
      await expect(faceplate.locator('[data-testid="face-page"]')).toHaveCount(pages);
      await page.evaluate(
        () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
      );

      await expect(faceplate).toHaveScreenshot(`face-${type}-dock.png`, {
        maxDiffPixels: DOCK_MAX_DIFF,
      });

      expect(
        errors.filter((e) => !/getUserMedia|audio/i.test(e)),
        `pageerrors: ${errors.join(' | ')}`,
      ).toEqual([]);
    });
  }
});
