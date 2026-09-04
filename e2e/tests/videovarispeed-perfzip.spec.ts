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
// FIX B (multi-slot): VIDEOVARISPEED's 7-slot "Load multiple…" selector kept
// per-slot bytes ONLY in local object URLs; the export resolver dumped slot 0
// only, so a perf with N videos lost N-1 of them. The second test loads BOTH
// slot 0 (main picker) AND slot 1 (the multi panel) and asserts both come back
// after a fresh rack — proving every populated slot now travels in the bundle.
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
  await page.goto('/rack?seed=none');
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


/** Open a videovarispeed node's dock full view — every transport affordance
 *  (file input, PLAY/LOOP, slots, crop) is its `fullViewBody`; the SAME
 *  `videovarispeed-*` testids the card carried render there, including the
 *  state attributes, which live on `videovarispeed-face-body`. Idempotent
 *  (openFullView de-dupes). */
async function openVvsPane(page: import('@playwright/test').Page, id: string): Promise<void> {
  await page.waitForFunction(
    () =>
      typeof (globalThis as unknown as { __openDockFullView?: unknown }).__openDockFullView ===
      'function',
    undefined,
    { timeout: 30_000 },
  );
  await page.evaluate(
    (i) => (globalThis as unknown as { __openDockFullView: (x: string) => void }).__openDockFullView(i),
    id,
  );
  await page
    .locator(`[data-testid="dock-fullview-pane"][data-pane-node="${id}"] [data-testid="videovarispeed-face-body"]`)
    .waitFor({ state: 'visible', timeout: 60_000 });
}

/** Open PICTUREBOX's dock full view (its file input + bank are its
 *  `fullViewBody`; `data-has-image` lives on `picturebox-assets-body`). */
async function openPicPane(page: import('@playwright/test').Page, id: string): Promise<void> {
  await page.evaluate(
    (i) => (globalThis as unknown as { __openDockFullView: (x: string) => void }).__openDockFullView(i),
    id,
  );
  await page
    .locator(`[data-testid="dock-fullview-pane"][data-pane-node="${id}"] [data-testid="picturebox-assets-body"]`)
    .waitFor({ state: 'visible', timeout: 60_000 });
}

test.describe('VIDEOVARISPEED + PICTUREBOX perf-zip round-trip', () => {
  test('restores the videovarispeed video + picturebox image after a new rack', async ({ page }) => {
    const errors = await setup(page);

    await spawnPatch(page, [
      { id: VVS_ID, type: 'videovarispeed', domain: 'video', position: { x: 80, y: 80 } },
      { id: PIC_ID, type: 'picturebox', domain: 'video', position: { x: 520, y: 80 } },
    ]);
    await openVvsPane(page, VVS_ID);

    const vvsCard = page.locator(`[data-testid="dock-fullview-pane"][data-pane-node="${VVS_ID}"]`);

    // Load a real video + image via the real dock pickers. setInputFiles drives
    // loadFile → (for VVS now) registers the export resolver + stamps handleId.
    await vvsCard.locator('[data-testid="videovarispeed-file-input"]').setInputFiles(AV_FIXTURE);
    await expect(vvsCard.locator('[data-testid="videovarispeed-face-body"]')).toHaveAttribute(
      'data-has-local-file', 'true', { timeout: 10000 },
    );
    // Two panes at once — the pic pane joins the vvs pane; scope by node.
    await openPicPane(page, PIC_ID);
    const picCard = page.locator(`[data-testid="dock-fullview-pane"][data-pane-node="${PIC_ID}"]`);
    await picCard.locator('[data-testid="picturebox-face-file-input"]').setInputFiles(IMG_FIXTURE);
    // `data-has-image` lives on the face CANVAS (not the body root).
    await expect(picCard.locator('[data-testid="picturebox-face-canvas"]')).toHaveAttribute(
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

    // VIDEO: the VVS node re-acquires its file from the seeded blob handle — the
    // actual bytes travelled in the zip + were re-attached (no re-pick). THIS is
    // the fix: before it, data-has-local-file stayed false on load. (The clear
    // closed the pane with the node; reopen it for the restored node.)
    await openVvsPane(page, VVS_ID);
    await expect(page.locator(`[data-testid="dock-fullview-pane"][data-pane-node="${VVS_ID}"] [data-testid="videovarispeed-face-body"]`))
      .toHaveAttribute('data-has-local-file', 'true', { timeout: 12000 });

    expect(errors, `page errors: ${errors.join('\n')}`).toEqual([]);
  });

  test('restores ALL populated VIDEOVARISPEED slots (slot 0 + slot 1) after a new rack', async ({ page }) => {
    const errors = await setup(page);

    await spawnPatch(page, [
      { id: VVS_ID, type: 'videovarispeed', domain: 'video', position: { x: 80, y: 80 } },
    ]);
    await openVvsPane(page, VVS_ID);

    const vvsCard = page.locator(`[data-testid="dock-fullview-pane"][data-pane-node="${VVS_ID}"]`);

    // Slot 0 via the main picker.
    await vvsCard.locator('[data-testid="videovarispeed-file-input"]').setInputFiles(AV_FIXTURE);
    await expect(vvsCard.locator('[data-testid="videovarispeed-face-body"]')).toHaveAttribute(
      'data-has-local-file', 'true', { timeout: 10000 },
    );

    // The 7-slot bank is ALWAYS-ON in the dock face (the card's right-click
    // reveal died with the card).
    await expect(vvsCard.locator('[data-testid="videovarispeed-multi-panel"]')).toBeVisible({ timeout: 5000 });
    await vvsCard.locator('[data-testid="videovarispeed-slot-input-1"]').setInputFiles(AV_FIXTURE);
    // Slot 1 holds LOCAL bytes (data-slot-local=true), not just synced meta.
    await expect(vvsCard.locator('[data-testid="videovarispeed-slot-1"]'))
      .toHaveAttribute('data-slot-local', 'true', { timeout: 10000 });

    // Export.
    const zipB64 = await page.evaluate(async () => {
      const w = globalThis as unknown as { __perfZip: { export: () => Promise<Uint8Array> } };
      const bytes = await w.__perfZip.export();
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
      return btoa(bin);
    });
    // Two ~49 KB clips out-of-band → well above a 1-clip bundle.
    expect(zipB64.length, 'exported zip should carry BOTH slot videos').toBeGreaterThan(20000);

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

    await expect.poll(() => nodeCount(page), { timeout: 8000 }).toBe(1);

    // Slot 0 re-acquires (active slot → data-has-local-file true). (The clear
    // closed the pane; reopen for the restored node.)
    await openVvsPane(page, VVS_ID);
    await expect(page.locator(`[data-testid="dock-fullview-pane"][data-pane-node="${VVS_ID}"] [data-testid="videovarispeed-face-body"]`))
      .toHaveAttribute('data-has-local-file', 'true', { timeout: 12000 });

    // Slot 1 re-acquires too: the always-on bank shows slot 1 holding LOCAL
    // bytes again (data-slot-local=true), proving the per-slot reload pulled
    // the seeded blob handle — NOT merely that the synced slotMeta name
    // survived. THIS is the Fix B repair.
    const restored = page.locator(`[data-testid="dock-fullview-pane"][data-pane-node="${VVS_ID}"]`);
    await expect(restored.locator('[data-testid="videovarispeed-multi-panel"]')).toBeVisible({ timeout: 5000 });
    await expect(restored.locator('[data-testid="videovarispeed-slot-1"]'))
      .toHaveAttribute('data-slot-local', 'true', { timeout: 12000 });

    expect(errors, `page errors: ${errors.join('\n')}`).toEqual([]);
  });
});
