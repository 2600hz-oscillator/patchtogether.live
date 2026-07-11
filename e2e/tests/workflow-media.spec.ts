// e2e/tests/workflow-media.spec.ts
//
// WORKFLOW MODE P3 — the media system on /rack?mode=workflow:
//
//   +  media loader — hidden-input pick (files / folder) + drop target
//      feeding the centralized mediaLibrary; rejected files surface in a
//      transient notice.
//   💾 Loaded Assets Picker — images/videos/sounds submenus; STICKY while
//      open (outside clicks don't close it; ESC does); hover thumbnails;
//      per-row ✕ unload.
//   Click-to-patch (the VIRTUAL-PORT drag primitive): clicking an asset
//      row starts a dangling cable; dropping it on a module input creates
//      the asset's module in the RIGHT RAIL — video→videovarispeed,
//      image→picturebox, audio→samsloop — loads the media through the
//      module's OWN load path, and wires module-output → dropped input.
//      The REAL-SOURCE-CHAIN rule: the sound flow asserts AUDIBLE signal
//      at the destination (library file → samsloop node.data → worklet →
//      wire → scope), not just an edge.
//
// Driving /rack?mode=workflow keeps this in the NORMAL e2e lane (no
// DB/relay) — same rationale as workflow-mode.spec.ts.

import { test, expect, type Page } from '@playwright/test';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnPatch } from './_helpers';
import { readScopePeakOverWindow } from './_module-coverage-helpers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WAV_PATH = resolve(__dirname, '../fixtures/samsloop-test.wav');
const WEBM_PATH = resolve(__dirname, '../fixtures/av-clip.webm');

// 16×16 solid red PNG (r=255,g=40,b=40) — a real decodable image whose
// non-blackness the picturebox flow can assert renderer-independently.
const RED_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGP4r6FBEmIY1TCqYfhqAADwH08QVe6wtwAAAABJRU5ErkJggg==';

interface PatchNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data?: Record<string, unknown>;
}
interface PatchEdge {
  id: string;
  source: { nodeId: string; portId: string };
  target: { nodeId: string; portId: string };
}

async function readNodes(page: Page): Promise<PatchNode[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __patch: { nodes: Record<string, PatchNode> } };
    return Object.values(w.__patch.nodes)
      .filter(Boolean)
      .map((n) => ({ id: n.id, type: n.type, position: n.position, data: n.data }));
  });
}
async function readEdges(page: Page): Promise<PatchEdge[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __patch: { edges: Record<string, PatchEdge> } };
    return Object.values(w.__patch.edges).filter(Boolean) as PatchEdge[];
  });
}
async function assetNodesOf(page: Page, type: string): Promise<PatchNode[]> {
  return (await readNodes(page)).filter((n) => n.type === type && n.id.startsWith('asset-'));
}

/** Wait for the virtual-carry commit to land: module created AND wired.
 *  (The resolve runs media decode/encode between node-create and the edge
 *  write, so polling the node alone races the edge.) */
async function waitForAssetWire(
  page: Page,
  type: string,
  target: { nodeId: string; portId: string },
): Promise<{ node: PatchNode; edges: PatchEdge[] }> {
  await expect
    .poll(
      async () => {
        const nodes = await assetNodesOf(page, type);
        if (nodes.length === 0) return 'no node';
        const edges = await readEdges(page);
        return edges.some(
          (e) =>
            e.source.nodeId === nodes[0].id &&
            e.target.nodeId === target.nodeId &&
            e.target.portId === target.portId,
        )
          ? 'wired'
          : 'node only';
      },
      { timeout: 20_000 },
    )
    .toBe('wired');
  const [node] = await assetNodesOf(page, type);
  return { node, edges: await readEdges(page) };
}

/** Fire SAMSLOOP's manual trigger through the engine read seam — the
 *  EXACT function the card's ▶ TRIGGER button invokes (SamsloopCard →
 *  read('manualTrigger')). Screen-independent: the rail card can sit
 *  partially under the topbar band depending on the auto-pan. */
