// e2e/tests/videobox-performance-bundle.spec.ts
//
// Portable Performance Bundle (.zip) round-trip — the cross-machine
// "Export performance" / "Load performance" feature.
//
// ONE focused, deterministic round-trip (no matrix — this lands in the
// serialized e2e-video lane via the `videobox-*` glob, already near its budget):
//
//   1. Spawn a moderately heavy rack: VIDEOBOX (load a real video asset) +
//      PICTUREBOX (load a real image asset) + a TOYBOX.
//   2. Confirm the video is loaded + the image decoded (data attributes).
//   3. Export performance → capture the .zip bytes (via the __perfZip hook, so
//      no download dialog).
//   4. NEW RACK: clear the patch → assert empty.
//   5. Load performance from the captured bytes.
//   6. Assert CONTENT correctness deterministically:
//        - PICTUREBOX restored node.data.imageBytes EQUALS the pre-export value
//          (the image bytes round-tripped exactly), and the card shows has-image.
//        - VIDEOBOX re-acquires its file (data-has-local-file=true), proving the
//          actual video BYTES travelled in the zip + were seeded back into the
//          handle store — no re-pick. (Cross-machine: the bytes are in the zip,
//          not a FileSystemFileHandle.)
//
// Fixtures are SMALL + committed (CI stays cheap): e2e/fixtures/av-clip.webm
// (49 KB) + e2e/fixtures/tiny.png (75 B). The user's IMG_5206.MOV + a mountain
// photo are for MANUAL verification only (see the PR description), NOT committed.
//
// RENDER-SMOKE / SwiftShader cost: this is a PURE DATA round-trip — it exports a
// .zip, clears, re-imports, and asserts DOM / Y.Doc state (imageBytes byte-exact,
// data-has-local-file, nodeCount). It NEVER reads a canvas / output texture. The
// only reason it was expensive on CI's SwiftShader software renderer was the
// live, unbounded VideoEngine rAF render loop grinding away under VIDEOBOX +
// PICTUREBOX + TOYBOX while the test did its data work — that GPU churn blew the
// timeout on the software renderer. `installRenderSmokeHooks(page)` BEFORE the
// app boots IDLES the rAF render loop (`__videoEnginePause`), so no frames are
// drawn during the data round-trip. Every assertion below is unchanged — we
// remove the render COST, not the checks. (The frozen clock it also sets is a
// no-op here: this spec reads no pixels.)

import { test, expect, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks } from './_render-smoke';

const AV_FIXTURE = fileURLToPath(new URL('../fixtures/av-clip.webm', import.meta.url));
const IMG_FIXTURE = fileURLToPath(new URL('../fixtures/tiny.png', import.meta.url));

const VID_ID = 'perf-vid';
const PIC_ID = 'perf-pic';
const TOY_ID = 'perf-toy';

async function setup(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  // Pause the engine rAF render loop BEFORE the app boots. This is a pure DATA
  // round-trip (no pixel reads), so idling the renderer keeps the heavy rack
  // cheap on CI's SwiftShader software renderer without touching any assertion.
  await installRenderSmokeHooks(page);
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  return errors;
}

/** Read a node's data.imageBytes from the live patch (or null). */
async function imageBytes(page: Page, nodeId: string): Promise<string | null> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, { data?: Record<string, unknown> }> } };
    const b = w.__patch.nodes[id]?.data?.imageBytes;
    return typeof b === 'string' ? b : null;
  }, nodeId);
}

/** Count nodes in the live patch. */
async function nodeCount(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, unknown> } };
    return Object.keys(w.__patch.nodes).length;
  });
}

