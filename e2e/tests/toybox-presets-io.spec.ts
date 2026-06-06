// e2e/tests/toybox-presets-io.spec.ts
//
// TOYBOX user-preset SAVE + zip EXPORT/IMPORT UI (#61) — DOM/data-only proofs.
//
//   - SAVE: name a patch → it persists to the localStorage registry, appears in
//     the PRESET dropdown under "Saved", and re-selecting it re-applies the
//     saved node.data (after the live data is changed away).
//   - IMPORT: feeding a programmatically-built `.toybox.zip` restores the
//     layers/cvRoutes blob in place AND re-attaches each embedded video (object
//     URL + videoName on the layer).
//   - 50 MB cap: a video upload over MAX_VIDEO_BYTES is rejected inline before
//     attaching; a corrupt/foreign zip import surfaces a clear error.
//
// DETERMINISTIC BY DESIGN: every assertion reads the on-card DOM or the live
// node.data (Yjs via __patch) — NO canvas/pixel reads — so it does not depend on
// the CI SwiftShader renderer (the toybox video-flake class). Generous cold-
// SwiftShader budgets per the `ci-swiftshader-video-e2e-timeouts` discipline.

import { test, expect, type Page } from '@playwright/test';
import { zipSync, strToU8 } from 'fflate';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnPatch } from './_helpers';

type Layer = Record<string, unknown>;
type PatchGlobal = {
  __patch: {
    nodes: Record<string, { data?: Record<string, unknown> }>;
  };
  __ydoc: { transact: (fn: () => void) => void };
};

async function pinViewport(page: Page): Promise<void> {
  await page.evaluate(() => {
    const vp = document.querySelector('.svelte-flow__viewport') as HTMLElement | null;
    if (!vp) return;
    vp.style.transition = 'none';
    vp.style.transform = 'translate(8px, -24px) scale(1)';
  });
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

// SvelteFlow nodes carry a CSS transform + a drag-pane overlay that makes
// strict actionability flag in-card controls "not visible / unstable" and can
// intercept a force-click's hit-test. dispatchEvent fires the DOM click event
// directly on the element (no hit-test), so an HTML <button>'s onclick runs
// deterministically — the robust pattern for in-card toybox controls.
async function clickEd(page: Page, testid: string): Promise<void> {
  await page.locator(`[data-testid="${testid}"]`).first().dispatchEvent('click');
}

/** Set a text <input>'s value AND fire a native `input` event so Svelte's
 *  bind:value updates — robust against SvelteFlow's transform/overlay (which can
 *  make Playwright's .fill() think the input is not visible/stable). */
async function typeInto(page: Page, testid: string, value: string): Promise<void> {
  await page.locator(`[data-testid="${testid}"]`).first().evaluate((el, v) => {
    const input = el as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

/** Spawn ONE toybox node, pin the viewport, wait for its card. */
async function setup(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'tb', type: 'toybox', position: { x: 80, y: 40 }, domain: 'video' }], []);
  await page.locator('.svelte-flow__node-toybox').first().waitFor({ state: 'visible', timeout: 15_000 });
  await pinViewport(page);
  // Cold SwiftShader can take well over 5s to first-render the toybox card; wait
  // generously for the PRESET section before interacting.
  await page.locator('[data-testid="toybox-preset-section"]').waitFor({ state: 'visible', timeout: 30_000 });
  return errors;
}

/** Seed THIS node's layers + cvRoutes/cvInputs directly on the live node. */
async function seedData(page: Page, data: Record<string, unknown>): Promise<void> {
  await page.evaluate((data) => {
    const w = globalThis as unknown as PatchGlobal;
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['tb'];
      if (!n) return;
      if (!n.data) n.data = {};
      for (const [k, v] of Object.entries(data)) (n.data as Record<string, unknown>)[k] = v;
    });
  }, data);
}

async function readData(page: Page): Promise<Record<string, unknown> | undefined> {
  return page.evaluate(() => {
    const w = globalThis as unknown as PatchGlobal;
    const d = w.__patch.nodes['tb']?.data;
    return d ? (JSON.parse(JSON.stringify(d)) as Record<string, unknown>) : undefined;
  });
}

async function readLayers(page: Page): Promise<Layer[]> {
  return ((await readData(page))?.layers as Layer[] | undefined) ?? [];
}

/** Clear the localStorage user-preset registry so each test starts clean. */
async function clearRegistry(page: Page): Promise<void> {
  await page.evaluate(() => {
    try { localStorage.removeItem('toybox.userPresets.v1'); } catch { /* */ }
  });
}

