// e2e/tests/cube.spec.ts
//
// CUBE v4 UI smoke. Covers the v4 fixes (PR feat/cube-v4-reload-perf-render):
//   - card + all THREE viz canvases (3D cube / slice / waveform) mount.
//   - RELOAD FIX (item #1): switching a slot's FACTORY dropdown to a different
//     table — TWICE — replaces node.data each time (the bug was the second/
//     different load no-op'ing). Mirrors the WAVESCULPT separate-selector path.
//   - SCREEN toggle (item #2): the SCRN button flips the screen_on param; with
//     the screen OFF and video_out UNPATCHED the rAF loop is gated off (the
//     biggest perf win) — audio keeps running, no console errors.
//   - INITIAL RENDER (item #4): the 3D cube canvas is non-blank on mount,
//     BEFORE any param is touched (the material used to only appear after the
//     MORPH knob moved).
//
// No pixel-exact assertions on the animated canvases (cube is in
// VRT_MODULE_MASKS.canvas / EXEMPT_BASELINE_PAIRS linux); we assert the
// store-level param/data changes + a coarse "canvas has non-background pixels".

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

type PatchGlobal = {
  __patch: {
    nodes: Record<string, { params: Record<string, number>; data?: Record<string, { source?: string }> }>;
  };
};

test.describe('CUBE v4 — reload / screen-off / initial render', () => {
  test('card + all three viz canvases mount; 3D cube is non-blank on initial mount', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, [
      { id: 'cb', type: 'cube', position: { x: 200, y: 100 }, domain: 'audio' },
    ]);

    await expect(page.locator('[data-testid="cube-3d-viz"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="cube-slice-viz"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="cube-wave-viz"]')).toHaveCount(1);

    // Item #4: the 3D cube must render the field/material on mount (no knob
    // touched). Let a couple of throttled frames tick, then assert the canvas
    // has pixels distinct from the flat clear colour.
    await page.waitForTimeout(400);
    const nonBlank = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="cube-3d-viz"]') as HTMLCanvasElement | null;
      if (!c) return false;
      const ctx = c.getContext('2d');
      if (!ctx) return false;
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      // The clear colour is a near-uniform dark blue; count distinctly-coloured
      // (brighter) pixels — the volume stack / wireframe / slice plane.
      let lit = 0;
      for (let i = 0; i < data.length; i += 4) {
        if ((data[i] ?? 0) + (data[i + 1] ?? 0) + (data[i + 2] ?? 0) > 120) lit++;
      }
      return lit > 50;
    });
    expect(nonBlank, 'the 3D cube renders content on initial mount (item #4)').toBe(true);

    expect(errors, 'no console / page errors during CUBE render').toEqual([]);
  });

  test('FLOOR dropdown reload replaces node.data twice (item #1)', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, [
      { id: 'cb', type: 'cube', position: { x: 200, y: 100 }, domain: 'audio' },
    ]);

    const select = page.locator('[data-testid="cube-floor-select"]');
    await expect(select).toHaveCount(1);

    // Read the factory <option> values so we can pick two distinct ones.
    const optionValues = await select.locator('option').evaluateAll((opts) =>
      opts.map((o) => (o as HTMLOptionElement).value).filter((v) => v.startsWith('factory:')),
    );
    expect(optionValues.length, 'need ≥2 factory tables for the reload test').toBeGreaterThanOrEqual(2);

    const readFloorSource = () => page.evaluate(() => {
      const w = globalThis as unknown as PatchGlobal;
      return w.__patch.nodes['cb']?.data?.floor?.source ?? null;
    });

    // Two distinct factory options to switch between.
    const firstPick = optionValues[0]!;
    const secondPick = optionValues.find((v) => v !== firstPick)!;
    expect(secondPick).not.toBe(firstPick);

    // First reload — writes node.data.floor.source.
    await select.selectOption(firstPick);
    await page.waitForTimeout(120);
    expect(await readFloorSource(), 'first reload wrote node.data.floor.source').toBe(firstPick);

    // Second, DIFFERENT reload — THIS is the load that used to no-op.
    await select.selectOption(secondPick);
    await page.waitForTimeout(120);
    expect(await readFloorSource(), 'second/different reload replaced the table').toBe(secondPick);

    // And switch BACK to the first — re-selecting an already-seen value still works.
    await select.selectOption(firstPick);
    await page.waitForTimeout(120);
    expect(await readFloorSource(), 'reload back to the first table works').toBe(firstPick);
  });

  test('SCRN toggle flips the screen_on param (item #2)', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, [
      { id: 'cb', type: 'cube', position: { x: 200, y: 100 }, domain: 'audio' },
    ]);

    const readScreen = () => page.evaluate(() => {
      const w = globalThis as unknown as PatchGlobal;
      return w.__patch.nodes['cb']?.params.screen_on ?? 1;
    });
    // Count "lit" (brighter-than-clear) pixels on the on-card 3D canvas — the
    // live cube fills thousands; the SCREEN-OFF placeholder is a flat dark panel
    // with only a few dim "SCREEN OFF" text pixels.
    const litPixels = () => page.evaluate(() => {
      const c = document.querySelector('[data-testid="cube-3d-viz"]') as HTMLCanvasElement | null;
      if (!c) return -1;
      const ctx = c.getContext('2d'); if (!ctx) return -1;
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      let lit = 0;
      for (let i = 0; i < data.length; i += 4) {
        if ((data[i] ?? 0) + (data[i + 1] ?? 0) + (data[i + 2] ?? 0) > 120) lit++;
      }
      return lit;
    });

    // Default ON → the live cube renders (many lit pixels).
    expect(await readScreen()).toBe(1);
    await page.waitForTimeout(400);
    const litOn = await litPixels();
    expect(litOn, 'live cube fills the canvas when the screen is ON').toBeGreaterThan(2000);

    const btn = page.locator('[data-testid="cube-screen-toggle"]');
    await expect(btn).toHaveCount(1);
    await btn.click();
    await page.waitForTimeout(120);
    expect(await readScreen(), 'screen toggled OFF').toBe(0);

    // With the screen OFF + video_out unpatched the viz loop is gated off, but
    // the page must keep running without errors (audio path untouched). The
    // on-card 3D canvas paints a deterministic "SCREEN OFF" placeholder — an
    // order of magnitude fewer lit pixels than the live cube.
    await page.waitForTimeout(300);
    expect(errors, 'no errors with the screen OFF').toEqual([]);
    const litOff = await litPixels();
    expect(litOff, 'screen OFF stops the viz (placeholder only)').toBeLessThan(litOn / 5);

    await btn.click();
    await page.waitForTimeout(120);
    expect(await readScreen(), 'screen toggled back ON').toBe(1);
  });
});
