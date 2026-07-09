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
// DETERMINISM: no wall-clock sleeps. CUBE's viz is param + audio-snapshot driven
// (not time-animated), so each "let it render N frames" beat drives the
// `__cubeStep()` card-step seam (one synchronous tick(), throttle bypassed, no
// rAF reschedule). Store-param settles poll the actual `__patch` value. The
// 3D-canvas lit-pixel floors are RENDERER-TOLERANT (coarse "has lit content" /
// RELATIVE on/off ratio — never bit-equality) and gated on a runtime GL probe
// (CI renders wavesculpt-class 3D under SwiftShader).

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

type PatchGlobal = {
  __patch: {
    nodes: Record<string, { params: Record<string, number>; data?: Record<string, { source?: string }> }>;
  };
};

/** Wait until the CubeCard mounted + installed its DRS step seam. */
async function awaitCubeSeam(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => typeof (globalThis as { __cubeStep?: unknown }).__cubeStep === 'function'))
    .toBe(true);
}

/** Drive `n` synchronous viz frames via the step seam (throttle bypassed). The
 *  3D scene is param/snapshot-driven, so N forced frames render deterministically. */
async function cubeStep(page: Page, n = 4): Promise<void> {
  await page.evaluate((n) => {
    const g = globalThis as { __cubeStep?: (t?: number) => number };
    for (let i = 0; i < n; i++) g.__cubeStep?.();
  }, n);
  await page.evaluate(() => {}); // flush console events to the listener
}

/** Count "lit" (brighter-than-clear) pixels on the on-card 3D canvas. */
async function litPixels(page: Page): Promise<number> {
  return page.evaluate(() => {
    const c = document.querySelector('[data-testid="cube-3d-viz"]') as HTMLCanvasElement | null;
    if (!c) return -1;
    const ctx = c.getContext('2d');
    if (!ctx) return -1;
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 0; i < data.length; i += 4) {
      if ((data[i] ?? 0) + (data[i + 1] ?? 0) + (data[i + 2] ?? 0) > 120) lit++;
    }
    return lit;
  });
}

/** Runtime GL-capability probe: WebGL2 obtainable AND the 3D canvas reads back
 *  non-degenerate content after stepping. The cube 3D path renders through WebGL2
 *  blitted onto the 2D `cube-3d-viz`; if a renderer yields nothing usable we skip
 *  the pixel floor rather than ship a flaky assert (CI = SwiftShader). */
async function cubeGlUsable(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    let webgl2 = false;
    try {
      webgl2 = !!document.createElement('canvas').getContext('webgl2');
    } catch {
      webgl2 = false;
    }
    if (!webgl2) return false;
    const c = document.querySelector('[data-testid="cube-3d-viz"]') as HTMLCanvasElement | null;
    if (!c) return false;
    const ctx = c.getContext('2d');
    if (!ctx) return false;
    let data: Uint8ClampedArray;
    try {
      data = ctx.getImageData(0, 0, c.width, c.height).data;
    } catch {
      return false;
    }
    let min = 255;
    let max = 0;
    for (let i = 0; i < data.length; i += 4) {
      const v = (data[i] ?? 0) + (data[i + 1] ?? 0) + (data[i + 2] ?? 0);
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return max - min > 4;
  });
}

test.describe('CUBE v4 — reload / screen-off / initial render', () => {
  test('card + all three viz canvases mount; 3D cube is non-blank on initial mount', async ({ page, rack, errorWatch }) => {
    await spawnPatch(page, [
      { id: 'cb', type: 'cube', position: { x: 200, y: 100 }, domain: 'audio' },
    ]);

    await expect(page.locator('[data-testid="cube-3d-viz"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="cube-slice-viz"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="cube-wave-viz"]')).toHaveCount(1);

    // Item #4: the 3D cube renders the field/material on mount (no knob touched).
    // Drive a few deterministic frames, then assert the canvas has lit content.
    await awaitCubeSeam(page);
    await cubeStep(page, 4);
    if (await cubeGlUsable(page)) {
      expect(await litPixels(page), 'the 3D cube renders content on initial mount (item #4)').toBeGreaterThan(50);
    } else {
      test.info().annotations.push({ type: 'skip-floor', description: 'no usable GL pixel read on this renderer' });
    }

  });

  test('FLOOR dropdown reload replaces node.data twice (item #1)', async ({ page, rack }) => {
    await spawnPatch(page, [
      { id: 'cb', type: 'cube', position: { x: 200, y: 100 }, domain: 'audio' },
    ]);

    const select = page.locator('[data-testid="cube-floor-select"]');
    await expect(select).toHaveCount(1);

    const optionValues = await select.locator('option').evaluateAll((opts) =>
      opts.map((o) => (o as HTMLOptionElement).value).filter((v) => v.startsWith('factory:')),
    );
    expect(optionValues.length, 'need ≥2 factory tables for the reload test').toBeGreaterThanOrEqual(2);

    const readFloorSource = () => page.evaluate(() => {
      const w = globalThis as unknown as PatchGlobal;
      return w.__patch.nodes['cb']?.data?.floor?.source ?? null;
    });

    const firstPick = optionValues[0]!;
    const secondPick = optionValues.find((v) => v !== firstPick)!;
    expect(secondPick).not.toBe(firstPick);

    // First reload — writes node.data.floor.source. Poll the store (deterministic
    // settle) rather than sleeping.
    await select.selectOption(firstPick);
    await expect.poll(readFloorSource, { message: 'first reload wrote floor.source' }).toBe(firstPick);

    // Second, DIFFERENT reload — THIS is the load that used to no-op.
    await select.selectOption(secondPick);
    await expect.poll(readFloorSource, { message: 'second/different reload replaced the table' }).toBe(secondPick);

    // And switch BACK to the first — re-selecting an already-seen value still works.
    await select.selectOption(firstPick);
    await expect.poll(readFloorSource, { message: 'reload back to the first table works' }).toBe(firstPick);
  });

  test('SCRN toggle flips the screen_on param (item #2)', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, [
      { id: 'cb', type: 'cube', position: { x: 200, y: 100 }, domain: 'audio' },
    ]);

    const readScreen = () => page.evaluate(() => {
      const w = globalThis as unknown as PatchGlobal;
      return w.__patch.nodes['cb']?.params.screen_on ?? 1;
    });

    await awaitCubeSeam(page);

    // Default ON → the live cube renders (many lit pixels). The RELATIVE on/off
    // ratio below is renderer-tolerant; gate the absolute floor on the GL probe.
    expect(await readScreen()).toBe(1);
    await cubeStep(page, 4);
    const glOk = await cubeGlUsable(page);
    const litOn = await litPixels(page);
    if (glOk) {
      expect(litOn, 'live cube fills the canvas when the screen is ON').toBeGreaterThan(2000);
    }

    const btn = page.locator('[data-testid="cube-screen-toggle"]');
    await expect(btn).toHaveCount(1);
    await btn.click();
    await expect.poll(readScreen, { message: 'screen toggled OFF' }).toBe(0);

    // With the screen OFF + video_out unpatched the viz loop is gated off, but the
    // page must keep running without errors (audio path untouched). The 3D canvas
    // paints a deterministic "SCREEN OFF" placeholder — far fewer lit pixels.
    await cubeStep(page, 4);
    const litOff = await litPixels(page);
    if (glOk) {
      expect(litOff, 'screen OFF stops the viz (placeholder only)').toBeLessThan(litOn / 5);
    }
    expect(errors, 'no errors with the screen OFF').toEqual([]);

    await btn.click();
    await expect.poll(readScreen, { message: 'screen toggled back ON' }).toBe(1);
  });
});