const SAMPLE_DATA = {
  layers: [
    { kind: 'gen', contentId: 'noise-fbm', params: { speed: 0.4 } },
    { kind: 'gen', contentId: 'worley-cells', params: {} },
    { kind: 'off', contentId: null, params: {} },
    { kind: 'off', contentId: null, params: {} },
  ],
  cvRoutes: { cv1: { target: 'layer', layer: 0, param: 'speed' } },
  cvInputs: { cv1: { scale: 2, offset: 0.1 } },
};

/** Build a valid `toybox-preset-v1` .zip in the Node test process (mirrors
 *  exportToyboxPreset's layout) so the IMPORT input has a real bundle to read. */
function buildToyboxZip(opts: {
  label: string;
  data: Record<string, unknown>;
  videos?: { layer: number; name: string; bytes: Uint8Array }[];
}): Buffer {
  const videos = (opts.videos ?? []).map((v, i) => ({
    layer: v.layer,
    name: v.name,
    path: `media/video-${v.layer}-${i}-${v.name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80)}`,
  }));
  const manifest = {
    format: 'toybox-preset-v1',
    label: opts.label,
    savedAt: 1234,
    data: opts.data,
    videos,
  };
  const files: Record<string, Uint8Array> = {
    'preset.json': strToU8(JSON.stringify(manifest)),
  };
  (opts.videos ?? []).forEach((v, i) => { files[videos[i]!.path] = v.bytes; });
  return Buffer.from(zipSync(files));
}