test.describe('Portable Performance Bundle (.zip) round-trip', () => {
  test('exports the whole rack + restores video + image content after a new rack', async ({ page }) => {
    const errors = await setup(page);

    // ---- 1. Spawn the heavy rack ----
    await spawnPatch(page, [
      { id: VID_ID, type: 'videobox', domain: 'video', position: { x: 80, y: 80 } },
      { id: PIC_ID, type: 'picturebox', domain: 'video', position: { x: 460, y: 80 } },
      { id: TOY_ID, type: 'toybox', domain: 'video', position: { x: 840, y: 80 } },
    ]);

    const vidCard = page.locator(`.svelte-flow__node[data-id="${VID_ID}"]`);
    const picCard = page.locator(`.svelte-flow__node[data-id="${PIC_ID}"]`);

    // ---- 2. Load real assets via the real card pickers ----
    // VIDEOBOX: setInputFiles drives loadFile → registers the export resolver.
    await vidCard.locator('[data-testid="videobox-file-input"]').setInputFiles(AV_FIXTURE);
    await expect(vidCard.locator('[data-testid="videobox-card"]')).toHaveAttribute(
      'data-has-local-file', 'true', { timeout: 10000 },
    );

    // PICTUREBOX: setInputFiles drives onFileChange → downscale+encode → imageBytes.
    await picCard.locator('[data-testid="picturebox-file-input"]').setInputFiles(IMG_FIXTURE);
    await expect(picCard.locator('[data-testid="picturebox-card"]')).toHaveAttribute(
      'data-has-image', 'true', { timeout: 10000 },
    );

    const beforeImage = await imageBytes(page, PIC_ID);
    expect(beforeImage, 'PICTUREBOX should have encoded imageBytes before export').toBeTruthy();
    expect(beforeImage!.length).toBeGreaterThan(50);

    // ---- 3. Export performance → capture the .zip bytes ----
    const zipB64 = await page.evaluate(async () => {
      const w = globalThis as unknown as { __perfZip: { export: () => Promise<Uint8Array> } };
      const bytes = await w.__perfZip.export();
      // Return as base64 so it crosses the CDP boundary intact.
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
      return btoa(bin);
    });
    expect(zipB64.length, 'exported zip should be non-trivial (carries the video bytes)').toBeGreaterThan(1000);

    // ---- 4. NEW RACK: clear everything ----
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        for (const id of Object.keys(w.__patch.edges)) delete w.__patch.edges[id];
        for (const id of Object.keys(w.__patch.nodes)) delete w.__patch.nodes[id];
      });
    });
    await expect.poll(() => nodeCount(page), { timeout: 5000 }).toBe(0);

    // ---- 5. Load performance from the captured bytes ----
    await page.evaluate(async (b64) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const w = globalThis as unknown as { __perfZip: { load: (b: Uint8Array) => Promise<void> } };
      await w.__perfZip.load(bytes);
    }, zipB64);

    // ---- 6. Assert content correctness ----
    // All three modules came back.
    await expect.poll(() => nodeCount(page), { timeout: 8000 }).toBe(3);
    await expect(page.locator(`.svelte-flow__node[data-id="${VID_ID}"]`)).toBeVisible({ timeout: 8000 });
    await expect(page.locator(`.svelte-flow__node[data-id="${PIC_ID}"]`)).toBeVisible({ timeout: 8000 });
    await expect(page.locator(`.svelte-flow__node[data-id="${TOY_ID}"]`)).toBeVisible({ timeout: 8000 });

    // IMAGE: restored imageBytes equals the pre-export value (byte-exact).
    const afterImage = await imageBytes(page, PIC_ID);
    expect(afterImage, 'restored PICTUREBOX imageBytes must equal the pre-export bytes').toBe(beforeImage);
    await expect(page.locator(`.svelte-flow__node[data-id="${PIC_ID}"] [data-testid="picturebox-card"]`))
      .toHaveAttribute('data-has-image', 'true', { timeout: 8000 });

    // VIDEO: the card re-acquires the file from the seeded blob handle (the
    // actual bytes travelled in the zip) — no re-pick, fully cross-machine.
    await expect(page.locator(`.svelte-flow__node[data-id="${VID_ID}"] [data-testid="videobox-card"]`))
      .toHaveAttribute('data-has-local-file', 'true', { timeout: 12000 });

    expect(errors, `page errors: ${errors.join('\n')}`).toEqual([]);
  });
});