async function triggerSamsloop(page: Page, nodeId: string): Promise<void> {
  await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
      __patch: { nodes: Record<string, unknown> };
    };
    const eng = w.__engine?.();
    const node = w.__patch.nodes[id];
    if (!eng || !node) throw new Error('engine/node not ready for trigger');
    const trig = eng.read(node, 'manualTrigger');
    if (typeof trig !== 'function') throw new Error('manualTrigger not exposed');
    (trig as () => void)();
  }, nodeId);
}

async function gotoWorkflow(page: Page): Promise<void> {
  await page.goto('/rack?mode=workflow');
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

/** Feed files through the + loader's hidden file input (the browse path).
 *  Playwright can't mix path-strings and buffer payloads in ONE
 *  setInputFiles call, so we batch: paths first, payloads second (each
 *  change event ingests additively into the library; the notice reflects
 *  the LAST batch, so synthetic rejects go last). Fixture PATHS also keep
 *  their real mtime — the rebind test's dupe-key depends on it. */
async function loadViaLoader(
  page: Page,
  files: Array<string | { name: string; mimeType: string; buffer: Buffer }>,
): Promise<void> {
  const input = page.getByTestId('workflow-media-file-input');
  const paths = files.filter((f): f is string => typeof f === 'string');
  const payloads = files.filter(
    (f): f is { name: string; mimeType: string; buffer: Buffer } => typeof f !== 'string',
  );
  if (paths.length > 0) await input.setInputFiles(paths);
  if (payloads.length > 0) await input.setInputFiles(payloads);
}

async function openPickerSection(page: Page, section: 'images' | 'videos' | 'sounds') {
  const trigger = page.getByTestId('workflow-topbar-slot-assets-picker');
  if ((await page.getByTestId('workflow-assets-menu').count()) === 0) {
    await trigger.click();
  }
  const sectionBtn = page.getByTestId(`workflow-assets-section-${section}`);
  if ((await sectionBtn.getAttribute('aria-expanded')) !== 'true') {
    await sectionBtn.click();
  }
  return page.getByTestId(`workflow-assets-list-${section}`);
}

/** Drop the carried (virtual) cable on `portId` of node `nodeId` via the
 *  card's own PatchPanel: trigger → INPUT drill → port row. */
async function dropOnInput(page: Page, nodeId: string, portId: string): Promise<void> {
  const card = page.locator(`.svelte-flow__node[data-id="${nodeId}"]`);
  await card.getByTestId('patch-trigger').click();
  const panel = page.locator(`[data-patch-panel-chrome="${nodeId}"]`);
  await expect(panel).toBeVisible();
  // Flat cards expose an INPUT nav; sectioned mega-cards list sections.
  const inputsNav = panel.locator('[data-testid="patch-panel-nav"][data-nav="inputs"]');
  if (await inputsNav.count()) {
    await inputsNav.click();
  } else {
    await panel.locator('[data-testid="patch-panel-section-nav"]').first().click();
  }
  await panel
    .locator(`[data-testid="patch-panel-port-row"][data-port-id="${portId}"][data-direction="input"]`)
    .click();
}

test.describe('workflow media system (P3)', () => {
  test('loader ingests mixed files; picker lists them per kind; rejected files surface unobtrusively', async ({
    page,
  }) => {
    await gotoWorkflow(page);
    await loadViaLoader(page, [
      { name: 'red.png', mimeType: 'image/png', buffer: Buffer.from(RED_PNG_B64, 'base64') },
      WAV_PATH,
      WEBM_PATH,
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not media') },
    ]);

    // The unsupported file is REPORTED, not silently dropped.
    const notice = page.getByTestId('workflow-media-notice');
    await expect(notice).toBeVisible();
    await expect(page.getByTestId('workflow-media-rejected-item')).toHaveText(/notes\.txt/);
    await notice.getByTestId('workflow-media-notice-dismiss').click();
    await expect(notice).toHaveCount(0);

    // Each kind lists under its own submenu.
    const images = await openPickerSection(page, 'images');
    await expect(images.locator('[data-testid="workflow-asset-row"]')).toHaveText(/red\.png/);
    const videos = await openPickerSection(page, 'videos');
    await expect(videos.locator('[data-testid="workflow-asset-row"]')).toHaveText(/av-clip\.webm/);
    const sounds = await openPickerSection(page, 'sounds');
    await expect(sounds.locator('[data-testid="workflow-asset-row"]')).toHaveText(
      /samsloop-test\.wav/,
    );
    // Nothing is patched yet — no highlight.
    await expect(
      sounds.locator('[data-testid="workflow-asset-row"]'),
    ).toHaveAttribute('data-patched', 'false');
  });

  test('sticky menu: outside clicks leave it open; ESC closes; ESC also cancels a started drag with no module created', async ({
    page,
  }) => {
    await gotoWorkflow(page);
    await loadViaLoader(page, [WAV_PATH]);
    await openPickerSection(page, 'sounds');

    // Outside pointerdown (the canvas pane) does NOT close the picker.
    await page.locator('.svelte-flow__pane:visible').first().click({ position: { x: 200, y: 300 } });
    await expect(page.getByTestId('workflow-assets-menu')).toBeVisible();

    // ESC closes it.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('workflow-assets-menu')).toHaveCount(0);

    // Row click starts the virtual drag (menu closes, ghost cable dangles)…
    await openPickerSection(page, 'sounds');
    await page.locator('[data-testid="workflow-asset-row"][data-kind="audio"]').click();
    await expect(page.getByTestId('workflow-assets-menu')).toHaveCount(0);
    await expect(page.getByTestId('pickup-cable')).toBeVisible();

    // …and ESC discards it: no cable, no module ever created.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('pickup-cable')).toHaveCount(0);
    expect(await assetNodesOf(page, 'samsloop')).toHaveLength(0);
  });

  test('REAL CHAIN — click-patch a sound: samsloop lands in the right rail, wired, AUDIBLE at the scope; unload deletes it', async ({
    page,
  }) => {
    // Media decode + a 2.5 s audibility window + a CI SwiftShader boot.
    test.setTimeout(90_000);
    await gotoWorkflow(page);
    await spawnPatch(page, [{ id: 'sc', type: 'scope', position: { x: 60, y: 200 } }]);
    await loadViaLoader(page, [WAV_PATH]);

    await openPickerSection(page, 'sounds');
    await page.locator('[data-testid="workflow-asset-row"][data-kind="audio"]').click();
    await expect(page.getByTestId('pickup-cable')).toBeVisible();

    await dropOnInput(page, 'sc', 'ch1');

    // The module materializes (created at commit time), wired out→ch1.
    const { node: loop, edges } = await waitForAssetWire(page, 'samsloop', {
      nodeId: 'sc',
      portId: 'ch1',
    });
    expect(
      edges.some(
        (e) =>
          e.source.nodeId === loop.id &&
          e.source.portId === 'out' &&
          e.target.nodeId === 'sc' &&
          e.target.portId === 'ch1',
      ),
    ).toBe(true);

    // Ordinary VISIBLE card, placed in the far-right rail column.
    const card = page.locator(`.svelte-flow__node[data-id="${loop.id}"]`);
    await expect(card).toBeVisible();
    const scope = (await readNodes(page)).find((n) => n.id === 'sc')!;
    expect(loop.position.x).toBeGreaterThan(scope.position.x + 100);
    // Media went through SAMSLOOP's own load path (bytes persisted on data)
    // + the durable descriptor for rebind.
    expect((loop.data as { fileBytesB64?: string }).fileBytesB64).toBeTruthy();
    expect((loop.data as { mediaDesc?: { name: string } }).mediaDesc?.name).toBe(
      'samsloop-test.wav',
    );

    // AUDIBLE at the destination: wait until the factory's node.data poll
    // has pushed the sample into the worklet (sampleLength goes non-zero;
    // a trigger BEFORE the load would be re-silenced by loadSample), then
    // trigger the loop and read the scope.
    await expect
      .poll(
        async () =>
          page.evaluate((id) => {
            const w = globalThis as unknown as {
              __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
              __patch: { nodes: Record<string, unknown> };
            };
            const eng = w.__engine?.();
            const node = w.__patch.nodes[id];
            if (!eng || !node) return 0;
            const len = eng.read(node, 'sampleLength');
            return typeof len === 'number' ? len : 0;
          }, loop.id),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);
    // Trigger + measure, retrying: `sampleLength` can reflect the synced
    // data before the worklet's transferable lands, and a trigger racing
    // loadSample is re-silenced — a later trigger then sticks (loop mode
    // keeps playing once it takes).
    let level = { peak: 0, rms: 0, nonzeroSamples: 0, polls: 0 };
    for (let attempt = 0; attempt < 5 && level.peak <= 0.03; attempt++) {
      await triggerSamsloop(page, loop.id);
      level = await readScopePeakOverWindow(page, 'sc', 900);
    }
    expect(level.peak).toBeGreaterThan(0.03);
    expect(level.nonzeroSamples).toBeGreaterThan(0);

    // The picker row now renders patched (theme highlight).
    const sounds = await openPickerSection(page, 'sounds');
    const row = sounds.locator('[data-testid="workflow-asset-row"]');
    await expect(row).toHaveAttribute('data-patched', 'true');

    // ✕ unloads: module + its wires gone, row gone, menu still open (sticky).
    await row.getByTestId('workflow-asset-unload').click();
    await expect(row).toHaveCount(0);
    await expect(page.getByTestId('workflow-assets-menu')).toBeVisible();
    await expect
      .poll(async () => (await assetNodesOf(page, 'samsloop')).length)
      .toBe(0);
    expect((await readEdges(page)).filter((e) => e.source.nodeId === loop.id)).toHaveLength(0);
    await expect(page.locator(`.svelte-flow__node[data-id="${loop.id}"]`)).toHaveCount(0);
  });

  test('drag-from-existing reuses the ONE module; right-click adds a second rail module; drags still default to the first', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await gotoWorkflow(page);
    // Side by side — a SCOPE card is ~570px tall, so stacking them would
    // overlap sc2's patch trigger under sc1's card body.
    await spawnPatch(page, [
      { id: 'sc1', type: 'scope', position: { x: 60, y: 120 } },
      { id: 'sc2', type: 'scope', position: { x: 520, y: 120 } },
    ]);
    await loadViaLoader(page, [WAV_PATH]);

    // First drag → creates the module.
    await openPickerSection(page, 'sounds');
    await page.locator('[data-testid="workflow-asset-row"][data-kind="audio"]').click();
    await dropOnInput(page, 'sc1', 'ch1');
    const { node: first } = await waitForAssetWire(page, 'samsloop', {
      nodeId: 'sc1',
      portId: 'ch1',
    });

    // Second drag from the (highlighted) row → a NEW wire from the SAME
    // module — still exactly ONE samsloop.
    const sounds = await openPickerSection(page, 'sounds');
    const row = sounds.locator('[data-testid="workflow-asset-row"]');
    await expect(row).toHaveAttribute('data-patched', 'true');
    await row.click();
    await dropOnInput(page, 'sc2', 'ch1');
    await expect
      .poll(async () =>
        (await readEdges(page)).filter((e) => e.source.nodeId === first.id).length,
      )
      .toBe(2);
    expect(await assetNodesOf(page, 'samsloop')).toHaveLength(1);

    // Right-click → "add additional output module": a SECOND module for
    // the same asset, stacked BELOW the first in the rail (no wire).
    await openPickerSection(page, 'sounds');
    await row.click({ button: 'right' });
    await page.getByTestId('workflow-asset-add-module').click();
    await expect
      .poll(async () => (await assetNodesOf(page, 'samsloop')).length, { timeout: 15_000 })
      .toBe(2);
    const both = await assetNodesOf(page, 'samsloop');
    const second = both.find((n) => n.id !== first.id)!;
    expect(second.position.y).toBeGreaterThan(first.position.y);
    expect(Math.abs(second.position.x - first.position.x)).toBeLessThan(1);

    // Subsequent drags STILL default to the first module.
    await sounds.locator('[data-testid="workflow-asset-row"]').click();
    await dropOnInput(page, 'sc2', 'ch2');
    await expect
      .poll(async () =>
        (await readEdges(page)).filter(
          (e) => e.source.nodeId === first.id && e.target.portId === 'ch2',
        ).length,
      )
      .toBe(1);
    expect((await readEdges(page)).filter((e) => e.source.nodeId === second.id)).toHaveLength(0);
  });

  test('image → picturebox: created in the rail, wired to a video input, preview shows the non-black image', async ({
    page,
  }) => {
    // One video-domain module boots the video engine on CI's SwiftShader.
    test.setTimeout(90_000);
    await gotoWorkflow(page);
    await spawnPatch(page, [{ id: 'fx', type: 'chroma', position: { x: 60, y: 200 }, domain: 'video' }]);
    await loadViaLoader(page, [
      { name: 'red.png', mimeType: 'image/png', buffer: Buffer.from(RED_PNG_B64, 'base64') },
    ]);

    await openPickerSection(page, 'images');
    await page.locator('[data-testid="workflow-asset-row"][data-kind="image"]').click();
    await expect(page.getByTestId('pickup-cable')).toBeVisible();
    await dropOnInput(page, 'fx', 'in');

    // Created + wired picturebox.out → chroma.in.
    const { node: pb, edges } = await waitForAssetWire(page, 'picturebox', {
      nodeId: 'fx',
      portId: 'in',
    });
    expect(
      edges.some(
        (e) =>
          e.source.nodeId === pb.id &&
          e.source.portId === 'out' &&
          e.target.nodeId === 'fx' &&
          e.target.portId === 'in',
      ),
    ).toBe(true);
    // Rail placement + the module's own persistence fields.
    const fx = (await readNodes(page)).find((n) => n.id === 'fx')!;
    expect(pb.position.x).toBeGreaterThan(fx.position.x + 100);
    expect((pb.data as { imageBytes?: string }).imageBytes).toBeTruthy();

    // The card preview renders the image — decode it on a 2D canvas and
    // count non-black pixels (renderer-tolerant: no WebGL read needed).
    const card = page.locator(`.svelte-flow__node[data-id="${pb.id}"]`);
    const preview = card.getByTestId('picturebox-preview');
    await expect(preview).toBeVisible();
    const nonBlackRatio = await preview.evaluate(async (el) => {
      const img = el as HTMLImageElement;
      if (!img.complete) await new Promise((r) => (img.onload = r));
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let nonBlack = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] + d[i + 1] + d[i + 2] > 60) nonBlack++;
      }
      return nonBlack / (c.width * c.height);
    });
    expect(nonBlackRatio).toBeGreaterThan(0.9); // solid red, JPEG-encoded
  });

  test('hover thumbnails: image rows show the image; video rows show a poster frame to the right of the menu', async ({
    page,
  }) => {
    await gotoWorkflow(page);
    await loadViaLoader(page, [
      { name: 'red.png', mimeType: 'image/png', buffer: Buffer.from(RED_PNG_B64, 'base64') },
      WEBM_PATH,
    ]);

    const images = await openPickerSection(page, 'images');
    await images.locator('[data-testid="workflow-asset-row"]').hover();
    const thumb = page.getByTestId('workflow-asset-thumb');
    await expect(thumb).toBeVisible();
    await expect(thumb.getByTestId('workflow-asset-thumb-image')).toBeVisible();
    // To the RIGHT of the menu.
    const menuBox = (await page.getByTestId('workflow-assets-menu').boundingBox())!;
    const thumbBox = (await thumb.boundingBox())!;
    expect(thumbBox.x).toBeGreaterThanOrEqual(menuBox.x + menuBox.width);

    // Video row: the probe's captured poster frame (or, while it's still
    // settling, the metadata-preloaded <video> fallback) renders.
    const videos = await openPickerSection(page, 'videos');
    await videos.locator('[data-testid="workflow-asset-row"]').hover();
    await expect(thumb).toBeVisible();
    await expect(async () => {
      const poster = await thumb.getByTestId('workflow-asset-thumb-poster').count();
      const fallback = await thumb.getByTestId('workflow-asset-thumb-video').count();
      expect(poster + fallback).toBeGreaterThan(0);
    }).toPass();
    // The poster eventually wins once the probe capture settles (real
    // decode — the unit fakes cover the capture math).
    await expect
      .poll(
        async () => {
          // re-hover so the overlay re-reads meta.posterUrl
          await videos.locator('[data-testid="workflow-asset-row"]').hover();
          return thumb.getByTestId('workflow-asset-thumb-poster').count();
        },
        { timeout: 15_000 },
      )
      .toBe(1);
  });

  test('rebind: after quicksave→reload→quickload, re-adding the matching file re-links the EXISTING module (no duplicate)', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await gotoWorkflow(page);
    await spawnPatch(page, [{ id: 'sc', type: 'scope', position: { x: 60, y: 200 } }]);
    await loadViaLoader(page, [WAV_PATH]);
    await openPickerSection(page, 'sounds');
    await page.locator('[data-testid="workflow-asset-row"][data-kind="audio"]').click();
    await dropOnInput(page, 'sc', 'ch1');
    const { node: orig } = await waitForAssetWire(page, 'samsloop', {
      nodeId: 'sc',
      portId: 'ch1',
    });

    // Quicksave slot 1 (File.. menu), then a full reload → quickload.
    await page.getByTestId('workflow-file-trigger').click();
    await page.getByTestId('workflow-file-quicksave').click();
    await page.getByTestId('workflow-quicksave-1').click();
    await expect(page.getByTestId('workflow-file-menu')).toHaveCount(0);

    await page.reload();
    await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
    await page.getByTestId('workflow-file-trigger').click();
    await page.getByTestId('workflow-file-quickload').click();
    const slot1 = page.getByTestId('workflow-quickload-1');
    await expect(slot1).toBeEnabled();
    await slot1.click();

    // The module survives the round-trip (same id, descriptor intact) but
    // the SESSION-LOCAL library is empty → nothing to pick, no links.
    await expect
      .poll(async () => (await assetNodesOf(page, 'samsloop')).length, { timeout: 15_000 })
      .toBe(1);
    await expect(page.getByTestId('workflow-topbar-slot-assets-picker')).toBeVisible();
    await page.getByTestId('workflow-topbar-slot-assets-picker').click();
    await expect(page.getByTestId('workflow-assets-section-sounds')).toBeDisabled();
    await page.keyboard.press('Escape');

    // Re-adding the SAME file (dupe-key match) REBINDS automatically:
    // the row lights up patched and NO second module appears.
    await loadViaLoader(page, [WAV_PATH]);
    const sounds = await openPickerSection(page, 'sounds');
    await expect(sounds.locator('[data-testid="workflow-asset-row"]')).toHaveAttribute(
      'data-patched',
      'true',
      { timeout: 10_000 },
    );
    expect(await assetNodesOf(page, 'samsloop')).toHaveLength(1);
    expect((await assetNodesOf(page, 'samsloop'))[0].id).toBe(orig.id);
  });
});
