// e2e/tests/videovarispeed-perfzip.spec.ts
//
// FIX 2: VIDEOVARISPEED video + PICTUREBOX image must round-trip through the
// portable performance .zip.
//
// Owner report: "images probably work but video does not." Root cause:
// VIDEOVARISPEED never stamped fileMeta.handleId, never registered a bytes
// resolver with the video-export-registry, and was not matched by
// collectAssetRefs — so its clip was dropped from the zip + never re-attached.
// This spec proves the video bytes now travel in the zip + re-acquire on load
// (data-has-local-file=true → re-attached to the engine <video>), and confirms
// PICTUREBOX images still round-trip (inline base64 on the envelope).
//
// Fixtures are SMALL + committed: e2e/fixtures/av-clip.webm + tiny.png.

import { test, expect, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { spawnPatch } from './_helpers';

const AV_FIXTURE = fileURLToPath(new URL('../fixtures/av-clip.webm', import.meta.url));
const IMG_FIXTURE = fileURLToPath(new URL('../fixtures/tiny.png', import.meta.url));

const VVS_ID = 'perf-vvs';
const PIC_ID = 'perf-pic';

async function setup(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  return errors;
}

async function imageBytes(page: Page, nodeId: string): Promise<string | null> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, { data?: Record<string, unknown> }> } };
    const b = w.__patch.nodes[id]?.data?.imageBytes;
    return typeof b === 'string' ? b : null;
  }, nodeId);
}

async function nodeCount(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, unknown> } };
    return Object.keys(w.__patch.nodes).length;
  });
}

test.describe('VIDEOVARISPEED + PICTUREBOX perf-zip round-trip', () => {
  test('restores the videovarispeed video + picturebox image after a new rack', async ({ page }) => {
    const errors = await setup(page);

    await spawnPatch(page, [
      { id: VVS_ID, type: 'videovarispeed', domain: 'video', position: { x: 80, y: 80 } },
      { id: PIC_ID, type: 'picturebox', domain: 'video', position: { x: 520, y: 80 } },
    ]);

    const vvsCard = page.locator(`.svelte-flow__node[data-id="${VVS_ID}"]`);
    const picCard = page.locator(`.svelte-flow__node[data-id="${PIC_ID}"]`);

    // Load a real video + image via the real card pickers. setInputFiles drives
    // loadFile → (for VVS now) registers the export resolver + stamps handleId.
    await vvsCard.locator('[data-testid="videovarispeed-file-input"]').setInputFiles(AV_FIXTURE);
    await expect(vvsCard.locator('[data-testid="videovarispeed-card"]')).toHaveAttribute(
      'data-has-local-file', 'true', { timeout: 10000 },
    );
    await picCard.locator('[data-testid="picturebox-file-input"]').setInputFiles(IMG_FIXTURE);
    await expect(picCard.locator('[data-testid="picturebox-card"]')).toHaveAttribute(
      'data-has-image', 'true', { timeout: 10000 },
    );

    const beforeImage = await imageBytes(page, PIC_ID);
    expect(beforeImage, 'PICTUREBOX should have encoded imageBytes before export').toBeTruthy();

    // Export → capture the zip bytes (must be non-trivial — it carries the VVS
    // video bytes out-of-band, which it didn't before this fix).
    const zipB64 = await page.evaluate(async () => {
      const w = globalThis as unknown as { __perfZip: { export: () => Promise<Uint8Array> } };
      const bytes = await w.__perfZip.export();
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
      return btoa(bin);
    });
    // The av-clip fixture is ~49 KB; the zip must be well above the manifest-only
    // size, proving the video bytes travelled.
    expect(zipB64.length, 'exported zip should carry the VVS video bytes').toBeGreaterThan(10000);

    // NEW RACK: clear.
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

    // Load.
    await page.evaluate(async (b64) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const w = globalThis as unknown as { __perfZip: { load: (b: Uint8Array) => Promise<void> } };
      await w.__perfZip.load(bytes);
    }, zipB64);

    await expect.poll(() => nodeCount(page), { timeout: 8000 }).toBe(2);

    // IMAGE: restored bytes equal the pre-export value (byte-exact, inline).
    const afterImage = await imageBytes(page, PIC_ID);
    expect(afterImage, 'restored PICTUREBOX imageBytes must equal the pre-export bytes').toBe(beforeImage);

    // VIDEO: the VVS card re-acquires its file from the seeded blob handle — the
    // actual bytes travelled in the zip + were re-attached (no re-pick). THIS is
    // the fix: before it, data-has-local-file stayed false on load.
    await expect(page.locator(`.svelte-flow__node[data-id="${VVS_ID}"] [data-testid="videovarispeed-card"]`))
      .toHaveAttribute('data-has-local-file', 'true', { timeout: 12000 });

    expect(errors, `page errors: ${errors.join('\n')}`).toEqual([]);
  });
});