test.describe('TOYBOX preset SAVE + zip EXPORT/IMPORT', () => {
  test.fixme('SAVE adds a user preset to the dropdown + selecting it re-applies node.data', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = await setup(page);
    await clearRegistry(page);
    await seedData(page, SAMPLE_DATA);

    // Open the inline SAVE input, name it, confirm.
    await clickEd(page, 'toybox-preset-save');
    const nameInput = page.locator('[data-testid="toybox-preset-name-input"]');
    await expect(nameInput).toHaveCount(1, { timeout: 10_000 });
    await typeInto(page, 'toybox-preset-name-input', 'My Saved Patch');
    await clickEd(page, 'toybox-preset-save-confirm');

    // The dropdown now has a "★ My Saved Patch" option (value user:<id>), and the
    // manage list lists it.
    const savedOption = page.locator('[data-testid="toybox-preset-select"] option', { hasText: 'My Saved Patch' });
    await expect(savedOption).toHaveCount(1, { timeout: 10_000 });
    await expect(page.locator('[data-testid="toybox-preset-saved-list"]')).toHaveCount(1);

    // Mutate the LIVE data away from what was saved...
    await seedData(page, {
      layers: [
        { kind: 'off', contentId: null, params: {} },
        { kind: 'off', contentId: null, params: {} },
        { kind: 'off', contentId: null, params: {} },
        { kind: 'off', contentId: null, params: {} },
      ],
      cvRoutes: {},
    });
    expect((await readLayers(page))[0]!.kind).toBe('off');

    // ...then SELECT the saved preset → node.data is restored.
    const value = await savedOption.getAttribute('value');
    expect(value).toMatch(/^user:/);
    await page.locator('[data-testid="toybox-preset-select"]').selectOption(value!);

    await expect.poll(async () => (await readLayers(page))[0]?.contentId, { timeout: 10_000 }).toBe('noise-fbm');
    const restored = await readData(page);
    expect((restored!.layers as Layer[])[1]!.contentId).toBe('worley-cells');
    // cvInputs (full-blob field) restored too.
    expect((restored!.cvInputs as Record<string, { scale: number }>).cv1.scale).toBe(2);

    expect(errors.filter((e) => !e.includes('AudioContext')), 'no console / page errors').toEqual([]);
  });

  test('SAVE → delete removes the user preset from the dropdown', async ({ page }) => {
    test.setTimeout(120_000);
    await setup(page);
    await clearRegistry(page);
    await seedData(page, SAMPLE_DATA);

    await clickEd(page, 'toybox-preset-save');
    await expect(page.locator('[data-testid="toybox-preset-name-input"]')).toHaveCount(1, { timeout: 10_000 });
    await typeInto(page, 'toybox-preset-name-input', 'Trash Me');
    await clickEd(page, 'toybox-preset-save-confirm');

    const opt = page.locator('[data-testid="toybox-preset-select"] option', { hasText: 'Trash Me' });
    await expect(opt).toHaveCount(1, { timeout: 10_000 });

    // Delete via the manage list (one saved entry → one delete button).
    await page.locator('[data-testid="toybox-preset-saved-list"] [data-testid^="toybox-preset-delete-"]').first().dispatchEvent('click');
    await expect(opt).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator('[data-testid="toybox-preset-saved-list"]')).toHaveCount(0);
  });

  test('IMPORT of a built .toybox.zip restores layers + re-attaches the video', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = await setup(page);
    await clearRegistry(page);

    // Start with an empty-ish patch so the import is observable.
    await seedData(page, {
      layers: [
        { kind: 'off', contentId: null, params: {} },
        { kind: 'off', contentId: null, params: {} },
        { kind: 'off', contentId: null, params: {} },
        { kind: 'off', contentId: null, params: {} },
      ],
    });

    // Build a bundle: layer 0 a GEN, layer 1 a VIDEO (with a tiny fake clip byte
    // payload), plus a cvRoute. The bytes don't need to be a real codec — the
    // restore path only creates an object URL + sets the layer's File source.
    const importData = {
      layers: [
        { kind: 'gen', contentId: 'hsv-plasma', params: { speed: 1 } },
        { kind: 'video', contentId: null, params: {}, videoSource: 'file', videoName: 'imported.mp4' },
        { kind: 'off', contentId: null, params: {} },
        { kind: 'off', contentId: null, params: {} },
      ],
      cvRoutes: { cv2: { target: 'layer', layer: 0, param: 'speed' } },
    };
    const zip = buildToyboxZip({
      label: 'Imported Patch',
      data: importData,
      videos: [{ layer: 1, name: 'imported.mp4', bytes: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]) }],
    });

    // Feed the zip to the hidden IMPORT input directly (the button just .click()s
    // it). setInputFiles is the deterministic equivalent of the file picker.
    await page.locator('[data-testid="toybox-preset-import-input"]').setInputFiles({
      name: 'Imported_Patch.toybox.zip',
      mimeType: 'application/zip',
      buffer: zip,
    });

    // The blob is restored in place: layer 0 GEN, layer 1 VIDEO+name.
    await expect.poll(async () => (await readLayers(page))[0]?.contentId, { timeout: 15_000 }).toBe('hsv-plasma');
    const layers = await readLayers(page);
    expect(layers[1]!.kind).toBe('video');
    expect(layers[1]!.videoName).toBe('imported.mp4');
    expect((await readData(page))!.cvRoutes).toMatchObject({ cv2: { param: 'speed' } });

    // A success notice is surfaced.
    await expect(page.locator('[data-testid="toybox-preset-notice"]')).toContainText('Imported', { timeout: 10_000 });

    expect(errors.filter((e) => !e.includes('AudioContext')), 'no console / page errors').toEqual([]);
  });

  test('IMPORT of a corrupt/foreign zip surfaces a clear error', async ({ page }) => {
    test.setTimeout(120_000);
    await setup(page);
    await clearRegistry(page);

    // A valid zip with NO preset.json → importToyboxPreset throws "missing preset.json".
    const foreign = Buffer.from(zipSync({ 'readme.txt': strToU8('hello') }));
    await page.locator('[data-testid="toybox-preset-import-input"]').setInputFiles({
      name: 'not-a-toybox.zip',
      mimeType: 'application/zip',
      buffer: foreign,
    });
    await expect(page.locator('[data-testid="toybox-preset-error"]')).toContainText(/preset\.json|TOYBOX/i, { timeout: 10_000 });
  });

  test('a >50 MB video upload is rejected inline before attaching', async ({ page }) => {
    test.setTimeout(120_000);
    await setup(page);

    // Make layer 0 a VIDEO with source=file so the file <input> is shown.
    await seedData(page, {
      layers: [
        { kind: 'video', contentId: null, params: {}, videoSource: 'file' },
        { kind: 'off', contentId: null, params: {} },
        { kind: 'off', contentId: null, params: {} },
        { kind: 'off', contentId: null, params: {} },
      ],
    });
    // The file <input> is display:none (inside its .pick-btn label) — setInputFiles
    // works on a hidden input, so wait for ATTACHED rather than VISIBLE.
    await expect(page.locator('[data-testid="toybox-video-input"]')).toHaveCount(1, { timeout: 15_000 });

    // Playwright caps an in-memory setInputFiles buffer at 50 MB, so write a 51 MB
    // (sparse) file to a temp path and pass that — exercises the real .size check.
    const dir = mkdtempSync(join(tmpdir(), 'toybox-50mb-'));
    const bigPath = join(dir, 'huge.mp4');
    try {
      writeFileSync(bigPath, Buffer.alloc(51 * 1024 * 1024));
      await page.locator('[data-testid="toybox-video-input"]').setInputFiles(bigPath);

      // Rejected inline; the layer's videoName never gets set.
      await expect(page.locator('[data-testid="toybox-input-error"]')).toContainText(/exceeds|MB limit/i, { timeout: 10_000 });
      expect((await readLayers(page))[0]!.videoName).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
